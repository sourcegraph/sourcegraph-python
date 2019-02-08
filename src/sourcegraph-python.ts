import { activateBasicCodeIntel } from '@sourcegraph/basic-code-intel'
// tslint:disable-next-line:rxjs-no-wholesale
import { combineLatest, concat, from, Observable, of, Subject } from 'rxjs'
import { map, startWith, tap } from 'rxjs/operators'
import * as sourcegraph from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import {
    DefinitionRequest,
    DidChangeConfigurationNotification,
    DidChangeConfigurationParams,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    ExecuteCommandParams,
    ExecuteCommandRequest,
    HoverRequest,
    LogMessageNotification,
    ReferenceParams,
    ReferencesRequest,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { getOrTryToCreateAccessToken } from './access-token'
import { createUriConverter, UriConverter } from './converters'
import { LanguageServerConnectionManager } from './lsp'

function fromSubscribable<T>(sub: {
    subscribe(next: (value?: T) => void): sourcegraph.Unsubscribable
}): Observable<T> {
    return new Observable<T>(subscribable =>
        sub.subscribe(next => subscribable.next(next))
    )
}

// No-op for Sourcegraph versions prior to 3.0-preview
const DUMMY_CTX = { subscriptions: { add: (_unsubscribable: any) => void 0 } }

export function activate(ctx: sourcegraph.ExtensionContext = DUMMY_CTX): void {
    const languageServerUrl = sourcegraph.configuration.get<Settings>().value[
        'python.serverUrl'
    ]
    if (!languageServerUrl) {
        if (sourcegraph.app.activeWindow) {
            const docURL = `${sourcegraph.internal.sourcegraphURL
                .toString()
                .replace(/\/$/, '')}/extensions/sourcegraph/python`
            console.log(
                'Configure `python.serverUrl` in user settings for more accurate Python code intelligence.',
                docURL
            )
        }
        return activateBasicCodeIntel({
            fileExts: ['py'],
            definitionPatterns: ['\\b%s\\b='],
            commentStyle: {
                docPlacement: 'below the definition',
                lineRegex: /#\s*(.*)/,
                block: {
                    startRegex: /"""/,
                    contentRegex: /^\s*(.*)/,
                    endRegex: /"""/,
                },
            },
        })(ctx)
    }

    const connectionManager = new LanguageServerConnectionManager(
        from(sourcegraph.workspace.onDidChangeRoots).pipe(
            // Only startWith a root if there are roots. Otherwise, there is no need to start, because when a root
            // is present, the observable will emit.
            sourcegraph.workspace.roots.length > 0 ? startWith(void 0) : tap(),
            map(() => sourcegraph.workspace.roots)
        ),
        async (originalRootUriStr, _actualRootUri, conn) => {
            if (originalRootUriStr) {
                const originalRootUri = new URL(originalRootUriStr)
                const repo = `${originalRootUri.host}${
                    originalRootUri.pathname
                }`.replace(/^\/\//, '')
                const rev = originalRootUri.search.slice(1) // remove leading '?'

                const settings = sourcegraph.configuration.get<Settings>().value
                const zipUrl = new URL(
                    settings['python.sourcegraphUrl'] ||
                        sourcegraph.internal.sourcegraphURL.toString()
                )
                const accessToken = await getOrTryToCreateAccessToken()
                if (accessToken) {
                    zipUrl.username = accessToken
                }
                zipUrl.pathname = `/${repo}@${rev}/-/raw`

                await conn.sendRequest(ExecuteCommandRequest.type, {
                    command: 'workspace/extractArchive',
                    arguments: [zipUrl.toString(), false],
                } as ExecuteCommandParams)
            }
            const prefix = `${originalRootUriStr || '(no root)'}: `
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
        languageServerUrl
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
            map(([, connections]) => ({
                config: sourcegraph.configuration.get().value,
                connections,
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
    ): Promise<{
        uriConverter: UriConverter
        connection: rpc.MessageConnection
    }> {
        const rootUri = getWorkspaceRoot(doc.uri) || null
        if (!rootUri) {
            throw new Error('root uri is not ready yet')
        }
        return connectionManager
            .get(rootUri)
            .then(({ actualRootUri, connection }) => ({
                uriConverter: createUriConverter(rootUri, actualRootUri),
                connection,
            }))
    }

    concat(
        ...sourcegraph.workspace.textDocuments.map(doc => of(doc)),
        from(sourcegraph.workspace.onDidOpenTextDocument)
    ).subscribe(async doc => {
        if (sourcegraph.workspace.roots.length === 0) {
            return
        }
        const { uriConverter, connection } = await getConnectionForDocument(doc)
        connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
                uri: uriConverter.toLanguageServer(doc.uri),
                languageId: doc.languageId,
                text: doc.text,
                version: 2,
            },
        } as DidOpenTextDocumentParams)
    })

    sourcegraph.languages.registerHoverProvider(['python'], {
        provideHover: async (doc, pos) => {
            const { uriConverter, connection } = await getConnectionForDocument(
                doc
            )
            const response = await connection.sendRequest(HoverRequest.type, {
                textDocument: {
                    uri: uriConverter.toLanguageServer(doc.uri),
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
            const { uriConverter, connection } = await getConnectionForDocument(
                doc
            )
            const response = await connection.sendRequest(
                DefinitionRequest.type,
                {
                    textDocument: {
                        uri: uriConverter.toLanguageServer(doc.uri),
                    },
                    position: {
                        line: pos.line,
                        character: pos.character,
                    },
                } as TextDocumentPositionParams
            )
            return response
                ? Array.isArray(response)
                    ? response.map(loc => ({
                          uri: new sourcegraph.URI(
                              uriConverter.toClient(loc.uri)
                          ),
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
            const { uriConverter, connection } = await getConnectionForDocument(
                doc
            )
            const response = await connection.sendRequest(
                ReferencesRequest.type,
                {
                    textDocument: {
                        uri: uriConverter.toLanguageServer(doc.uri),
                    },
                    position: {
                        line: pos.line,
                        character: pos.character,
                    },
                    context,
                } as ReferenceParams
            )
            return response
                ? response.map(loc => ({
                      uri: new sourcegraph.URI(uriConverter.toClient(loc.uri)),
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
