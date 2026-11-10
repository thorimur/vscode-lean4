/**
 * Requests that let the Lean language server ask the user for input through the editor's own UI.
 *
 * All of these requests are sent from the server to the client. A client advertises support for
 * each request with the corresponding field of `ClientCapabilities.lean.window`
 * (`LeanWindowClientCapabilities`). A server must not send a request whose capability is absent.
 *
 * Conventions shared by all requests:
 * - The client answers `null` when the user dismisses the dialog without answering.
 * - If the server cancels a request (`$/cancelRequest`) or stops, the client closes its quick pick
 *   or input box and answers `null`. Message and file dialogs cannot be closed by the client; they
 *   stay open until the user answers.
 * - At most one quick pick or input box is open at a time. Showing another one, whether from the
 *   server or from anywhere else in the editor, closes the previous one, which is answered `null`.
 * - Icons are named by codicon id (https://microsoft.github.io/vscode-codicons/dist/codicon.html),
 *   e.g. `"arrow-right"`. Quick-pick labels, descriptions and details may also embed codicons as
 *   `$(name)`.
 * - An optional field is either absent or set; `null` is not accepted in its place.
 * - A result that can take several shapes is an object with a single key naming the shape, e.g.
 *   `{ "back": { "value": "" } }`. This is the encoding Lean derives for inductive types, as
 *   for `TaggedText` in the infoview API.
 */

import { z } from 'zod'

/**
 * Support for one request: the request is supported if its field is present. Empty for now;
 * finer-grained capabilities can be added as fields.
 */
export type LeanWindowRequestCapability = Record<string, never>

/** `ClientCapabilities.lean.window`: which of the requests below the client supports. */
export interface LeanWindowClientCapabilities {
    showMessageRequest?: LeanWindowRequestCapability
    showQuickPick?: LeanWindowRequestCapability
    showInputBox?: LeanWindowRequestCapability
    showOpenDialog?: LeanWindowRequestCapability
    showSaveDialog?: LeanWindowRequestCapability
    createQuickPick?: LeanWindowRequestCapability
    updateQuickPick?: LeanWindowRequestCapability
    createInputBox?: LeanWindowRequestCapability
    updateInputBox?: LeanWindowRequestCapability
    hideQuickInput?: LeanWindowRequestCapability
}

// ---------------------------------------------------------------------------------------------------
// `$/lean/window/showMessageRequest`
// ---------------------------------------------------------------------------------------------------

/**
 * Like LSP's `window/showMessageRequest`, but the message can be shown as a modal dialog, with
 * secondary text.
 */
export const showMessageRequestMethod = '$/lean/window/showMessageRequest'

/** A button of a message dialog. */
export const messageActionItemSchema = z.object({
    title: z.string(),
    /**
     * Modal dialogs only: the button chosen when the user dismisses the dialog, e.g. with Escape.
     * Without such a button, dismissing the dialog answers `null`.
     */
    isCloseAffordance: z.boolean().optional(),
    /**
     * Returned unchanged when the button is chosen, so the server need not match on titles. Any
     * JSON value, `null` included.
     */
    data: z.unknown(),
})

export const showMessageRequestParamsSchema = z.object({
    /** Severity, as in LSP's `MessageType`: 1 error, 2 warning, 3 info, 4 log (shown as info). */
    type: z.number().int(),
    message: z.string(),
    actions: z.array(messageActionItemSchema).optional(),
    /**
     * Show a modal dialog that blocks the editor until the user answers. Otherwise the message is a
     * notification, which VS Code may move to its notification centre unanswered; the request then
     * stays pending until the user answers there. Use `modal` for questions that need an answer.
     */
    modal: z.boolean().optional(),
    /** Secondary text. VS Code shows it only in modal dialogs. */
    detail: z.string().optional(),
})

export type LeanShowMessageRequestParams = z.input<typeof showMessageRequestParamsSchema>
/** The chosen button. */
export type LeanShowMessageRequestResult = z.input<typeof messageActionItemSchema> | null

