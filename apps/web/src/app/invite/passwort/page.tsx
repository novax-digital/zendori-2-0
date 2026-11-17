'use client';

// Password-setup page for invited team members (0024). The invite mail carries
// a Supabase recovery token (?token_hash=…); this page redeems it once via
// verifyOtp (which establishes a session) and lets the invitee set their
// password. Renders bare (AppShell BARE_PREFIXES includes /invite) and is
// public in the middleware — an expired/used token shows a friendly hint to
// request a fresh invite.
import { Suspense, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import AuthCard from '@/components/ui/AuthCard';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';

type Phase = 'ready' | 'saving' | 'done' | 'invalid';

function PasswordSetupInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tokenHash = searchParams.get('token_hash') ?? '';
  // The single-use recovery token is redeemed on SUBMIT, not on page load
  // (review 2026-07-23): redeeming on load would consume the token for
  // link-prefetching mail scanners and for invitees who open the page but set
  // the password later — leaving a passwordless "Aktiv" account behind.
  const [phase, setPhase] = useState<Phase>(tokenHash ? 'ready' : 'invalid');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const redeemedRef = useRef(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Das Passwort muss mindestens 8 Zeichen lang sein.');
      return;
    }
    if (password !== confirm) {
      setError('Die Passwörter stimmen nicht überein.');
      return;
    }
    setPhase('saving');
    const supabase = createSupabaseBrowserClient();
    // Redeem once; a retry after a failed password update keeps the session
    // from the first redemption instead of burning the token again.
    if (!redeemedRef.current) {
      const { error: otpError } = await supabase.auth.verifyOtp({
        type: 'recovery',
        token_hash: tokenHash,
      });
      if (otpError) {
        setPhase('invalid');
        return;
      }
      redeemedRef.current = true;
    }
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setPhase('ready');
      setError('Das Passwort konnte nicht gespeichert werden. Bitte erneut versuchen.');
      return;
    }
    setPhase('done');
    setTimeout(() => router.replace('/inbox'), 1200);
  };

  return (
    <AuthCard title="Passwort festlegen">
      {phase === 'invalid' ? (
        <Callout tone="danger" title="Dieser Einladungslink ist ungültig oder abgelaufen.">
          Bitte lass dir vom Team-Verantwortlichen eine neue Einladung senden („Einladung erneut
          senden" unter Team).
        </Callout>
      ) : null}

      {phase === 'ready' || phase === 'saving' ? (
        <form className="stack" onSubmit={submit}>
          <p className="muted small">Willkommen bei Zendori! Lege dein Passwort fest, um loszulegen.</p>
          <Field label="Passwort (mindestens 8 Zeichen)" htmlFor="pw">
            <input
              id="pw"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Passwort bestätigen" htmlFor="pw2">
            <input
              id="pw2"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Button type="submit" variant="primary" disabled={phase === 'saving'}>
            {phase === 'saving' ? 'Wird gespeichert…' : 'Passwort speichern'}
          </Button>
        </form>
      ) : null}

      {phase === 'done' ? (
        <Callout tone="success">Passwort gespeichert. Du wirst zur Inbox weitergeleitet.</Callout>
      ) : null}
    </AuthCard>
  );
}

export default function PasswordSetupPage() {
  return (
    <Suspense fallback={null}>
      <PasswordSetupInner />
    </Suspense>
  );
}
