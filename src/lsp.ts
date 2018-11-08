// tslint:disable:rxjs-no-wholesale
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
    InitializeError,
    InitializeParams,
    InitializeResult,
    MarkupKind,
} from 'vscode-languageserver-protocol'
import { createWebSocketMessageTransports } from './websocket'

interface Entry {
    /** The root URI of the repository on Sourcegraph. */
    originalRootUri: string | null

    /**
     * The root URI used by the server. The server automatically creates a temporary directory when the initialize
     * request's rootUri is "tmp:"; in that case, actualRootUri is the file: URI to that temporary directory.
     */
    actualRootUri: Promise<string | null>

    connection: Promise<rpc.MessageConnection>
}

export class LanguageServerConnectionManager implements Unsubscribable {
    private subscriptions = new Subscription()
    private entries = new BehaviorSubject<Entry[]>([])

    constructor(
        roots: Subscribable<ReadonlyArray<sourcegraph.WorkspaceRoot>>,
        private prepareConn: (
            originalRootUri: string | null,
            actualRootUri: string | null,
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
            for (const { originalRootUri } of this.entries.value) {
                this.removeConnection(originalRootUri)
            }
            this.entries.next([])
        })
    }

    private findEntry(rootUri: string | null): Entry | undefined {
        return this.entries.value.find(e => e.originalRootUri === rootUri)
    }

    private removeEntry(rootUri: string | null): void {
        this.entries.next(
            this.entries.value.filter(e => e.originalRootUri !== rootUri)
        )
    }

    private removeConnection(rootUri: string | null): void {
        const e = this.findEntry(rootUri)
        if (!e) {
            throw new Error(`no connection found with root URI ${rootUri}`)
        }
        this.removeEntry(rootUri)
        if (e) {
            e.connection
                .then(c => c.dispose())
                .catch(err =>
                    console.error(
                        `Error disposing Python language server connection for ${JSON.stringify(
                            rootUri
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
    public async get(
        rootUri: string | null
    ): Promise<{
        actualRootUri: string | null
        connection: rpc.MessageConnection
    }> {
        const e = this.findOrCreateEntry(rootUri)
        return {
            actualRootUri: await e.actualRootUri,
            connection: await e.connection,
        }
    }

    private findOrCreateEntry(rootUri: string | null): Entry {
        let e = this.findEntry(rootUri)
        if (!e) {
            const connection = createWebSocketMessageTransports(
                new WebSocket(this.address)
            ).then(({ reader, writer }) => {
                const c = rpc.createMessageConnection(reader, writer)
                c.listen()
                return initialize(c).then(({ rootUri: actualRootUri }) =>
                    this.prepareConn(rootUri, actualRootUri, c).then(() => ({
                        connection: c,
                        actualRootUri,
                    }))
                )
            })
            e = {
                originalRootUri: rootUri,
                actualRootUri: connection.then(
                    ({ actualRootUri }) => actualRootUri
                ),
                connection: connection.then(({ connection }) => connection),
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

interface InitializeResultWithRootUri extends InitializeResult {
    rootUri: string | null
}

/**
 * Extend LSP's InitializeRequest to add the rootUri field to the result. This is the URI to the temporary
 * directory generated by the server (because we passed "tmp:" as the root URI).
 */
namespace InitializeRequest {
    export const type = new rpc.RequestType<
        InitializeParams,
        InitializeResultWithRootUri,
        InitializeError,
        void
    >('initialize')
}

async function initialize(
    conn: rpc.MessageConnection
): Promise<InitializeResultWithRootUri> {
    const result = await conn.sendRequest(InitializeRequest.type, {
        processId: null as any,
        documentSelector: [{ language: 'python' }],
        rootUri: 'tmp:', // tells the server to make a new temp dir (and return its path in the initialize result)
        workspaceFolders: [], // not used by python-language-server
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
    return result
}
