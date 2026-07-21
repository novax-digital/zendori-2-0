import type { Metadata } from 'next';
import HostedForm from './HostedForm';

// Hosted public form page (Phase 10): shareable stand-alone rendering of a
// builder form — the test target from the builder, a QR/e-mail-signature
// link, and the fallback for CMSs that strip third-party scripts. Renders
// bare (no app chrome, see AppShell BARE_PREFIXES + middleware allowlist).
// The definition is loaded CLIENT-side via /api/forms/bootstrap so the page
// gets a valid render token exactly like the embed.

export const metadata: Metadata = {
  title: 'Kontaktformular',
  robots: { index: false },
};

export default async function HostedFormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
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
        <HostedForm token={token} />
      </div>
      <p style={{ marginTop: '1.2rem', fontSize: '0.8rem', color: '#94a3b8' }}>
        Bereitgestellt mit Zendori
      </p>
    </div>
  );
}
