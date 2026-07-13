import { redirect } from 'next/navigation';
import { acceptInvite } from '../../actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type InviteDetails = { org_name: string; email: string; role: string; expires_at: string };

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);

  const { data } = await supabase.rpc('invite_details', { p_token: token });
  const invite = (data as InviteDetails[] | null)?.[0];

  return (
    <main className="centered">
      <div className="card">
        <h1>Einladung</h1>
        {!invite ? (
          <p className="error">
            Diese Einladung ist ungültig, abgelaufen oder wurde bereits verwendet.
          </p>
        ) : (
          <>
            <p className="sub">
              Du wurdest als <strong>{invite.role === 'owner' ? 'Owner' : 'Agent'}</strong> zur
              Organisation <strong>{invite.org_name}</strong> eingeladen (für {invite.email}).
            </p>
            {error ? <p className="error">{error}</p> : null}
            <form action={acceptInvite}>
              <input type="hidden" name="token" value={token} />
              <button className="primary" type="submit">
                Einladung annehmen
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
