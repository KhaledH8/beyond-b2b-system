import type { NextConfig } from 'next';

const config: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@bb/ui', '@bb/domain'],
};

export default config;
