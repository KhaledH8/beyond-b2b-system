import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Admin app vitest config (ADR-029 step 1 + step 2).
 *
 * The root `vitest.config.ts` only includes `apps/* /src/**` (via the
 * existing `apps/api` convention). The admin app uses `apps/admin/lib/`
 * for server-side helpers per the ADR-029 layout — so we widen the
 * include pattern locally rather than forcing a `src/` directory the
 * Next.js App Router does not need.
 *
 * `server-only` is a Next.js virtual module — Next emits it at build
 * time as a hard fence against client-side import. It does not
 * resolve under vitest, so we alias it to a no-op stub. The runtime
 * fence is still active under `next build` (admin step-3+ verifies
 * this in CI).
 */
export default defineConfig({
  resolve: {
    alias: {
      'server-only': fileURLToPath(
        new URL('./test/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  // Use the React automatic JSX runtime so `<>...</>` and JSX in
  // server-component sources don't require `import React from 'react'`
  // (Next 15's compiler does the same in production).
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    passWithNoTests: true,
    include: [
      'lib/**/*.{test,spec}.ts',
      'lib/**/*.{test,spec}.tsx',
      'app/**/*.{test,spec}.ts',
      'app/**/*.{test,spec}.tsx',
      'components/**/*.{test,spec}.tsx',
    ],
  },
});
