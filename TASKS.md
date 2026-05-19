# TASKS

Running task list for Beyond Borders. Newest at the top of each section.
Claude must keep this file current at the start and end of every working
session.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.

---

## Now (this session)

- [x] **Booking Truth — Slice 3: supplier booking, fixture mode
      (2026-05-19).**
      - Additive migration
        `20260519000002_booking_supplier_booking_columns.ts`: NULLable
        `supplier_booked_at`, `supplier_booking_status`
        (CHECK CONFIRMED|ON_REQUEST), `supplier_booking_mode`
        (CHECK FIXTURE|LIVE) on `booking_booking`; reuses existing
        `supplier_id` + `supplier_confirmation_ref`. `down()` reverses.
      - Adapter: `HotelbedsClient` gains `book()`;
        `HotelbedsAdapter.book()` delegates to the client (mirrors
        `fetchRates`). Fixture client returns deterministic
        `HB-FIX-<sha256-12>` CONFIRMED ref; stub + live clients
        reject `book()` with `NOT_IMPLEMENTED`. `cancel()` unchanged.
      - `POST /internal/bookings/:id/supplier-book`
        (`InternalAuthGuard`) → `BookingSupplierService`: load booking
        (404), replay if `supplier_confirmation_ref` set, refuse
        terminal (422), resolve ingredients from pinned
        `booking_sourced_offer_snapshot` else live
        `offer_sourced_snapshot`, call `adapter.book()` **before** the
        DB tx (NOT_IMPLEMENTED → 501), then short tx:
        `recordSupplierBooking` + `BOOKING_SUPPLIER_BOOKED` via
        `emitInTransaction`, COMMIT. Status **unchanged**. Audit/DB
        failure rolls back; replay emits no second audit.
      - `audit-event.types.ts`: new APP kind
        `BOOKING_SUPPLIER_BOOKED` + payload.
      - Repos: `BookingRecord`/`loadById` extended with supplier-book
        fields; `recordSupplierBooking`, `loadGuestContact`;
        `BookingSnapshotRepository.loadBookingTimeOfferSnapshot`.
        Module imports `AdaptersModule` (`SupplierAdapterRegistry`).
      - Tests: `book.test.ts` (fixture deterministic+idempotent,
        stub/live NOT_IMPLEMENTED, adapter delegation, cancel still
        not implemented); `booking-supplier.service.test.ts` (happy,
        BookRequest build, audit-in-tx, pinned vs live fallback,
        404/terminal/501, audit-fail rollback, replay + race);
        `booking-supplier.controller.test.ts` (real DB, registry
        overridden with fixture fake: records ref + audit, no status
        change, replay no dup audit, confirm still independent →
        3 audit kinds, 401/404).
      - **Not** in this slice: live supplier booking, payment,
        ledger, documents, cancellation/refund/compensation, full
        ADR-010 saga sequencing, UI. Confirm behaviour unchanged.

- [x] **Booking Truth — Slice 2: ADR-021 booking-time snapshot
      pinning at CONFIRMED + BOOKING_CONFIRMED (2026-05-19).**
      - Additive migration `20260519000001_booking_time_snapshots.ts`:
        four immutable tables — `booking_sourced_offer_snapshot`
        (1:1 per booking, UNIQUE booking_id),
        `booking_sourced_price_component_snapshot`,
        `booking_cancellation_policy_snapshot`,
        `booking_tax_fee_snapshot` (TAX/FEE denormalised per
        CLAUDE.md §12). BEFORE UPDATE/DELETE trigger
        `booking_snapshot_immutable()` makes every row write-once.
        Purely additive; `down()` drops triggers/function/tables.
      - `booking-snapshot.repository.ts`: tenant-scoped reads of
        `offer_sourced_snapshot` / `_component` /
        `_cancellation_policy`; parameterised inserts of the four
        booking-time tables; `snapshotExistsForBooking`.
      - `BookingService.confirm` extended: pre-tx 400 when
        `source_offer_snapshot_id` is null; in the existing confirm
        transaction (after the markConfirmed gate, with the FX lock):
        load source snapshot (409 + rollback if gone), pin offer +
        all components + TAX/FEE + cancellation policy, then emit
        `BOOKING_CONFIRMED` via `emitInTransaction`. Any failure →
        rollback, booking stays not-CONFIRMED. Idempotent
        already-CONFIRMED fast-path pins nothing, emits no audit.
      - `audit-event.types.ts`: `BookingConfirmedPayload` extended
        backward-compatibly (kept `bookingId`/`supplierId`; added
        tenantId, accountId, bookingReference, sourceOfferSnapshotId,
        supplier, supplierRawRef, sellAmount*, fxLockId, status).
      - `booking.repository.ts`: `BookingRecord`/`loadById` extended
        with accountId, reference, sourceOfferSnapshotId, supplierRef,
        supplierRawRef (confirm-time context).
      - Tests: new `booking-snapshot.repository.test.ts` (real DB:
        tenant-scoped read, pin offer/component/tax/policy, 1:1
        rejection, immutability trigger blocks UPDATE/DELETE); new
        `BookingService.confirm — snapshot pinning` unit suite
        (pin+audit-in-tx ordering, fxLockId in payload, null-source
        guard, source-gone rollback, snapshot-fail rollback,
        audit-fail rollback, replay no-op); existing service +
        repository tests updated for the two new constructor deps and
        seed an offer snapshot; intake controller create→confirm now
        asserts booking-time rows + both audit events; audit test
        `APP_EVENT` switched to `MARKUP_RULE_EDITED`.
      - **Not** in this slice: supplier `book()`, payment, ledger,
        documents, cancellation/refund, full ADR-010 saga, UI, Auth0,
        JwtAuthGuard, impersonation. Authored-path booking-time
        snapshot remains design-locked (no authored supply yet).

- [x] **Booking Intake — Slice 1 (2026-05-19).** Smallest safe
      booking-truth slice. Closes the "confirm endpoint is dead code"
      gap: nothing previously created a `booking_booking` row.
      - Additive migration `20260515000001_booking_intake_columns.ts`:
        `source_offer_snapshot_id`, `idempotency_key`, `supplier_ref`,
        `supplier_raw_ref` (all NULLable). Partial-unique index
        `booking_booking_idem_uq (tenant_id, idempotency_key)`;
        partial index `booking_booking_source_offer_idx`. No
        destructive change; existing CONFIRMED behaviour untouched;
        `down()` reverses cleanly.
      - `POST /internal/bookings` (`InternalAuthGuard`) →
        `BookingIntakeService.create`. Validates shape, refuses
        missing pricing (400) and `PROVISIONAL`/not-bookable rates
        (422, ADR-020), validates money-movement enums against the
        shell CHECKs, generates a `BB-YYYY-NNNNN` tenant-scoped
        reference with collision retry, inserts `INITIATED`, and
        writes `BOOKING_CREATED` (`APP`) via
        `AuditService.emitInTransaction` in the **same transaction**
        (audit failure rolls the booking back).
      - Idempotent on `(tenantId, idempotencyKey)`: fast-path replay
        + idem-race rollback/re-read; replay emits no second audit.
      - `audit-event.types.ts`: new `BOOKING_CREATED` kind +
        `BookingCreatedPayload` (target-kind routing already maps
        `BOOKING_*` → `BOOKING`).
      - Tests: `booking-intake.service.test.ts` (unit, mocked: happy
        path, validation, bookability gate, audit-rollback,
        idempotency replay/race/ref-retry), `booking-reference.test.ts`,
        `booking-intake.repository.test.ts` (real DB),
        `booking-intake.controller.test.ts` (real DB, incl.
        create→confirm proving confirm is no longer dead code).
        Existing booking confirm/repository/controller + audit suites
        still green.
      - **Not** in this slice: supplier `book()`, payment, ledger,
        documents, cancellation/refund, full ADR-010 saga, UI, Auth0.
        **Next booking-truth slice:** ADR-021 booking-time snapshot
        pinning at `CONFIRMED`.

- [x] **ADR-028 V1.0 step 7 — audit read API LIST (2026-05-13).**
      Backend-only slice. New permission `AUDIT_READ_SENSITIVE`
      added to the catalogue (PERMISSIONS const + PERMISSION_KIND as
      `READ`); `platform_admin` automatically picks it up via the
      all-permissions self-grant; lower roles (`ops_support`,
      `finance_ops`, `integrations_ops`, `read_only_auditor`) keep
      `AUDIT_READ` only. ADR-026 D6 amended with a dated annotation.
      New module `apps/api/src/admin-audit/`:
        - `audit-event.repository.ts` — single parameterised SQL
          with 14 positional `$N` placeholders covering tenant,
          all filters, sensitive-scope, cursor, limit; ORDER BY
          `occurred_at DESC, id DESC`; no string interpolation.
        - `audit-event.service.ts` — input validation (ULID,
          category enum, ISO dates), limit clamping (default 50,
          max 200, min 1), cursor decode via shared helper,
          applied-filters echo for audit emission. Fetches limit+1
          rows for has-more detection.
        - `cursor.ts` — base64-JSON `(occurredAt, id)` encoding;
          invalid cursors decode to null (never throw); decoded by
          the service into a typed value.
        - `admin-audit.controller.ts` — JWT + RolesGuard +
          `@RequirePermission(AUDIT_READ)` (NOT InternalAuthGuard).
          Tenant scope sourced from AuthContext only. Re-resolves
          permissions via `PermissionResolverService` to check for
          `AUDIT_READ_SENSITIVE`. Sensitive-category short-circuit:
          `category=SENSITIVE_ACCESS` without the sensitive
          permission → 403 before any DB or audit work. Successful
          calls emit `SECURITY.AUDIT_QUERY_EXECUTED` via
          `AuditService.emit()` (background, best-effort); failed
          4xx calls do NOT emit per ADR-028 D9.
        - `admin-audit.module.ts` — imports DatabaseModule +
          AuthModule; wired into AppModule.
      Tests: 9 cursor unit + 18 repo SQL contract + 31 service
      validation + 14 controller (delegation, guard/permission
      metadata, sensitive 403, self-audit, audit-emit-throw-isolated)
      + 12 HTTP flow with real `JwtAuthGuard` + `RolesGuard`
      (happy path, sensitive scope, 403/401 paths,
      X-Internal-Api-Key rejected, cross-tenant exclusion, cursor
      pagination, AUDIT_QUERY_EXECUTED assertion). Plus 5 new
      permission tests asserting `AUDIT_READ_SENSITIVE` is in
      `ALL_PERMISSIONS`, `platform_admin` has it, lower operator
      roles don't. **113 new backend tests, all passing.** API
      typecheck + lint clean. Impersonation + JwtAuthGuard +
      agency-selector tests still 86/86. Root suite 939 passed
      with only the pre-existing search MinIO/DB baseline failure.
      **Kind-level PII redaction is deliberately deferred for V1.**
      Only category-level `SENSITIVE_ACCESS` is gated by
      `AUDIT_READ_SENSITIVE`; `IMPERSONATION_*` events remain
      readable with `AUDIT_READ` per ADR-027's monthly review
      obligation. Documented in PROJECT-STATE + this entry +
      ADR-026 amendment.
      **NOT implemented in this slice:** DETAIL endpoint
      (`GET /admin/audit/events/:id`), `bb-audit query` CLI,
      retention cron, partition-creation cron, `SENSITIVE_ACCESS`
      emitters (V1.1), legacy-audit backfill, audit UI. All
      deferred per ADR-028 §"Implementation order".
- [x] **ADR-027 V1.1 agency selector (2026-05-13) — backend +
      admin UI.**
      Backend: new `apps/api/src/admin-agencies/` module exposing
      `GET /admin/agencies` (JWT + `RolesGuard` +
      `IMPERSONATE_AGENCY_ACCOUNT`). Tenant scoped via
      `AuthContext.tenantId`; never via query. Hard WHERE filter
      to `account_type = 'AGENCY'` + `status = 'ACTIVE'`. `q`
      matches name (ILIKE substring) and id (ILIKE prefix);
      `limit` defaults to 20 and is clamped 1–50 at the service.
      Parameterised SQL with `$1/$2/$3` placeholders. Repository →
      service → controller layering mirrors the existing
      `auth/impersonation` module. Wired into `AppModule`. 39
      backend tests added: 12 service (input shaping, limit
      clamping, result mapping), 8 repo (SQL contract, params,
      sort, injection safety), 8 controller (delegation +
      guard/permission metadata), 11 HTTP end-to-end (boots real
      Nest with `JwtAuthGuard` + `RolesGuard`; covers operator
      happy path, q-by-name, q-by-id-prefix, limit honour,
      SUSPENDED/non-AGENCY/cross-tenant rejection, no-permission
      403, AGENCY user 403, 401 without bearer, and 401 when only
      `X-Internal-Api-Key` is sent — proves the endpoint is
      JWT-only). API typecheck + lint clean.
      Admin app: `lib/impersonation-client.ts` gains
      `listAgencies(q?, limit?)` with query-string assembly +
      trim + floor + empty-result normalisation. New server
      action `searchAgenciesAction` wraps `listAgencies` and
      degrades to `{ accounts: [] }` on any error so the form
      always renders. `components/ImpersonationStartForm.tsx`
      rewritten as a richer `'use client'` component:
        - Agency search Input + Search button (runs on Enter or
          click via `useTransition`).
        - Clickable result list rendered from `initialAgencies`
          prop, with name + ID in each row and a selected
          highlight.
        - "Selected:" panel shows the chosen agency.
        - "Or enter the account ULID manually" toggle reveals
          the V1 raw-ULID Input as a fallback.
        - Hidden `<input name="targetAccountId">` carries either
          the selected or the manual value to the unchanged
          `startImpersonationAction`.
      `app/(protected)/impersonation/page.tsx` fetches the
      initial top-20 agency list server-side and passes it down
      (graceful degrade to empty list on error). 16 admin tests
      added: 7 client-lib `listAgencies` (URL composition, trim,
      floor, normalisation, error propagation) + 9 form selector
      (agency input/button/list, empty state, click-to-select,
      hidden field wiring, manual fallback toggle + drive,
      back-to-selector). Replaced the four old V1 raw-ULID form
      tests; relabelled with selector-aware names. Admin
      typecheck + lint + test (189/189, was 173) + build clean
      (`/impersonation` 1.91 KB → 2.82 KB JS). Root suite shows
      the pre-existing search MinIO/DB baseline failure only
      (1 file, 2 tests). **Auth0 local smoke-testing still
      pending** — real dev-tenant credentials are not configured
      locally; deferred until those land.
      **No advanced filters. No pagination beyond top 50. No
      live debounced search. No backend changes outside
      `admin-agencies/`. No JwtAuthGuard change. No new
      permission. No dev-token bypass.**
