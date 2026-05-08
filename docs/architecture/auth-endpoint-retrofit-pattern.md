# Endpoint retrofit pattern (ADR-026 Slices E4-A + E4-B)

This is the canonical pattern for adding human auth + permission gating
to a controller in `apps/api`. Slice E4-A established the guard +
permission gating; E4-B added the body-vs-`AuthContext` reconciliation
step. Both were established on `SearchController` (`POST /search`);
future retrofits copy this verbatim.

It does NOT cover `/internal/*` routes — those continue to use
`InternalAuthGuard` and a shared API key, untouched by this work.

---

## When to use this pattern

Use it on every NEW or EXISTING human-user endpoint that lives outside
`/internal/*`, with one explicit exception: identity-baseline routes
that must work for any authenticated user (today, only `GET /me`) keep
`@UseGuards(JwtAuthGuard)` alone, with no `RolesGuard`. Those are the
routes whose entire purpose is "confirm I'm authenticated"; gating them
with a permission would be circular.

Every other route — search, booking ops, ledger, documents, account
settings — gets the full pattern below.

---

## The pattern

Three pieces, applied at the controller class level + each method:

```ts
import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';
import { RolesGuard } from '../auth/permissions/roles.guard';
import { RequirePermission } from '../auth/permissions/require-permission.decorator';
import { PERMISSIONS } from '../auth/permissions/permissions';

@UseGuards(JwtAuthGuard, RolesGuard)        // 1. order matters
@Controller('my-area')
export class MyController {
  @Post()
  @RequirePermission(PERMISSIONS.MY_PERM)   // 2. one declaration per method
  async myHandler(...) { ... }
}
```

And the controller's module imports `AuthModule`:

```ts
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule, /* ... */] })
export class MyModule {}
```

That's the whole pattern.

---

## Why each piece

**`@UseGuards(JwtAuthGuard, RolesGuard)` — order matters.** NestJS evaluates
guards in declaration order. `JwtAuthGuard` validates the bearer token,
syncs the user, and attaches `AuthContext` to the request. `RolesGuard`
reads `AuthContext`. Reverse the order and `RolesGuard` finds nothing —
its defense-in-depth check then returns 403 (`logger.warn(
'RolesGuard hit without AuthContext on request — JwtAuthGuard missing
or out of order')`). Always list `JwtAuthGuard` first.

**Controller-level guards, method-level permissions.** The guards apply
to every method on the controller; the permission is declared per
method. A class with five GETs and one DELETE has one `@UseGuards` and
six `@RequirePermission` decorations. Methods with different permissions
sit in the same controller cleanly.

**Default-deny on missing metadata.** A method that wears `RolesGuard`
but no `@RequirePermission` returns 403. A future contributor who
copies the controller boilerplate but forgets the decoration on a new
endpoint will see the route fail closed in the very first integration
test, not silently expose the route.

**`AuthModule` import in the controller's module.** `JwtAuthGuard` and
`RolesGuard` are providers in `AuthModule`. Without the import, Nest
DI fails at startup with `Nest can't resolve dependencies of the
JwtAuthGuard ...`. The `AuthModule.exports` list already includes both
guards, so importing the module is enough — no per-provider wiring.

---

## Picking the permission

`apps/api/src/auth/permissions/permissions.ts` is the single source of
truth. Use the existing `PERMISSIONS.*` constant; do not invent new
permission strings inline.

If your endpoint truly needs a permission that does not exist in the
catalogue, add it to `permissions.ts` AND assign it in the relevant
role-permission maps in the same commit. Do not wire a controller to a
permission that no role holds — every authenticated user would see 403
and the bug would only surface in production.

A permission can serve more than one endpoint. `SEARCH_EXECUTE` already
gates `/search`; any future "alternate search" endpoint that shares the
same authorization shape should reuse it rather than create
`SEARCH_EXECUTE_V2`.

---

## Body reconciliation (E4-B)

