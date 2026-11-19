import type { Metadata } from 'next';
import Script from 'next/script';

// Hosted Demo-Anruf page (docs/demo-call.md): a shareable stand-alone link
// and the reference integration of the demo.js embed (same-origin API base).
// Renders bare (no app chrome — AppShell BARE_PREFIXES + middleware allowlist).

export const metadata: Metadata = {
  title: 'Demo-Anruf',
  robots: { index: false },
};

export default function DemoPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1rem',
        background: 'var(--surface, #f1f5f9)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '680px',
          background: '#ffffff',
          borderRadius: '18px',
          boxShadow: '0 10px 40px rgba(15, 23, 42, 0.08)',
          padding: '2rem',
        }}
      >
        <div data-zendori-demo="" data-accent="#12c7c4" />
      </div>
      <p style={{ marginTop: '1.2rem', fontSize: '0.8rem', color: '#94a3b8' }}>
        Bereitgestellt mit Zendori
      </p>
      <Script src="/demo.js" strategy="afterInteractive" />
    </div>
  );
}
