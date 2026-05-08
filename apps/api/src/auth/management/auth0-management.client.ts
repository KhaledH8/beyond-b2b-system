import { Inject, Injectable, Logger } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../auth.tokens';
import { Auth0ManagementTokenService } from './auth0-management-token.service';

/**
 * Thin wrapper over the Auth0 Management API endpoints we use for
 * E2-B admin provisioning.
 *
 * Surface kept narrow on purpose:
 *
 *   - `createUser`   — POST /api/v2/users
 *   - `updateUser`   — PATCH /api/v2/users/{id}
 *   - `deleteUser`   — DELETE /api/v2/users/{id}
 *   - `getUserById`  — GET /api/v2/users/{id} (used by the bootstrap
 *                       script to confirm an admin-created Auth0 user
 *                       exists before writing the DB row).
 *
 * We deliberately do NOT pull in `auth0` npm package — the surface is
 * small, the contract is stable, and a full SDK would also pull in
 * `jsonwebtoken` etc. that we already replaced with node:crypto.
 *
 * Errors are surfaced as `Auth0ManagementError` with the HTTP status,
 * Auth0 error code, and a short message. Callers map them to domain
 * errors (e.g. `EmailAlreadyTakenError`).
 */
@Injectable()
export class Auth0ManagementClient {
  private readonly logger = new Logger(Auth0ManagementClient.name);

  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(Auth0ManagementTokenService)
    private readonly tokenService: Auth0ManagementTokenService,
  ) {}

  async createUser(input: CreateAuth0UserInput): Promise<Auth0UserResource> {
    const body: Record<string, unknown> = {
      // Locked default: every admin-provisioned user comes from the
      // Username-Password-Authentication database connection. SSO
      // connections are out of scope for V1; if a future tenant wants
      // SAML/OIDC connections, that's a config field on the
      // provisioning request, not a hardcoded change here.
      connection: input.connection ?? 'Username-Password-Authentication',
      email: input.email,
      email_verified: input.emailVerified ?? false,
      // App metadata carries our application-side identifiers and the
      // user_class. Auth0 Actions copy the relevant fields into the
      // namespaced custom claims at token mint time (E2-A claims:
      // tenant_id, user_class, account_id).
      app_metadata: {
        tenant_id: input.tenantId,
        user_class: input.userClass,
        ...(input.accountId !== undefined
          ? { account_id: input.accountId }
          : {}),
      },
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.password !== undefined
        ? { password: input.password }
        : { verify_email: true }),
    };
    return this.fetchJson('POST', '/api/v2/users', body);
  }

  async updateUser(
    auth0UserId: string,
    patch: UpdateAuth0UserInput,
  ): Promise<Auth0UserResource> {
    const body: Record<string, unknown> = {};
    if (patch.email !== undefined) body['email'] = patch.email;
    if (patch.name !== undefined) body['name'] = patch.name;
    if (patch.blocked !== undefined) body['blocked'] = patch.blocked;
    if (patch.appMetadata !== undefined) body['app_metadata'] = patch.appMetadata;
    return this.fetchJson('PATCH', `/api/v2/users/${encodeURIComponent(auth0UserId)}`, body);
  }

  async deleteUser(auth0UserId: string): Promise<void> {
    await this.fetchJson(
      'DELETE',
      `/api/v2/users/${encodeURIComponent(auth0UserId)}`,
    );
  }

  async getUserById(auth0UserId: string): Promise<Auth0UserResource | null> {
    try {
      return await this.fetchJson(
        'GET',
        `/api/v2/users/${encodeURIComponent(auth0UserId)}`,
      );
    } catch (err) {
      if (err instanceof Auth0ManagementError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  private async fetchJson(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Auth0UserResource> {
    const token = await this.tokenService.getAccessToken();
    const url = `${this.config.issuerBaseUrl.replace(/\/$/, '')}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 204) {
      return {} as Auth0UserResource;
    }
    const text = await response.text();
    if (!response.ok) {
      this.logger.warn(
        `Auth0 Management ${method} ${path} -> ${response.status}: ${truncate(text, 200)}`,
      );
      throw parseManagementError(response.status, text);
    }
    if (text.length === 0) return {} as Auth0UserResource;
    try {
      return JSON.parse(text) as Auth0UserResource;
    } catch {
      throw new Auth0ManagementError(
        response.status,
        'invalid_json',
        'Auth0 Management API returned non-JSON body',
      );
    }
  }
}

export interface CreateAuth0UserInput {
  readonly email: string;
  readonly tenantId: string;
  readonly userClass: 'OPERATOR' | 'AGENCY';
  readonly accountId?: string;
  readonly name?: string;
  readonly emailVerified?: boolean;
  readonly password?: string;
  readonly connection?: string;
}

export interface UpdateAuth0UserInput {
  readonly email?: string;
  readonly name?: string;
  readonly blocked?: boolean;
  readonly appMetadata?: Record<string, unknown>;
}

export interface Auth0UserResource {
  readonly user_id?: string;
  readonly email?: string;
  readonly name?: string;
  readonly app_metadata?: Record<string, unknown>;
}

export class Auth0ManagementError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'Auth0ManagementError';
  }
}

function parseManagementError(status: number, text: string): Auth0ManagementError {
  let code = 'unknown';
  let message = text;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (typeof json['errorCode'] === 'string') code = json['errorCode'];
    else if (typeof json['error'] === 'string') code = json['error'];
    if (typeof json['message'] === 'string') message = json['message'];
    else if (typeof json['error_description'] === 'string') {
      message = json['error_description'];
    }
  } catch {
    // Non-JSON error body — keep the raw text as the message.
  }
  return new Auth0ManagementError(status, code, truncate(message, 300));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
