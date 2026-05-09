import { defineConfig } from 'vitest/config';

export default defineConfig({
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
