import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-029 step 5 — component boundary tests.
 *
 * Components are client-facing. None should import server-only modules
 * (session, auth0, api-client) — that would leak server dependencies
 * into the client bundle. We scan sources statically rather than at
 * runtime so the checks are independent of the module graph.
 */

const COMPONENTS_DIR = path.resolve(__dirname, '..');

const SERVER_ONLY_MODULES = [
  'server-only',
  'lib/session',
  'lib/auth0',
  'lib/api-client',
];

async function readComponentSources(): Promise<
  { file: string; content: string }[]
> {
  const entries = await fsp.readdir(COMPONENTS_DIR, { withFileTypes: true });
  const results: { file: string; content: string }[] = [];
  for (const entry of entries) {
    if (
      entry.isFile() &&
      (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.test.ts')
    ) {
      const fullPath = path.join(COMPONENTS_DIR, entry.name);
      results.push({ file: entry.name, content: await fsp.readFile(fullPath, 'utf8') });
    }
  }
  return results;
}

describe('Component boundary — no server-only imports', () => {
  it('V — no component file imports server-only modules', async () => {
    const sources = await readComponentSources();
    expect(sources.length).toBeGreaterThan(0);

    for (const { file, content } of sources) {
      for (const mod of SERVER_ONLY_MODULES) {
        const hasImport =
          content.includes(`from '${mod}'`) ||
          content.includes(`from "${mod}"`) ||
          content.includes(`require('${mod}')`) ||
          content.includes(`require("${mod}")`);
        expect(hasImport, `${file} must not import '${mod}'`).toBe(false);
      }
    }
  });

  it('W — no component file imports next/headers or next/cookies (server-only Next APIs)', async () => {
    const sources = await readComponentSources();
    const serverNextApis = ['next/headers', 'next/cookies'];
    for (const { file, content } of sources) {
      for (const api of serverNextApis) {
        const hasImport =
          content.includes(`from '${api}'`) ||
          content.includes(`from "${api}"`);
        expect(hasImport, `${file} must not import '${api}'`).toBe(false);
      }
    }
  });

  it('X — all interactive components declare "use client"', async () => {
    const INTERACTIVE = ['Button.tsx', 'Input.tsx', 'Textarea.tsx'];
    const sources = await readComponentSources();
    for (const { file, content } of sources) {
      if (INTERACTIVE.includes(file)) {
        expect(
          content.trimStart().startsWith("'use client'"),
          `${file} must start with 'use client'`,
        ).toBe(true);
      }
    }
  });
});