// ---------------------------------------------------------------------------------------------------
// Fields shared by quick picks and input boxes
// ---------------------------------------------------------------------------------------------------

/** A button in the title bar of a quick pick or input box, or on a quick-pick item. */
export const quickInputButtonSchema = z.object({
    /** Codicon id. */
    icon: z.string(),
    tooltip: z.string().optional(),
})

/** Position in a multi-step flow, shown as "current/total" next to the title. */
const stepSchema = z
    .object({ current: z.number().int().positive(), total: z.number().int().positive() })
    .refine(step => step.current <= step.total, { message: '`current` exceeds `total`' })

export const quickInputSchema = z.object({
    title: z.string().optional(),
    step: stepSchema.optional(),
    /** Buttons in the title bar. */
    buttons: z.array(quickInputButtonSchema).optional(),
    /** Show the editor's Back button in the title bar, for returning to a previous step. */
    backButton: z.boolean().optional(),
    /** Keep the dialog open when focus moves elsewhere, e.g. to the editor. */
    ignoreFocusOut: z.boolean().optional(),
})

/**
 * How the user left a quick pick or input box with a title-bar button. Every result also reports
 * `value`, the text in the input field at that moment.
 */
export type LeanQuickInputButtonResult =
    | { back: { value: string } }
    | {
          button: {
              /** Index into `buttons`. */
              button: number
              value: string
          }
      }

// ---------------------------------------------------------------------------------------------------
// `$/lean/window/showQuickPick`
// ---------------------------------------------------------------------------------------------------

/**
 * Lets the user choose one or more items from a list, filtered by the text they type.
 *
 * The items are fixed while the quick pick is open. To let the user accept typed text that matches
 * no item, or that matches items they do not want, add an item with `alwaysShow` for that purpose:
 * choosing it reports the typed text as `value`.
 */
export const showQuickPickMethod = '$/lean/window/showQuickPick'

export const quickPickItemSchema = z.object({
    label: z.string(),
    /**
     * `"separator"` makes this item a heading for the items after it. Separators cannot be chosen
     * and are hidden while the user filters.
     */
    kind: z.enum(['default', 'separator']).optional(),
    /** Codicon id, shown before the label. */
    icon: z.string().optional(),
    description: z.string().optional(),
    detail: z.string().optional(),
    /** Initially selected. Only meaningful with `canPickMany`. */
    picked: z.boolean().optional(),
    /** Shown even when it does not match the filter text. */
    alwaysShow: z.boolean().optional(),
    /** Buttons shown on the item. */
    buttons: z.array(quickInputButtonSchema).optional(),
})

const quickPickParamsSchema = quickInputSchema.extend({
    items: z.array(quickPickItemSchema),
    placeholder: z.string().optional(),
    /**
     * Text about the typed text or the choice, e.g. why the typed text can't be used. Shown below the
     * input field; VS Code before 1.108 shows it after the title instead.
     */
    prompt: z.string().optional(),
    /** Initial filter text. */
    value: z.string().optional(),
    canPickMany: z.boolean().optional(),
    /** Also filter on `description`. Labels are always filtered on. */
    matchOnDescription: z.boolean().optional(),
    /** Also filter on `detail`. */
    matchOnDetail: z.boolean().optional(),
    /**
     * Index into `items` of the initially highlighted item, which must not be a separator. If the
     * initial filter text hides it, no item is highlighted.
     */
    activeItem: z.number().int().nonnegative().optional(),
})

function checkActiveItem(params: z.output<typeof quickPickParamsSchema>, ctx: z.RefinementCtx) {
    const active = params.activeItem !== undefined ? params.items[params.activeItem] : undefined
    if (params.activeItem !== undefined && (active === undefined || active.kind === 'separator')) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['activeItem'],
            message: '`activeItem` must be the index of an item that is not a separator',
        })
    }
}

export const showQuickPickParamsSchema = quickPickParamsSchema.superRefine(checkActiveItem)

export type LeanQuickPickItem = z.input<typeof quickPickItemSchema>
export type LeanShowQuickPickParams = z.input<typeof showQuickPickParamsSchema>

