'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiConflictError,
  ApiForbiddenError,
  ApiNetworkError,
  ApiServerError,
  ApiUnauthorizedError,
  ApiValidationError,
} from '../../../lib/api-client';
import {
  startImpersonation,
  stopImpersonation,
} from '../../../lib/impersonation-client';
import { ULID_PATTERN } from '../../../lib/ulid';
import type { StartFormState } from './form-state';

function getString(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function mapStartError(err: unknown): StartFormState {
  if (err instanceof ApiValidationError) {
    return {
      ok: false,
      formError:
        'The backend rejected the request as invalid. Check the inputs.',
    };
  }
  if (err instanceof ApiUnauthorizedError) {
    return {
      ok: false,
      formError: 'Session expired. Sign in again.',
    };
  }
  if (err instanceof ApiForbiddenError) {
    return {
      ok: false,
      formError:
        'Forbidden. The target is not an AGENCY in your tenant, or you do not hold IMPERSONATE_AGENCY_ACCOUNT.',
    };
  }
  if (err instanceof ApiConflictError) {
    return {
      ok: false,
      formError:
        'An active impersonation already exists for this operator. Stop it first.',
    };
  }
  if (err instanceof ApiServerError) {
    return {
      ok: false,
      formError: `Backend error (status ${err.status ?? 'unknown'}). Try again.`,
    };
  }
  if (err instanceof ApiNetworkError) {
    return {
      ok: false,
      formError: 'Network error reaching the backend. Try again.',
    };
  }
  return { ok: false, formError: 'Unknown error.' };
}

/**
 * Start impersonation. Validates inputs locally (non-empty, ULID
 * shape) before hitting the network so trivial input errors are
 * caught without an audit-log entry on the backend. Backend remains
 * the authoritative validator (AGENCY type, same tenant, no existing
 * grant) — typed API errors are mapped to form messages.
 *
 * On success: revalidates layout (so the next render picks up the new
 * `/me` impersonation block + banner) and `/impersonation`, then
 * redirects to `/impersonation` (which now renders the active card).
 */
export async function startImpersonationAction(
  _prev: StartFormState,
  formData: FormData,
): Promise<StartFormState> {
  const targetAccountId = getString(formData, 'targetAccountId');
  const ticketRef = getString(formData, 'ticketRef');
  const reasonText = getString(formData, 'reasonText');

  const fieldErrors: {
    targetAccountId?: string;
    ticketRef?: string;
    reasonText?: string;
  } = {};
  if (!targetAccountId) {
    fieldErrors.targetAccountId = 'Required';
  } else if (!ULID_PATTERN.test(targetAccountId)) {
    fieldErrors.targetAccountId =
      'Must be a 26-character Crockford-base32 ULID';
  }
  if (!ticketRef) fieldErrors.ticketRef = 'Required';
  if (!reasonText) fieldErrors.reasonText = 'Required';

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  try {
    await startImpersonation({ targetAccountId, reasonText, ticketRef });
  } catch (err) {
    return mapStartError(err);
  }

  revalidatePath('/', 'layout');
  revalidatePath('/impersonation');
  redirect('/impersonation');
}

/**
 * Stop impersonation. Idempotent. Invoked from the banner (any page)
 * and from the active card on `/impersonation`. Always revalidates
 * the layout so the banner disappears on the next render. Does not
 * redirect — the operator stays on the page they clicked Stop from.
 *
 * Errors are intentionally swallowed: the user-visible state on the
 * next render reflects whatever is actually true on the backend.
 * A failure to stop is rare and the operator can retry; we do not
 * surface a transient error mid-action.
 */
export async function stopImpersonationAction(): Promise<void> {
  try {
    await stopImpersonation();
  } catch {
    // Swallow — next render will reflect actual server state.
  }
  revalidatePath('/', 'layout');
  revalidatePath('/impersonation');
}
