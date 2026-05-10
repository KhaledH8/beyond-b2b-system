import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Next.js virtual module; doesn't resolve under vitest. The
      // admin `lib/session.ts` and `lib/auth0.ts` import this at the
      // top to fence them off from client components at build time.
      // The runtime fence is active under `next build`; vitest sees
      // an empty stub.
      'server-only': fileURLToPath(
        new URL('./apps/admin/test/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  // ADR-029 step 4: admin tests exercise app-router layouts that
  // contain JSX. Use the React automatic JSX runtime so the test
  // transform doesn't require an explicit `import React from 'react'`
  // in source files (Next 15's compiler does the same in production).
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    passWithNoTests: true,
    include: [
      'packages/*/src/**/*.{test,spec}.ts',
      'packages/*/*/src/**/*.{test,spec}.ts',
      'apps/*/src/**/*.{test,spec}.ts',
      // ADR-029: apps/admin uses lib/ rather than src/ (Next.js App
      // Router convention); the per-app vitest.config.ts mirrors this.
      'apps/*/lib/**/*.{test,spec}.ts',
      // ADR-029 step 4: app/ holds layouts and pages (route handlers
      // for the Next.js App Router); their `__tests__` directories
      // hold the layout/page unit tests. Both .ts and .tsx are
      // picked up because some tests construct JSX fixtures.
      'apps/*/app/**/*.{test,spec}.{ts,tsx}',
    ],
  },
});
