import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@bb/ui', '@bb/domain'],
};

export default config;
