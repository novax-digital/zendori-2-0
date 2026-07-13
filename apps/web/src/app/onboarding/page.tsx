import { redirect } from 'next/navigation';
import { createOrganization } from '../actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships } = await supabase.from('org_members').select('org_id').limit(1);
  if (memberships && memberships.length > 0) redirect('/');

  return (
    <main className="centered">
      <div className="card">
        <h1>Organisation anlegen</h1>
        <p className="sub">
          Erstelle deine Organisation — der Mandant, in dem Kanäle, Konversationen und dein Team
          leben.
        </p>
        {error ? <p className="error">{error}</p> : null}
        <form className="stack" action={createOrganization}>
          <div>
            <label htmlFor="name">Name der Organisation</label>
            <input id="name" name="name" type="text" placeholder="z. B. Strong Energy" required />
          </div>
          <button className="primary" type="submit">
            Organisation erstellen
          </button>
        </form>
      </div>
    </main>
  );
}