export type LeanShowQuickPickResult =
    | {
          accepted: {
              /**
               * Indices into `items` of the chosen items, in increasing order. Empty when nothing was
               * chosen: the user accepted text that matched no item, or, with `canPickMany`, accepted
               * without checking any item.
               */
              selected: number[]
              value: string
          }
      }
    | {
          itemButton: {
              /** Index into `items` of the item whose button was pressed. */
              item: number
              /** Index into that item's `buttons`. */
              button: number
              value: string
          }
      }
    | LeanQuickInputButtonResult
    | null

// ---------------------------------------------------------------------------------------------------
// `$/lean/window/showInputBox`
// ---------------------------------------------------------------------------------------------------

/** Lets the user enter a line of text. */
export const showInputBoxMethod = '$/lean/window/showInputBox'

export const showInputBoxParamsSchema = quickInputSchema.extend({
    /** Initial text. */
    value: z.string().optional(),
    /**
     * Part of `value` to select initially, as `[start, end)` in UTF-16 code units, like LSP
     * positions. Defaults to all of `value`.
     */
    valueSelection: z
        .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
        .refine(([start, end]) => start <= end, { message: 'the selection must not end before it starts' })
        .optional(),
    placeholder: z.string().optional(),
    /** Text shown below the input field. */
    prompt: z.string().optional(),
    /** Hide the typed text. */
    password: z.boolean().optional(),
    /**
     * Shown below the input field until the user edits `value`. Meant for asking again after the
     * server rejected an answer, with `value` set to the rejected answer. With severity `error`, the
     * user cannot accept until they edit `value`.
     */
    validationMessage: z
        .object({
            message: z.string(),
            severity: z.enum(['info', 'warning', 'error']),
        })
        .optional(),
})

export type LeanShowInputBoxParams = z.input<typeof showInputBoxParamsSchema>
export type LeanShowInputBoxResult = { accepted: { value: string } } | LeanQuickInputButtonResult | null

// ---------------------------------------------------------------------------------------------------
// `$/lean/window/showOpenDialog` and `$/lean/window/showSaveDialog`
// ---------------------------------------------------------------------------------------------------

/** Shows the system dialog for choosing files or folders to open. */
export const showOpenDialogMethod = '$/lean/window/showOpenDialog'

/** Shows the system dialog for choosing where to save a file. */
export const showSaveDialogMethod = '$/lean/window/showSaveDialog'

/** File-type filters, in the order the dialog lists them. */
export const fileFiltersSchema = z.array(
    z.object({
        label: z.string(),
        /** Extensions without the dot, e.g. `["lean"]`. */
        extensions: z.array(z.string()),
    }),
)

export const showOpenDialogParamsSchema = z.object({
    title: z.string().optional(),
    /** Label of the button that confirms the choice. */
    openLabel: z.string().optional(),
    /** The file or folder the dialog starts at. */
    defaultUri: z.string().optional(),
    /** Whether the user selects files, folders, or both. */
    select: z.enum(['files', 'folders', 'filesAndFolders']),
    /** Defaults to `false`. */
    canSelectMany: z.boolean().optional(),
    filters: fileFiltersSchema.optional(),
})

export type LeanShowOpenDialogParams = z.input<typeof showOpenDialogParamsSchema>
/** The chosen files or folders, as `DocumentUri`s. */
export type LeanShowOpenDialogResult = string[] | null

export const showSaveDialogParamsSchema = z.object({
    title: z.string().optional(),
    /** Label of the button that confirms the choice. */
    saveLabel: z.string().optional(),
    /** The file the dialog suggests. */
    defaultUri: z.string().optional(),
    filters: fileFiltersSchema.optional(),
})

export type LeanShowSaveDialogParams = z.input<typeof showSaveDialogParamsSchema>
/** The chosen file, as a `DocumentUri`. */
export type LeanShowSaveDialogResult = string | null

