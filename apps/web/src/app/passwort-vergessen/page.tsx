import Link from 'next/link';
import { requestPasswordReset } from './actions';
import AuthSplit from '@/components/auth/AuthSplit';
import { AuthSubmit, AuthTextField } from '@/components/auth/AuthFields';
import Callout from '@/components/ui/Callout';
import Icon from '@/components/ui/Icon';

export const metadata = { title: 'Passwort vergessen' };

function BackToLogin() {
  return (
    <Link className="authx-link authx-back" href="/login">
      <Icon name="arrowLeft" size={15} />
      Zurück zur Anmeldung
    </Link>
  );
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  if (sent) {
    return (
      <AuthSplit
        chip="Passwort vergessen"
        title="Schau in dein Postfach."
        subtitle="Wenn ein Konto zu dieser Adresse existiert, ist jetzt eine E-Mail mit einem Link unterwegs."
      >
        <div className="authx-done">
          <span className="authx-done-icon">
            <Icon name="mail" size={20} />
          </span>
          <span>
            Öffne die E-Mail und klicke auf <strong>„Neues Passwort festlegen“</strong>. Der Link
            gilt nur einmal und ist zeitlich begrenzt. Nichts angekommen? Schau im Spam-Ordner
            nach oder fordere den Link in ein paar Minuten erneut an.
          </span>
        </div>
        <BackToLogin />
      </AuthSplit>
    );
  }

  return (
    <AuthSplit
      chip="Passwort vergessen"
      title="Neues Passwort anfordern."
      subtitle="Gib die E-Mail-Adresse deines Kontos ein. Wir schicken dir einen Link, mit dem du ein neues Passwort festlegst."
    >
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <form className="authx-form" action={requestPasswordReset}>
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
        <AuthSubmit label="Link senden" pendingLabel="Wird gesendet …" />
      </form>
      <BackToLogin />
    </AuthSplit>
  );
}
