import type { PhoneNumberStatus, PhoneNumberType } from '@zendori/core';
import { canViewArea, isAdminRole } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { href } from '@/lib/href';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsFrame from '@/components/SettingsTabs';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import { requestPhoneNumber, withdrawPhoneNumberRequest } from './actions';

// Telefonnummern (0016): the org's number inventory + self-service requests.
// Numbers are provisioned by the operator (Twilio purchase under the Novax
// regulatory bundle + xAI registration); the customer redirects their public
// number to the provisioned one (Rufumleitungs-Modell, §9).

const PATH = '/settings/phone-numbers';

type NumberRow = {
  id: string;
  e164: string | null;
  number_type: PhoneNumberType;
  status: PhoneNumberStatus;
  desired_region: string | null;
  note: string | null;
  channel_id: string | null;
  created_at: string;
  activated_at: string | null;
};

const TYPE_LABELS: Record<PhoneNumberType, string> = {
  local: 'Festnetz (Ortsnetz)',
  mobile: 'Mobilfunk',
  national: 'National (032)',
};

// 'failed' (0033) is an operator-internal state — the admin retries it, so the
// customer just sees the setup still in progress (no internal error text).
const STATUS_LABELS: Record<PhoneNumberStatus, string> = {
  requested: 'Angefragt',
  provisioning: 'Wird eingerichtet',
  failed: 'Wird eingerichtet',
  active: 'Aktiv',
  released: 'Gekündigt',
};

const STATUS_TONE: Record<PhoneNumberStatus, BadgeTone> = {
  requested: 'warn',
  provisioning: 'warn',
  failed: 'warn',
  active: 'success',
  released: 'danger',
};

export default async function PhoneNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string; panel?: string }>;
}) {
  const { org, error, notice, panel } = await searchParams;
  const { orgId, orgs, role, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'channels')) return <NoAccessPanel title="Telefonnummern" />;
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const isOwner = isAdminRole(role);

  const supabase = await createSupabaseServerClient();
  const [{ data: numberData }, { data: channelData }] = await Promise.all([
    supabase
      .from('phone_numbers')
      .select('id, e164, number_type, status, desired_region, note, channel_id, created_at, activated_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true }),
    supabase.from('channels').select('id, name').eq('org_id', orgId).eq('type', 'voice'),
  ]);
  const numbers = (numberData ?? []) as NumberRow[];
  const channelNames = new Map(
    ((channelData ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name])
  );

  const listHref = href(PATH, { org: orgId });
  const newHref = href(PATH, { org: orgId, panel: 'new' });
  const drawerOpen = panel === 'new' && isOwner;
  const requestButton = isOwner ? (
    <Button href={newHref} variant="primary" icon="plus" scroll={false}>
      Nummer beantragen
    </Button>
  ) : null;

  return (
    <SettingsFrame access={access} orgId={orgId}>
      <div className="page">
        <PageHeader
          title="Telefonnummern"
          subtitle={`Die Rufnummern von ${orgName} für den KI-Sprachassistenten.`}
          actions={requestButton}
        />

        <div className="page-body">
          {/* while the drawer is open its own banner shows the message */}
          {drawerOpen ? null : <DismissibleBanners error={error} notice={notice} />}

          {!isOwner ? <Callout>Nur Inhaber können Nummern beantragen.</Callout> : null}

          {numbers.length === 0 ? (
            <EmptyState
              title="Noch keine Telefonnummer"
              text="Zendori richtet jede Nummer schlüsselfertig ein: Nummer, Telefonie-Anbindung und Voice-Kanal."
              action={requestButton}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nummer</th>
                    <th>Typ</th>
                    <th>Status</th>
                    <th>Voice-Kanal</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  {numbers.map((n) => (
                    <tr key={n.id}>
                      <td>
                        {n.e164 ? (
                          <span className="cell-title mono">{n.e164}</span>
                        ) : (
                          <span className="muted">
                            {n.desired_region ? `Wunsch: ${n.desired_region}` : '—'}
                          </span>
                        )}
                      </td>
                      <td>{TYPE_LABELS[n.number_type]}</td>
                      <td>
                        <Badge tone={STATUS_TONE[n.status]} dot>
                          {STATUS_LABELS[n.status]}
                        </Badge>
                      </td>
                      <td className="muted">
                        {n.channel_id ? (channelNames.get(n.channel_id) ?? '—') : '—'}
                      </td>
                      <td className="cell-actions">
                        {n.status === 'requested' && isOwner ? (
                          <form action={withdrawPhoneNumberRequest}>
                            <input type="hidden" name="org" value={orgId} />
                            <input type="hidden" name="id" value={n.id} />
                            <Button type="submit" size="sm">
                              Zurückziehen
                            </Button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {drawerOpen ? (
          <Drawer
            title="Nummer beantragen"
            closeHref={listHref}
            footer={
              <>
                <Button href={listHref} scroll={false}>
                  Abbrechen
                </Button>
                <Button type="submit" form="phone-number-form" variant="primary">
                  Nummer beantragen
                </Button>
              </>
            }
          >
            <DismissibleBanners error={error} notice={notice} />
            <Callout>
              Zendori kauft und konfiguriert die Nummer für dich, inklusive Telefonie-Anbindung und
              Voice-Kanal. Danach erscheint sie hier als „Aktiv“; du leitest deine bestehende Nummer
              dorthin um oder nutzt die neue direkt. Stimme und Begrüßung stellst du am Voice-Kanal
              ein.
            </Callout>
            <form id="phone-number-form" className="stack" action={requestPhoneNumber}>
              <input type="hidden" name="org" value={orgId} />
              <Field label="Nummern-Typ" htmlFor="pn-type">
                <select id="pn-type" name="numberType" defaultValue="local">
                  <option value="local">Festnetz (Ortsnetz, z. B. 030 / 089)</option>
                  <option value="mobile">Mobilfunk (015x/016x/017x)</option>
                  <option value="national">National (032 — ortsunabhängig)</option>
                </select>
              </Field>
              <Field label="Wunschregion (optional)" htmlFor="pn-region">
                <input
                  id="pn-region"
                  name="desiredRegion"
                  type="text"
                  maxLength={120}
                  placeholder="z. B. Berlin (030)"
                />
              </Field>
              <Field label="Notiz an Zendori (optional)" htmlFor="pn-note">
                <input
                  id="pn-note"
                  name="note"
                  type="text"
                  maxLength={500}
                  placeholder="z. B. Nummer für die Support-Hotline"
                />
              </Field>
            </form>
          </Drawer>
        ) : null}
      </div>
    </SettingsFrame>
  );
}
