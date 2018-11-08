// tslint:disable-next-line:rxjs-no-wholesale
import { from, Observable, Subscribable, Subscription } from 'rxjs'
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

export class LanguageServerConnectionManager implements Unsubscribable {
    private subscriptions = new Subscription()
    private conns = new Map<string, Promise<rpc.MessageConnection>>()

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
                        this.getOrCreateConnection(uri.toString())
                    }
                })
        )

        // Clean up connections.
        this.subscriptions.add(() => {
            for (const rootURI of this.conns.keys()) {
                this.removeConnection(rootURI)
            }
            this.conns.clear()
        })
    }

    private removeConnection(rootURI: string): void {
        const conn = this.conns.get(rootURI)
        this.conns.delete(rootURI)
        if (conn) {
            conn.then(c => c.dispose()).catch(err =>
                console.error(
                    `Error disposing Python language server connection for ${JSON.stringify(
                        rootURI
                    )}:`,
                    err
                )
            )
        }
    }

    public getConnection(uri: sourcegraph.URI): Promise<rpc.MessageConnection> {
        // TODO!(sqs) HACK: chop off path to get root URI
        const rootURI = 'file:///tmp/python-sample-0'
        /// 'git://github.com/sgtest/python-sample-0/ad924954afa36439105efa03cce4c5981a2a5384' // uri.toString().replace(/#.*$/, '')
        return this.getOrCreateConnection(rootURI)
    }

    public getAll(): Promise<rpc.MessageConnection>[] {
        return Array.from(this.conns.values())
    }

    public get connections():Observable<rpc.MessageConnection[]> { return this._entries.pipe(map(({connection})=>connection) }

    private async getOrCreateConnection(
        rootURI: string
    ): Promise<rpc.MessageConnection> {
        rootURI = 'file:///tmp/python-sample-0'
        let conn = this.conns.get(rootURI)
        if (!conn) {
            console.log('CONNECTING TO', rootURI, 'existing:', [
                ...this.conns.keys(),
            ])
            conn = createWebSocketMessageTransports(
                new WebSocket(this.address)
            ).then(({ reader, writer }) => {
                const c = rpc.createMessageConnection(reader, writer)
                c.listen()
                conn = initialize(prepURI(rootURI).toString(), c)
                    .then(() => this.prepareConn(rootURI, c))
                    .then(() => c)
                return conn
            })
            this.conns.set(rootURI, conn)
            return conn
        }
        return conn
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
                name: rootURI.replace(/^[^/]+\/[^/]+$/, ''),
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
            traceLogging: true, // Max level, let LS decide through settings actual level of logging.
            asyncStartup: true,
        },
    } as InitializeParams)
    conn.sendNotification(InitializedNotification.type)
}
