# ADR-006: Tenancy and account model

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

Beyond Borders plans to resell this platform to other travel agencies.
Tenancy cannot be retrofitted — it shapes every table, query, and auth
decision. At the same time, four different buyer types (B2C, agency,
subscriber, corporate) must be first-class on a single tenant.

## Decision

### Two axes, not one

- **Tenant** = who owns/operates this instance (Beyond Borders, later
  Agency X, Agency Y). Tenants never see each other's data.
- **Account** = a specific buyer under a tenant. Accounts can be
  individuals (B2C), agencies, subscriber groups, or corporate entities.

Beyond Borders is tenant #1 on day one. A second tenant is a
configuration event, not a migration.

### Entities

```
Tenant {
  tenant_id, name, slug, settings (theming, default currency, default
  locale), status
}

Account {
  account_id, tenant_id, account_type (B2C | AGENCY | SUBSCRIBER |
  CORPORATE), parent_account_id?, name, billing_profile_ref?,
  credit_terms?, default_markup_ref?, settings, status
}

User {
  user_id, tenant_id, email, auth info, status
}

AccountMembership {
  membership_id, user_id, account_id, role (OWNER, MANAGER, BOOKER,
  TRAVELER, READ_ONLY), status
}
```

A user can belong to multiple accounts (a travel agent who also books
personally, or a corporate bookler who is also an admin of another
corporate sub-entity).

### B2C specifics

- B2C shoppers can book as guests. A guest booking creates a lightweight
  `Account` with `account_type = B2C` and `parent_account_id = null`,
  owned by the traveler's email, claimable later if they register.
- Registered B2C users have an Account + User + Membership as normal.

### Agency, subscriber, corporate

- Agency accounts have sub-users (agents).
- Subscriber/member accounts represent closed groups (association,
  employer-affiliated); members are users with a membership.
- Corporate accounts can be hierarchical via `parent_account_id`
  (global corporate HQ → country subsidiaries). Pricing rules can
  attach at any level; evaluation walks up the tree (see ADR-004).

### Isolation model

- Every row in every domain table carries `tenant_id`.
- Data access goes through a **tenant-scoped data layer**. Queries
  without a tenant scope are a code smell enforced by linting and CI.
- Row-Level Security in Postgres is **not** relied on as the primary
  isolation — the application layer enforces it, with RLS as a
  belt-and-suspenders backup for direct DB access.
- Search indexes are partitioned per tenant (either separate indexes
  or a tenant filter that is always required).

### Supplier access per tenant

- `SupplierConnection` is a (tenant, supplier) row. Each tenant
  supplies their own credentials. Beyond Borders, as tenant #1, holds
  Beyond Borders' contracts. A future Agency X, as tenant #2, holds
  their own — we do not resell access to our wholesale contracts
  without a commercial decision to do so.

### Auth

- Tenants resolve from the request (subdomain, domain, or header).
- Users authenticate against the resolved tenant.
- SSO (SAML/OIDC) is a tenant setting for corporate and agency
  accounts. Plain email/password for B2C and small agencies.

## Consequences

- Every schema has `tenant_id` as a leading index column.
- Admins have two levels: tenant admin (within their tenant) and
  platform admin (Beyond Borders operators managing multiple tenants).
- Subscriber and corporate group hierarchies add complexity to pricing
  rule evaluation; ADR-004 accounts for this via parent-walking.

## Open items

- Domain/subdomain pattern for tenant routing — decide at Phase 1
  alongside first frontend app.
- Platform-admin vs tenant-admin UI split — Phase 2.
- Data export/portability for a tenant that leaves — not MVP but
  noted as a platform-resale must-have.

## Amendment 2026-04-21 (see ADR-012, ADR-014)

### Wallet accounts per Account

Every `Account` may have zero or more `WalletAccount` rows, one per
`(balance_type, currency)`. Balance types include `CASH_WALLET`,
`PROMO_CREDIT`, `LOYALTY_REWARD`, `REFERRAL_REWARD`, `AGENCY_CREDIT`,
`CORPORATE_CREDIT`. Ledger-authoritative; see ADR-012.

### Credit lines per Account (B2B)

AGENCY and CORPORATE account types may have a `CreditLine` with
limit, currency, billing cycle, and terms. Exposure is a derived view
over `CREDIT_DRAWDOWN`/`CREDIT_SETTLEMENT` ledger entries (ADR-012).

### Referral issuance per Account (B2C primary)

Each B2C `Account` may own one or more `ReferralInvite` records with
state machine defined in ADR-014. Anti-fraud evaluation produces
per-invite decision traces stored alongside the invite.

### Tenancy scoping

All of the above — wallet accounts, credit lines, referral invites,
fraud decisions — carry `tenant_id` as a leading index column. Tenant
isolation rules from the original decision apply without exception.