Once the route is gated, every endpoint that accepts `tenantId` or
`accountId` (or any other already-known-from-context identifier) in
its body must reconcile those against `AuthContext`. The locked V1
rule, applied first on `/search`:

- **AGENCY user** — derive `tenantId` and `accountId` from
  `AuthContext`. If the body provides either field, it must equal the
  AuthContext value. Mismatch → **403** (no detail body, reason logged
  at warn). Omitted → AuthContext value used silently. Body fields
  become optional going forward.

- **OPERATOR user** — `/<area>` is unsupported as-self in V1.
  Return **403** with a policy message indicating impersonation (E8)
  is required. This applies even when the operator role would
  otherwise pass the permission check (e.g. `platform_admin` holds
  every permission). Operators have no `accountId`, and any
  account-scoped endpoint cannot meaningfully run for them. When E8
  ships, the impersonation guard will produce a synthetic
  AGENCY-shaped `AuthContext` and the same code path will accept it
  unchanged.

The handler reads `AuthContext` via the `@Auth()` decorator:

```ts
async myHandler(
  @Body() body: unknown,
  @Auth() auth: AuthContext,
): Promise<MyResponse> {
  if (auth.userClass === 'OPERATOR') {
    throw new ForbiddenException(
      'Operator action requires impersonation; not supported in V1 (ADR-026 E8)',
    );
  }
  // Defense in depth — the AuthContext invariants (E2-A + E3-A) say
  // AGENCY users always carry a non-empty accountId, but a future
  // alternate AuthContext-construction path could violate that.
  if (typeof auth.accountId !== 'string' || auth.accountId.length === 0) {
    throw new ForbiddenException();
  }
  const parsed = parseBody(body); // returns optional bodyTenantId/bodyAccountId
  if (parsed.bodyTenantId !== null && parsed.bodyTenantId !== auth.tenantId) {
    throw new ForbiddenException();
  }
  if (parsed.bodyAccountId !== null && parsed.bodyAccountId !== auth.accountId) {
    throw new ForbiddenException();
  }
  return this.service.do({
    tenantId: auth.tenantId,
    accountId: auth.accountId,
    ...parsed.rest,
  });
}
```

**Failure mode is uniformly 403, never 400.** A foreign `accountId`
in a well-formed body is an authorization concern (this identity
cannot do this on that account), not a validation concern. 400 would
suggest "fix the body"; the right fix is "use a different identity."

Body fields for the reconciled identifiers should be **parsed as
optional** in the body validator. Required-field validation in
`parseBody` only applies to fields the body is the source of truth
for (dates, occupancy, etc).

---

## What this pattern still does NOT do

It does not impersonate. Operator-as-agency views are out of scope until
Slice E8 (`IMPERSONATE_AGENCY_ACCOUNT` permission already in the
catalogue). Until then, the OPERATOR branch above is a hard 403.

It does not change the response shape on auth or reconciliation
failure. Every guard / reconciliation failure is a uniform 401
(JwtAuthGuard) or 403 (RolesGuard / controller reconciliation) with
no detail body — except the OPERATOR branch which surfaces a policy
message naming E8, since that's information a legitimate caller needs
to understand the deny.

---

## Tests required when retrofitting

Three files in
`apps/api/src/<area>/__tests__/`. The templates are
`search.controller.guards.test.ts` and
`search.controller.reconciliation.test.ts`.

**Layer A — metadata pin** (in `<controller>.guards.test.ts`). Use
`Reflect.getMetadata('__guards__', ...)` and
`Reflector.get(REQUIRE_PERMISSION_KEY, ...)` to assert:

- `[JwtAuthGuard, RolesGuard]` are attached, in that order.
- Each method has a `@RequirePermission(...)` declaration.
- The chosen permission is held by the expected roles in the
  `__PERMISSION_MAP_FOR_TESTS` matrix (positive AND negative).

