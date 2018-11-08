// tslint:disable-next-line:rxjs-no-wholesale
import { combineLatest, from, Observable } from 'rxjs'
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
    return sourcegraph.URI.parse(
        uri
            .toString()
            .replace('?', '/')
            .replace('#', '/')
    )
}

function unprepURI(uri: string | sourcegraph.URI): string {
    return (
        'git://github.com/sgtest/python-sample-0?ad924954afa36439105efa03cce4c5981a2a5384#' +
        uri.toString().replace('file:///tmp/python-sample-0/', '')
    )
    return uri
        .toString()
        .replace('b6f5/', 'b6f5#')
        .replace('/fd3759', '?fd3759')
        .replace('b09b/', 'b09b#')
        .replace('/7e71', '?7e71')
        .replace('a5384/', 'a5384#')
        .replace('/ad924', '?ad924')
}

function fromSubscribable<T>(sub: {
    subscribe(next: (value?: T) => void): sourcegraph.Unsubscribable
}): Observable<T> {
    return new Observable<T>(subscribable =>
        sub.subscribe(next => subscribable.next(next))
    )
}

export async function activate(): Promise<void> {
    const conns = new LanguageServerConnectionManager(
        from(
            sourcegraph.workspace.onDidChangeRoots as any /* TODO!(sqs) */
        ).pipe(
            startWith(void 0),
            map(() => sourcegraph.workspace.roots)
        ),
        async (rootURI: string, conn: rpc.MessageConnection) => {
            // await sendFiles()
        },
        ADDR
    )

    combineLatest(
        fromSubscribable(sourcegraph.configuration),
        conns.connections
    )
        .pipe(startWith(void 0))
        .subscribe(() => {
            console.log('XXX')
            for (const conn of conns.getAll()) {
                conn.then(conn =>
                    conn.sendNotification(
                        DidChangeConfigurationNotification.type,
                        {
                            settings: { python: { logLevel: 'Trace' } },
                        } as DidChangeConfigurationParams
                    )
                ).catch(err => console.error(err))
            }
        })

    async function sendFiles(
        rootURI: string,
        conn: rpc.MessageConnection
    ): Promise<void> {
        return
        const uris = await listFilesRecursively(
            sourcegraph.workspace.fileSystem,
            sourcegraph.URI.parse(unprepURI(rootURI))
        )
        uris.sort()
        for (const uri of uris) {
            if (uri.toString().includes('.py')) {
                const contents = await sourcegraph.workspace.fileSystem.readFile(
                    uri
                )
                conn.sendNotification(DidOpenTextDocumentNotification.type, {
                    textDocument: {
                        uri: prepURI(uri).toString(),
                        languageId: 'python',
                        text: new TextDecoder('utf-8').decode(contents),
                        version: 1,
                    },
                } as DidOpenTextDocumentParams)
                await new Promise(resolve => setTimeout(resolve, 300))
            }
        }
    }

    sourcegraph.workspace.onDidOpenTextDocument.subscribe(async doc => {
        const conn = await conns.getConnection(sourcegraph.URI.parse(doc.uri))
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
            const conn = await conns.getConnection(
                sourcegraph.URI.parse(doc.uri)
            )
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

    if (false) {
        sourcegraph.languages.registerDefinitionProvider(['python'], {
            provideDefinition: async (doc, pos) => {
                const conn = await conns.getConnection(
                    sourcegraph.URI.parse(doc.uri)
                )
                const response = await conn.sendRequest(
                    DefinitionRequest.type,
                    {
                        textDocument: {
                            uri: prepURI(doc.uri).toString(),
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
                const conn = await conns.getConnection(
                    sourcegraph.URI.parse(doc.uri)
                )
                const response = await conn.sendRequest(
                    ReferencesRequest.type,
                    {
                        textDocument: {
                            uri: prepURI(doc.uri).toString(),
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
}

async function listFilesRecursively(
    fs: sourcegraph.FileSystem,
    rootURI: sourcegraph.URI
): Promise<sourcegraph.URI[]> {
    const files: sourcegraph.URI[] = []
    const toRecurse: sourcegraph.URI[] = [sourcegraph.URI.parse(`${rootURI}#`)]
    while (toRecurse.length > 0) {
        const dir = toRecurse.shift()!
        const entries = await fs.readDirectory(dir)
        for (const [name, type] of entries) {
            const uri = sourcegraph.URI.parse(
                `${dir.toString()}${dir.fragment === '' ? '#' : '/'}${name}`
            )
            switch (type) {
                case sourcegraph.FileType.File:
                    files.push(uri)
                    break
                case sourcegraph.FileType.Directory:
                    toRecurse.push(uri)
                    break
                default:
                // TODO(sqs): skip symlinks and unknown
            }
        }
    }
    return files
}
