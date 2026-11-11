import * as semver from 'semver'
import {
    CancellationToken,
    CancellationTokenSource,
    Disposable,
    InputBox,
    InputBoxValidationSeverity,
    MessageOptions,
    QuickInput,
    QuickInputButton,
    QuickInputButtons,
    QuickPick,
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
import { displayNotificationWithItems, NotificationSeverity } from '../utils/notifs'
import {
    createInputBoxMethod,
    createInputBoxParamsSchema,
    createQuickPickMethod,
    createQuickPickParamsSchema,
    fileFiltersSchema,
    hideQuickInputMethod,
    hideQuickInputParamsSchema,
    LeanLiveQuickInputEvent,
    LeanQuickInputButtonResult,
    LeanShowInputBoxResult,
    LeanShowMessageRequestResult,
    LeanShowOpenDialogResult,
    LeanShowQuickPickResult,
    LeanShowSaveDialogResult,
    LeanUpdateQuickInputResult,
    LeanWindowClientCapabilities,
    liveQuickInputSchema,
    quickInputButtonSchema,
    quickInputSchema,
    showInputBoxMethod,
    showInputBoxParamsSchema,
    showMessageRequestMethod,
    showMessageRequestParamsSchema,
    showOpenDialogMethod,
    showOpenDialogParamsSchema,
    showQuickPickMethod,
    showQuickPickParamsSchema,
    showSaveDialogMethod,
    showSaveDialogParamsSchema,
    updateInputBoxMethod,
    updateInputBoxParamsSchema,
    updateQuickPickMethod,
    updateQuickPickParamsSchema,
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

function notificationSeverity(type: number): NotificationSeverity {
    switch (type) {
        case MessageType.Error:
            return 'Error'
        case MessageType.Warning:
            return 'Warning'
        default:
            return 'Information'
    }
}

const showMessageRequest = serverDialog(
    showMessageRequestMethod,
    showMessageRequestParamsSchema,
    async (_, params): Promise<LeanShowMessageRequestResult> => {
        const options: MessageOptions = { modal: params.modal ?? false, detail: params.detail }
        const chosen = await displayNotificationWithItems(
            notificationSeverity(params.type),
            params.message,
            options,
            params.actions ?? [],
        )
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

/** VS Code shows `QuickPickItem.iconPath` since 1.81; earlier versions only render icons in labels. */
const quickPickItemIconPathSupported = semver.gte(version, '1.81.0')

function quickPickItemLabelAndIcon(label: string, icon: string | undefined): Pick<QuickPickItem, 'label' | 'iconPath'> {
    if (icon === undefined) {
        return { label }
    }
    return quickPickItemIconPathSupported ? { label, iconPath: new ThemeIcon(icon) } : { label: `$(${icon}) ${label}` }
}

/** VS Code shows `QuickPick.prompt` since 1.108. */
const quickPickPromptSupported = semver.gte(version, '1.108.0')

/** Shows `prompt` below the input field of `pick`, or, where VS Code can't, after `title`. */
function setQuickPickPrompt(pick: QuickPick<QuickPickItem>, title: string | undefined, prompt: string | undefined) {
    if (quickPickPromptSupported) {
        // Missing from the `@types/vscode` that this extension builds against.
        ;(pick as QuickPick<QuickPickItem> & { prompt: string | undefined }).prompt = prompt
    } else if (prompt !== undefined) {
        pick.title = title !== undefined ? `${title} — ${prompt}` : prompt
    }
}

interface IndexedQuickPickItem extends QuickPickItem {
    /** Index into the `items` of the request. */
    index: number
}

type QuickPickResult = NonNullable<LeanShowQuickPickResult>

/** How to report the events of a quick pick in terms of the parameters it shows. */
interface QuickPickReporter {
    accepted(): QuickPickResult
    button(button: QuickInputButton): QuickPickResult
    itemButton(item: IndexedQuickPickItem, button: QuickInputButton): QuickPickResult
}

/**
 * Shows `params` in `pick`. Sets the typed text to `params.value`; with `keepValue`, an absent
 * `params.value` leaves it alone.
 */
function setQuickPickParams(
    pick: QuickPick<IndexedQuickPickItem>,
    params: z.output<typeof showQuickPickParamsSchema>,
    keepValue: boolean,
): QuickPickReporter {
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
    setQuickPickPrompt(pick, params.title, params.prompt)
    pick.canSelectMany = params.canPickMany ?? false
    pick.matchOnDescription = params.matchOnDescription ?? false
    pick.matchOnDetail = params.matchOnDetail ?? false
    if (params.value !== undefined || !keepValue) {
        pick.value = params.value ?? ''
    }
    if (pick.canSelectMany) {
        pick.selectedItems = items.filter(
            item => item.kind !== QuickPickItemKind.Separator && params.items[item.index].picked,
        )
    }
    const active = params.activeItem !== undefined ? items[params.activeItem] : undefined
    if (active !== undefined && active.kind !== QuickPickItemKind.Separator) {
        pick.activeItems = [active]
    }
    return {
        accepted: () => ({
            accepted: {
                selected: pick.selectedItems.map(item => item.index).sort((a, b) => a - b),
                value: pick.value,
            },
        }),
        button: button => reportButton(button, pick.value),
        itemButton: (item, button) => ({
            itemButton: { item: item.index, button: itemButtons[item.index].indexOf(button), value: pick.value },
        }),
    }
}

const validationSeverities = {
    info: InputBoxValidationSeverity.Info,
    warning: InputBoxValidationSeverity.Warning,
    error: InputBoxValidationSeverity.Error,
}

type InputBoxResult = NonNullable<LeanShowInputBoxResult>

/**
 * Shows `params` in `box`, treating `keepValue` as `setQuickPickParams` does. Returns how to report a
 * press of one of its title-bar buttons.
 */
function setInputBoxParams(
    box: InputBox,
    params: z.output<typeof showInputBoxParamsSchema>,
    keepValue: boolean,
): (button: QuickInputButton) => InputBoxResult {
    const reportButton = setUpQuickInput(box, params)
    if (params.value !== undefined || !keepValue) {
        box.value = params.value ?? ''
        // Selecting all of an updated text would make the next keystroke replace it.
        box.valueSelection = params.valueSelection ?? (keepValue ? [box.value.length, box.value.length] : undefined)
    }
    box.placeholder = params.placeholder
    box.prompt = params.prompt
    box.password = params.password ?? false
    const validation = params.validationMessage
    box.validationMessage =
        validation !== undefined
            ? { message: validation.message, severity: validationSeverities[validation.severity] }
            : undefined
    return button => reportButton(button, box.value)
}

function toFileFilters(
    filters: z.output<typeof fileFiltersSchema> | undefined,
): { [label: string]: string[] } | undefined {
    return filters !== undefined ? Object.fromEntries(filters.map(f => [f.label, f.extensions])) : undefined
}

const showOpenDialog = serverDialog(
    showOpenDialogMethod,
    showOpenDialogParamsSchema,
    async (client, params): Promise<LeanShowOpenDialogResult> => {
        const uris = await window.showOpenDialog({
            title: params.title,
            openLabel: params.openLabel,
            defaultUri:
                params.defaultUri !== undefined ? client.protocol2CodeConverter.asUri(params.defaultUri) : undefined,
            canSelectFiles: params.select !== 'folders',
            canSelectFolders: params.select !== 'files',
            canSelectMany: params.canSelectMany ?? false,
            filters: toFileFilters(params.filters),
        })
        return uris?.map(uri => client.code2ProtocolConverter.asUri(uri)) ?? null
    },
)

const showSaveDialog = serverDialog(
    showSaveDialogMethod,
    showSaveDialogParamsSchema,
    async (client, params): Promise<LeanShowSaveDialogResult> => {
        const uri = await window.showSaveDialog({
            title: params.title,
            saveLabel: params.saveLabel,
            defaultUri:
                params.defaultUri !== undefined ? client.protocol2CodeConverter.asUri(params.defaultUri) : undefined,
            filters: toFileFilters(params.filters),
        })
        return uri !== undefined ? client.code2ProtocolConverter.asUri(uri) : null
    },
)

type LiveParams = z.output<typeof liveQuickInputSchema>

/**
 * The client side of a live quick pick or input box session (see `createQuickPickMethod`). Queues the
 * events of `input` until the server asks for them.
 */
class LiveQuickInput<Params extends LiveParams & { value?: string }, Result> {
    private readonly queue: LeanLiveQuickInputEvent<Result>[] = []
    private waiter: ((event: LeanLiveQuickInputEvent<Result> | undefined) => void) | undefined
    private ended = false
    private reportValueChanges = false
    /**
     * The typed text as the server knows it. VS Code reports the client's own changes of `value` as
     * value changes too, asynchronously, so those echoes are recognised by their text.
     */
    private knownValue: string
    private readonly subscriptions: Disposable[]

    /**
     * Shows `input`, whose parameters other than `params`' live ones are already set. `apply` sets the
     * parameters of an update, and `listen` subscribes to the events other than value changes.
     */
    constructor(
        private readonly input: QuickInput & {
            readonly value: string
            onDidChangeValue(listener: (value: string) => unknown): Disposable
        },
        client: LanguageClient,
        params: Params,
        private readonly apply: (params: Params) => void,
        listen: (report: (result: Result) => void) => Disposable[],
        onEnd: () => void,
    ) {
        this.knownValue = input.value
        this.setLiveParams(params)
        this.subscriptions = [
            ...listen(result => this.report({ result })),
            input.onDidChangeValue(value => {
                if (this.reportValueChanges && value !== this.knownValue) {
                    this.knownValue = value
                    this.report({ valueChanged: { value } })
                }
            }),
            client.onDidChangeState(({ newState }) => {
                if (newState === State.Stopped) {
                    input.hide()
                }
            }),
            input.onDidHide(() => {
                this.ended = true
                this.queue.length = 0
                for (const s of this.subscriptions) {
                    s.dispose()
                }
                input.dispose()
                this.waiter?.(undefined)
                onEnd()
            }),
        ]
        input.show()
    }

    private setLiveParams(params: LiveParams) {
        this.reportValueChanges = params.reportValueChanges ?? false
        this.input.busy = params.busy ?? false
    }

    private report(event: LeanLiveQuickInputEvent<Result>) {
        const waiter = this.waiter
        if (waiter !== undefined) {
            this.waiter = undefined
            waiter(event)
            return
        }
        const last = this.queue[this.queue.length - 1]
        if (last !== undefined && 'valueChanged' in last && 'valueChanged' in event) {
            this.queue[this.queue.length - 1] = event
        } else {
            this.queue.push(event)
        }
    }

    /** Applies `update`, unless an event is already queued, and answers the next event. */
    async next(
        update: Params | undefined,
        token: CancellationToken,
    ): Promise<LeanUpdateQuickInputResult<LeanLiveQuickInputEvent<Result>> | ResponseError> {
        if (this.ended) {
            return null
        }
        if (this.waiter !== undefined) {
            return new ResponseError(ErrorCodes.InvalidRequest, 'Another update of this session is pending')
        }
        const queued = this.queue.shift()
        if (queued !== undefined) {
            return { applied: update === undefined, event: queued }
        }
        if (update !== undefined) {
            this.apply(update)
            this.setLiveParams(update)
            if (update.value !== undefined) {
                this.knownValue = update.value
            }
        }
        const cancellation = token.onCancellationRequested(() => this.input.hide())
        try {
            const event = await new Promise<LeanLiveQuickInputEvent<Result> | undefined>(
                resolve => (this.waiter = resolve),
            )
            return event !== undefined ? { applied: true, event } : null
        } finally {
            cancellation.dispose()
        }
    }

    hide() {
        if (!this.ended) {
            this.input.hide()
        }
    }
}

type QuickPickSession = LiveQuickInput<z.output<typeof createQuickPickParamsSchema>, QuickPickResult>
type InputBoxSession = LiveQuickInput<z.output<typeof createInputBoxParamsSchema>, InputBoxResult>

/** Shows `params` in a new quick pick, as a session. `onEnd` runs when it closes. */
function openQuickPick(
    client: LanguageClient,
    params: z.output<typeof createQuickPickParamsSchema>,
    onEnd: () => void = () => {},
): QuickPickSession {
    const pick = window.createQuickPick<IndexedQuickPickItem>()
    let report = setQuickPickParams(pick, params, false)
    return new LiveQuickInput(
        pick,
        client,
        params,
        update => (report = setQuickPickParams(pick, update, true)),
        emit => [
            pick.onDidAccept(() => emit(report.accepted())),
            pick.onDidTriggerButton(button => emit(report.button(button))),
            pick.onDidTriggerItemButton(({ item, button }) => emit(report.itemButton(item, button))),
        ],
        onEnd,
    )
}

/**
 * Shows `params` in a new input box, as a session. `onEnd` runs when it closes. With `oneShot`, an
 * initial `validationMessage` is shown until the user edits the text, and with severity `error` it
 * refuses accepting until then, as `window.showInputBox` does; otherwise the server decides.
 */
function openInputBox(
    client: LanguageClient,
    params: z.output<typeof createInputBoxParamsSchema>,
    oneShot: boolean,
    onEnd: () => void = () => {},
): InputBoxSession {
    const box = window.createInputBox()
    let reportButton = setInputBoxParams(box, params, false)
    // Unlike `window.showInputBox`, an input box does not itself refuse to accept on an error.
    let rejected = oneShot && params.validationMessage?.severity === 'error'
    return new LiveQuickInput(
        box,
        client,
        params,
        update => (reportButton = setInputBoxParams(box, update, true)),
        emit => [
            box.onDidAccept(() => {
                if (!rejected) {
                    emit({ accepted: { value: box.value } })
                }
            }),
            box.onDidTriggerButton(button => emit(reportButton(button))),
            // The message explains why the initial value was rejected, so it is stale once edited.
            ...(oneShot
                ? [
                      box.onDidChangeValue(() => {
                          box.validationMessage = undefined
                          rejected = false
                      }),
                  ]
                : []),
        ],
        onEnd,
    )
}

/** Answers a one-shot request: the session's first event, after which it closes. */
async function firstResult<Params extends LiveParams & { value?: string }, Result>(
    session: LiveQuickInput<Params, Result>,
    token: CancellationToken,
): Promise<Result | null> {
    const answer = await session.next(undefined, token)
    session.hide()
    // A one-shot session reports no value changes, and no other update can be pending.
    return answer !== null && !(answer instanceof ResponseError) && 'result' in answer.event
        ? answer.event.result
        : null
}

const showQuickPick = serverDialog(
    showQuickPickMethod,
    showQuickPickParamsSchema,
    async (client, params, token): Promise<LeanShowQuickPickResult> =>
        await firstResult(openQuickPick(client, params), token),
)

const showInputBox = serverDialog(
    showInputBoxMethod,
    showInputBoxParamsSchema,
    async (client, params, token): Promise<LeanShowInputBoxResult> =>
        await firstResult(openInputBox(client, params, true), token),
)

let nextSessionId = 0
const liveQuickPicks = new Map<number, QuickPickSession>()
const liveInputBoxes = new Map<number, InputBoxSession>()

const createQuickPick = serverDialog(
    createQuickPickMethod,
    createQuickPickParamsSchema,
    async (client, params): Promise<number> => {
        const id = nextSessionId++
        liveQuickPicks.set(
            id,
            openQuickPick(client, params, () => liveQuickPicks.delete(id)),
        )
        return id
    },
)

const updateQuickPick = serverDialog(updateQuickPickMethod, updateQuickPickParamsSchema, async (_, params, token) =>
    liveQuickPicks.has(params.session) ? liveQuickPicks.get(params.session)?.next(params.update, token) : null,
)

const createInputBox = serverDialog(
    createInputBoxMethod,
    createInputBoxParamsSchema,
    async (client, params): Promise<number> => {
        const id = nextSessionId++
        liveInputBoxes.set(
            id,
            openInputBox(client, params, false, () => liveInputBoxes.delete(id)),
        )
        return id
    },
)

const updateInputBox = serverDialog(updateInputBoxMethod, updateInputBoxParamsSchema, async (_, params, token) =>
    liveInputBoxes.has(params.session) ? liveInputBoxes.get(params.session)?.next(params.update, token) : null,
)

const hideQuickInput = serverDialog(hideQuickInputMethod, hideQuickInputParamsSchema, async (_, params) => {
    ;(liveQuickPicks.get(params.session) ?? liveInputBoxes.get(params.session))?.hide()
    return null
})

const serverDialogs = {
    showMessageRequest,
    showQuickPick,
    showInputBox,
    showOpenDialog,
    showSaveDialog,
    createQuickPick,
    updateQuickPick,
    createInputBox,
    updateInputBox,
    hideQuickInput,
} satisfies Record<keyof LeanWindowClientCapabilities, ServerDialog>

/** Advertises exactly the requests that `registerServerDialogs` handles. */
export const leanWindowClientCapabilities: LeanWindowClientCapabilities = Object.fromEntries(
    Object.keys(serverDialogs).map(name => [name, {}]),
)

/** Lets the server behind `client` show the dialogs of `./protocol`. */
export function registerServerDialogs(client: LanguageClient): Disposable {
    return Disposable.from(...Object.values(serverDialogs).map(dialog => dialog.register(client)))
}
