// tslint:disable:rxjs-no-wholesale
import { basename } from 'path'
import {
    BehaviorSubject,
    from,
    Observable,
    Subscribable,
    Subscription,
} from 'rxjs'
import { bufferCount, map, startWith } from 'rxjs/operators'
import * as sourcegraph from 'sourcegraph'
import { Unsubscribable } from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import {
    InitializedNotification,
    InitializeParams,
    InitializeRequest,
    MarkupKind,
} from 'vscode-languageserver-protocol'
import { prepURI } from './sourcegraph-python'
import { createWebSocketMessageTransports } from './websocket'

interface Entry {
    rootURI: string
    connection: Promise<rpc.MessageConnection>
}

export class LanguageServerConnectionManager implements Unsubscribable {
    private subscriptions = new Subscription()
    private entries = new BehaviorSubject<Entry[]>([])

    constructor(
        roots: Subscribable<ReadonlyArray<sourcegraph.WorkspaceRoot>>,
        private prepareConn: (
            rootURI: string,
            conn: rpc.MessageConnection
        ) => Promise<void>,
        private address: string
    ) {
        // Initiate language server connection for all roots immediately when they are added.
        this.subscriptions.add(
            from(roots)
                .pipe(
                    startWith([] as sourcegraph.WorkspaceRoot[]),
                    bufferCount(2)
                )
                .subscribe(([prevRoots, roots]) => {
                    for (const prevRoot of prevRoots) {
                        if (
                            !roots
                                .map(({ uri }) => uri.toString())
                                .includes(prevRoot.uri.toString())
                        ) {
                            this.removeConnection(prevRoot.uri.toString())
                        }
                    }

                    for (const { uri } of roots) {
                        // It is safe to not handle the promise here, because all callers to getConnection will handle it.
                        this.findOrCreateEntry(uri.toString())
                    }
                })
        )

        // Clean up connections.
        this.subscriptions.add(() => {
            for (const { rootURI } of this.entries.value) {
                this.removeConnection(rootURI)
            }
            this.entries.next([])
        })
    }

    private findEntry(rootURI: string): Entry | undefined {
        return this.entries.value.find(e => e.rootURI === rootURI)
    }

    private removeEntry(rootURI: string): void {
        this.entries.next(this.entries.value.filter(e => e.rootURI !== rootURI))
    }

    private removeConnection(rootURI: string): void {
        const e = this.findEntry(rootURI)
        if (!e) {
            throw new Error(`no connection found with root URI ${rootURI}`)
        }
        this.removeEntry(rootURI)
        if (e) {
            e.connection
                .then(c => c.dispose())
                .catch(err =>
                    console.error(
                        `Error disposing Python language server connection for ${JSON.stringify(
                            rootURI
                        )}:`,
                        err
                    )
                )
        }
    }

    /**
     * An observable that emits when the set of connections changes.
     */
    public get connections(): Observable<Promise<rpc.MessageConnection>[]> {
        return this.entries.pipe(
            map(entries => entries.map(({ connection }) => connection))
        )
    }

    /**
     * Returns the connection for the given root URI. If no connection exists yet, it is established.
     */
    public async get(rootURI: string | null): Promise<rpc.MessageConnection> {
        return (await this.findOrCreateEntry(rootURI)).connection
    }

    private async findOrCreateEntry(rootURI: string | null): Promise<Entry> {
        rootURI = 'file:///tmp/python-sample-0' // TODO!(sqs)
        let e = this.findEntry(rootURI)
        if (!e) {
            e = {
                rootURI,
                connection: createWebSocketMessageTransports(
                    new WebSocket(this.address)
                ).then(({ reader, writer }) => {
                    const c = rpc.createMessageConnection(reader, writer)
                    c.listen()
                    initialize(prepURI(rootURI!).toString(), c) // TODO!(sqs)
                        .then(() => this.prepareConn(rootURI!, c)) // TODO!(sqs)
                        .then(() => c)
                    return c
                }),
            }
            this.entries.next([...this.entries.value, e])
            return e
        }
        return e
    }

    public unsubscribe(): void {
        this.subscriptions.unsubscribe()
    }
}

async function initialize(
    rootURI: string,
    conn: rpc.MessageConnection
): Promise<void> {
    await conn.sendRequest(InitializeRequest.type, {
        processId: null as any,
        documentSelector: [{ language: 'python' }],
        rootUri: rootURI,
        workspaceFolders: [
            {
                name: basename(rootURI),
                uri: rootURI,
            },
        ],
        capabilities: {
            textDocument: {
                hover: { contentFormat: [MarkupKind.Markdown] },
            },
            workspace: {
                workspaceFolders: true,
            },
        },
        initializationOptions: {
            interpreter: {
                properties: {
                    InterpreterPath:
                        '/home/sqs/.pyenv/versions/3.7.1/bin/python',
                    Version: '3.7.1',
                    DatabasePath:
                        '/home/sqs/src/github.com/Microsoft/vscode-python/languageServer.0.1.482',
                },
            },
            displayOptions: {
                preferredFormat: 'markdown',
                trimDocumentationLines: false,
                maxDocumentationLineLength: 0,
                trimDocumentationText: false,
                maxDocumentationTextLength: 0,
            },
            testEnvironment: false,
            searchPaths: [
                '/usr/lib/python3.7;/usr/lib/python3.7/plat-x86_64-linux-gnu;/usr/lib/python3.7/lib-tk;/usr/lib/python3.7/lib-old;/usr/lib/python3.7/lib-dynload;/home/sqs/.local/lib/python3.7/site-packages;/usr/local/lib/python3.7/dist-packages;/usr/lib/python3.7/dist-packages;/usr/lib/python3.7/dist-packages/gtk-2.0;',
                '/usr/bin',
            ],
            typeStubSearchPaths: [
                '/home/sqs/src/github.com/Microsoft/vscode-python/languageServer.0.1.48/Typeshed',
            ],
            excludeFiles: [],
            analysisUpdates: true,
            traceLogging: true,
            asyncStartup: true,
        },
    } as InitializeParams)
    conn.sendNotification(InitializedNotification.type)
}
