import { TextDocument, Position, TextEditor, EventEmitter, Uri, Diagnostic } from 'vscode'
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions
} from 'vscode-languageclient/node'
import { executablePath, serverLoggingEnabled, serverLoggingPath } from './config'
import { assert } from './utils/assert'

export interface PlainGoal {
    rendered: string;
    // since 2021-03-10
    goals?: string[];
}

export class LeanClient {
    client: LanguageClient

    private restartedEmitter = new EventEmitter()
    restarted = this.restartedEmitter.event

    private diagnosticsEmitter = new EventEmitter<{uri: Uri, diagnostics: Diagnostic[]}>()
    diagnostics = this.diagnosticsEmitter.event

    async restart(): Promise<void> {
        if (this.isStarted()) {
            await this.stop()
        }
        const serverOptions: ServerOptions = {
            command: executablePath(),
            args: ['--server'],
            options: {
                shell: true,
                env: { ...process.env }
            }
        }
        if (serverLoggingEnabled()) {
            serverOptions.options.env.LEAN_SERVER_LOG_DIR = serverLoggingPath()
        }
        const clientOptions: LanguageClientOptions = {
            documentSelector: [{ scheme: 'file', language: 'lean4' }],
            middleware: {
                handleDiagnostics: (uri, diagnostics, next) => {
                    next(uri, diagnostics);
                    this.diagnosticsEmitter.fire({uri, diagnostics})
                },
            },
        }
        this.client = new LanguageClient(
            'lean4',
            'Lean 4',
            serverOptions,
            clientOptions
        )
        this.client.start()
        this.restartedEmitter.fire(undefined)
    }

    start(): Promise<void> {
        return this.restart()
    }

    isStarted(): boolean {
        return this.client !== undefined
    }

    async stop(): Promise<void> {
        assert(() => this.isStarted())
        await this.client.stop()
        this.client = undefined
    }

    refreshFileDependencies(editor: TextEditor): void {
        assert(() => this.isStarted())
        const doc = editor.document
        const uri = doc.uri.toString()
        // This causes a text document version number discontinuity. In
        // (didChange (oldVersion) => refreshFileDependencies => didChange (newVersion))
        // the client emits newVersion = oldVersion + 1, despite the fact that the
        // didOpen packet emitted below initializes the version number to be 1.
        // This is not a problem though, since both client and server are fine
        // as long as the version numbers are monotonous.
        this.client.sendNotification('textDocument/didClose', {
            'textDocument': {
                uri
            }
        })
        this.client.sendNotification('textDocument/didOpen', {
            'textDocument': {
                uri,
                'languageId': 'lean4',
                'version': 1,
                'text': doc.getText()
            }
        })
    }

    requestPlainGoals(doc: TextDocument, position: Position): Promise<PlainGoal> {
        assert(() => this.isStarted())
        return this.client.sendRequest(
            '$/lean/plainGoal',
            this.client.code2ProtocolConverter.asTextDocumentPositionParams(doc, position))
    }
}