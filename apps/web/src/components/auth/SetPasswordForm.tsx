'use client';

// Sets a password from a Supabase recovery token (?token_hash=…): used by the
// team invite (/invite/passwort) and by "Passwort vergessen" (/passwort-neu).
// The single-use token is redeemed on SUBMIT, not on page load (review
// 2026-07-23): redeeming on load would consume it for link-prefetching mail
// scanners and for people who open the page but set the password later.
import { useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { AuthPasswordField, AuthSubmit } from '@/components/auth/AuthFields';
import Callout from '@/components/ui/Callout';
import Icon from '@/components/ui/Icon';

type Phase = 'ready' | 'saving' | 'done' | 'invalid';

export default function SetPasswordForm({
  invalid,
  submitLabel,
  redirectTo,
}: {
  /** Shown for a missing, used or expired token. */
  invalid: ReactNode;
  submitLabel: string;
  /** Where to go once the password is saved. */
  redirectTo: string;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tokenHash = searchParams.get('token_hash') ?? '';
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
      setError(
        updateError.code === 'same_password'
          ? 'Bitte wähle ein anderes Passwort als bisher.'
          : 'Das Passwort konnte nicht gespeichert werden. Bitte erneut versuchen.'
      );
      return;
    }
    setPhase('done');
    setTimeout(() => router.replace(redirectTo), 1200);
  };

  if (phase === 'invalid') return <>{invalid}</>;

  if (phase === 'done') {
    return (
      <div className="authx-done" role="status">
        <span className="authx-done-icon">
          <Icon name="check" size={20} />
        </span>
        <span>
          <strong>Passwort gespeichert.</strong> Du wirst gleich weitergeleitet …
        </span>
      </div>
    );
  }

  return (
    <form className="authx-form" onSubmit={submit}>
      <AuthPasswordField
        id="pw"
        label="Neues Passwort"
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="Mindestens 8 Zeichen"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <AuthPasswordField
        id="pw2"
        label="Passwort bestätigen"
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="Noch einmal eingeben"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <AuthSubmit label={submitLabel} pendingLabel="Wird gespeichert …" pending={phase === 'saving'} />
    </form>
  );
}
