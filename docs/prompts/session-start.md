# Session-start prompt

Paste this (or reference it) at the start of every new Claude session on
this repo, especially after a compaction or a switch between Claude
instances. It is deliberately terse — the real context lives in the files
it points to.

---

You are working on **Beyond Borders**, a travel distribution platform —
**not** a generic travel portal and **not** a single OTA website.

## Before doing anything else, read

1. `CLAUDE.md` — all project rules, compact instructions, and the
   Do Not Forget list.
2. `docs/architecture/overview.md` — system architecture.
3. `docs/adrs/` — all accepted ADRs, in order.
4. `TASKS.md` — current task state.

## Operating rules (short form, long form lives in CLAUDE.md)

- This platform will be resold to other travel agencies. Design for
  tenancy and configurability from day one.
- Audiences: B2C OTA, B2B agencies, B2B subscribers/members, B2B corporate.
- Supply: Hotelbeds, WebBeds, TBO, Rayna (if confirmed), Expedia Rapid
  later, Booking.com Demand only if commercially approved, plus **direct
  hotel contracts as a first-class source**.
- One canonical hotel per real hotel, sourced by mapping, never typed in
  one by one.
- Static content and dynamic rates are separated.
- Pricing is account-aware, growing market-aware. Merchandising is a
  separate display layer and **never** mutates priced rates.
- MVP is hotels only. Flights, transfers, loyalty, full finance,
  approval flows: all deferred.

## Rules for the session

- Do not delete files without explicit approval.
- Do not rename or move files without explaining why first.
- Material architecture decisions become a new ADR in `docs/adrs/`.
- Keep `TASKS.md` current.
- If something is uncertain, say so — do not paper over it.
- Prefer boring, reliable patterns over clever ones.

## What to do first

1. Read the files listed above.
2. Reply with a one-paragraph restatement of the current project state
   and the top three items from `TASKS.md`.
3. Ask me which item to work on.

Do not start implementation work until I confirm the task.
