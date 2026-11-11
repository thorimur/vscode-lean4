import * as semver from 'semver'
import {
    CancellationToken,
    CancellationTokenSource,
    Disposable,
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
    RequestType,
    ResponseError,
    CancellationToken as RpcCancellationToken,
    State,
} from 'vscode-languageclient/node'
import { z } from 'zod'
import {
    createQuickPickMethod,
    createQuickPickParamsSchema,
    hideQuickInputMethod,
    hideQuickInputParamsSchema,
    LeanLiveQuickInputEvent,
    LeanQuickInputButtonResult,
    LeanShowQuickPickResult,
    LeanUpdateQuickInputResult,
    LeanWindowClientCapabilities,
    liveQuickInputSchema,
    quickInputButtonSchema,
    quickInputSchema,
    showQuickPickMethod,
    showQuickPickParamsSchema,
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

function toQuickInputButtons(buttons: z.output<typeof quickInputButtonSchema>[] | undefined): QuickInputButton[] {
    return (buttons ?? []).map(button => ({ iconPath: new ThemeIcon(button.icon), tooltip: button.tooltip }))
}

/**
 * Applies the fields of `quickInputSchema` to `input`. Returns how to report a
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

const showQuickPick = serverDialog(
    showQuickPickMethod,
    showQuickPickParamsSchema,
    async (_, params, token): Promise<LeanShowQuickPickResult> => {
        const pick = window.createQuickPick<IndexedQuickPickItem>()
        const report = setQuickPickParams(pick, params, false)
        return await showUntilHidden(pick, token, respond => [
            pick.onDidAccept(() => respond(report.accepted())),
            pick.onDidTriggerButton(button => respond(report.button(button))),
            pick.onDidTriggerItemButton(({ item, button }) => respond(report.itemButton(item, button))),
        ])
    },
)

type LiveParams = z.output<typeof liveQuickInputSchema>

/**
 * The client side of a live quick input session (see `createQuickPickMethod`). Queues the
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
        this.input.hide()
    }
}

let nextSessionId = 0
const liveQuickPicks = new Map<number, LiveQuickInput<z.output<typeof createQuickPickParamsSchema>, QuickPickResult>>()
const createQuickPick = serverDialog(
    createQuickPickMethod,
    createQuickPickParamsSchema,
    async (client, params): Promise<number> => {
        const id = nextSessionId++
        const pick = window.createQuickPick<IndexedQuickPickItem>()
        let report = setQuickPickParams(pick, params, false)
        const session = new LiveQuickInput<z.output<typeof createQuickPickParamsSchema>, QuickPickResult>(
            pick,
            client,
            params,
            update => (report = setQuickPickParams(pick, update, true)),
            emit => [
                pick.onDidAccept(() => emit(report.accepted())),
                pick.onDidTriggerButton(button => emit(report.button(button))),
                pick.onDidTriggerItemButton(({ item, button }) => emit(report.itemButton(item, button))),
            ],
            () => liveQuickPicks.delete(id),
        )
        liveQuickPicks.set(id, session)
        return id
    },
)

const updateQuickPick = serverDialog(updateQuickPickMethod, updateQuickPickParamsSchema, async (_, params, token) =>
    liveQuickPicks.has(params.session) ? liveQuickPicks.get(params.session)?.next(params.update, token) : null,
)

const hideQuickInput = serverDialog(hideQuickInputMethod, hideQuickInputParamsSchema, async (_, params) => {
    liveQuickPicks.get(params.session)?.hide()
    return null
})

const serverDialogs = {
    showQuickPick,
    createQuickPick,
    updateQuickPick,
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
