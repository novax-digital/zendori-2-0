import { Suspense } from 'react';
import Link from 'next/link';
import AuthSplit from '@/components/auth/AuthSplit';
import SetPasswordForm from '@/components/auth/SetPasswordForm';
import Callout from '@/components/ui/Callout';

// Target of the "Passwort vergessen" mail (lib/auth/password-reset.ts). Public
// in the middleware, bare in the AppShell.

export const metadata = { title: 'Neues Passwort', robots: { index: false } };

export default function NewPasswordPage() {
  return (
    <AuthSplit
      chip="Passwort zurücksetzen"
      title="Neues Passwort festlegen."
      subtitle="Wähle ein sicheres Passwort mit mindestens 8 Zeichen. Danach bist du direkt angemeldet."
    >
      <Suspense fallback={null}>
        <SetPasswordForm
          submitLabel="Passwort speichern"
          redirectTo="/"
          invalid={
            <Callout tone="danger" title="Dieser Link ist ungültig oder abgelaufen.">
              Links zum Zurücksetzen gelten nur einmal und nur für kurze Zeit.{' '}
              <Link href="/passwort-vergessen">Neuen Link anfordern</Link>
            </Callout>
          }
        />
      </Suspense>
    </AuthSplit>
  );
}
