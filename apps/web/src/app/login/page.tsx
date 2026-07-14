import { signIn } from '../actions';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; next?: string }>;
}) {
  const { error, notice, next } = await searchParams;

  return (
    <main className="centered">
      <div className="auth-wrap">
        <div className="auth-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="onlight" src="/brand/logo-onlight.svg" alt="Zendori" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ondark" src="/brand/logo-ondark.svg" alt="Zendori" />
        </div>
        <div className="card">
          <h1>Willkommen zurück</h1>
          <p className="sub">Melde dich bei deinem Konto an.</p>
          {error ? <p className="error">{error}</p> : null}
          {notice ? <p className="notice">{notice}</p> : null}
          <form className="stack" action={signIn}>
            <input type="hidden" name="next" value={next ?? '/'} />
            <div>
              <label htmlFor="email">E-Mail</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div>
              <label htmlFor="password">Passwort</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <button className="primary" type="submit">
              Anmelden
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
