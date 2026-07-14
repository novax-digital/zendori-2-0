import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { inter } from '@/lib/fonts';
import AppShell from '@/components/AppShell';

export const metadata: Metadata = {
  title: {
    default: 'Zendori',
    template: '%s · Zendori',
  },
  description: 'Multichannel-Kundensupport — alle Kanäle, eine Inbox.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '48x48' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#12c7c4',
};

// Resolves the stored theme preference to an explicit data-theme BEFORE paint,
// so switching or reloading never flashes the wrong theme. 'auto' follows the OS.
const themeScript = `(function(){try{var p=localStorage.getItem('zendori-theme')||'auto';var d=p==='dark'||(p==='auto'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