- [x] **ADR-027 impersonation UI v1 (2026-05-10) — Slice 3.**
      First operator UI on top of the ADR-029 foundation.
      `apps/admin/lib/impersonation-client.ts` (server-only) wraps
      `apiFetch` with three typed functions:
      `getActiveImpersonation()`, `startImpersonation(input)`,
      `stopImpersonation()`. Wire types mirror the API exactly.
      `app/(protected)/impersonation/actions.ts` (`'use server'`)
      exports `startImpersonationAction` (validates ULID + non-empty
      ticketRef/reasonText, maps typed `Api*Error` → form-state
      messages, on success revalidates `/` layout + `/impersonation`
      then redirects to `/impersonation`) and `stopImpersonationAction`
      (idempotent, swallows errors, revalidates). Form-state types in
      sibling `form-state.ts` (Next forbids non-function exports from
      `'use server'` files).
      New components:
        - `components/ImpersonationBanner.tsx` (server) — `<Banner
          variant="danger">` with account name + ID + ticketRef +
          expiry + READ_ONLY warning + End-impersonation submit form.
        - `components/ImpersonationActiveCard.tsx` (server) — full
          grant detail dl (target, ticket, reason, scope, startedAt,
          expiresAt) + Stop button.
        - `components/ImpersonationStartForm.tsx` (`'use client'`,
          uses `useActionState`) — three required fields (Input for
          targetAccountId with helper text explicitly stating "no
          agency selector yet — paste from support ticket"; Input
          for ticketRef; Textarea for reasonText) + inline
          field/form error display.
      `components/SystemBanner.tsx` now accepts optional
      `impersonation` prop and renders `<ImpersonationBanner>` when
      set; null when absent (existing test H still passes).
      `components/AdminShell.tsx` threads `impersonation` from
      layout to SystemBanner.
      `components/Sidebar.tsx` gains an Impersonation link.
      `app/(protected)/layout.tsx` calls `getActiveImpersonation()`
      when `identity.impersonation` is present; degrades gracefully
      to no banner on null (TTL race) or thrown error (5xx /
      network). No tokens flow to client components.
      `app/(protected)/impersonation/page.tsx` (new) renders the
      active card OR the start form based on
      `getActiveImpersonation()`.
      Tests: new `lib/__tests__/impersonation-client.test.ts` (7
      tests A–G covering endpoints, methods, body shapes, response
      parsing, error propagation, idempotency); existing
      `layout-components.test.tsx` extended from 18 to 39 tests
      (added H2 for SystemBanner impersonation render; K2 for
      Sidebar Impersonation link; R2 for AdminShell threading
      impersonation; S–Y for ImpersonationBanner; Z–FF for
      ImpersonationActiveCard; GG–JJ for ImpersonationStartForm);
      `server-only-boundary.test.ts` extended to include
      `lib/impersonation-client` in the static-source scan list and
      its `server-only` top-line guard. Admin tests 173/173 (was
      145, +28). Admin typecheck + lint + build clean; new route
      `/impersonation` shows as `ƒ` (Dynamic) in the build table.
      Root suite shows pre-existing Docker-down failures (no Docker
      Desktop on this machine); slice-relevant API tests
      (impersonation service + controller + flow + JwtAuthGuard) all
      47/47 pass.
      **V1 limitation (documented in README + form helper text +
      catalogue): raw 26-char ULID input only; no agency selector.
      Deliberate scope call — requires a tenant-scoped agency-search
      endpoint that does not exist. Operator pastes ULID from a
      support ticket; backend still validates AGENCY + same-tenant.**
      **No role UI. No audit UI. No backend changes. No JwtAuthGuard
      change. No dev-token bypass.**
- [x] **ADR-029 D4 amendment (2026-05-10) — admin gate impersonation
      carve-out.** `apps/admin/lib/session.ts` admits operators
      currently impersonating an AGENCY account. New typed
      `MeImpersonationBlock` mirrors the ADR-027 D6 AuthContext block
      (`grantId`, `actorUserId`, `actorAuth0Sub`,
      `actorUserClass: 'OPERATOR'`, `expiresAt`,
      `scope: 'READ_ONLY'`). New `isValidImpersonationBlock()`
      type-guard runs strict validation (every field non-empty;
      `actorUserClass` and `scope` literal-locked). Gate logic:
      `userClass === 'OPERATOR'` accepted as before; `userClass ===
      'AGENCY'` accepted only when impersonation block validates;
      else `NotOperatorError` → `/not-operator` (unchanged).
      `OperatorIdentity` gains optional
      `impersonation: { grantId, expiresAt, scope }`; tokens and full
      session never leak. ADR-029 D4 amended in-file with a dated
      annotation; ADR-029 INDEX row reflects amendment.
      Tests: session.test.ts gains S/T/U/V/W/X/Y/Z/AA covering
      accept-OPERATOR-no-impersonation, accept-impersonating, reject
      no-impersonation, reject `actorUserClass='AGENCY'`, reject
      missing grantId, reject `scope='READ_WRITE'`, reject
      non-object impersonation, reject array, no token leakage.
      protected-layout.test.ts gains test I (impersonating-operator
      success path). 145/145 admin tests pass (was 135, +10); 736
      root passes (was 726, +10) with same 4 MinIO baseline. Admin
      typecheck + lint + build clean. **No banner. No /impersonation
      route. No backend changes. No JwtAuthGuard change. No new
      permissions. No dev-token bypass.**
- [x] **ADR-027 active-grant UI prep (2026-05-10) — GET
      /impersonation/active returns target account name.**
      Backend-only slice unblocking the future ADR-027 D11 banner.
      New `ImpersonationGrantRepository.findActiveWithTargetByActor`
      does an INNER JOIN of `impersonation_grant` to `core_account`
      on `(target_account_id, tenant_id)` (defense-in-depth against
      retroactive re-tenanting). `ImpersonationService.getActiveGrant`
      now returns `ActiveImpersonationView | null` =
      `{ grant: ImpersonationGrantRecord, target: { accountId,
      accountName } } | null`. `ImpersonationController.active`
      passes through. Hot path unchanged: `JwtAuthGuard` continues
      to use the simpler `findActiveByActor` (no JOIN per
      authenticated request). Tests: service test K replaced with
      view-shape assertions; new test L2 pins that
      `findActiveByActor` is NOT called from the UI path; controller
      test I asserts `{ grant, target }` shape; e2e flow test step
      3 asserts the new HTTP shape; in-memory grant repo in the
      flow test gains `findActiveWithTargetByActor`. Start response
      and stop response unchanged. 36/36 impersonation tests +
      23/23 hot-path tests + 726 root passes (was 725, +1) with
      same 4 MinIO baseline failures unrelated to this slice.
      No UI built. No AuthContext change. No JwtAuthGuard hot-path
      change. No new permissions. No new endpoints.
- [x] **ADR-029 step 4 (2026-05-10) — operator-class layout gate.**
      New `apps/admin/app/(protected)/layout.tsx` calls
      `requireOperatorSession()` and maps `UnauthorizedError` →
      `redirect('/auth/login')`, `NotOperatorError` →
      `redirect('/not-operator')`, anything else rethrows for Next's
      default error UI. Exports `dynamic = 'force-dynamic'` and
      `revalidate = 0` (ADR-029 D6: an operator-class check must
      never be served from a stale render). Home page moved
      `apps/admin/app/page.tsx` → `apps/admin/app/(protected)/page.tsx`
      via `git mv` so it inherits the gate; URL stays `/`. New
      home renders `Signed in as <displayName | email | auth0Sub>`
      via a second `requireOperatorSession()` call (ADR-029 D3
      latency tradeoff accepted). New public-shape
      `apps/admin/app/not-operator/page.tsx` renders the static
      403 with a `Sign out` link. Root `apps/admin/app/layout.tsx`
      stays minimal (html/body) so SDK-mounted `/auth/*` routes
      and `/not-operator` render without the gate. `next build`
      route table confirms: `/` is `ƒ` (Dynamic), `/not-operator`
      + `/_not-found` are `○` (Static). New tests:
      `apps/admin/app/__tests__/protected-layout.test.ts` (8 tests:
      `dynamic` + `revalidate` exports, success render, redirects
      on Unauthorized + NotOperator, rethrow on SessionApiError +
      unexpected, single-call invariant) using `vi.hoisted` shared
      state and a `RedirectSentinel` mock for `next/navigation`;
      `apps/admin/app/__tests__/server-only-boundary.test.ts`
      (4 tests: static-source scan that no `'use client'` file in
      `app/` or `components/` imports `lib/session` / `lib/auth0` /
      `lib/api-client`, and that all three modules start with
      `import 'server-only';`). Vitest configs (admin + root)
      gained `esbuild.jsx = 'automatic'` so JSX in App-Router
      sources transforms cleanly under tests; root vitest include
      extended to `apps/*/app/**/*.{test,spec}.{ts,tsx}` so CI
      runs the layout + boundary tests. Lint + typecheck + admin
      tests (92/92, was 80, +12) + admin build all clean. Root
      `pnpm test` 682 passed (was 670, +12) with the same 4
      MinIO-baseline failures unrelated to this slice.
      **No design-system components, no Header/Sidebar, no
      operator features built; access tokens stay server-side
      (boundary statically asserted).**
- [x] **ADR-029 step 5 (2026-05-10) — design-system v0 components.**
      Installed Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/postcss`,
      `postcss`) in `apps/admin`; `postcss.config.mjs` uses the v4
      single-plugin format; `app/globals.css` has `@import 'tailwindcss'`;
      root layout imports the stylesheet. Five components created in
      `apps/admin/components/`:
        - `Button` (`'use client'`) — `primary | secondary | danger | ghost`
          variants; `sm | md` sizes; disabled state; visible focus ring
          (`focus-visible:outline-2`).
        - `Input` (`'use client'`) — `label` (required), `helperText`,
          `errorText`; auto-generates `id` from label; `aria-describedby`
          wired to helper/error `<p>`; `aria-invalid` on error;
          helper hidden when error is shown.
        - `Textarea` (`'use client'`) — same a11y pattern as Input.
        - `Card` (server-compatible) — optional `title` renders `<h2>`
          header above content wrapper.
        - `Banner` (server-compatible) — `info | warning | danger`
          variants; `role="status"` for info, `role="alert"` for
          warning/danger; `aria-label` reflects variant name.
      Dev-only preview page at `app/__preview/page.tsx` calls
      `notFound()` in production (verified: route is absent from the
      `next build` route table in production mode, available in dev).
      Tests: `components/__tests__/components.test.tsx` (21 DOM tests
      A–U: renders, label association, helper/error text, disabled
      state, banner roles/aria; uses `@testing-library/react` +
      `happy-dom` + `@testing-library/jest-dom`);
      `components/__tests__/component-boundaries.test.ts` (3 static
      source scans V–X: no server-only/next-server imports,
      interactive components declare `'use client'`). Vitest setup
      extended: `test/stubs/vitest-setup.ts` imports matchers and
      registers `afterEach(cleanup)`; `test/stubs/jest-dom.d.ts`
      extends TypeScript with jest-dom types; both admin and root
      vitest configs gain `setupFiles` pointing to the setup file;
      root config gains `apps/*/components/**/*.{test,spec}.{ts,tsx}`
      include. Lint + typecheck + admin tests (116/116, was 92, +24)
      + build all clean. Root `pnpm test` 706 passed (was 682, +24)
      with the same 4 MinIO-baseline failures unrelated to this slice.
      **No Header/Sidebar yet. No operator features. Components stay
      in `apps/admin/components/` (not promoted to `packages/ui`).**
- [x] **ADR-029 step 6 (2026-05-10) — layout v0.** Four server-compatible
      layout components created in `apps/admin/components/`:
        - `AdminShell` — top-level wrapper: `<SystemBanner />` →
          `<Header />` → `<aside><Sidebar /></aside>` + `<main>`.
          Accepts `displayName: string` and `children`.
        - `Header` — `<header>` landmark; "Beyond Borders / Admin"
          label; operator display name; "Sign out" anchor to
          `/auth/logout`; optional `actions` slot.
        - `Sidebar` — `<aside>` containing `<nav aria-label="Main
          navigation">` with a single Home link to `/`.
        - `SystemBanner` — renders `null` (empty slot; ADR-027
          impersonation alert mounts here in a later slice).
      `(protected)/layout.tsx` updated: resolves `displayName`
      (`name ?? email ?? auth0Sub`) from the typed identity and
      wraps `{children}` in `<AdminShell displayName={displayName}>`.
      No tokens reach the shell or any child component.
      `(protected)/page.tsx` updated: removed its own `<main>` wrapper
      (AdminShell now owns the sole `<main>` landmark; nested `<main>`
      is invalid HTML).
      Boundary test Y added: `component-boundaries.test.ts` asserts
      that `AdminShell`, `Header`, `Sidebar`, `SystemBanner` do NOT
      start with `'use client'` (server-component invariant).
      18 DOM tests A–R added in
      `components/__tests__/layout-components.test.tsx` (Header labels,
      Sidebar nav landmark + Home link, SystemBanner null render,
      AdminShell banner/nav/main landmarks + children-in-main +
      sign-out/Home link assertions). Lint + typecheck + admin tests
      (135/135, was 116, +19) + build clean (`/` = ƒ Dynamic,
      `/not-operator` = ○ Static). Root `pnpm test` 725 passed (was
      706, +19) with the same 4 MinIO-baseline failures.
      **No impersonation UI. No role-management. No agency portal.**
