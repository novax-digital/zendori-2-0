import { redirect } from 'next/navigation';
import { createOrganization } from '../actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import AuthCard from '@/components/ui/AuthCard';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';

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
    <AuthCard
      title="Organisation anlegen"
      subtitle="In deiner Organisation leben Kanäle, Konversationen und dein Team."
    >
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <form className="stack" action={createOrganization}>
        <Field label="Name der Organisation" htmlFor="name">
          <input id="name" name="name" type="text" placeholder="z. B. Beispiel GmbH" required />
        </Field>
        <Button type="submit" variant="primary">
          Organisation erstellen
        </Button>
      </form>
    </AuthCard>
  );
}
