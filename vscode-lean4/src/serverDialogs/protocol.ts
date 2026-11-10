/**
 * Requests that let the Lean language server ask the user for input through the editor's own UI.
 *
 * All of these requests are sent from the server to the client. A client advertises support for
 * each request with the corresponding field of `ClientCapabilities.lean.window`
 * (`LeanWindowClientCapabilities`). A server must not send a request whose capability is absent.
 *
 * Conventions shared by all requests:
 * - The client answers `null` when the user dismisses the dialog without answering.
 * - An optional field is either absent or set; `null` is not accepted in its place.
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