**Layer B — HTTP guard exercise** (in `<controller>.guards.test.ts`).
Boot a tiny `Test.createTestingModule` with the real `JwtAuthGuard`
+ `RolesGuard` wired to mocked `JwtValidatorService`,
`UserSyncService`, and `PermissionResolverService`. Drive via `fetch`:

- No bearer → 401.
- Invalid bearer → 401.
- Valid bearer, AGENCY user holds the permission, body matches → 200/201.
- Valid bearer, AGENCY user lacks the permission → 403.
- Valid bearer, OPERATOR user without the permission → 403 (RolesGuard).
- Valid bearer, OPERATOR holding the permission → 403 (controller
  reconciliation; verifies the controller-level deny even when the
  guard pipeline allows).
- Valid bearer, AGENCY user with body.accountId mismatched → 403.

**Layer C — reconciliation unit tests** (in
`<controller>.reconciliation.test.ts`). Call the controller method
directly with a mocked service and a constructed `AuthContext` —
no HTTP, no Nest module. Cover at minimum:

- AGENCY, body matches → service called with AuthContext-derived IDs.
- AGENCY, body omits IDs → derived from AuthContext.
- AGENCY, body.tenantId mismatches → 403, no service call.
- AGENCY, body.accountId mismatches → 403, no service call.
- OPERATOR (any role, including a hypothetical permission-holder) →
  403 with the impersonation policy message, no service call.
- AGENCY with empty/null AuthContext.accountId → 403 (defense in depth).
- Malformed body (missing required non-reconciled field) → 400.

**Existing business-logic integration tests** for the same
controller — the ones that hit a real DB to test pricing / sourcing
/ etc — should override the guards with stand-ins that ALSO populate
`AuthContext` so the controller's reconciliation step finds matching
values:

```ts
const echoBodyAuthGuard: CanActivate = {
  canActivate: (ctx: ExecutionContext): boolean => {
    const req = ctx.switchToHttp().getRequest<{
      body?: { tenantId?: string; accountId?: string };
    }>();
    const body = req.body ?? {};
    (req as unknown as Record<symbol, unknown>)[AUTH_CONTEXT_KEY] = {
      auth0Sub: 'test|stub',
      userId: 'test-user-id',
      tenantId: body.tenantId ?? '',
      accountId: body.accountId ?? '',
      userClass: 'AGENCY',
    };
    return true;
  },
};
const passThroughGuard: CanActivate = { canActivate: () => true };

await Test.createTestingModule({ /* ... */ })
  .overrideGuard(JwtAuthGuard).useValue(echoBodyAuthGuard)
  .overrideGuard(RolesGuard).useValue(passThroughGuard)
  .compile();
```

Auth behavior is pinned by `*.guards.test.ts` and reconciliation
behavior by `*.reconciliation.test.ts`; the existing business-logic
tests stay focused on the area they test.

---

## Checklist for a new retrofit slice

- [ ] Controller has `@UseGuards(JwtAuthGuard, RolesGuard)` at class
      level.
- [ ] Every method has `@RequirePermission(...)`.
- [ ] The permission(s) are in `permissions.ts` and held by at least
      one role.
- [ ] Module imports `AuthModule`.
- [ ] Handler injects `@Auth() auth: AuthContext` and reconciles
      body-claimed `tenantId` / `accountId` (and any other
      AuthContext-knowable identifier) against the AuthContext.
- [ ] OPERATOR branch returns 403 with the impersonation policy
      message (until E8 ships).
- [ ] Body validator parses reconciled identifiers as optional.
- [ ] `<controller>.guards.test.ts` covers Layer A + Layer B.
- [ ] `<controller>.reconciliation.test.ts` covers Layer C.
- [ ] Existing business-logic integration tests override both guards
      with the echo-body / pass-through stand-ins.
- [ ] `npx tsc --noEmit && npx eslint src && npx vitest run apps/api/src
      && npx nest build` all pass.
