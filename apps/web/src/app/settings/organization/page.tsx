// "Organisation" page of the Einstellungen hub: rename the organization
// (owner/admin — RLS organizations_update is the authoritative gate). The slug
// is shown read-only: it is baked into generated intake addresses.
import { isAdminRole } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsFrame from '@/components/SettingsTabs';
import Button from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Property, PropertyList, Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import { updateOrganizationName } from './actions';

export default async function OrganizationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, role, access } = await requireActiveOrg(org);
  if (!isAdminRole(role)) return <NoAccessPanel title="Organisation" />;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('organizations')
    .select('name, slug, created_at')
    .eq('id', orgId)
    .maybeSingle();
  const orgRow = (data ?? { name: '', slug: '', created_at: '' }) as {
    name: string;
    slug: string;
    created_at: string;
  };

  return (
    <SettingsFrame access={access} orgId={orgId}>
      <div className="page">
        <PageHeader title="Organisation" subtitle="Name und Stammdaten deiner Zendori-Instanz." />

        <div className="page-body">
          <DismissibleBanners error={error} notice={notice} />

          <div className="form-narrow">
            <Section title="Name">
              <form id="org-name-form" className="stack" action={updateOrganizationName}>
                <input type="hidden" name="org" value={orgId} />
                <Field
                  label="Name der Organisation"
                  htmlFor="org-name"
                  help="Erscheint in der Organisations-Auswahl, im Team-Bereich und in Einladungs-E-Mails."
                >
                  <input
                    id="org-name"
                    name="name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={120}
                    defaultValue={orgRow.name}
                  />
                </Field>
              </form>
            </Section>

            <Section
              title="Details"
              help="Das Kürzel steckt in bereits generierten Intake-Adressen und kann nicht geändert werden."
            >
              <PropertyList>
                <Property label="Kürzel (fest)">
                  <span className="mono">{orgRow.slug || '—'}</span>
                </Property>
                <Property label="Angelegt am">
                  {orgRow.created_at
                    ? new Date(orgRow.created_at).toLocaleDateString('de-DE')
                    : '—'}
                </Property>
              </PropertyList>
            </Section>
          </div>
        </div>

        <div className="save-bar">
          <Button type="submit" form="org-name-form" variant="primary">
            Speichern
          </Button>
        </div>
      </div>
    </SettingsFrame>
  );
}
