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
