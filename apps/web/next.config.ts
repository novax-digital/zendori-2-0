import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@zendori/core', '@zendori/channels', '@zendori/ai'],
};

export default nextConfig;
