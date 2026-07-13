import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@zendori/core', '@zendori/channels', '@zendori/ai'],
  webpack: (config) => {
    // Workspace packages ship TS sources with NodeNext-style `.js` relative
    // imports; teach webpack to resolve those to the `.ts` files.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
