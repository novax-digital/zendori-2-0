import { Suspense } from 'react';
import AuthSplit from '@/components/auth/AuthSplit';
import SetPasswordForm from '@/components/auth/SetPasswordForm';
import Callout from '@/components/ui/Callout';

// Password-setup page for invited team members (0024). The invite mail carries
// a Supabase recovery token (?token_hash=…); SetPasswordForm redeems it on
// submit and sets the password. Renders bare (AppShell BARE_PREFIXES includes
// /invite) and is public in the middleware — an expired/used token shows a
// hint to request a fresh invite.

export const metadata = { title: 'Passwort festlegen', robots: { index: false } };

export default function PasswordSetupPage() {
  return (
    <AuthSplit
      chip="Einladung"
      title="Willkommen bei Zendori."
      subtitle="Lege dein Passwort fest, um loszulegen. Mindestens 8 Zeichen."
    >
      <Suspense fallback={null}>
        <SetPasswordForm
          submitLabel="Passwort speichern"
          redirectTo="/inbox"
          invalid={
            <Callout tone="danger" title="Dieser Einladungslink ist ungültig oder abgelaufen.">
              Bitte lass dir vom Team-Verantwortlichen eine neue Einladung senden („Einladung
              erneut senden“ unter Team).
            </Callout>
          }
        />
      </Suspense>
    </AuthSplit>
  );
}
