import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import {
  BootstrapPlatformAdminService,
  type BootstrapInput,
} from './bootstrap-platform-admin.service';

/**
 * CLI entry point for the platform_admin bootstrap (Slice E2-B).
 *
 * Usage:
 *
 *   AUTH0_ISSUER_BASE_URL=https://auth.beyondborders.platform/ \
 *   AUTH0_AUDIENCE=https://api.beyondborders.platform \
 *   AUTH0_DEFAULT_TENANT_ID=01ARZ3NDEKTSV4RRFFQ69G5FAV \
 *   DATABASE_URL=postgres://... \
 *   pnpm --filter @bb/api exec ts-node \
 *     src/auth/bootstrap/bootstrap-platform-admin.ts \
 *     --auth0-sub auth0|6541... \
 *     --email admin@beyondborders.platform \
 *     --tenant-id 01ARZ3NDEKTSV4RRFFQ69G5FAV \
 *     [--display-name "Admin Name"]
 *
 * Idempotent: a second run with the same `--auth0-sub` reuses the
 * existing row and the existing grant; nothing duplicates.
 *
 * Exit codes:
 *
 *   0  success (created or reused)
 *   1  invalid arguments / required flag missing
 *   2  service-side error (DB unreachable, etc.)
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.auth0Sub || !args.email || !args.tenantId) {
    console.error(
      'Missing required flag. Usage: --auth0-sub <sub> --email <email> --tenant-id <ulid> [--display-name <name>]',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const service = app.get(BootstrapPlatformAdminService);
    const input: BootstrapInput = {
      auth0Sub: args.auth0Sub,
      email: args.email,
      tenantId: args.tenantId,
      ...(args.displayName !== undefined
        ? { displayName: args.displayName }
        : {}),
    };
    const result = await service.ensure(input);
    // Stable JSON output so a deployment runbook can pipe the result
    // into another tool (e.g. recording the assigned core_user.id).
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(2);
  } finally {
    await app.close();
  }
}

interface ParsedArgs {
  auth0Sub?: string;
  email?: string;
  tenantId?: string;
  displayName?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (typeof flag !== 'string' || typeof value !== 'string') break;
    switch (flag) {
      case '--auth0-sub':
        out.auth0Sub = value;
        i++;
        break;
      case '--email':
        out.email = value;
        i++;
        break;
      case '--tenant-id':
        out.tenantId = value;
        i++;
        break;
      case '--display-name':
        out.displayName = value;
        i++;
        break;
      default:
        // Unknown flag; ignore so future additions are non-breaking.
        break;
    }
  }
  return out;
}

void main();
