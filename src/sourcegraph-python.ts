import * as sourcegraph from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import {
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    HoverRequest,
    InitializedNotification,
    InitializeParams,
    InitializeRequest,
    MarkupKind,
} from 'vscode-languageserver-protocol'
import { createWebSocketMessageTransports } from './websocket'

async function connectTo2(address: string): Promise<rpc.MessageConnection> {
    const { reader, writer } = await createWebSocketMessageTransports(
        new WebSocket(address)
    )
    return rpc.createMessageConnection(reader, writer)
}

export async function activate(): Promise<void> {
    const conn = await connectTo2('ws://localhost:4288')
    conn.listen()

    const rootURI = `file:///home/sqs/src/${
        sourcegraph.workspace.textDocuments[0]
            ? new URL(
                  sourcegraph.workspace.textDocuments[0].uri
              ).pathname.slice(2)
            : 'github.com/sgtest/python-single-package-user'
    }`

    await conn.sendRequest(InitializeRequest.type, {
        processId: null as any,
        documentSelector: [{ language: 'python', scheme: 'file' }],
        rootUri: rootURI,
        workspaceFolders: [
            {
                name: 'python-sample-0',
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
                        '/home/sqs/src/github.com/Microsoft/vscode-python/languageServer.0.1.48',
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

    const toURI = (doc: sourcegraph.TextDocument) => {
        const docuri = new URL(doc.uri)

        // TODO pass a Zip URL instead of hard-coding the path on disk
        const fetchuri = `file:///home/sqs/src/${docuri.pathname.slice(
            2
        )}/${docuri.hash.slice(1)}`
        return fetchuri
    }

    for (const doc of sourcegraph.workspace.textDocuments) {
        conn.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
                uri: toURI(doc),
                languageId: doc.languageId,
                text: doc.text,
                version: 0,
            },
        } as DidOpenTextDocumentParams)
    }
    sourcegraph.workspace.onDidOpenTextDocument.subscribe(doc => {
        conn.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
                uri: toURI(doc),
                languageId: doc.languageId,
                text: doc.text,
                version: 0,
            },
        } as DidOpenTextDocumentParams)
    })

    sourcegraph.languages.registerHoverProvider(['python'], {
        provideHover: async (doc, pos) => {
            const response = await conn.sendRequest(HoverRequest.type, {
                textDocument: {
                    uri: toURI(doc),
                },
                position: {
                    line: pos.line,
                    character: pos.character,
                },
            })

            console.log('XXX', await conn.sendRequest())

            if (!response) {
                return {
                    contents: {
                        value: '```go\n' + 'NO RESPONSE' + '\n```',
                        kind: sourcegraph.MarkupKind.Markdown,
                    },
                }
            }

            return {
                contents: response.contents,
                // contents: { value: '' },
                // __backcompatContents: response.contents,
            } as sourcegraph.Hover
        },
    })
}
