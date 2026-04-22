import type { NextConfig } from 'next';

const config: NextConfig = {
  // ESLint runs via `pnpm lint` (root eslint.config.mjs); skip the redundant
  // build-time pass that Next.js runs by default to avoid plugin warnings.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@bb/ui', '@bb/domain'],
};

export default config;
