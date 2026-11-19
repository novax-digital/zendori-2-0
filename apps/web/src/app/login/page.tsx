import Link from 'next/link';
import { signIn } from '../actions';
import AuthSplit from '@/components/auth/AuthSplit';
import { AuthPasswordField, AuthSubmit, AuthTextField } from '@/components/auth/AuthFields';
import Callout from '@/components/ui/Callout';

export const metadata = { title: 'Anmelden' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; next?: string }>;
}) {
  const { error, notice, next } = await searchParams;

  return (
    <AuthSplit
      chip="Anmeldung"
      title="Willkommen zurück."
      subtitle="Melde dich an, um deinen Posteingang, deine Agenten und Kanäle zu verwalten."
      footer={
        <>
          Noch kein Zugang?{' '}
          <a href="https://zendori.ai/demo">Demo-Anruf anfordern</a>
        </>
      }
    >
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {notice ? <Callout tone="success">{notice}</Callout> : null}
      <form className="authx-form" action={signIn}>
        <input type="hidden" name="next" value={next ?? '/'} />
        <AuthTextField
          id="email"
          name="email"
          type="email"
          label="E-Mail"
          icon="mail"
          autoComplete="email"
          placeholder="du@firma.de"
          required
        />
        <AuthPasswordField
          id="password"
          name="password"
          label="Passwort"
          autoComplete="current-password"
          placeholder="••••••••"
          required
          aside={
            <Link className="authx-link" href="/passwort-vergessen">
              Passwort vergessen?
            </Link>
          }
        />
        <AuthSubmit label="Anmelden" pendingLabel="Wird angemeldet …" />
      </form>
    </AuthSplit>
  );
}
