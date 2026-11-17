import Link from 'next/link';
import { redirect } from 'next/navigation';
import { signOut } from './actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import AuthCard from '@/components/ui/AuthCard';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';

type Membership = {
  role: string;
  organizations: { id: string; name: string; slug: string } | null;
};

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS shows fellow members' rows too — filter to the signed-in user
  const { data } = await supabase
    .from('org_members')
    .select('role, organizations(id, name, slug)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  const memberships = (data ?? []) as unknown as Membership[];

  if (memberships.length === 0) redirect('/onboarding');
  // one org (the normal case): straight into the app instead of a chooser page
  const only = memberships.length === 1 ? memberships[0]?.organizations : null;
  if (only) redirect(`/inbox?org=${only.id}`);

  return (
    <AuthCard
      wide
      title="Organisation wählen"
      subtitle="Du bist Mitglied in mehreren Organisationen. Wähle, wo du arbeiten möchtest."
      footer={
        <form action={signOut}>
          <Button type="submit" variant="ghost">
            Abmelden
          </Button>
        </form>
      }
    >
      <div className="option-group">
        {memberships.map((m) =>
          m.organizations ? (
            <Link key={m.organizations.id} className="option" href={`/inbox?org=${m.organizations.id}`}>
              <span className="option-text">
                <span className="option-title">{m.organizations.name}</span>
                <span className="option-help">{m.organizations.slug}</span>
              </span>
              <Badge>{m.role === 'owner' ? 'Inhaber' : m.role === 'admin' ? 'Admin' : 'Mitarbeiter'}</Badge>
              <Icon name="chevronRight" className="muted" />
            </Link>
          ) : null
        )}
      </div>
    </AuthCard>
  );
}
