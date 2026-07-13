import Link from 'next/link';
import { signUp } from '../actions';

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="centered">
      <div className="card">
        <h1>Konto erstellen</h1>
        <p className="sub">Registriere dich, um Zendori zu nutzen.</p>
        {error ? <p className="error">{error}</p> : null}
        <form className="stack" action={signUp}>
          <div>
            <label htmlFor="email">E-Mail</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div>
            <label htmlFor="password">Passwort (min. 8 Zeichen)</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <button className="primary" type="submit">
            Registrieren
          </button>
        </form>
        <p className="sub" style={{ marginTop: '1rem', marginBottom: 0 }}>
          Bereits ein Konto? <Link href="/login">Anmelden</Link>
        </p>
      </div>
    </main>
  );
}
