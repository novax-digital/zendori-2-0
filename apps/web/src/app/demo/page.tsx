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
  // Same frame as the demo box on zendori.ai (DemoCallForm.astro): 1px brand
  // gradient border around a white card on mist. The embed brings the brand
  // look itself; Sora/Inter fall back to system fonts on this page.
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1rem',
        background: '#f4f7fa',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '620px',
          borderRadius: '22px',
          padding: '1px',
          background: 'linear-gradient(135deg, rgba(0, 208, 132, 0.7), rgba(0, 153, 255, 0.7))',
          boxShadow: '0 30px 80px -30px rgba(0, 153, 255, 0.55)',
        }}
      >
        <div style={{ background: '#ffffff', borderRadius: '21px', padding: 'clamp(1.2rem, 1rem + 1.5vw, 2rem)' }}>
          <div data-zendori-demo="" data-privacy-url="https://zendori.ai/datenschutzerklaerung" />
        </div>
      </div>
      <p style={{ marginTop: '1.2rem', fontSize: '0.8rem', color: '#94a3b8' }}>
        Bereitgestellt mit Zendori
      </p>
      <Script src="/demo.js" strategy="afterInteractive" />
    </div>
  );
}
