import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@zendori/core', '@zendori/channels', '@zendori/ai'],
  // Fonts the chat widget may load on customer websites (theme font "Inter" /
  // "Sora"): cross-origin font loads need CORS, and the files never change.
  async headers() {
    return [
      {
        source: '/widget-fonts/:file*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
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