// ---------------------------------------------------------------------------------------------------
// Live quick picks and input boxes: `$/lean/window/createQuickPick`, `$/lean/window/updateQuickPick`,
// `$/lean/window/createInputBox`, `$/lean/window/updateInputBox` and `$/lean/window/hideQuickInput`
// ---------------------------------------------------------------------------------------------------

/**
 * A live quick pick or input box stays open until the server hides it. It reports what the user does
 * as events, and the server can change it while it is open, e.g. to offer items that depend on the
 * typed text, or to explain why an answer was rejected.
 *
 * - `createQuickPick` and `createInputBox` show it and answer a session id.
 * - `updateQuickPick` and `updateInputBox` optionally replace its parameters, then answer the next
 *   event. At most one such request per session may be pending.
 * - Events that happen while no update request is pending are queued, and consecutive value changes
 *   are merged into the last one. If an event is queued when an update request arrives, the client
 *   answers with that event and `applied: false`, and does not apply the update, because the update
 *   was computed without knowing about the event.
 * - Indices in an event refer to the parameters that were shown when it happened, with one exception
 *   the client can't detect: VS Code resolves items and buttons in the extension, so an event the
 *   user causes in the moment before an update's new items reach the editor is reported against the
 *   new items, with `applied: true`. Servers that change items while the user may act should keep the
 *   positions of existing items where they can, e.g. by adding items at the end.
 * - `applied` is also `true` when the request carries no update.
 * - Accepting or pressing a button does not close it. The server answers by updating it, or by
 *   closing it with `hideQuickInput`.
 * - It also closes when the user dismisses it, another quick input replaces it, the server cancels a
 *   pending update request, or the client stops. The pending or next update request is then answered
 *   `null`, and the session ends.
 */
export const createQuickPickMethod = '$/lean/window/createQuickPick'
export const updateQuickPickMethod = '$/lean/window/updateQuickPick'
export const createInputBoxMethod = '$/lean/window/createInputBox'
export const updateInputBoxMethod = '$/lean/window/updateInputBox'
export const hideQuickInputMethod = '$/lean/window/hideQuickInput'

export const liveQuickInputSchema = z.object({
    /** Report edits of the input field as `valueChanged` events. */
    reportValueChanges: z.boolean().optional(),
    /** Show a progress indicator, e.g. while the server computes an update. */
    busy: z.boolean().optional(),
})

const sessionSchema = z.number().int().nonnegative()

/** The parameters of `showQuickPick`, except that in an update, an absent `value` keeps the typed text. */
export const createQuickPickParamsSchema = quickPickParamsSchema
    .merge(liveQuickInputSchema)
    .superRefine(checkActiveItem)

export const updateQuickPickParamsSchema = z.object({
    session: sessionSchema,
    /** Replaces all parameters. Absent to only wait for the next event. */
    update: createQuickPickParamsSchema.optional(),
})

/**
 * The parameters of `showInputBox`, except that in an update, `value` and `valueSelection` change the
 * typed text only when `value` is present, and `value` without `valueSelection` puts the cursor at
 * the end. A live input box shows `validationMessage` until the server
 * changes it, and lets the user accept despite an `error` message: the server decides what to do.
 */
export const createInputBoxParamsSchema = showInputBoxParamsSchema.merge(liveQuickInputSchema)

export const updateInputBoxParamsSchema = z.object({
    session: sessionSchema,
    /** Replaces all parameters. Absent to only wait for the next event. */
    update: createInputBoxParamsSchema.optional(),
})

export const hideQuickInputParamsSchema = z.object({ session: sessionSchema })

export type LeanLiveQuickInputEvent<Result> = { result: Result } | { valueChanged: { value: string } }
export type LeanQuickPickEvent = LeanLiveQuickInputEvent<NonNullable<LeanShowQuickPickResult>>
export type LeanInputBoxEvent = LeanLiveQuickInputEvent<NonNullable<LeanShowInputBoxResult>>

/** `null` when the session has ended. */
export type LeanUpdateQuickInputResult<Event> = {
    /** Whether the update was applied; see above. */
    applied: boolean
    event: Event
} | null
