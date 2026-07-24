// "Organisation" tab of the Einstellungen hub: rename the organization
// (owner/admin — RLS organizations_update is the authoritative gate). The slug
// is shown read-only: it is baked into generated intake addresses.
import { isAdminRole } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsTabs from '@/components/SettingsTabs';
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
    <div className="shell">
      <div className="page-head">
        <h1>Einstellungen</h1>
        <p>Organisation, Erreichbarkeit und Abrechnung deiner Zendori-Instanz.</p>
      </div>

      <SettingsTabs active="organization" access={access} orgId={orgId} />

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />

      <div className="panel">
        <h2>Organisation</h2>
        <form className="stack" action={updateOrganizationName} style={{ maxWidth: '26rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <div>
            <label htmlFor="org-name">Name der Organisation</label>
            <input
              id="org-name"
              name="name"
              type="text"
              required
              minLength={2}
              maxLength={120}
              defaultValue={orgRow.name}
            />
            <p className="help">
              Erscheint in der Organisations-Auswahl, im Team-Bereich und in Einladungs-E-Mails.
            </p>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </form>
      </div>

      <div className="panel">
        <h2>Details</h2>
        <table>
          <tbody>
            <tr>
              <td style={{ color: 'var(--text-muted)' }}>Kürzel (fest)</td>
              <td>{orgRow.slug}</td>
            </tr>
            <tr>
              <td style={{ color: 'var(--text-muted)' }}>Angelegt am</td>
              <td>
                {orgRow.created_at
                  ? new Date(orgRow.created_at).toLocaleDateString('de-DE')
                  : '—'}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="help" style={{ marginTop: '0.75rem' }}>
          Das Kürzel steckt in bereits generierten Intake-Adressen und kann nicht geändert werden.
        </p>
      </div>
    </div>
  );
}
