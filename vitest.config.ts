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
  test: {
    passWithNoTests: true,
    include: [
      'packages/*/src/**/*.{test,spec}.ts',
      'packages/*/*/src/**/*.{test,spec}.ts',
      'apps/*/src/**/*.{test,spec}.ts',
      // ADR-029: apps/admin uses lib/ rather than src/ (Next.js App
      // Router convention); the per-app vitest.config.ts mirrors this.
      'apps/*/lib/**/*.{test,spec}.ts',
    ],
  },
});
