// tslint:disable-next-line:rxjs-no-wholesale
import { combineLatest, Observable } from 'rxjs'
import { map, startWith } from 'rxjs/operators'
import * as sourcegraph from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import {
    DefinitionRequest,
    DidChangeConfigurationNotification,
    DidChangeConfigurationParams,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    HoverRequest,
    LogMessageNotification,
    ReferenceParams,
    ReferencesRequest,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { LanguageServerConnectionManager } from './lsp'

const ADDR = 'ws://localhost:4288'

export function prepURI(uri: string | sourcegraph.URI): sourcegraph.URI {
    return sourcegraph.URI.parse(
        uri
            .toString()
            .replace(
                'git://github.com/sgtest/python-sample-0?ad924954afa36439105efa03cce4c5981a2a5384#',
                'file:///tmp/python-sample-0/'
            )
    )
}

function unprepURI(uri: string | sourcegraph.URI): string {
    return (
        'git://github.com/sgtest/python-sample-0?ad924954afa36439105efa03cce4c5981a2a5384#' +
        uri.toString().replace('file:///tmp/python-sample-0/', '')
    )
}

function fromSubscribable<T>(sub: {
    subscribe(next: (value?: T) => void): sourcegraph.Unsubscribable
}): Observable<T> {
    return new Observable<T>(subscribable =>
        sub.subscribe(next => subscribable.next(next))
    )
}

export async function activate(): Promise<void> {
    const connectionManager = new LanguageServerConnectionManager(
        fromSubscribable(sourcegraph.workspace.onDidChangeRoots).pipe(
            startWith(void 0),
            map(() => sourcegraph.workspace.roots)
        ),
        async (rootURI: string, conn: rpc.MessageConnection) => {
            const prefix = `${rootURI}: `
            conn.onNotification(LogMessageNotification.type, params =>
                console.info(prefix + params.message)
            )
            conn.onNotification(rpc.LogTraceNotification.type, params =>
                console.debug(
                    prefix +
                        params.message +
                        (params.verbose ? `\n\n${params.verbose}` : '')
                )
            )
        },
        ADDR
    )

    // Watch configuration.
    //
    // The Python language server waits for the first workspace/didChangeConfiguration notification to start
    // pre-parsing files in the workspace.
    combineLatest(
        fromSubscribable<void>(sourcegraph.configuration),
        connectionManager.connections
    )
        .pipe(
            map(([, bbb]) => ({
                config: sourcegraph.configuration.get().value,
                connections: bbb,
            }))
        )
        .subscribe(({ config, connections }) => {
            for (const conn of connections) {
                conn.then(conn =>
                    conn.sendNotification(
                        DidChangeConfigurationNotification.type,
                        {
                            // Settings must contain "python" property, or else files won't be pre-parsed.
                            settings:
                                config && config.python
                                    ? config.python
                                    : { python: {} },
                        } as DidChangeConfigurationParams
                    )
                ).catch(err => console.error(err))
            }
        })

    /** Gets the workspace root that contains the given URI. */
    function getWorkspaceRoot(uri: string): string | undefined {
        const root = sourcegraph.workspace.roots.find(root =>
            uri.startsWith(root.uri.toString())
        )
        return root ? root.uri.toString() : undefined
    }

    async function getConnectionForDocument(
        doc: sourcegraph.TextDocument
    ): Promise<rpc.MessageConnection> {
        const rootURI = getWorkspaceRoot(doc.uri) || null
        return connectionManager.get(rootURI)
    }

    sourcegraph.workspace.onDidOpenTextDocument.subscribe(async doc => {
        const conn = await getConnectionForDocument(doc)
        conn.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
                uri: prepURI(doc.uri).toString(),
                languageId: doc.languageId,
                text: doc.text,
                version: 2,
            },
        } as DidOpenTextDocumentParams)
    })

    sourcegraph.languages.registerHoverProvider(['python'], {
        provideHover: async (doc, pos) => {
            const conn = await getConnectionForDocument(doc)
            const response = await conn.sendRequest(HoverRequest.type, {
                textDocument: {
                    uri: prepURI(doc.uri).toString(),
                },
                position: {
                    line: pos.line,
                    character: pos.character,
                },
            })

            return response
                ? ({ contents: response.contents } as sourcegraph.Hover)
                : null
        },
    })

    sourcegraph.languages.registerDefinitionProvider(['python'], {
        provideDefinition: async (doc, pos) => {
            const conn = await getConnectionForDocument(doc)
            const response = await conn.sendRequest(DefinitionRequest.type, {
                textDocument: {
                    uri: prepURI(doc.uri).toString(),
                },
                position: {
                    line: pos.line,
                    character: pos.character,
                },
            } as TextDocumentPositionParams)
            return response
                ? Array.isArray(response)
                    ? response.map(loc => ({
                          uri: sourcegraph.URI.parse(unprepURI(loc.uri)),
                          range: new sourcegraph.Range(
                              loc.range.start.line,
                              loc.range.start.character,
                              loc.range.end.line,
                              loc.range.end.character
                          ),
                      }))
                    : null
                : null
        },
    })

    sourcegraph.languages.registerReferenceProvider(['python'], {
        provideReferences: async (doc, pos, context) => {
            const conn = await getConnectionForDocument(doc)
            const response = await conn.sendRequest(ReferencesRequest.type, {
                textDocument: {
                    uri: prepURI(doc.uri).toString(),
                },
                position: {
                    line: pos.line,
                    character: pos.character,
                },
                context,
            } as ReferenceParams)
            return response
                ? response.map(loc => ({
                      uri: sourcegraph.URI.parse(unprepURI(loc.uri)),
                      range: new sourcegraph.Range(
                          loc.range.start.line,
                          loc.range.start.character,
                          loc.range.end.line,
                          loc.range.end.character
                      ),
                  }))
                : null
        },
    })
}
