import type { PhoneNumberStatus, PhoneNumberType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requestPhoneNumber, withdrawPhoneNumberRequest } from './actions';
import { canViewArea, isAdminRole } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsTabs from '@/components/SettingsTabs';

// Telefonnummern (0016): the org's number inventory + self-service requests.
// Numbers are provisioned by the operator (Twilio purchase under the Novax
// regulatory bundle + xAI registration); the customer redirects their public
// number to the provisioned one (Rufumleitungs-Modell, §9).

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

const STATUS_LABELS: Record<PhoneNumberStatus, string> = {
  requested: 'Angefragt',
  provisioning: 'Wird eingerichtet',
  active: 'Aktiv',
  released: 'Gekündigt',
};

const statusClass: Record<PhoneNumberStatus, string> = {
  requested: 'badge--warn',
  provisioning: 'badge--warn',
  active: 'badge--success',
  released: 'badge--danger',
};

export default async function PhoneNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
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

  return (
    <div className="shell">
      <SettingsTabs active="phone-numbers" access={access} orgId={orgId} />

      <div className="page-head">
        <h1>Telefonnummern</h1>
        <p>
          Die Rufnummern von {orgName} für den KI-Sprachassistenten. Zendori richtet jede Nummer
          schlüsselfertig ein (Nummer, Telefonie-Anbindung, Voice-Kanal) — du leitest anschließend
          einfach deine bestehende Nummer dorthin um oder nutzt die neue Nummer direkt.
        </p>
      </div>

      {error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {notice}
        </p>
      ) : null}

      <div className="panel">
        <h2>Deine Nummern</h2>
        {numbers.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine Telefonnummer vorhanden — stelle unten deine erste Anfrage.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nummer</th>
                <th>Typ</th>
                <th>Status</th>
                <th>Voice-Kanal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id}>
                  <td>
                    {n.e164 ? (
                      <code className="invite-link" style={{ display: 'inline' }}>{n.e164}</code>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>
                        {n.desired_region ? `Wunsch: ${n.desired_region}` : '—'}
                      </span>
                    )}
                  </td>
                  <td>{TYPE_LABELS[n.number_type]}</td>
                  <td>
                    <span className={`badge ${statusClass[n.status]}`}>
                      {STATUS_LABELS[n.status]}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {n.channel_id ? channelNames.get(n.channel_id) ?? '—' : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {n.status === 'requested' && isOwner ? (
                      <form action={withdrawPhoneNumberRequest} style={{ display: 'inline-block' }}>
                        <input type="hidden" name="org" value={orgId} />
                        <input type="hidden" name="id" value={n.id} />
                        <button className="ghost" type="submit">
                          Zurückziehen
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Neue Nummer beantragen</h2>
        <p className="help">
          Zendori kauft und konfiguriert die Nummer für dich (inklusive Telefonie-Anbindung und
          Voice-Kanal). Nach der Einrichtung erscheint sie oben als „Aktiv" und kann unter
          Einstellungen → Kanäle konfiguriert werden.
        </p>
        {isOwner ? (
          <form className="stack" action={requestPhoneNumber} style={{ maxWidth: '28rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <div>
              <label htmlFor="pn-type">Nummern-Typ</label>
              <select id="pn-type" name="numberType" defaultValue="local">
                <option value="local">Festnetz (Ortsnetz, z. B. 030 / 089)</option>
                <option value="mobile">Mobilfunk (015x/016x/017x)</option>
                <option value="national">National (032 — ortsunabhängig)</option>
              </select>
            </div>
            <div>
              <label htmlFor="pn-region">Wunschregion (optional)</label>
              <input
                id="pn-region"
                name="desiredRegion"
                type="text"
                maxLength={120}
                placeholder="z. B. Berlin (030)"
              />
            </div>
            <div>
              <label htmlFor="pn-note">Notiz an Zendori (optional)</label>
              <input
                id="pn-note"
                name="note"
                type="text"
                maxLength={500}
                placeholder="z. B. Nummer für die Support-Hotline"
              />
            </div>
            <button className="primary" type="submit">
              Nummer beantragen
            </button>
          </form>
        ) : (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Nur Inhaber können Nummern beantragen.
          </p>
        )}
      </div>
    </div>
  );
}
