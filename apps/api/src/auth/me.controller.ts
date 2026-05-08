import { Controller, Get, UseGuards } from '@nestjs/common';
import { Auth, type AuthContext } from './auth-context';
import { JwtAuthGuard } from './jwt/jwt-auth.guard';

/**
 * `GET /me` — minimal protected endpoint exercising the full auth
 * stack: bearer extraction, JWT validation, user sync, AuthContext
 * population.
 *
 * Returns the resolved auth context (no PII, no role list — roles
 * land in E3). Useful for:
 *
 *   - Smoke-testing the deployed auth pipeline.
 *   - Letting a freshly-authenticated UI confirm the session is
 *     established before requesting other resources.
 *
 * This endpoint is intentionally thin in this slice. A richer
 * "/me" returning roles, account membership, and feature flags
 * lives in E3+ once role/membership tables exist.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class MeController {
  @Get('me')
  async me(@Auth() auth: AuthContext): Promise<AuthContext> {
    return auth;
  }
}
