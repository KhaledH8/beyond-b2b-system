'use client';

import { useActionState, useState, useTransition } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { Banner } from './Banner';
import { Button } from './Button';
import { Card } from './Card';
import { Input } from './Input';
import { Textarea } from './Textarea';
import {
  searchAgenciesAction,
  startImpersonationAction,
} from '../app/(protected)/impersonation/actions';
import {
  INITIAL_START_STATE,
  type StartFormState,
} from '../app/(protected)/impersonation/form-state';

/**
 * Plain-object agency shape. Matches the wire `AgencySummary` from
 * `lib/impersonation-client.ts` but kept duplicated here so the
 * client component never imports the server-only module.
 */
export interface AgencyOption {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export interface ImpersonationStartFormProps {
  /** Initial agency list fetched server-side by the page. */
  readonly initialAgencies: ReadonlyArray<AgencyOption>;
}

/**
 * Start-impersonation form (ADR-027 V1.1 — agency selector).
 *
 * Client component because it composes three pieces of client state:
 *   - the search query + result list (driven by `searchAgenciesAction`)
 *   - the currently-selected agency
 *   - a manual-ULID-mode toggle
 * Plus `useActionState` for the start action's form state.
 *
 * The form submits a single hidden `targetAccountId` to the existing
 * `startImpersonationAction`. The server action still owns ULID
 * validation, non-empty checks, and typed API-error mapping — no
 * server-side change was needed for this slice.
 *
 * Manual fallback exists by design: when an agency isn't in the
 * current selector page, the operator switches to manual mode and
 * pastes the ULID directly. The same `targetAccountId` field is
 * submitted whether the value came from the selector or the manual
 * input.
 */
export function ImpersonationStartForm({
  initialAgencies,
}: ImpersonationStartFormProps) {
  const [state, formAction] = useActionState<StartFormState, FormData>(
    startImpersonationAction,
    INITIAL_START_STATE,
  );

  const [agencies, setAgencies] = useState<ReadonlyArray<AgencyOption>>(
    initialAgencies,
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AgencyOption | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualId, setManualId] = useState('');
  const [isSearching, startSearch] = useTransition();

  function runSearch(): void {
    const q = query;
    startSearch(async () => {
      const { accounts } = await searchAgenciesAction(q);
      setAgencies(accounts);
      // Drop the current selection if it's no longer in the new list.
      if (selected && !accounts.some((a) => a.id === selected.id)) {
        setSelected(null);
      }
    });
  }

  function handleSearchKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  }

  // The single source of truth submitted to the server action.
  const submitTargetAccountId = manualMode ? manualId : (selected?.id ?? '');

  return (
    <Card title="Start impersonation">
      <form action={formAction} className="flex flex-col gap-4">
        {!manualMode ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  name="agencyQuery"
                  label="Agency"
                  value={query}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setQuery(e.target.value)
                  }
                  onKeyDown={handleSearchKey}
                  placeholder="Acme Travel or 01ARZ…"
                  helperText="Search by agency name or account ID."
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={runSearch}
                disabled={isSearching}
                data-testid="agency-search-button"
              >
                Search
              </Button>
            </div>

            {agencies.length === 0 ? (
              <p
                data-testid="agency-empty-state"
                className="px-1 py-2 text-sm italic text-gray-500"
              >
                No active agencies found.
              </p>
            ) : (
              <ul
                data-testid="agency-list"
                className="max-h-64 overflow-auto rounded border border-gray-200 bg-white"
              >
                {agencies.map((a) => {
                  const isSelected = selected?.id === a.id;
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(a)}
                        aria-pressed={isSelected}
                        data-testid={`agency-option-${a.id}`}
                        className={[
                          'flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm',
                          'hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-600',
                          isSelected
                            ? 'bg-indigo-50 font-semibold'
                            : '',
                        ]
                          .join(' ')
                          .trim()}
                      >
                        <span className="text-gray-900">{a.name}</span>
                        <code className="font-mono text-xs text-gray-500">
                          {a.id}
                        </code>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {selected && (
              <p
                data-testid="agency-selected"
                className="rounded bg-gray-50 px-3 py-2 text-sm text-gray-800"
              >
                Selected:{' '}
                <strong data-testid="agency-selected-name">
                  {selected.name}
                </strong>{' '}
                <code
                  data-testid="agency-selected-id"
                  className="font-mono text-xs text-gray-600"
                >
                  {selected.id}
                </code>
              </p>
            )}

            <button
              type="button"
              onClick={() => setManualMode(true)}
              data-testid="manual-mode-toggle"
              className="self-start text-xs text-indigo-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 rounded"
            >
              Or enter the account ULID manually
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              name="targetAccountIdManual"
              label="Target account ID (manual)"
              value={manualId}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setManualId(e.target.value)
              }
              helperText="Paste the 26-character Crockford-base32 ULID from the support ticket."
              errorText={state.fieldErrors?.targetAccountId}
              autoComplete="off"
              spellCheck={false}
              data-testid="manual-target-account-id"
            />
            <button
              type="button"
              onClick={() => {
                setManualMode(false);
                setManualId('');
              }}
              data-testid="selector-mode-toggle"
              className="self-start text-xs text-indigo-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 rounded"
            >
              Back to agency selector
            </button>
          </div>
        )}

        {/* The single targetAccountId the action receives. */}
        <input
          type="hidden"
          name="targetAccountId"
          value={submitTargetAccountId}
          data-testid="hidden-target-account-id"
        />

        {/* Selector-mode validation error (manual mode shows it inline). */}
        {!manualMode && state.fieldErrors?.targetAccountId && (
          <p
            role="alert"
            data-testid="selector-target-error"
            className="text-xs text-red-600"
          >
            {state.fieldErrors.targetAccountId}
          </p>
        )}

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
