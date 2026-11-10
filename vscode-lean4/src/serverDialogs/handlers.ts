import { CancellationToken, CancellationTokenSource, Disposable, MessageItem, MessageOptions, window } from 'vscode'
import {
    ErrorCodes,
    LanguageClient,
    MessageType,
    RequestType,
    ResponseError,
    CancellationToken as RpcCancellationToken,
    State,
} from 'vscode-languageclient/node'
import { z } from 'zod'
import {
    LeanShowMessageRequestResult,
    LeanWindowClientCapabilities,
    showMessageRequestMethod,
    showMessageRequestParamsSchema,
} from './protocol'

/** The client side of one request from `./protocol`. */
interface ServerDialog {
    register(client: LanguageClient): Disposable
}

/**
 * Handles `method` by validating its parameters and passing them to `show`, with a token that is
 * cancelled when the server cancels the request or the client stops.
 */
function serverDialog<Params>(
    method: string,
    paramsSchema: z.ZodType<Params, z.ZodTypeDef, unknown>,
    show: (client: LanguageClient, params: Params, token: CancellationToken) => Promise<unknown>,
): ServerDialog {
    const type = new RequestType<unknown, unknown, void>(method)
    return {
        register: client =>
            client.onRequest(type, async (rawParams: unknown, token: unknown) => {
                // vscode-jsonrpc passes only the token when a request has no parameters.
                if (!RpcCancellationToken.is(token)) {
                    return new ResponseError(ErrorCodes.InvalidParams, `Missing parameters for '${method}'`)
                }
                const params = paramsSchema.safeParse(rawParams)
                if (!params.success) {
                    return new ResponseError(
                        ErrorCodes.InvalidParams,
                        `Invalid parameters for '${method}': ${params.error.message}`,
                    )
                }
                if (token.isCancellationRequested) {
                    return null
                }
                const cancellation = new CancellationTokenSource()
                const subscriptions = [
                    token.onCancellationRequested(() => cancellation.cancel()),
                    client.onDidChangeState(({ newState }) => {
                        if (newState === State.Stopped) {
                            cancellation.cancel()
                        }
                    }),
                ]
                try {
                    return await show(client, params.data, cancellation.token)
                } finally {
                    for (const s of subscriptions) {
                        s.dispose()
                    }
                    cancellation.dispose()
                }
            }),
    }
}

function showMessage<T extends MessageItem>(
    type: number,
    message: string,
    options: MessageOptions,
    items: T[],
): Thenable<T | undefined> {
    switch (type) {
        case MessageType.Error:
            return window.showErrorMessage(message, options, ...items)
        case MessageType.Warning:
            return window.showWarningMessage(message, options, ...items)
        default:
            return window.showInformationMessage(message, options, ...items)
    }
}

const showMessageRequest = serverDialog(
    showMessageRequestMethod,
    showMessageRequestParamsSchema,
    async (_, params): Promise<LeanShowMessageRequestResult> => {
        const options: MessageOptions = { modal: params.modal ?? false, detail: params.detail }
        const chosen = await showMessage(params.type, params.message, options, params.actions ?? [])
        return chosen ?? null
    },
)

const serverDialogs = {
    showMessageRequest,
} satisfies Record<keyof LeanWindowClientCapabilities, ServerDialog>

/** Advertises exactly the requests that `registerServerDialogs` handles. */
export const leanWindowClientCapabilities: LeanWindowClientCapabilities = Object.fromEntries(
    Object.keys(serverDialogs).map(name => [name, {}]),
)

/** Lets the server behind `client` show the dialogs of `./protocol`. */
export function registerServerDialogs(client: LanguageClient): Disposable {
    return Disposable.from(...Object.values(serverDialogs).map(dialog => dialog.register(client)))
}
