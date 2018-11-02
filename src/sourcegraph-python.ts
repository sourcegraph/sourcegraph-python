// tslint:disable-next-line:rxjs-no-wholesale
import { from } from 'rxjs'
import { map, startWith } from 'rxjs/operators'
import * as sourcegraph from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import {
    DefinitionRequest,
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
    // return new sourcegraph.URI(uri.toString())
    return new sourcegraph.URI(
        uri
            .toString()
            .replace('?', '/')
            .replace('#', '/')
    )
}

function unprepURI(uri: string | sourcegraph.URI): string {
    return uri
        .toString()
        .replace('b6f5/', 'b6f5#')
        .replace('/fd3759', '?fd3759')
        .replace('b09b/', 'b09b#')
        .replace('/7e71', '?7e71')
}

export async function activate(): Promise<void> {
    const conns = new LanguageServerConnectionManager(
        from(
            sourcegraph.workspace.onDidChangeRoots as any /* TODO!(sqs) */
        ).pipe(
            startWith(void 0),
            map(() => sourcegraph.workspace.roots)
        ),
        sendFiles,
        ADDR
    )

    async function sendFiles(
        rootURI: string,
        conn: rpc.MessageConnection
    ): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const uris = await listFilesRecursively(
            sourcegraph.workspace.fileSystem,
            new sourcegraph.URI(rootURI)
        )
        for (const uri of uris) {
            if (
                uri.toString().endsWith('.py') &&
                !uri.toString().endsWith('setup.py')
            ) {
                const contents = await sourcegraph.workspace.fileSystem.readFile(
                    uri
                )
                conn.sendNotification(DidOpenTextDocumentNotification.type, {
                    textDocument: {
                        uri: prepURI(uri).toString(),
                        languageId: 'python',
                        text: new TextDecoder('utf-8').decode(contents),
                        version: 0,
                    },
                } as DidOpenTextDocumentParams)
                await new Promise(resolve => setTimeout(resolve, 300))
            }
        }
    }

    sourcegraph.workspace.onDidOpenTextDocument.subscribe(async doc => {
        const conn = await conns.getConnection(new sourcegraph.URI(doc.uri))
        conn.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
                uri: prepURI(doc.uri).toString(),
                languageId: doc.languageId,
                text: doc.text,
                version: 0,
            },
        } as DidOpenTextDocumentParams)
    })

    sourcegraph.languages.registerHoverProvider(['python'], {
        provideHover: async (doc, pos) => {
            const conn = await conns.getConnection(new sourcegraph.URI(doc.uri))
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
            const conn = await conns.getConnection(new sourcegraph.URI(doc.uri))
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
                          uri: new sourcegraph.URI(unprepURI(loc.uri)),
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
            const conn = await conns.getConnection(new sourcegraph.URI(doc.uri))
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
                      uri: new sourcegraph.URI(unprepURI(loc.uri)),
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

async function listFilesRecursively(
    fs: sourcegraph.FileSystem,
    rootURI: sourcegraph.URI
): Promise<sourcegraph.URI[]> {
    const files: sourcegraph.URI[] = []
    const toRecurse: sourcegraph.URI[] = [new sourcegraph.URI(`${rootURI}#`)]
    while (toRecurse.length > 0) {
        const dir = toRecurse.shift()!
        const entries = await fs.readDirectory(dir)
        for (const [name, type] of entries) {
            const uri = new sourcegraph.URI(
                `${dir.toString()}${
                    dir.toString().endsWith('#') ? '' : '/'
                }${name}`
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
