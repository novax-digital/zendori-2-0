import { signIn } from '../actions';
import AuthCard from '@/components/ui/AuthCard';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; next?: string }>;
}) {
  const { error, notice, next } = await searchParams;

  return (
    <AuthCard title="Willkommen zurück" subtitle="Melde dich bei deinem Konto an.">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {notice ? <Callout tone="success">{notice}</Callout> : null}
      <form className="stack" action={signIn}>
        <input type="hidden" name="next" value={next ?? '/'} />
        <Field label="E-Mail" htmlFor="email">
          <input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Passwort" htmlFor="password">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Button type="submit" variant="primary">
          Anmelden
        </Button>
      </form>
    </AuthCard>
  );
}
