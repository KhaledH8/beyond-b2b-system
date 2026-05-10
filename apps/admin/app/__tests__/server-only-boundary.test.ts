import { describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';

/**
 * ADR-029 step 4 — server-only boundary smoke check.
 *
 * Statically scans every TS/TSX file under `apps/admin/app/` and
 * `apps/admin/components/` (when it exists) and asserts:
 *
 *   1. No file marked `'use client'` imports the server-only
 *      modules: `lib/session`, `lib/auth0`, or `lib/api-client`.
 *      The runtime fence at `next build` already enforces this —
 *      this test catches the violation at vitest time so a
 *      misplaced `'use client'` directive fails CI before it
 *      reaches a build.
 *
 *   2. None of those three server-only modules has a `'use client'`
 *      directive at the top.
 *
 * The check is a static-source smoke test, not a dependency-graph
 * analysis. It catches the obvious mistake (`'use client'` +
 * `import { ... } from '@/lib/session'` in the same file) and
 * trusts the rest to the Next.js runtime fence.
 */

const SERVER_MODULES = [
  'lib/session',
  'lib/auth0',
  'lib/api-client',
];

async function walkTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.next') continue;
        await visit(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
    }
  }
  await visit(root);
  return out;
}

function adminRoot(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  // here is apps/admin/app/__tests__; admin root is two up.
  return path.resolve(here, '..', '..');
}

function isClientComponent(src: string): boolean {
  // Match the directive on the very first non-empty, non-comment line.
  // Next.js requires it at the top of the file. A simple heuristic:
  // the directive appears within the first 200 chars and is the first
  // non-whitespace string-literal statement.
  const head = src.slice(0, 200);
  return (
    /^['"]use client['"];?\s*$/m.test(head) &&
    /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(src)
  );
}

function importsAny(src: string, modules: readonly string[]): string | null {
  for (const m of modules) {
    // Match `from '...lib/session'` or `from '...lib/session.ts'` etc.
    const re = new RegExp(`from\\s+['"][^'"]*${m.replace(/\//g, '\\/')}['"]`);
    if (re.test(src)) return m;
  }
  return null;
}

describe('server-only boundary — static source scan', () => {
  it('I — no `use client` file in apps/admin/app imports server-only lib modules', async () => {
    const files = await walkTree(path.join(adminRoot(), 'app'));
    const violations: string[] = [];
    for (const f of files) {
      const src = await fsp.readFile(f, 'utf8');
      if (isClientComponent(src)) {
        const offending = importsAny(src, SERVER_MODULES);
        if (offending) {
          violations.push(`${f} (use client) imports ${offending}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('J — no `use client` file in apps/admin/components imports server-only lib modules', async () => {
    const componentsDir = path.join(adminRoot(), 'components');
    const files = await walkTree(componentsDir);
    const violations: string[] = [];
    for (const f of files) {
      const src = await fsp.readFile(f, 'utf8');
      if (isClientComponent(src)) {
        const offending = importsAny(src, SERVER_MODULES);
        if (offending) {
          violations.push(`${f} (use client) imports ${offending}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('K — none of session/auth0/api-client are marked `use client`', async () => {
    const libDir = path.join(adminRoot(), 'lib');
    const targets = ['session.ts', 'auth0.ts', 'api-client.ts'];
    const offenders: string[] = [];
    for (const t of targets) {
      const src = await fsp.readFile(path.join(libDir, t), 'utf8');
      if (isClientComponent(src)) offenders.push(t);
    }
    expect(offenders).toEqual([]);
  });

  it('L — session/auth0/api-client all start with `import "server-only"`', async () => {
    const libDir = path.join(adminRoot(), 'lib');
    const targets = ['session.ts', 'auth0.ts', 'api-client.ts'];
    for (const t of targets) {
      const src = await fsp.readFile(path.join(libDir, t), 'utf8');
      expect(
        src.startsWith("import 'server-only';"),
        `${t} must start with import 'server-only'`,
      ).toBe(true);
    }
  });
});
