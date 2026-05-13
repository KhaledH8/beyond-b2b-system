/**
 * Form-state shape and initial value for the start-impersonation
 * server action. Lives in a non-`'use server'` module because Next.js
 * forbids non-function exports from `'use server'` files. Both the
 * action implementation (server) and the `<ImpersonationStartForm>`
 * client component import from here.
 */
export interface StartFormState {
  readonly ok: boolean;
  readonly fieldErrors?: {
    readonly targetAccountId?: string;
    readonly ticketRef?: string;
    readonly reasonText?: string;
  };
  readonly formError?: string;
}

export const INITIAL_START_STATE: StartFormState = { ok: true };
