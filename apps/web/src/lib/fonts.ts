import localFont from 'next/font/local';

// Self-hosted Inter (no layout shift, no external requests) — the single UI face,
// matching the Zendori website. Exposed as a CSS variable used in globals.css.

export const inter = localFont({
  variable: '--font-inter',
  display: 'swap',
  src: [
    { path: '../fonts/Inter-Regular.ttf', weight: '400', style: 'normal' },
    { path: '../fonts/Inter-Medium.ttf', weight: '500', style: 'normal' },
    { path: '../fonts/Inter-SemiBold.ttf', weight: '600', style: 'normal' },
    { path: '../fonts/Inter-Bold.ttf', weight: '700', style: 'normal' },
  ],
});

// Sora — the brand headline face (zendori.ai, Brand Guidelines v1.0). Only the
// sign-in pages use it (auth headlines); exposed as --font-sora on their root.
export const sora = localFont({
  variable: '--font-sora',
  display: 'swap',
  src: [
    { path: '../fonts/Sora-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/Sora-SemiBold.woff2', weight: '600', style: 'normal' },
  ],
});
