import * as semver from 'semver'
import {
    CancellationToken,
    CancellationTokenSource,
    Disposable,
    InputBoxValidationSeverity,
    MessageItem,
    MessageOptions,
    QuickInput,
    QuickInputButton,
    QuickInputButtons,
    QuickPickItem,
    QuickPickItemKind,
    ThemeIcon,
    version,
    window,
} from 'vscode'
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
    LeanQuickInputButtonResult,
    LeanShowInputBoxResult,
    LeanShowMessageRequestResult,
    LeanShowQuickPickResult,
    LeanWindowClientCapabilities,
    quickInputButtonSchema,
    quickInputSchema,
    showInputBoxMethod,
    showInputBoxParamsSchema,
    showMessageRequestMethod,
    showMessageRequestParamsSchema,
    showQuickPickMethod,
    showQuickPickParamsSchema,
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

function toQuickInputButtons(buttons: z.output<typeof quickInputButtonSchema>[] | undefined): QuickInputButton[] {
    return (buttons ?? []).map(button => ({ iconPath: new ThemeIcon(button.icon), tooltip: button.tooltip }))
}

/**
 * Applies the fields that quick picks and input boxes share to `input`. Returns how to report a
 * press of one of its title-bar buttons.
 */
function setUpQuickInput(
    input: QuickInput & { buttons: readonly QuickInputButton[] },
    params: z.output<typeof quickInputSchema>,
): (button: QuickInputButton, value: string) => LeanQuickInputButtonResult {
    input.title = params.title
    input.step = params.step?.current
    input.totalSteps = params.step?.total
    input.ignoreFocusOut = params.ignoreFocusOut ?? false
    const buttons = toQuickInputButtons(params.buttons)
    input.buttons = params.backButton ? [QuickInputButtons.Back, ...buttons] : buttons
    return (button, value) =>
        button === QuickInputButtons.Back ? { back: { value } } : { button: { button: buttons.indexOf(button), value } }
}

/**
 * Shows `input` until it is hidden: by a call of the `respond` passed to `listen`, by the user, by
 * another quick input replacing it, or by cancellation of `token`. Resolves to the first result
 * passed to `respond`, or to `null` if there was none or `token` was cancelled.
 */
function showUntilHidden<Result>(
    input: QuickInput,
    token: CancellationToken,
    listen: (respond: (result: Result) => void) => Disposable[],
): Promise<Result | null> {
    return new Promise(resolve => {
        let result: Result | undefined
        const subscriptions: Disposable[] = [
            ...listen(r => {
                // The input stays interactive until the editor processes `hide`.
                if (result === undefined) {
                    result = r
                    input.hide()
                }
            }),
            token.onCancellationRequested(() => input.hide()),
            input.onDidHide(() => {
                for (const s of subscriptions) {
                    s.dispose()
                }
                input.dispose()
                resolve(token.isCancellationRequested ? null : (result ?? null))
            }),
        ]
        input.show()
    })
}

/** VS Code shows `QuickPickItem.iconPath` since 1.81; earlier versions only render icons in labels. */
const quickPickItemIconPathSupported = semver.gte(version, '1.81.0')

function quickPickItemLabelAndIcon(label: string, icon: string | undefined): Pick<QuickPickItem, 'label' | 'iconPath'> {
    if (icon === undefined) {
        return { label }
    }
    return quickPickItemIconPathSupported ? { label, iconPath: new ThemeIcon(icon) } : { label: `$(${icon}) ${label}` }
}

interface IndexedQuickPickItem extends QuickPickItem {
    /** Index into the `items` of the request. */
    index: number
}

const showQuickPick = serverDialog(
    showQuickPickMethod,
    showQuickPickParamsSchema,
    async (_, params, token): Promise<LeanShowQuickPickResult> => {
        const pick = window.createQuickPick<IndexedQuickPickItem>()
        const reportButton = setUpQuickInput(pick, params)
        const itemButtons = params.items.map(item => toQuickInputButtons(item.buttons))
        const items = params.items.map(
            (item, index): IndexedQuickPickItem => ({
                index,
                ...quickPickItemLabelAndIcon(item.label, item.icon),
                kind: item.kind === 'separator' ? QuickPickItemKind.Separator : QuickPickItemKind.Default,
                description: item.description,
                detail: item.detail,
                alwaysShow: item.alwaysShow,
                buttons: itemButtons[index],
            }),
        )
        pick.items = items
        pick.placeholder = params.placeholder
        pick.canSelectMany = params.canPickMany ?? false
        pick.matchOnDescription = params.matchOnDescription ?? false
        pick.matchOnDetail = params.matchOnDetail ?? false
        pick.value = params.value ?? ''
        if (pick.canSelectMany) {
            pick.selectedItems = items.filter(
                item => item.kind !== QuickPickItemKind.Separator && params.items[item.index].picked,
            )
        }
        const active = params.activeItem !== undefined ? items[params.activeItem] : undefined
        if (active !== undefined && active.kind !== QuickPickItemKind.Separator) {
            pick.activeItems = [active]
        }
        return await showUntilHidden(pick, token, respond => [
            pick.onDidAccept(() =>
                respond({
                    accepted: {
                        selected: pick.selectedItems.map(item => item.index).sort((a, b) => a - b),
                        value: pick.value,
                    },
                }),
            ),
            pick.onDidTriggerButton(button => respond(reportButton(button, pick.value))),
            pick.onDidTriggerItemButton(({ item, button }) =>
                respond({
                    itemButton: {
                        item: item.index,
                        button: itemButtons[item.index].indexOf(button),
                        value: pick.value,
                    },
                }),
            ),
        ])
    },
)

const validationSeverities = {
    info: InputBoxValidationSeverity.Info,
    warning: InputBoxValidationSeverity.Warning,
    error: InputBoxValidationSeverity.Error,
}

const showInputBox = serverDialog(
    showInputBoxMethod,
    showInputBoxParamsSchema,
    async (_, params, token): Promise<LeanShowInputBoxResult> => {
        const box = window.createInputBox()
        const reportButton = setUpQuickInput(box, params)
        box.value = params.value ?? ''
        box.valueSelection = params.valueSelection
        box.placeholder = params.placeholder
        box.prompt = params.prompt
        box.password = params.password ?? false
        const validation = params.validationMessage
        if (validation !== undefined) {
            box.validationMessage = { message: validation.message, severity: validationSeverities[validation.severity] }
        }
        // Unlike `window.showInputBox`, an input box does not itself refuse to accept on an error.
        let rejected = validation?.severity === 'error'
        return await showUntilHidden(box, token, respond => [
            box.onDidAccept(() => {
                if (!rejected) {
                    respond({ accepted: { value: box.value } })
                }
            }),
            box.onDidTriggerButton(button => respond(reportButton(button, box.value))),
            // The message explains why the initial value was rejected, so it is stale once edited.
            box.onDidChangeValue(() => {
                box.validationMessage = undefined
                rejected = false
            }),
        ])
    },
)

const serverDialogs = {
    showMessageRequest,
    showQuickPick,
    showInputBox,
} satisfies Record<keyof LeanWindowClientCapabilities, ServerDialog>

/** Advertises exactly the requests that `registerServerDialogs` handles. */
export const leanWindowClientCapabilities: LeanWindowClientCapabilities = Object.fromEntries(
    Object.keys(serverDialogs).map(name => [name, {}]),
)

/** Lets the server behind `client` show the dialogs of `./protocol`. */
export function registerServerDialogs(client: LanguageClient): Disposable {
    return Disposable.from(...Object.values(serverDialogs).map(dialog => dialog.register(client)))
}
