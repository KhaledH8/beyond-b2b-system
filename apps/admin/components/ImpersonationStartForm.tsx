'use client';

import { useActionState } from 'react';
import { Banner } from './Banner';
import { Button } from './Button';
import { Card } from './Card';
import { Input } from './Input';
import { Textarea } from './Textarea';
import { startImpersonationAction } from '../app/(protected)/impersonation/actions';
import {
  INITIAL_START_STATE,
  type StartFormState,
} from '../app/(protected)/impersonation/form-state';

/**
 * Start-impersonation form. Client component only because
 * `useActionState` is a client-side React 19 hook for form-state
 * marshalling. The action itself runs server-side (it is imported
 * from a `'use server'` module). No backend token ever reaches this
 * component.
 *
 * V1 limitation: `targetAccountId` is a raw 26-char ULID text input.
 * The helper text says so. An agency-account selector / typeahead is
 * a deliberately-deferred follow-up slice — it requires a new backend
 * endpoint that does not exist yet.
 */
export function ImpersonationStartForm() {
  const [state, formAction] = useActionState<StartFormState, FormData>(
    startImpersonationAction,
    INITIAL_START_STATE,
  );

  return (
    <Card title="Start impersonation">
      <form action={formAction} className="flex flex-col gap-4">
        <Input
          name="targetAccountId"
          label="Target account ID"
          helperText="V1: paste the 26-character ULID from the support ticket. No agency selector yet."
          errorText={state.fieldErrors?.targetAccountId}
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          name="ticketRef"
          label="Ticket reference"
          helperText="e.g. SUP-1234 — recorded in the audit log."
          errorText={state.fieldErrors?.ticketRef}
          autoComplete="off"
        />
        <Textarea
          name="reasonText"
          label="Reason"
          helperText="Why are you impersonating? This is recorded for compliance."
          errorText={state.fieldErrors?.reasonText}
        />

        {state.formError && (
          <Banner variant="danger">
            <span data-testid="start-form-error">{state.formError}</span>
          </Banner>
        )}

        <div>
          <Button type="submit" variant="primary">
            Start impersonation
          </Button>
        </div>
      </form>
    </Card>
  );
}
