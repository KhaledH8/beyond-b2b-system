import { defineConfig } from 'vitest/config';

/**
 * Admin app vitest config (ADR-029 step 1).
 *
 * The root `vitest.config.ts` only includes `apps/* /src/**` (via the
 * existing `apps/api` convention). The admin app uses `apps/admin/lib/`
 * for server-side helpers per the ADR-029 layout — so we widen the
 * include pattern locally rather than forcing a `src/` directory the
 * Next.js App Router does not need.
 */
export default defineConfig({
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