- [x] **ADR-029 step 7 (2026-05-10) — README + continuity-doc tidy.**
      `apps/admin/README.md` status line updated to "foundation
      complete (all 7 steps)". ADR-029 implementation status
      propagated to: `docs/adrs/ADR-029-admin-app-foundation.md`
      (Status → `Accepted (implemented 2026-05-10)`; D8 Auth0 config
      block corrected to v4 paths: `/auth/callback`, `APP_BASE_URL`);
      `docs/adrs/INDEX.md` (row → `Accepted (implemented 2026-05-10)`);
      `docs/product/capability-catalog.md` (admin foundation row →
      `implemented`, operator impersonation UI description updated to
      reflect ADR-029 is complete and this is the immediate next
      slice). `docs/PROJECT-STATE.md` ADR-029 section body updated
      (all-7-complete summary, step 7 entry added, stale "step 6
      next" text replaced, recent commits refreshed). `TASKS.md`
      updated with next slice. No source code changes. Admin tests
      still 135/135, root 725/725 with same 4 MinIO-baseline
      failures.
      **ADR-029 foundation is fully implemented. ADR-027
      impersonation UI is now unblocked.**
- [ ] **Next — ADR-027 impersonation UI.** First feature slice on
      top of the ADR-029 foundation. Scope per ADR-027 D10/D11:
      persistent `<Banner variant="danger">` in the `<SystemBanner />`
      slot on every authenticated operator page; start/stop/active
      page at `apps/admin/app/impersonation/`. ADR-027 backend is
      fully shipped. Strictly blocked on ADR-029 step 7 merging
      (done). ADR-029 D1: no operator feature ships until step 7
      merges — that gate is now cleared.
- [x] **ADR-029 step 3 (2026-05-10) — server-side API client.**
      `apps/admin/lib/api-client.ts` exports `apiFetch<T>(method,
      path, opts?)` plus a typed error hierarchy: `ApiError` base
      + `ApiUnauthorizedError` (401 or no token), `ApiForbiddenError`
      (403), `ApiNotFoundError` (404), `ApiConflictError` (409),
      `ApiValidationError` (400 with parsed `bodyJson` when JSON),
      `ApiServerError` (5xx + any other non-2xx), `ApiNetworkError`
      (chains via `Error.cause`). Every error carries `requestId`.
      Locked rules per ADR-029 D5/D6/D12: `import 'server-only'`
      fence; `cache: 'no-store'` hard-coded (not a parameter); bearer
      auto-attached via `getAccessToken()` from `lib/session.ts`
      (caller never passes a token); `Content-Type: application/json`
      only when a body is present; `X-Request-Id` propagated when
      the caller passes a valid ULID, otherwise a fresh one is
      minted via the new portable `apps/admin/lib/ulid.ts` (Node +
      Edge runtime via `crypto.getRandomValues`); empty / 204 /
      content-length-0 / non-JSON 2xx all return `undefined`
      cleanly; no retry inside the helper (caller-owned per ADR-029
      D5); no request/response body logging at any level. 28 new
      tests cover bearer attachment, token-retrieval failure,
      cache enforcement (including the "callers cannot override"
      type-laundered case), body / no-body content-type rules,
      every status mapping, empty-body variants, request-id
      generation / propagation / regeneration / error-attachment,
      URL composition, the `server-only` top-line guard, and the
      no-body-logging sanity. Lint + typecheck + admin tests
      (80/80, was 52, +28) + admin build all clean. Root tests
      670 passed (was 642, +28) with the same 4 MinIO-baseline
      failures unrelated to this slice. **No layout, no design-
      system components, no operator feature, no dev-token bypass;
      access tokens stay server-side.**
- [ ] **Next — ADR-029 step 4: operator-class layout gate.**
      `apps/admin/app/layout.tsx` calls `requireOperatorSession()`
      at the top; failure paths render the static `/not-operator`
      page (AGENCY users) or redirect to `/auth/login`
      (unauthenticated). vitest+jsdom smoke test for the
      unauthenticated-redirect path per ADR-029 D10. The api-
      client + session helper are now ready for this slice to
      consume.
- [x] **ADR-029 step 2 (2026-05-10) — Auth0 SDK install + session
      helper.** Installed `@auth0/nextjs-auth0@^4.20.0` in
      `apps/admin` only (no other workspace touched). New artefacts:
      `apps/admin/middleware.ts` mounts the SDK at `/auth/login` /
      `/auth/logout` / `/auth/callback` (verified against installed
      `dist/server/client.d.ts`); `apps/admin/lib/auth0.ts` exports
      lazy `getAuth0Client()` singleton constructed from
      `loadAdminEnv()` (no SDK env fall-back used);
      `apps/admin/lib/session.ts` exports `getSession()`,
      `getAccessToken()`, `requireOperatorSession()` plus typed
      errors `UnauthorizedError`, `NotOperatorError`,
      `SessionApiError`. Both auth + session modules start with
      `import 'server-only';` to fence them from client components
      at `next build` time. `requireOperatorSession()` reads the
      session, acquires an access token, calls backend `/me` with
      `cache: 'no-store'` and `Authorization: Bearer <token>`,
      accepts only `userClass === 'OPERATOR'`, rejects empty
      `roles[]` if the field is present (forward-compat for when
      the API adds roles to /me), and returns a typed
      `OperatorIdentity`. Vitest aliases the `server-only` virtual
      module to a stub
      (`apps/admin/test/stubs/server-only.ts`); root
      `vitest.config.ts` mirrors the alias so CI's `pnpm test`
      runs admin tests. 18 new session tests cover happy path,
      missing session, getAccessToken failure / empty / whitespace,
      /me network / 401 / 403 / 5xx / invalid-JSON, AGENCY
      rejection, empty-roles rejection, `cache: 'no-store'` and
      bearer-header construction, base-URL composition, and the
      `server-only` top-line guard on both modules. Lint +
      typecheck clean; admin tests 52/52 (was 34, +18); root tests
      642 passed (was 624, +18) with the same 4 MinIO-baseline
      failures unrelated to this slice. **No login UI; no admin
      layout; no design-system components; no API client beyond
      what /me needs inside the session helper.**
- [ ] **Next — ADR-029 step 3: API client.** `apps/admin/lib/api-client.ts`:
      typed error class hierarchy
      (`ApiUnauthorizedError`, `ApiForbiddenError`,
      `ApiNotFoundError`, `ApiConflictError`,
      `ApiValidationError`, `ApiServerError`, `ApiNetworkError`),
      `cache: 'no-store'` hard-coded inside the helper, bearer
      auto-attached via `getAccessToken()`, X-Request-Id
      propagation, no retry inside the helper.
- [x] **ADR-029 step 1 (2026-05-10) — env scaffolding + Auth0 SDK
      verification notes.** New artefacts in `apps/admin/`:
      `.env.example` (9 required vars, every name verified against
      `@auth0/nextjs-auth0` v4 docs via Context7); `lib/env.ts`
      (`loadAdminEnv()` + `AdminEnvError`, loud-fail on missing/
      malformed vars, ULID + URL + AUTH0_DOMAIN-shape validation,
      `openid` required + `offline_access` rejected per ADR-029 D8,
      no fallback defaults); `lib/__tests__/env.test.ts` (34 tests,
      every error path); `vitest.config.ts` (widens include to
      `lib/**/*.test.ts` since admin uses `lib/` not `src/`);
      `README.md` (dev-tenant setup, no-bypass policy, SDK
      route-convention findings: v4 mounts `/auth/login` |
      `/auth/logout` | `/auth/callback`, NOT `/api/auth/*`; v4
      env-name discrepancy documented). Root `vitest.config.ts`
      include extended to `apps/*/lib/**/*.test.ts` so CI picks up
      the admin tests via `pnpm test`. **ADR-029 D8 patched** —
      `AUTH0_BASE_URL` → `APP_BASE_URL`, `AUTH0_ISSUER_BASE_URL` →
      `AUTH0_DOMAIN`, with a 2026-05-10 verification annotation
      (D2 already required this verification). Lint + typecheck
      clean; admin tests 34/34 pass; root tests 624 passed (was 590,
      +34) with the same 4 MinIO-baseline failures unrelated to this
      slice. **No SDK installed; no UI code; no login flow.**
- [ ] **Next — ADR-029 step 2: Auth0 SDK install + `lib/session.ts`
      (`requireOperatorSession()`).** Run `npm view
      @auth0/nextjs-auth0 versions`, install latest stable v4.x,
      re-verify route conventions against the installed README,
      record version + paths in PR description. Then write the
      session helper backed by `loadAdminEnv()`. Tests cover no
      session, AGENCY user (rejected), valid operator, `/me` failure.
- [x] **ADR-029 accepted (2026-05-10) — admin app foundation: auth,
      session, API client, layout, design system v0.** Locks the
      foundation slice that must ship before any operator UI feature
      lands in `apps/admin`. Auth0 Universal Login via
      `@auth0/nextjs-auth0` v4; single `lib/session.ts` with
      `requireOperatorSession()` as the only allowed reader of
      session state; single server-side `lib/api-client.ts`
      (`cache: 'no-store'`, bearer auto-attached, typed error class
      hierarchy, no retry inside the helper); operator-only layout
      gate that 403s AGENCY users to a static page; Tailwind +
      shadcn-copy 5-component v0 (`Button`, `Input`, `Textarea`,
      `Card`, `Banner`) in `apps/admin/components/`; layout v0
      (Header / `<SystemBanner />` slot / Sidebar / main); single-
      tenant per deployment via `BB_TENANT_ID`; vitest+jsdom for V0.1
      smoke; no `offline_access`; no dev-token bypass; manual OIDC
      via `openid-client` kept only as escape hatch. Continuity
      docs updated: `INDEX.md` (new "Frontend / Admin App" section
      + dependency-graph entry), `PROJECT-STATE.md` (design-locked
      cluster + immediate-next-slice options), `capability-catalog.md`
      (admin-app-foundation + impersonation-UI rows under §15
      Admin & Internal Surfaces), `TASKS.md` (this entry).
- [ ] **Next slice — ADR-029 admin app foundation implementation
      (Phase 1 frontend track).** Smallest safe sequence per
      ADR-029 §"Implementation order":
        1. Env scaffolding (`apps/admin/.env.example`,
           `next.config.ts` env validation, fail-loud-on-missing).
        2. Auth0 SDK install + `lib/session.ts`
           (`requireOperatorSession()`).
        3. `lib/api-client.ts` (typed error classes, header
           construction, `cache: 'no-store'` enforcement).
        4. Operator-class layout gate + static `/not-operator` page +
           vitest+jsdom smoke (unauthenticated GET / → 302 to
           login).
        5. Design-system v0: 5 components in
           `apps/admin/components/`, Tailwind setup, `/_dev/components`
           visual smoke gated to non-production.
        6. Layout v0: Header / `<SystemBanner />` slot / Sidebar /
           main; sign-out wired; Home → `/`.
        7. `apps/admin/README.md` + continuity-doc updates.
      No operator feature ships in `apps/admin` until step 7 merges.
- [ ] **Next-after-foundation — ADR-027 impersonation UI slice.**
      Persistent banner mounts in the `<SystemBanner />` slot from
      ADR-029 step 6; status / start / stop page lives at
      `/impersonation`. Strictly blocked on ADR-029 implementation;
      do not start until the 8 "what must be proven" gates from
      ADR-029 are demonstrated on a green CI build.
- [x] **ADR-027 V1.0 hardening + e2e backend verification (2026-05-10)**
      — TTL bounds enforced (default 30 min, min 5, max 240; invalid env
      values throw at startup via `parseTtlMinutes`); `JwtAuthGuard` adds
      defense-in-depth check that `grant.tenantId === user.tenantId` and
      falls through to OPERATOR-self context on mismatch.
      `impersonation-flow.test.ts` boots a real Nest app (real
      `JwtAuthGuard` + `RolesGuard` + `PermissionResolverService` +
      `ImpersonationService` + `ImpersonationController` + `SearchController`,
      stateful in-memory grant repo, mocked audit + DB) and drives the
      full HTTP lifecycle: ticketRef-required, start success +
      IMPERSONATION_STARTED audit, GET /active, /search runs
      AGENCY-shaped, body-vs-AuthContext mismatch still 403,
      stop + IMPERSONATION_ENDED audit, /search after stop returns
      403 (operator-as-self denied). 8 new tests. Migration verified
      against local Postgres: partial unique index blocks two un-ended
      grants for the same actor; ended-then-new is allowed.
      `SearchController` operator-block message updated from
      "impersonation not yet supported" to "active impersonation
      required" / "Operator search requires an active impersonation
      grant (ADR-027)". Lint + typecheck clean.
- [x] **ADR-027 V1.0 — operator impersonation** — `impersonation_grant`
      migration (partial unique index, lifecycle constraints, 3 indexes);
      `ImpersonationGrantRepository` (`findActiveByActor`,
      `findUnendedByActor`, `insert`, `end`);
      `ImpersonationService` (start validates ticketRef/reasonText/account
      type/tenant/existing grants, auto-ends expired un-ended grant, emits
      `IMPERSONATION_STARTED/ENDED/START_REJECTED` via `emitInTransaction`;
      stop emits `IMPERSONATION_ENDED`; getActive delegates);
      `ImpersonationController` (`POST /impersonation/start`,
      `POST /impersonation/stop`, `GET /impersonation/active`; all guarded
      `JwtAuthGuard + RolesGuard + @RequirePermission(IMPERSONATE_AGENCY_ACCOUNT)`);
      `AuthContext.impersonation` block; `JwtAuthGuard` rewritten to flip
      `userClass → 'AGENCY'`, set `accountId = grant.targetAccountId`,
      call `setRequestActor` + `setImpersonationGrantId` on every auth;
      `PermissionResolverService` impersonation branch
      `(agency/account_admin) ∩ READ ∖ IMPERSONATION_DENY_INITIAL +
      IMPERSONATE_AGENCY_ACCOUNT`; `PERMISSION_KIND` map + compile-time
      exhaustiveness via `satisfies`; `AuthModule` updated;
      `search.controller.guards.test.ts` `GuardTestModule` fixed for new
      JwtAuthGuard constructor signature. 24 new / extended tests; 191/191
      auth tests pass; 12/12 guard tests pass. Typecheck clean.
- [x] **ADR-028 V1.0 infrastructure (steps 1–5)** — DB roles (`bb_app`,
      `bb_audit_retention`, `bb_admin`); `audit_event` composite-partitioned
      migration with append-only triggers, indexes, grants; `audit_pruning_log`
      migration; `AuditService` with compile-time + runtime category enforcement
      (`emit`/`emitInTransaction`/`emitMany`); `RequestIdMiddleware` (ULID,
      Crockford base32 validation, X-Forwarded-For IP, AsyncLocalStorage);
      `AuditModule` + `AppModule` wiring. 11 AuditService unit tests,
      11 RequestIdMiddleware unit tests, 4 trigger integration tests.
      Typecheck clean. Unblocks ADR-027 V1.0.
- [x] **ADR-026 Slice E4-B** — body-vs-AuthContext reconciliation
      for `/search`. Closes the main remaining risk before treating
      `/search` as secure for shared use. Locked V1 rule:
      `tenantId` and `accountId` are derived from `AuthContext`,
      never trusted from the body. AGENCY users: if the body
      provides either field, it must equal the AuthContext value;
      mismatch → 403, omit → derived. Body fields are now optional.
      OPERATOR users (including `platform_admin`, which holds
      `SEARCH_EXECUTE` per the locked D8 rule): 403 with policy
      message `"Operator search requires impersonation; not
      supported in V1 (ADR-026 E8)"` — operators have no
      `accountId`, search is account-scoped, and the impersonation
      flow (E8) is the right path. Failure mode is uniformly 403,
      never 400, because foreign-accountId-in-well-formed-body is
      an authorization concern. `parseRequest` refactored into
      `parseSearchBody` returning optional `bodyTenantId` /
      `bodyAccountId`; the handler injects `@Auth() auth` and
      composes the typed `SearchRequest` from AuthContext + parsed
      body. Defense-in-depth: AGENCY AuthContext with null/empty
      `accountId` short-circuits to 403 before any DB call. Tests:
      new `search.controller.reconciliation.test.ts` (14 tests:
      allow / omit / mismatch on each field / OPERATOR-403 /
      defense-in-depth) plus two added cases in
      `search.controller.guards.test.ts` (HTTP-level: operator with
      `SEARCH_EXECUTE` still 403; AGENCY body.accountId mismatch
      → 403). Existing `search.controller.test.ts` business-logic
      integration tests updated: the pass-through `JwtAuthGuard`
      stand-in now echoes body IDs into a synthetic AGENCY
      `AuthContext` so reconciliation passes. Pattern doc
      `docs/architecture/auth-endpoint-retrofit-pattern.md`
      updated with the reconciliation step, the OPERATOR-403
      branch, and a Layer C test guideline. Typecheck + lint +
      build clean; 26 search guard+reconciliation tests pass.
- [x] **ADR-026 Slice E4-A** — first endpoint-retrofit pattern for
      human auth + permissions. `SearchController` (`POST /search`)
      gated with `@UseGuards(JwtAuthGuard, RolesGuard)` +
      `@RequirePermission(PERMISSIONS.SEARCH_EXECUTE)`. `SearchModule`
      now imports `AuthModule` so the guard providers resolve at DI
      time. `MeController` (`GET /me`) deliberately stays on
      `JwtAuthGuard` only — it is the identity-baseline probe and a
      `RolesGuard` on it would require new auth architecture (a
      `SELF_READ` permission), which the slice forbids. Tests:
      `apps/api/src/search/__tests__/search.controller.guards.test.ts`
      with two layers — Layer A (Reflector / metadata pin: guard
      order, decorator presence, role-permission matrix sanity) and
      Layer B (HTTP exercise via a Nest test app with the real
      `JwtAuthGuard` + `RolesGuard`, mocked validator/sync/resolver,
      driven by `fetch`): 10/10 passing. Existing
      `search.controller.test.ts` business-logic integration tests
      override both guards with a pass-through stand-in so they
      remain focused on pricing/sourcing/restriction assertions.
      Added
      `docs/architecture/auth-endpoint-retrofit-pattern.md` as the
      reusable runbook for future retrofit slices (E5, etc.).
      `/internal/*` routes unchanged — `InternalAuthGuard` continues
      to gate them. Typecheck + lint + build clean; new guard tests
      pass; pre-existing MinIO-dependent integration test is
      environmental, not a regression.
- [x] **ADR-026 Slice E2-B** — admin provisioning + Auth0 webhook
      ingestion + bootstrap script. Adds `Auth0ManagementTokenService`
      (M2M client_credentials cache, in-flight de-dup, near-expiry
      proactive refresh), `Auth0ManagementClient` (narrow surface:
      createUser/updateUser/deleteUser/getUserById; namespaced
      `app_metadata` carries tenant_id + user_class + account_id),
      `UserProvisioningService` (operator + agency provisioning,
      Auth0-first then DB transaction holding `core_user` +
      `user_account_membership` (agency only) + `user_role` grants
      atomically; compensating Auth0 deleteUser on DB failure;
      class-coherence + role-class checks fail loud at write time;
      409 → `EmailAlreadyTakenError`; membership unique_violation →
      `MembershipAlreadyExistsError`). `Auth0WebhookSignatureService`
      verifies HMAC-SHA256 over `${ts}.${rawBody}` with replay
      window (default 5 min); main.ts wires Express raw-body capture
      so JSON.stringify reordering can never break verification.
      `Auth0EventIngestionRepository` writes to the existing
      `auth0_event_ingestion` ledger; `Auth0EventHandlerService`
      processes `sce`/`scu` (email refresh), `scn` (display_name),
      `sd` (deactivate), `sapi` Block/Unblock; per-entry transactions;
      malformed-entry isolation; unknown types ledger-only. `POST
      /webhooks/auth0` (`Auth0WebhookController`) returns uniform 401
      on signature failure or missing raw body, 200 with batch summary
      otherwise. `BootstrapPlatformAdminService` + CLI entry
      (`apps/api/src/auth/bootstrap/bootstrap-platform-admin.ts`)
      idempotently creates the first `platform_admin`: read-or-insert
      `core_user`; reactivate if previously DEACTIVATED; idempotent
      `platform_admin` grant via existing partial unique index.
      Config: `auth.config.ts` extended with optional
      `management: Auth0ManagementConfig | null` (all-or-nothing
      M2M creds) and `webhookSecret: string | null`. Tests: 7 new
      test files, 158/158 auth tests passing; typecheck + lint +
      build clean.
- [x] **ADR-021 2026-04-22** — rate, offer, restriction, and
      occupancy model. Three layers kept separate: canonical product
      dimensions (`hotel_room_type`, `hotel_rate_plan`,
      `hotel_meal_plan`, `hotel_occupancy_template`,
      `hotel_child_age_band` + four `*_mapping` tables), authored
      rate primitives (`rate_auth_*` — base price, extra-person
      rule, meal supplement, tax/fee components, restriction,
      allotment, cancellation policy), and sourced offer snapshots
      (`offer_sourced_snapshot`, `offer_sourced_component`,
      `offer_sourced_restriction`,
      `offer_sourced_cancellation_policy`). New enums
      `OfferShape ∈ {SOURCED_COMPOSED, AUTHORED_PRIMITIVES,
      HYBRID_AUTHORED_OVERLAY}` and
      `RateBreakdownGranularity ∈ {TOTAL_ONLY, PER_NIGHT_TOTAL,
      PER_NIGHT_COMPONENTS, PER_NIGHT_COMPONENTS_TAX,
      AUTHORED_PRIMITIVES}`. Shared `RestrictionKind` enum across
      authored and sourced shapes. Booking-time snapshots
      (`booking_sourced_offer_snapshot`,
      `booking_authored_rate_snapshot`,
      `booking_cancellation_policy_snapshot`,
      `booking_tax_fee_snapshot`) immutable, written in the
      `CONFIRMED` transaction. Amends ADR-002, ADR-003 (adapter
      declares `offer_shape` + `min_rate_breakdown_granularity` in
      meta; `SupplierRate` carries the shape fields), ADR-004
      (pricing evaluator gains `SOURCED_COMPOSED` and
      `AUTHORED_PRIMITIVES` code paths; pricing trace carries
      shape + granularity), ADR-010 (snapshots written in same
      transaction as `CONFIRMED`), ADR-011 (new `rate_` and
      `offer_` prefixes; `hotel_` / `booking_` extended), ADR-013
      (authored-primitives push writes `rate_auth_*`; composed push
      continues `supply_ingested_rate`).
- [x] Update `docs/data-model/entities.md` — canonical product
      dimensions, sourced-offer snapshot entities, authored-rate
      primitive entities, booking-time snapshot entities; extended
      table-prefix ownership rows.
- [x] Amend `docs/adrs/ADR-011-monorepo-structure.md` — new `rate_`
      and `offer_` prefixes; `hotel_` and `booking_` row extensions;
      infra/migrations layout additions for `rates/` and `offers/`.
- [x] Amend `docs/roadmap.md` — Phase 0 adds ADR-021; Phase 1 ships
      rate-model migrations (canonical dims + mappings + sourced-
      offer snapshot tables) **before** the Hotelbeds adapter;
      Phase 2 adds booking-time snapshot tables (sourced write path
      + empty authored target); Phase 3 adds `rate_auth_*` tables
      and the authored booking-snapshot write path.
- [x] Amend `CLAUDE.md` §9 (compact checklist item 12) and §10
      (two new invariants: authored-vs-sourced shape separation;
      booking-time snapshots immutable, live shape stays on supply
      side).
- [x] **ADR-021 amendment 2026-04-23** — static seasonal contract-
      rate layer + promotion overlay for authored rates. New
      `AuthoringMode ∈ {SEASONAL_CONTRACT, PER_DAY_STREAM}` under
      `OfferShape = AUTHORED_PRIMITIVES`. New entities:
      `rate_contract`, `rate_contract_season`,
      `rate_contract_season_date_band`, `rate_contract_price`,
      `rate_promotion`, `rate_promotion_scope`,
      `rate_promotion_rule`. Optional nullable `contract_id?` /
      `season_id?` narrowing columns added (additive) to
      `rate_auth_extra_person_rule`, `rate_auth_meal_supplement`,
      `rate_auth_restriction`, `rate_auth_cancellation_policy`,
      and `contract_id?` on `rate_auth_fee_component`.
      `rate_auth_base_price`, `rate_auth_tax_component`, and
      `rate_auth_allotment` do not take contract columns.
      Promotion behavior: `discount_kind ∈ {PERCENT,
      FIXED_AMOUNT_PER_NIGHT, FIXED_AMOUNT_PER_STAY,
      NTH_NIGHT_FREE}`; `applies_to ∈ {PRE_SUPPLEMENT_BASE,
      POST_SUPPLEMENT_PRE_TAX, POST_TAX}` (default
      `POST_SUPPLEMENT_PRE_TAX`); stay / booking windows;
      priority; stackable with per-pair STACKING rules.
      Restrictions stay separate in `rate_auth_restriction`.
      Copy-season is a transactional service with
      `copied_from_season_id` lineage + `AuditLog SEASON_COPY`
      entry; new season starts in `DRAFT`. Sourced offers
      untouched.
- [x] Update `docs/data-model/entities.md` with seasonal contract
      entities, promotion entities, copy-season workflow note, and
      `BookingAuthoredRateSnapshot` additive fields. Extended
      `rate_` prefix row.
- [x] Amend `docs/adrs/ADR-011-monorepo-structure.md` `rate_`
      prefix row with the seven new tables.
- [x] Amend `docs/roadmap.md` Phase 3 — seasonal contract +
      promotion migrations land before the direct-paper adapter.
- [x] Create foundational repo docs: CLAUDE.md, README.md, TASKS.md,
      docs/architecture/overview.md, docs/adrs/ADR-001-foundation.md,
      docs/prompts/session-start.md, .gitignore baseline.
- [x] ADR-002 canonical hotel data model
- [x] ADR-003 supplier adapter contract
- [x] ADR-004 pricing rule model and precedence
- [x] ADR-005 static vs dynamic content split
- [x] ADR-006 tenancy and account model
- [x] ADR-007 tech stack (provisional)
- [x] ADR-008 hotel mapping strategy
- [x] ADR-009 merchandising and ranking
- [x] ADR-010 booking orchestration
- [x] ADR-011 monorepo structure
- [x] Update architecture overview to reflect ADRs 002–011
- [x] Domain entities cross-cutting index (`docs/data-model/entities.md`)
- [x] Phased roadmap (`docs/roadmap.md`)
- [x] ADR-012 payments, wallet, credit ledger, payouts
- [x] ADR-013 direct hotel connectivity (CRS / channel managers)
- [x] ADR-014 loyalty, rewards, referral
- [x] ADR-015 market benchmark / intelligent markup
- [x] Amend ADR-003 / ADR-004 / ADR-006 / ADR-010 / ADR-011 for the
      scope expansion (additive sections)
- [x] Update CLAUDE.md §3 / §5 / §6 / §9 / §10 for scope expansion
- [x] Update README.md (sources, wallet, rewards, phased scope)
- [x] Update `docs/architecture/overview.md` (invariants + module map)
- [x] Update `docs/data-model/entities.md` (ledger, rewards,
      rate-intelligence, direct-connect entities + table prefixes)
- [x] Update `docs/roadmap.md` for Phase 2–6 revisions
- [x] Connectivity notes: `docs/suppliers/synxis.md`, `rategain.md`,
      `siteminder.md`, `mews.md`, `cloudbeds.md`, `channex.md`
- [x] Design note: `docs/design/payments.md`
- [x] Design note: `docs/design/rewards-referral.md`
- [x] **ADR-014 amendment 2026-04-22** — margin-based reward economics,
      `recognized_margin` / `rewardable_margin` contract, funding-source
      taxonomy (`PLATFORM_FUNDED | HOTEL_FUNDED | SHARED_FUNDED`), new
      rule types (`PERCENT_OF_MARGIN` *default*,
      `FIXED_REWARD_BY_MARGIN_BRACKET`, `HOTEL_FUNDED_BONUS`,
      `MANUAL_OVERRIDE`, `CAP_AND_FLOOR`), `RewardCampaign`,
      `HotelRewardOverride`, `RewardFundingLeg`, `RewardOverrideAudit`
      entities, margin-based B2B kickback, observability by funder and
      margin band.
- [x] Update `docs/design/rewards-referral.md` §5, anti-patterns, §10
      (travel-reward UX lineage: tiers, redeem-at-booking, post-
      completion crediting, wallet clarity, lifetime points).
- [x] Update `docs/data-model/entities.md` rewards section + reward_
      table prefix list.
- [x] Update `CLAUDE.md` §5 / §9 / §10 with margin-based earning and
      funding-source invariants.
- [x] Update `docs/roadmap.md` Phase 2 (margin default), Phase 3
      (hotel-funded campaigns, manual overrides, B2B kickback v1).
- [x] **ADR-016 2026-04-22** — document generation, numbering,
      storage. Document types (`TAX_INVOICE`, `CREDIT_NOTE`,
      `DEBIT_NOTE`, `BB_BOOKING_CONFIRMATION`, `BB_VOUCHER`,
      `RESELLER_GUEST_CONFIRMATION`, `RESELLER_GUEST_VOUCHER`),
      `LegalEntity`, `DocumentNumberSequence` (gapless per legal
      entity + jurisdiction + fiscal year for legal tax docs),
      `DocumentTemplate`, `BookingDocument`, `DeliveryAttempt`,
      object-storage-backed PDF storage, document issue + delivery
      workers outside the booking saga.
- [x] **ADR-017 2026-04-22** — reseller billing, resale controls,
      branded documents. Reselling as a capability (`ResellerProfile`)
      on AGENCY/SUBSCRIBER accounts; versioned `BillingProfile`,
      `TaxProfile`, `BrandingProfile`, `ResellerResaleRule`
      (FIXED_GUEST_AMOUNT | FIXED_MARKUP_ABSOLUTE | PERCENT_MARKUP
      | HIDE_PRICE), `GuestPriceDisplayPolicy`; branding fallback
      chain; hard separation of source cost / BB sell-to-reseller /
      reseller resale amount.
- [x] Amend ADR-006 (reseller capability + `LegalEntity`),
      ADR-010 (document-issue worker outside saga), ADR-011
      (`packages/documents` + `packages/reseller` + table
      prefixes `doc_` / `reseller_`), ADR-012 (tax invoice is a
      document, not a ledger entry; reseller ledger writes only
      the sell-to-reseller amount).
- [x] Update `docs/data-model/entities.md` with reseller,
      billing, tax, branding, document entities and `doc_` /
      `reseller_` prefixes.
- [x] Update `CLAUDE.md` §2, §5, §9 (items 10–14), §10 for the
      reseller capability model, document model, and ledger-vs-
      document / tax-invoice-vs-commercial-voucher invariants.
- [x] Update `docs/roadmap.md` Phase 2 (document primitives +
      Beyond Borders direct tax invoice + BB voucher + confirmation)
      and Phase 3 (reseller capability + branded guest docs +
      reseller-channel tax invoice + tax engine ADR).
- [x] **ADR-018 2026-04-21** — reseller collections, balances,
      reserves, and payouts. Three settlement modes
      (`RESELLER_COLLECTS` default, `CREDIT_ONLY`,
      `PAYOUT_ELIGIBLE`), two new wallet books
      (`RESELLER_PLATFORM_CREDIT` non-withdrawable,
      `RESELLER_CASH_EARNINGS` withdrawable), earnings state
      machine derived from ledger (pending → available → reserved
      → paid_out with clawback), new ledger kinds, new entities
      (`ResellerKycProfile`, `PayoutAccount`, `ReserveBalance`,
      `WithdrawalRequest`, `PayoutBatch`, `RefundLiabilityRule`),
      hard KYC/KYB + sanctions/PEP + verified-PayoutAccount gating
      for `PAYOUT_ELIGIBLE`, `INDIVIDUAL_NOT_BUSINESS` never
      eligible in MVP, `reseller_collections_suspense` book for
      BB-collected guest payments on reseller-channel bookings.
- [x] Amend ADR-012 (new wallet balance types, new ledger kinds,
      reseller-collections suspense book, extended `PayoutBatch`
      scope; launch gate shared with `CASH_WALLET` jurisdictional
      review) and ADR-017 (`settlement_mode` on `ResellerProfile`,
      split onboarding with KYC + payout-account steps, anti-
      patterns for silent credit-to-cash conversion and routing
      guest payments into a `CASH_WALLET`).
- [x] Update `docs/data-model/entities.md` with reseller settlement
      entities, extended ledger kinds, `reseller_collections_suspense`
      book, and `pay_` / `reseller_` prefix additions.
- [x] Update `docs/architecture/overview.md` with invariants 13–17
      covering reseller settlement mode gating, distinct credit vs
      cash earnings books, ledger-derived state machine, payout
      evidence gate, and `PayoutBatch` reconciliation rule.
- [x] Update `docs/roadmap.md`: Phase 3 ships settlement-mode tables
      and `RESELLER_COLLECTS` only; Phase 4 enables `CREDIT_ONLY`
      with KYC; Phase 5 enables `PAYOUT_ELIGIBLE` per-jurisdiction
      behind the same legal-review gate as `CASH_WALLET`. Historical
      credit-to-cash conversion on upgrade called out as explicitly
      out of scope.
- [x] **ADR-020 2026-04-21** — collection mode and supplier
      settlement mode. Three orthogonal enums: `CollectionMode`
      (`BB_COLLECTS` | `RESELLER_COLLECTS` | `PROPERTY_COLLECT` |
      `UPSTREAM_PLATFORM_COLLECT`), `SupplierSettlementMode`
      (`PREPAID_BALANCE` | `POSTPAID_INVOICE` | `COMMISSION_ONLY`
      | `VCC_TO_PROPERTY` | `DIRECT_PROPERTY_CHARGE`),
      `PaymentCostModel` (`PLATFORM_CARD_FEE` | `RESELLER_CARD_FEE`
      | `PROPERTY_CARD_FEE` | `UPSTREAM_NETTED` |
      `BANK_TRANSFER_SETTLEMENT`). Strict allowed-combinations
      matrix; forbidden triples rejected at source selection before
      pricing runs. New adapter rate fields
      (`gross_currency_semantics`, `commission_basis`,
      `commission_params`), new pricing trace step
      `COLLECTION_AND_SETTLEMENT_BIND`, new saga step `VCC_ISSUED`
      (for `VCC_TO_PROPERTY`). New supplier-side internal books
      (`supplier_prepaid_balance_<id>`,
      `supplier_postpaid_payable_<id>`,
      `supplier_commission_receivable_<id>`, `vcc_issuance_suspense`)
      and new ledger kinds (`SUPPLIER_PREPAID_*`,
      `SUPPLIER_POSTPAID_*`, `SUPPLIER_COMMISSION_*`, `VCC_*`).
      New `COMMISSION_INVOICE` document archetype (BB → supplier /
      upstream), monotonic per tenant+supplier+fiscal_year,
      separate from legal-tax-doc gapless sequences. Mode-aware
      `recognized_margin`: `BB_COLLECTS` includes platform card
      fee, `RESELLER_COLLECTS` excludes it, `COMMISSION_ONLY`
      modes compute margin from the commission stream rather than
      a gross-to-net differential.
- [x] Amend ADR-003 (three axes on `StaticAdapterMeta` and
      `SupplierRate`, supersedes `booking_payment_model`),
      ADR-004 (mode-aware net cost, `COLLECTION_AND_SETTLEMENT_BIND`
      trace step, mode-aware `recognized_margin`), ADR-010 (saga
      branching on `CollectionMode`, `VCC_ISSUED` step between
      `SUPPLIER_BOOKED` and `PAYMENT_CAPTURED`, `FAILED_VCC_LOAD`
      state), ADR-012 (supplier-side books, new `LedgerEntry`
      kinds, `PaymentCostModel` on payment entries, no
      `PaymentIntent` mirror on `PROPERTY_COLLECT` /
      `UPSTREAM_PLATFORM_COLLECT`, reseller earnings accrual
      write-gate requires `BB_COLLECTS`), ADR-017 (cross-link
      with ADR-020 clarifying `RESELLER_COLLECTS` dual meaning),
      ADR-018 (anti-pattern: reseller earnings accrual on
      `PROPERTY_COLLECT` / `UPSTREAM_PLATFORM_COLLECT` rejected
      at ledger-write time).
- [x] Update `docs/data-model/entities.md` with "Money-movement
      axes" section (three enums), extend `SupplierRate` /
      `ConfirmedSupplierRate` / `Booking` to carry the triple,
      add supplier-side internal books, extend `LedgerEntry` kinds
      with `SUPPLIER_*` and `VCC_*`, add `COMMISSION_INVOICE`
      document archetype, tag `doc_` prefix with ADR-020.
- [x] Update `docs/architecture/overview.md` with invariants
      18–22 (three-axis triple declared per rate, forbidden
      combinations filtered at source selection, mode-aware
      `recognized_margin`, no `TAX_INVOICE` on `PROPERTY_COLLECT`
      / `UPSTREAM_PLATFORM_COLLECT`, no `PaymentIntent` mirror
      for money BB never touched).
- [x] Update `docs/roadmap.md`: Phase 1 ships the three enums
      declaratively with forbidden triples enforced; Phase 2 ships
      `BB_COLLECTS` + (`PREPAID_BALANCE` | `POSTPAID_INVOICE`) as
      the only bookable path; Phase 3 enables `VCC_TO_PROPERTY`
      and `PROPERTY_COLLECT` + `COMMISSION_ONLY`; Phase 4 enables
      `UPSTREAM_PLATFORM_COLLECT`. Forbidden combinations listed
      as explicitly out of scope.

## Next (Phase 0 — finishing the foundation)

- [x] Repo scaffolding: `package.json`, `pnpm-workspace.yaml`,
      `turbo.json`, `tsconfig.base.json`, `.prettierrc`,
      `eslint.config.mjs` with `no-restricted-imports` dependency-
      direction enforcement per ADR-011.
- [x] `apps/api` — NestJS shell with `GET /health` endpoint.
- [x] `apps/worker` — NestJS application-context shell; BullMQ
      processors register here in Phase 1.
- [x] `apps/b2c-web`, `apps/b2b-portal`, `apps/admin` — Next.js 15
      App Router shells with placeholder pages and correct
      `tsconfig.json` (ESNext + Bundler resolution).
- [x] `packages/domain` — zero-dependency core types: `Money`,
      `TenantContext`, `CanonicalHotel`, `Account`, `Tenant`,
      three-axis ADR-020 enums (`CollectionMode`,
      `SupplierSettlementMode`, `PaymentCostModel`),
      `MoneyMovementTriple`, `Booking`, `PricingTrace`.
- [x] `packages/supplier-contract` — full `SupplierAdapter` interface
      per ADR-003 + ADR-013 (`IngestionMode`, `ARI_PUSH` capability)
      + ADR-020 (`grossCurrencySemantics`, `commissionParams`,
      three-axis triple on `AdapterSupplierRate`).
- [x] `packages/ledger` — `LedgerEntry`, `WalletAccount`,
      `LedgerEntryKind` (all ADR-012/018/020 kinds), `LedgerPort`.
- [x] `packages/payments` — `PaymentPort` interface (Stripe rail,
      no implementation). ADR-020 no-PaymentIntent guard documented
      in JSDoc.
- [x] `packages/rewards` — `EarnRule`, `RewardPosting`,
      `RewardCampaign`, `FundingSource`, `ReferralInvite`,
      `FraudDecision` (ADR-014 amendment).
- [x] `packages/documents` — `BookingDocument`,
      `DocumentNumberSequence`, `LegalEntity`, `DeliveryAttempt`,
      `COMMISSION_INVOICE` type (ADR-016/020).
- [x] `packages/reseller` — `ResellerProfile`, `BillingProfile`,
      `TaxProfile`, `BrandingProfile`, `ResellerResaleRule`,
      `GuestPriceDisplayPolicy`, `ResellerKycProfile`,
      `PayoutAccount` (ADR-017/018).
- [x] `packages/rate-intelligence` — `BenchmarkReadPort`,
      `BenchmarkSnapshot` (read-only advisory, ADR-015).
- [x] `packages/ui` — placeholder (Phase 1: shadcn/ui).
- [x] `packages/config` — `AppConfig` + `loadConfig()`.
- [x] `packages/testing` — `TEST_TENANT_CONTEXT`, `money()` helper,
      adapter conformance suite placeholder.
- [x] `infra/docker/docker-compose.yml` — Postgres+PostGIS 16,
      Redis 7, MinIO (S3-compatible object storage).
- [x] `infra/migrations/{ledger,payments,rewards,rate-intelligence,
      direct-connect,documents,reseller}/` — empty directories for
      future migrations.
- [x] `.env.example` — local dev environment variable template.
- [x] `README.md` updated — Getting Started, infra URLs, command
      reference, full repo layout.

## Next (Phase 1 — first implementation tasks)

- [x] CI baseline: `.github/workflows/ci.yml` — Node 24, pnpm 10,
      single job: install → build → typecheck → lint → test.
      Root `vitest.config.ts` with `passWithNoTests: true` covers
      all packages; root `"test": "vitest run"` for Phase 0
      (switch back to `turbo run test` in Phase 1 when real tests exist).
- [x] Database tooling baseline — `packages/db` (pg.Pool factory),
      Knex migration runner (`infra/knexfile.ts` + custom
      `ModuleMigrationSource` across module subdirs), `pnpm db:migrate`
      / `pnpm db:rollback` scripts, `DatabaseModule` wired into
      `apps/api`. Migration files:
        `core/20260422000001_core_baseline.ts`   → core_tenant, core_account
        `supply/20260422000002_supply_baseline.ts` → supply_supplier (FK dep)
        `hotel/20260422000003_hotel_baseline.ts`  → hotel_canonical,
          hotel_supplier, hotel_mapping (PostGIS GIST indexes)
        `booking/20260422000004_booking_shell.ts` → booking_booking
          (ADR-020 triple immutable at confirmation)
- [ ] OpenTelemetry wiring — Pino logger + OTel trace/metric
      providers in `apps/api` and `apps/worker`.
- [x] **Rate-model Phase 1 migrations (ADR-021) — unblocks Hotelbeds
      adapter.** Files:
        `rates/20260423000005_rates_canonical_product_dimensions.ts` →
          `hotel_room_type`, `hotel_rate_plan`, `hotel_meal_plan`
          (canonical_hotel_id nullable for platform-global RO/BB/HB/FB/AI
          with partial unique indexes), `hotel_occupancy_template`
          (global + rate-plan-narrowed partial uniques),
          `hotel_child_age_band`
        `rates/20260423000006_rates_product_dimension_mappings.ts` →
          `hotel_room_mapping`, `hotel_rate_plan_mapping`,
          `hotel_meal_plan_mapping` (supplier-global, no
          supplier_hotel_id), `hotel_occupancy_mapping`
          (COALESCE partial unique handles nullable occupancy code).
          All mappings follow the ADR-008 convention: partial unique
          excluding `REJECTED | SUPERSEDED`, `superseded_by_id` chain,
          `mapping_method ∈ {DETERMINISTIC, FUZZY, MANUAL}`,
          `status ∈ {PENDING, CONFIRMED, REJECTED, SUPERSEDED}`.
        `offers/20260423000007_offers_sourced_offer_snapshots.ts` →
          `offer_sourced_snapshot` (TTL index on `valid_until`,
          `rate_breakdown_granularity` constrained to the four
          sourced values; `AUTHORED_PRIMITIVES` rejected at this
          layer), `offer_sourced_component` (ON DELETE CASCADE),
          `offer_sourced_restriction` (ON DELETE CASCADE),
          `offer_sourced_cancellation_policy` (1:1 with snapshot,
          `parsed_with` preserves parser id+version for future
          re-parsing).
      No `rate_auth_*` tables yet (Phase 3). No booking-time
      snapshot tables yet (Phase 2).
- [~] **Hotelbeds adapter scaffold** — `packages/adapters/hotelbeds/`
      implementing `SupplierAdapter`. Phase 1 scaffold landed; live
      HTTP client, booking confirmation, and cancellation are
      explicitly out of scope here and land in Phase 2.
        - `HOTELBEDS_META` declares `offerShape = SOURCED_COMPOSED`,
          `minRateBreakdownGranularity = TOTAL_ONLY`,
          `ingestionMode = PULL`. Supported money-movement axes
          declared at the meta level; the per-rate triple is
          resolved at normalization time (see correction below).
        - **Correction (2026-04-23): money-movement resolver.**
          The scaffold originally hardcoded `BB_COLLECTS +
          PREPAID_BALANCE + PLATFORM_CARD_FEE` as a universal
          per-rate triple — anti-pattern against ADR-020 (triple is
          per-rate, not per-supplier). Removed and replaced with:
            - Additive contract field `AdapterSupplierRate.moneyMovementProvenance`
              in `@bb/supplier-contract`: `'PAYLOAD_DERIVED' | 'CONFIG_RESOLVED' | 'PROVISIONAL'`.
            - New `packages/adapters/hotelbeds/src/money-movement.ts`:
              `HotelbedsMoneyMovementResolver` interface +
              `createProvisionalResolver`, `createStaticResolver`,
              `createPayloadFirstResolver` factories.
            - `runSourcedSearchAndPersist` now requires a
              `moneyMovementResolver` in its deps and calls it
              per rate; `HotelbedsAdapterDeps` forces composition
              root to inject one (no silent default).
            - PROVISIONAL results ship a fallback triple so the
              required `moneyMovement` field is populated, but
              `moneyMovementProvenance = 'PROVISIONAL'` is the
              loud signal that downstream booking must refuse.
          Phase 2 work: decide which payload signal (if any)
          Hotelbeds actually exposes from live fixtures and wire
          `createPayloadFirstResolver` accordingly; until then
          composition root uses `createProvisionalResolver`.
        - Additive contract changes: `OfferShape` +
          `RateBreakdownGranularity` added to `@bb/domain`;
          `StaticAdapterMeta` + `AdapterSupplierRate` carry the two
          shape fields (ADR-021 amendment to ADR-003).
        - `pnpm-workspace.yaml` gains `packages/adapters/*`.
        - ESLint dep-direction rule restricts the adapter to
          `@bb/domain` + `@bb/supplier-contract` only (ADR-011).
        - Ports (local to the adapter, DB-free): `SupplierRegistrationPort`,
          `RawPayloadStoragePort`, `HotelContentPersistencePort`,
          `MappingPersistencePort`, `SourcedOfferPersistencePort`.
          Concrete impls wire in the composition root next.
        - `runHotelContentSync` — paged pull from Hotelbeds Content
          API, writes raw payload + `hotel_supplier` rows.
        - `runSourcedSearchAndPersist` — per availability response:
          raw payload → `offer_sourced_snapshot` (+ components,
          restrictions, cancellation policy only when disclosed) →
          PENDING rows in the four `hotel_*_mapping` tables → flat
          `AdapterSupplierRate[]` projection. Components/restrictions
          are NOT fabricated (ADR-021 invariant).
        - `createStubHotelbedsClient` — every method throws
          `HotelbedsNotImplementedError` until Phase 2 credentials
          and signing land.
        - `HotelbedsAdapter.book` / `.cancel` throw
          `HotelbedsNotImplementedError` (out of scope).
        - `tsc --noEmit` and `eslint` clean across all 25 workspace
          packages; `pnpm build` clean across 18.
- [~] **Hotelbeds adapter composition-root wiring** — concrete DB-
      backed persistence ports + MinIO raw payload storage + adapter
      registry + booking guard, all under `apps/api`. Phase 1 wiring
      landed; live HTTP client, booking confirmation, and cancellation
      are still Phase 2.
        - New deps: `@aws-sdk/client-s3` on `apps/api`;
          `@bb/adapter-hotelbeds` + `@bb/supplier-contract`
          workspace refs on `apps/api`.
        - `packages/config` extended with MinIO access/secret keys,
          region, and `forcePathStyle` (defaults are dev-compose
          values — `bb_local`/`bb_local_secret`, `us-east-1`, path-
          style on).
        - `apps/api/src/common/ulid.ts` — 26-char ULID generator
          (crypto.randomBytes + Crockford base32, no third-party dep).
        - `apps/api/src/object-storage/object-storage.module.ts` —
          global `S3Client` + bucket providers against MinIO.
        - Five concrete Hotelbeds ports under
          `apps/api/src/adapters/hotelbeds/`:
            - `PgSupplierRegistrationPort` — upserts `supply_supplier`
              (`source_type = 'AGGREGATOR'`) on `(code)`.
            - `PgHotelContentPersistencePort` — upserts
              `hotel_supplier` rows in a single transaction; writes
              the per-hotel raw-payload ref into `raw_content`.
            - `PgMappingPersistencePort` — four tables, all inserts
              `status = 'PENDING', mapping_method = 'DETERMINISTIC'`.
              Room / rate-plan / occupancy mapping inserts resolve
              `hotel_supplier.id` via `INSERT ... SELECT`, so a
              mapping observed for a hotel not yet content-synced is
              a safe no-op instead of an FK failure.
              `ON CONFLICT` targets the partial unique indexes
              (including the occupancy table's `COALESCE(code, '')`
              expression index).
            - `PgSourcedOfferPersistencePort` — writes
              `offer_sourced_snapshot` + 0..N components + 0..N
              restrictions + 0..1 cancellation policy in a single
              transaction. Child rows only written when non-empty
              (ADR-021 invariant: no fabrication).
            - `MinioRawPayloadStoragePort` — content-addressed put:
              key = `hotelbeds/<purpose>/<YYYY/MM/DD>/<sha256>`.
              Hash doubles as filename — idempotent overwrites.
        - `HotelbedsModule` constructs the adapter with
          `createProvisionalResolver({ fallbackTriple, reason })`
          where `reason` spells out "Hotelbeds commercial
          confirmation pending"; every projected rate thus carries
          `moneyMovementProvenance = 'PROVISIONAL'`. `OnModuleInit`
          runs `ensureRegistered()` so the `supply_supplier` row
          exists before any FK-dependent write.
        - `SupplierAdapterRegistry` + `AdaptersModule` — supplier-
          code → `SupplierAdapter` lookup; adding the second
          adapter is a one-import change.
        - `apps/api/src/booking/booking-guard.ts` — `assertRateBookable(rate)`
          throws `ProvisionalMoneyMovementError` when
          `moneyMovementProvenance === 'PROVISIONAL'`. Call site is
          the first step of the booking saga (Phase 2).
        - `pnpm lint`, `pnpm typecheck`, `pnpm build` clean across
          the full workspace (25 / 25 / 18).
- [x] **Hotelbeds fixture-replay conformance path** —
      `createFixtureHotelbedsClient` in `@bb/testing` implements
      `HotelbedsClient` against two recorded JSON payloads
      (`packages/testing/src/hotelbeds/fixtures/hotels-page-01.json`,
      `availability-01.json`; two hotels, one room, one NRF + one
      FLEX rate) with deterministic raw bytes for content-addressed
      MinIO writes. Conformance test under
      `apps/api/src/adapters/hotelbeds/__tests__/hotelbeds.conformance.test.ts`
      drives `runHotelContentSync` + `runSourcedSearchAndPersist`
      against the live local stack (Postgres + MinIO) and asserts:
        - `supply_supplier` row present (`hotelbeds`, AGGREGATOR).
        - `hotel_supplier` rows for both fixture hotels.
        - `offer_sourced_snapshot` rows (one per rate) with
          `rate_breakdown_granularity = TOTAL_ONLY`, currency EUR,
          raw_payload_hash matching sha256, storage_ref under
          `hotelbeds/availability/`.
        - `offer_sourced_cancellation_policy` written only for the
          rate that actually disclosed one (ADR-021 no-fabrication
          invariant visible in assertions).
        - One `hotel_room_mapping`, two `hotel_rate_plan_mapping`
          (FLEX + NRF), two `hotel_meal_plan_mapping` (BB + RO),
          one `hotel_occupancy_mapping` row observed.
        - Raw payload roundtrips from MinIO via
          `GetObjectCommand` at the snapshot's `storage_ref`.
        - No `rate_auth_*` tables present in this phase
          (invariant: sourced writes never touch authored tables).
        - Every projected `AdapterSupplierRate` carries
          `moneyMovementProvenance = 'PROVISIONAL'` and
          `assertRateBookable(rate)` throws
          `ProvisionalMoneyMovementError`.
      Test skips cleanly when `DATABASE_URL` is absent so CI
      without a local stack is not broken. `pnpm typecheck`,
      `pnpm lint`, and `pnpm test` green.
- [x] **Hotelbeds adapter live HTTP client (Phase 2)** — real
      HTTP transport with signing, retry/backoff, timeout, and
      capture, plus runtime client-kind switch at the composition
      root. Booking confirmation, cancellation, and the
      worker-side content-sync cron are explicitly still out of
      scope and remain Phase 2+/Phase 3 follow-ups.
        - `packages/adapters/hotelbeds/src/live-client.ts` —
          `createLiveHotelbedsClient(config)`. Auth per
          developer.hotelbeds.com `/getting-started`:
          `Api-key: <apiKey>` + `X-Signature:
          SHA256_hex(apiKey + secret + epochSeconds)` recomputed per
          request. `Accept: application/json`,
          `Accept-Encoding: gzip`. Endpoints:
          `GET /hotel-content-api/1.0/hotels?fields=all&from&to&language&useSecondaryLanguage=false`
          and `POST /hotel-api/1.0/hotels`.
        - Retry policy: 429 / 500 / 502 / 503 / 504, AbortError
          timeouts, network TypeErrors. Honors `Retry-After`
          (seconds or HTTP-date). Default 3 retries with
          exponential backoff + jitter from a 200ms base.
        - Per-request timeout via `AbortSignal.timeout(...)`;
          default 15s, configurable.
        - Optional capture: when `captureDir` is set, every
          successful raw response is also written to
          `<captureDir>/<purpose>/<iso>-<sha256>.json`. Capture
          failures never fail a real request — observability only.
          Files can be promoted into
          `packages/testing/src/hotelbeds/fixtures/` to extend the
          regression suite verbatim.
        - Response normalization: live shape → adapter contract.
          Content `name` accepts both `string` and `{content}`;
          availability response unwraps `hotels.hotels` to match
          `HotelbedsAvailabilityResponse.hotels`. Hotel `code` is
          coerced to string at the boundary so downstream typing
          stays clean.
        - Typed `HotelbedsHttpError` carries `status`,
          `headers`, `bodyPreview`, `requestedUrl` so retry logic
          can branch and ops can debug.
        - `packages/adapters/hotelbeds/src/fixture-client.ts` —
          canonical `createFixtureHotelbedsClient` moved from
          `@bb/testing` so the composition root can pick the
          fixture kind without a runtime testing-package
          dependency. `@bb/testing` now thin-re-exports.
        - `apps/api/src/adapters/hotelbeds/hotelbeds.config.ts` —
          adapter-local env binding (`HOTELBEDS_CLIENT_KIND` ∈
          `stub | fixture | live`, plus `HOTELBEDS_API_KEY`,
          `HOTELBEDS_API_SECRET`, `HOTELBEDS_BASE_URL`,
          `HOTELBEDS_REQUEST_TIMEOUT_MS`,
          `HOTELBEDS_MAX_RETRIES`,
          `HOTELBEDS_RETRY_BASE_DELAY_MS`,
          `HOTELBEDS_CAPTURE_DIR`,
          `HOTELBEDS_FIXTURE_DIR`). Default kind is `stub` so a
          fresh checkout boots without credentials. `live` kind
          requires API key + secret; `fixture` kind requires a
          fixture dir. Validation runs at module init so
          misconfiguration fails loudly.
        - `HotelbedsModule` switches client by `cfg.kind` and
          keeps `createProvisionalResolver` on every kind: the
          booking guard refuses every rate from every client
          until ops swaps the money-movement resolver. This is
          deliberate — Phase 2 unlocks HTTP, not bookings.
        - `packages/adapters/hotelbeds/src/live-client.test.ts` —
          5 unit tests pin the load-bearing primitives without
          hitting the network: signing matches the SHA256 vector;
          `Api-key` + `X-Signature` ride every request; 503
          retries to eventual 200; 401 is non-retryable;
          availability shape normalization unwraps
          `hotels.hotels`. Conformance test (fixture replay
          against the real DB + MinIO stack) continues to gate
          adapter behavior end to end.
        - `vitest.config.ts` — `include` glob extended to
          `packages/*/*/src/**/*.{test,spec}.ts` so adapter
          packages (one extra directory level) are discovered.
        - `.env.example` — new Hotelbeds section with all
          adapter env vars and inline guidance.
        - `pnpm typecheck` (27/27), `pnpm lint` (26/26),
          `pnpm test` (9/9 across 2 files) green.
- [ ] Adapter conformance suite — formalize ADR-003 conformance
      harness in `packages/testing/` (applies to every adapter;
      Hotelbeds fixture-replay is the first implementation).
- [ ] Hotel mapping pipeline — deterministic match phase
      (`packages/mapping/`).
- [ ] Supplier content merge — static pipeline into
      `CanonicalHotel` (`packages/content/`).
- [ ] Basic pricing evaluator — `PERCENT_MARKUP` rule, trace output
      (`packages/pricing/`).
- [x] **Internal Hotelbeds API seam** — minimal, dev-oriented HTTP
      surface for triggering the adapter end-to-end:
        - `POST /internal/suppliers/hotelbeds/content-sync` →
          runs `runHotelContentSync` through `HotelbedsContentSyncService`
          (a thin DI wrapper that injects `HOTELBEDS_CLIENT`,
          `PgHotelContentPersistencePort`, `MinioRawPayloadStoragePort`).
          Body: `{ tenantId, pageSize?, maxPages? }`. Response carries
          `{ supplier, clientKind, tenantId, pagesFetched, hotelsUpserted }`.
        - `POST /internal/suppliers/hotelbeds/search` →
          calls `SupplierAdapterRegistry.get('hotelbeds').fetchRates(...)`
          which runs the full sourced-search write path. Body:
          `{ tenantId, supplierHotelId, checkIn, checkOut,
          occupancy:{ adults, children, childAges? }, currency? }`.
          Response carries `{ supplier, clientKind, tenantId,
          rateCount, rates: [...] }`. Each rate projection includes
          `moneyMovementProvenance` and an honest `isBookable: false`
          + `bookingRefusalReason` from the booking guard, so the
          PROVISIONAL safeguard is never quietly hidden by the seam.
        - `apps/api/src/adapters/hotelbeds/hotelbeds.module.tokens.ts` —
          extracted `HOTELBEDS_ADAPTER` and added `HOTELBEDS_CLIENT`
          tokens so adapter-internal services can share the same
          runtime-selected client without depending on the module.
        - `HOTELBEDS_CLIENT` is now a dedicated provider keyed by
          `pickClient(loadHotelbedsConfig())`. The adapter factory
          and `HotelbedsContentSyncService` both inject it; the
          `stub | fixture | live` switch lives in exactly one place.
        - Controller is mounted on `AdaptersModule` (alongside the
          `SupplierAdapterRegistry`); `HotelbedsModule` exports
          `HOTELBEDS_ADAPTER`, `HOTELBEDS_CLIENT`,
          `HotelbedsContentSyncService` for downstream consumers.
        - `apps/api/src/adapters/hotelbeds/__tests__/hotelbeds.controller.test.ts` —
          integration test boots a real Nest app via
          `Test.createTestingModule`, forces `HOTELBEDS_CLIENT_KIND=fixture`
          + `HOTELBEDS_FIXTURE_DIR` to the in-repo fixtures, drives both
          endpoints over HTTP, asserts response shape +
          `clientKind=fixture` + `isBookable=false` + 400 on bad bodies.
          Skips cleanly when `DATABASE_URL` is absent.
        - Hand-rolled body validators (no class-validator dep added)
          throw `BadRequestException` from @nestjs/common on missing
          / malformed fields. Endpoints reject bodies before any
          adapter call.
        - Constructor injection in module / service / controller
          uses explicit `@Inject(ClassRef)` so vitest's esbuild
          transpiler (which does not implement
          `emitDecoratorMetadata`) does not break Nest DI in tests.
          Production tsc emits the metadata anyway — `@Inject` is
          additive, not load-bearing in prod.
        - `pnpm typecheck` (27/27), `pnpm lint` (26/26),
          `pnpm test` (12/12 across 3 files) green.
- [x] **Channel-aware search + first-slice pricing** — normalized
      search seam above sourced offers (`offer_sourced_snapshot`)
      that drives the four commercial channels (B2C / AGENCY /
      SUBSCRIBER / CORPORATE) through one contract.
        - Migrations:
            - `infra/migrations/pricing/20260427000001_pricing_markup_rule.ts`
              — three precedence scopes (ACCOUNT / HOTEL / CHANNEL)
              with a CHECK enforcing exactly one scope key per row.
              Time-bound (`valid_from`, `valid_to`); status-gated;
              partial indexes for the four hot lookup paths and for
              the TTL sweeper.
            - `infra/migrations/merchandising/20260427000002_merchandising_promotion.ts`
              — `PROMOTED | RECOMMENDED | FEATURED` tags scoped to a
              `supplier_hotel_id`, optional `account_type` channel
              filter, identical time-bound + status pattern.
        - Domain types (`packages/domain/src/pricing.ts`):
            - `MarkupRuleScope`, `MarkupRuleSnapshot` (operational
              shape the evaluator sees), `AccountContext`,
              `PriceQuote`, `AppliedMarkup`.
            - Search contract: `SearchRequest`, `SearchResponse`,
              `SearchResultHotel`, `SearchResultRate`, `PromotionTag`,
              `SearchOccupancy`, `SearchResponseMeta`.
        - `packages/pricing` — new package, pure (no DB):
            - `money.ts` — BigInt minor-unit helpers + percent markup
              with half-away-from-zero rounding; rejects malformed
              decimal strings.
            - `evaluator.ts` — `evaluateSourcedOffer(offer, rules, ctx)`:
              precedence ACCOUNT > HOTEL > CHANNEL, priority breaks
              ties within scope, deterministic id tie-break. Returns
              `EvaluatedOffer` (price quote + trace). Unknown
              `markupKind` values are skipped — adding a kind is
              additive.
            - `evaluator.test.ts` — 10 unit tests cover money
              round-trip, sub-percent precision, scope precedence,
              priority tie-break, multi-tenant isolation, unknown-
              kind fallthrough.
            - ESLint rule: `@bb/pricing` may depend on `@bb/domain`
              only (and later `@bb/rate-intelligence`). `@bb/pricing`
              is added to `BACKEND_INTERNAL` so frontend apps never
              import it.
        - `apps/api/src/search/` — channel-aware search module:
            - Four Pg repositories: `PgAccountRepository`,
              `PgHotelSupplierRepository`, `PgMarkupRuleRepository`,
              `PgPromotionRepository`. Repositories load only the
              candidate set for one request; precedence picking
              stays in the pure evaluator (single source of truth).
            - `SearchService` orchestrates: account → adapter
              fetchRates (per supplier hotel) → code→hotel_supplier
              translation → rule + promotion fetch in parallel →
              evaluator → group by hotel → sort by cheapest selling
              price ascending. Promotion tag attaches to the result
              but never reorders past price ascending (CLAUDE.md
              merchandising-doesn't-mutate-price invariant).
            - `SearchController` — `POST /search`, hand-rolled body
              validator, 400 on malformed input. The booking guard
              still runs per rate so PROVISIONAL is surfaced as
              `isBookable: false` + `bookingRefusalReason` —
              consumers can render prices but cannot mistake them
              for sellable inventory.
            - `SearchModule` registered in `app.module.ts`. Imports
              `AdaptersModule` and `DatabaseModule`; explicitly does
              not import object-storage / payments / booking modules.
        - Integration test: `apps/api/src/search/__tests__/search.controller.test.ts`
          boots Nest in fixture mode, seeds tenant + AGENCY account,
          a CHANNEL 10% rule and a HOTEL 15% rule, plus a PROMOTED
          merchandising tag. Asserts HOTEL precedence wins, sell ==
          net + markup exactly (BigInt minor units), promotion tag
          attached, every rate is `isBookable: false`, trace records
          the rule firing, malformed body → 400.
        - `pnpm typecheck` (29/29), `pnpm lint` (28/28),
          `pnpm test` (24/24 across 5 files) green.
- [x] **Internal admin CRUD over pricing + merchandising** —
      configuration surface that the search/pricing layer reads from,
      mounted at `/internal/admin/...` alongside the other dev/ops
      seams.
        - `apps/api/src/admin/validation.ts` — hand-rolled
          validators (ULID, decimal-string with up to 4 fractional
          digits, ISO timestamp, AccountType / Status / Scope /
          PromotionKind enums, integer ranges, `rejectExtraKeys`,
          `ensureValidityWindow`). No class-validator dep.
        - Markup rules (`apps/api/src/admin/markup-rule.{repository,service,controller}.ts`):
            - `POST   /internal/admin/pricing/markup-rules`
            - `GET    /internal/admin/pricing/markup-rules`
              (filters: `tenantId`, `scope`, `accountId`,
              `supplierHotelId`, `accountType`, `status`,
              `limit`, `offset`)
            - `GET    /internal/admin/pricing/markup-rules/:id`
            - `PATCH  /internal/admin/pricing/markup-rules/:id`
              (mutable: `percentValue`, `priority`, `validFrom`,
              `validTo`, `status`)
            - `DELETE /internal/admin/pricing/markup-rules/:id`
              (soft-delete → `status='INACTIVE'`)
            - Service enforces "exactly one scope key matches scope"
              before the row hits the DB CHECK; window validation
              composes patch + existing row so partial edits cannot
              produce `validTo <= validFrom`. Postgres FK / CHECK
              violations are translated to `ConflictException` with
              the constraint name surfaced.
        - Promotions (`apps/api/src/admin/promotion.{repository,service,controller}.ts`):
            - `POST   /internal/admin/merchandising/promotions`
            - `GET    /internal/admin/merchandising/promotions`
              (filters: `tenantId`, `supplierHotelId`,
              `accountType`, `kind`, `status`, `limit`, `offset`)
            - `GET    /internal/admin/merchandising/promotions/:id`
            - `PATCH  /internal/admin/merchandising/promotions/:id`
              (mutable: `kind`, `priority`, `accountType` (tri-state
              clearable to NULL), `validFrom`, `validTo`, `status`)
            - `DELETE /internal/admin/merchandising/promotions/:id`
              (soft-delete)
            - `tenantId` and `supplierHotelId` are create-time-only
              (immutable on patch) — changing them effectively
              creates a different promotion.
        - Soft-delete is the only delete mode for both surfaces. Rows
          remain queryable for audit; the search-time read path
          filters on `status = 'ACTIVE'` so deactivation is
          immediate from the consumer perspective.
        - `AdminModule` registered in `app.module.ts`. Imports
          `DatabaseModule` only — no adapters, no object storage, no
          search, no booking.
        - `apps/api/src/admin/__tests__/admin.controller.test.ts` —
          18 integration tests boot Nest in fixture mode, seed a
          tenant + AGENCY account + Hotelbeds content sync (so a
          `hotel_supplier` row exists for HOTEL-scope tests), then
          exercise:
            - create per scope (ACCOUNT, HOTEL, CHANNEL) and per
              promotion kind (PROMOTED / RECOMMENDED / FEATURED)
            - 400 on cross-scope keys (e.g. CHANNEL + accountId)
            - 400 on malformed `percentValue` (>4 fractional digits)
            - 400 on unknown body keys
            - 400 on `validTo <= validFrom`
            - list with `tenantId + scope` filter
            - patch `percentValue` + `priority`; preserves scope
            - patch reject on immutable / unknown field
            - DELETE → status flips to `INACTIVE`, row remains
              retrievable
            - promotion patch: clear `accountType` with explicit
              null; reject patch on `supplierHotelId`
        - `pnpm typecheck` (29/29), `pnpm lint` (28/28),
          `pnpm test` (42/42 across 6 files) green.
- [x] **Internal API key auth guard** — `InternalAuthGuard` + `@Actor()`
      decorator applied to all `/internal/...` endpoints. `X-Internal-Api-Key`
      header validated against `INTERNAL_API_KEY` env var. Missing or
      mismatched key → 401. Actor extracted into request context and available
      to all controller methods via `@Actor() actor: InternalActor`.
- [x] **Admin audit log** — `admin_audit_log` table (`id`, `tenant_id`,
      `actor_id`, `resource_type`, `resource_id`, `operation`, `payload`,
      `created_at`). `AuditLogRepository` is write-only and append-only.
      `AuditOperation ∈ {CREATE | PATCH | SOFT_DELETE | DELETE}`.
      `DELETE` was added to the DB CHECK constraint in migration
      `core/20260430000001_admin_audit_log_add_delete_op.ts`.
- [x] **Phase A authored pricing schema — Slice 1 (ADR-022)** — migration
      `infra/migrations/authored/20260429000001_authored_phase_a_rate_schema.ts`.
      Six tables under `rate_auth_*` prefix: `rate_auth_contract`,
      `rate_auth_season`, `rate_auth_child_age_band`, `rate_auth_base_rate`,
      `rate_auth_occupancy_supplement`, `rate_auth_meal_supplement`.
      Composite FK design: `UNIQUE(id, contract_id)` on season and age band
      tables makes `(id, contract_id)` valid composite FK targets; all child
      tables reference `(season_id, contract_id)` or
      `(child_age_band_id, contract_id)` so the DB enforces same-contract
      membership without application code. MATCH SIMPLE handles nullable
      `child_age_band_id` correctly for EXTRA_ADULT rows. Date-ordering
      enforced by DB CHECK; season non-overlap enforced at service layer.
      Rollback drops in reverse FK order.
- [x] **DirectContracts module — Slice 2 (ADR-022)** — contract, season,
      and child age band CRUD at
      `/internal/admin/direct-contracts/{contracts,contracts/:id/seasons,
      contracts/:contractId/child-age-bands}`, all behind `InternalAuthGuard`.
      Service invariants: contracts are created DRAFT only; DRAFT→ACTIVE
      requires ≥1 season; INACTIVE is terminal and immutable; supplier must
      have `source_type = 'DIRECT'`. Season creation uses a serializable
      `SELECT ... FOR UPDATE` + overlap check + INSERT in one transaction.
      `requireDateOrder` called before the transaction so invalid date order
      returns 400 (not a DB 23514 inside the catch → 500 path). Seasons and
      child age bands are hard-deleted; FK guards block deletion while base
      rates or supplements reference them (DB 23503 → 409). Tenant scoping
      flows through the contract row; child tables carry no direct
      `tenant_id`. Audit log emits `CREATE | PATCH | SOFT_DELETE | DELETE`
      on every mutating operation. `pg` DATE type parser registered in
      `packages/db/src/pool.ts` (`types.setTypeParser(1082, ...)`) to return
      raw `YYYY-MM-DD` strings and prevent timezone-based date drift.
      All 91 tests green including the Hotelbeds conformance test, which was
      updated to scope authored-table row-count assertions by `tenant_id` to
      isolate from concurrent test-file writes.
- [x] **ADR-022 and ADR-023** — `docs/adrs/ADR-022-authored-direct-pricing-core.md`
      and `docs/adrs/ADR-023-authored-direct-pricing-restrictions-cancellation.md`
      written and recorded.
- [ ] Pricing layer follow-ups (sequenced):
        - Multi-supplier search (currently calls Hotelbeds only).
        - Currency conversion step (`CURRENCY_CONVERSION` trace kind
          already in `@bb/domain`; engine wiring lands when the FX
          module exists).
        - Tax / fee composition (ADR-004 step 3).
        - Promotion / discount kind (`PROMOTION_APPLIED` post-markup).
        - `FIXED_MARKUP_ABSOLUTE` and `MARKET_ADJUSTED_MARKUP` rule
          kinds (the second pulls in `@bb/rate-intelligence`).
        - `canonical_hotel_id` scope on rules + promotions once the
          mapping pipeline lands; supplier_hotel_id stays as a
          fallback for unsynced inventory.
        - Auth on `/search` and on `/internal/admin/...` once the
          auth module ships — both are open by design today,
          sequenced behind the contracts.
        - Audit log on admin writes — `admin_audit_event` table that
          captures `(actor, action, before, after)` per
          create/patch/delete.
- [ ] Supplier notes: `docs/suppliers/hotelbeds.md`,
      `webbeds.md`, `tbo.md`.
- [ ] Flow docs: `docs/flows/search.md`, `docs/flows/booking.md`.

## Later (Phase 3 — pre-adapter order for direct rates)

These are not active-session tasks. They are recorded here so that
the ordering is explicit and not lost when Phase 3 begins. Full
Phase 3 scope lives in `docs/roadmap.md`.

- [ ] **Seasonal-contract + promotion migrations (ADR-021
      amendment 2026-04-23) — lands before the direct-paper
      adapter implementation in Phase 3.** Migration files under
      `infra/migrations/rates/`:
        `NNNN_rate_contract.ts` → `rate_contract`,
          `rate_contract_season`, `rate_contract_season_date_band`,
          `rate_contract_price`
        `NNNN_rate_promotion.ts` → `rate_promotion`,
          `rate_promotion_scope`, `rate_promotion_rule`
        `NNNN_rate_auth_contract_columns.ts` → additive nullable
          `contract_id?` / `season_id?` on `rate_auth_extra_person_rule`,
          `rate_auth_meal_supplement`, `rate_auth_restriction`,
          `rate_auth_cancellation_policy`; `contract_id?` on
          `rate_auth_fee_component`. No backfill — these tables
          are empty until Phase 3.
      Booking snapshot additive columns (`authoring_mode`,
      `contract_id?`, `season_id?`, `applied_promotions_jsonb`) on
      `booking_authored_rate_snapshot` land in the same batch.
- [ ] Copy-season service (transactional clone;
      `copied_from_season_id` lineage + `AuditLog SEASON_COPY`
      entry; new season starts `DRAFT`). No operator UI yet.
- [ ] Direct-paper adapter implements `SupplierAdapter` with
      `authoring_mode = SEASONAL_CONTRACT`,
      `supports_seasonal_contracts = true`,
      `supports_promotions = true`, `offer_shape =
      AUTHORED_PRIMITIVES`; composes offers at search time from
      `rate_contract_price` + extra-person/meal supplements + tax
      + fee, applies promotions per `applies_to` order, writes
      `booking_authored_rate_snapshot` at `CONFIRMED`.

## Later (beyond Phase 0)

See `docs/roadmap.md`. Phase 1 onward.

## Open risks / uncertainties

- [!] **Rayna** integration — technical availability and data shape
      unconfirmed. Adapter is conditional.
- [!] **Booking.com Demand API** — commercial eligibility unknown; do
      not build toward it yet.
- [!] **Direct contract intake heterogeneity** — PDFs, spreadsheets,
      emails. Intake tooling budget must not be underestimated.
- [!] **Direct-connect certification tax** — SynXis, RateGain,
      SiteMinder, Mews, Cloudbeds, Channex each carry commercial /
      onboarding / certification overhead beyond adapter code. Plan a
      quarter of calendar time per provider to first-live with one
      hotel (ADR-013).
- [!] **Mapping at scale** — fuzzy matching and human review UI are
      Phase 2+ work; coverage depends on a cross-reference like Giata,
      which is a commercial decision.
- [!] **Supplier rate-limit and sandbox quality** — varies widely; plan
      for per-adapter back-pressure and recorded fixtures for CI.
- [!] **Multi-hotel carts** — deliberately out of MVP (ADR-010). Adding
      later is non-trivial.
- [!] **Payment provider choice** — Stripe confirmed by ADR-012 as the
      rail (via Stripe Connect). Stripe Customer Balance and Stripe
      Treasury explicitly rejected as the wallet.
- [!] **UAE stored-value wallet legal review** — `CASH_WALLET`
      (ADR-012) is paused pending jurisdictional legal clearance.
      `PROMO_CREDIT`, `LOYALTY_REWARD`, `REFERRAL_REWARD` are
      non-stored-value and lower-risk to launch first.
- [!] **Referral fraud** — anti-fraud is non-optional before launch
      (ADR-014). Budget real operational tooling, not just signals.
- [!] **Rate-intelligence legal/ethics** — public-rate benchmark
      ingestion (scraping or commercial feeds) requires per-tenant,
      per-jurisdiction legal review before enablement (ADR-015).
- [!] **Benchmark source commercial selection** — RateGain DataLabs
      vs OTA Insight vs Lighthouse vs bespoke scraper; Phase 4 decision.
- [!] **Auth provider** — decision deferred to Phase 1 infra selection.
- [!] **`recognized_margin` contract owned by pricing** (ADR-014
      amendment) — rewards consumes it via a narrow read interface.
      Exact inclusion list (especially payment processing cost
      estimation brackets and supplier post-booking rebates) must be
      finalized with finance before Phase 2 build. Without this the
      default `PERCENT_OF_MARGIN` rule cannot be computed
      deterministically.
- [!] **Hotel-funded reward reconciliation** (ADR-014 amendment) —
      `funding_source = HOTEL_FUNDED` implies a receivable-from-hotel
      leg that must clear at supplier invoicing. Hand-off design is
      Phase 3; do not ship `HOTEL_FUNDED` before that clears.
- [!] **Tax engine ADR outstanding** (ADR-016 / ADR-017) — UAE VAT
      minimal implementation inline for Phase 2 Beyond Borders
      direct flow is acceptable; full tax engine with UAE + KSA
      (ZATCA) profiles and place-of-supply / reverse-charge logic
      must land before reseller onboarding opens in Phase 3.
- [!] **Legal tax-doc sequence contention at scale** (ADR-016) —
      gapless sequential counters serialize under load. Phase 2
      is fine; revisit at Phase 5+ if booking rate stresses the
      single-sequence lock.
- [!] **Reseller onboarding tooling** (ADR-017) — branding upload
      moderation, KYC for reseller `TaxProfile.registrations`,
      DKIM / custom sending domain per reseller. Phase 3 back-office
      scope; MVP reseller admin is platform-admin-operated.
- [!] **Reseller DKIM and sending-domain policy** (ADR-017) —
      guest-facing email from a platform address with reseller
      `Reply-To` is acceptable for MVP, but bounces and
      deliverability for reseller-branded mail over a long horizon
      need Phase 4 custom-domain support.
- [!] **Reseller-of-reseller chains** explicitly out of scope
      (ADR-017). Adding later requires an ADR and a commercial
      driver; do not pre-architect.
- [!] **Reseller `PAYOUT_ELIGIBLE` jurisdictional launch review**
      (ADR-018) — operating the payout pipeline in any given country
      may require holding a payment-institution / e-money /
      marketplace-facilitator licence. `PAYOUT_ELIGIBLE` does not
      enable in production for a jurisdiction until legal clearance
      is recorded against that tenant + country. Shares the same
      gate as ADR-012 `CASH_WALLET`. MVP launch sequencing:
      `RESELLER_COLLECTS` everywhere, then `CREDIT_ONLY`, then
      `PAYOUT_ELIGIBLE` per-jurisdiction.
- [!] **KYC / KYB provider selection for reseller onboarding**
      (ADR-018) — document capture, sanctions / PEP screening, and
      ongoing monitoring require a provider integration (Sumsub /
      Onfido / Persona / equivalent). Phase 4 commercial decision.
      Without this, `CREDIT_ONLY` and `PAYOUT_ELIGIBLE` cannot
      onboard real resellers.
- [!] **Tax withholding on reseller payouts** (ADR-018) — whether
      we withhold tax at payout in specific jurisdictions (US
      1099-K style reporting, VAT on platform fee, GCC withholding
      edges) is a tax-engine concern. Deferred to the tax-engine
      ADR; must resolve before `PAYOUT_ELIGIBLE` launches in any
      jurisdiction with a withholding obligation.
- [!] **Multi-currency reseller payouts** (ADR-018) — MVP requires
      earning currency and payout currency to match. Cross-currency
      payouts with explicit FX are Phase 4+.
- [!] **Chargeback and dispute operational playbook** (ADR-018) —
      post-payout clawbacks are modelled by `RefundLiabilityRule`
      but require real operational tooling for dispute workflow
      and reseller-facing communication. Phase 4 back-office scope.
- [!] **Card-fee estimation contract with finance** (ADR-020) —
      mode-aware `recognized_margin` requires a deterministic
      platform-card-fee estimate at pricing time (by BIN range,
      card brand, tenant merchant category). Must be agreed with
      finance and pricing before Phase 2, since it feeds the
      default `PERCENT_OF_MARGIN` reward rule and drives the
      `BB_COLLECTS` vs `RESELLER_COLLECTS` margin gap.
- [!] **VCC provider selection** (ADR-020) — `VCC_TO_PROPERTY`
      requires a virtual-card-issuance integration (Stripe Issuing,
      Marqeta, Adyen Issuing, or specialist travel-VCC issuer such
      as Conferma / WEX). Provider choice affects FX handling,
      acceptance at hotels, and chargeback rights on the BB side.
      Phase 3 commercial decision; do not ship `VCC_TO_PROPERTY`
      before it resolves.
- [!] **Commission recognition timing policy** (ADR-020) — whether
      `SUPPLIER_COMMISSION_ACCRUAL` posts on `SUPPLIER_BOOKED`,
      on stay, or on cleared supplier payment is a revenue-
      recognition decision. Must be finalized with finance before
      `COMMISSION_ONLY` modes go live in Phase 3. Impacts clawback
      shape, reseller earnings timing on `RESELLER_COLLECTS`, and
      `recognized_margin` availability for reward maturation.
- [!] **`COMMISSION_INVOICE` tax treatment** (ADR-020 + pending
      tax engine ADR) — commission invoices BB raises to a
      supplier or upstream platform are a separate tax
      determination from guest-facing `TAX_INVOICE`s. Place-of-
      supply, reverse-charge, and VAT registration edges (UAE /
      KSA / cross-border) must be covered by the tax-engine ADR
      before Phase 3 launch of `COMMISSION_ONLY` / `PROPERTY_COLLECT`.
- [!] **Upstream-collect webhook handshake design** (ADR-020) —
      `UPSTREAM_PLATFORM_COLLECT` depends on Expedia / Booking.com /
      equivalent confirmation, cancellation, and remittance
      webhooks. Handshake semantics (retries, signature
      verification, idempotency keys, statement reconciliation
      granularity) are per-platform and must be designed in
      Phase 4; do not pre-architect.
- [!] **Legacy `booking_payment_model` retirement** (ADR-020
      supersedes ADR-003's single-enum shape) — any existing
      adapter metadata, rate rows, or bookings carrying
      `booking_payment_model` need a one-way migration to the
      three-axis triple. Migration and deprecation timing is a
      Phase 1 task; the old field must not linger past Phase 2
      to avoid two sources of truth on payment flow.
