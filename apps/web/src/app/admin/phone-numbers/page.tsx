import type { CSSProperties } from 'react';
import type { PhoneNumberStatus, PhoneNumberType } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// Platform-admin view over ALL phone numbers/requests (0016). Fulfilment is
// operator-side via the provisioning script — for each open request the exact
// command is shown ready to copy (run from apps/worker on the operator machine).

type NumberRow = {
  id: string;
  org_id: string;
  e164: string | null;
  number_type: PhoneNumberType;
  status: PhoneNumberStatus;
  desired_region: string | null;
  note: string | null;
  channel_id: string | null;
  created_at: string;
};

const STATUS_LABELS: Record<PhoneNumberStatus, string> = {
  requested: 'Angefragt',
  provisioning: 'Wird eingerichtet',
  active: 'Aktiv',
  released: 'Gekündigt',
};

const statusStyles: Record<PhoneNumberStatus, CSSProperties> = {
  requested: { background: 'var(--warn-tint)', color: 'var(--warn)' },
  provisioning: { background: 'var(--warn-tint)', color: 'var(--warn)' },
  active: { background: 'var(--success-tint)', color: 'var(--success-ink)' },
  released: { background: 'var(--danger-tint)', color: 'var(--danger)' },
};

export default async function AdminPhoneNumbersPage() {
  await requirePlatformAdmin();

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return (
      <div className="shell">
        <div className="page-head">
          <h1>Telefonnummern</h1>
        </div>
        <p className="error">Service-Role ist serverseitig nicht konfiguriert.</p>
      </div>
    );
  }

  const [{ data: numberData }, { data: orgData }] = await Promise.all([
    admin
      .from('phone_numbers')
      .select('id, org_id, e164, number_type, status, desired_region, note, channel_id, created_at')
      .order('created_at', { ascending: false }),
    admin.from('organizations').select('id, name'),
  ]);
  const numbers = (numberData ?? []) as NumberRow[];
  const orgNames = new Map(
    ((orgData ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name])
  );

  const open = numbers.filter((n) => n.status === 'requested' || n.status === 'provisioning');
  const rest = numbers.filter((n) => n.status === 'active' || n.status === 'released');

  const provisionCommand = (n: NumberRow): string =>
    `npx tsx --env-file=../../.env scripts/provision-voice-number.ts \\\n` +
    `  --request ${n.id} --name "Telefon ${orgNames.get(n.org_id) ?? n.org_id}"`;

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Telefonnummern</h1>
        <p>
          Alle Nummern-Anfragen und provisionierten Nummern über alle Kunden. Offene Anfragen
          erfüllst du mit dem Provisioning-Script (aus apps/worker) — es kauft die Nummer, hängt
          sie an den SIP-Trunk, registriert sie bei xAI und setzt die Anfrage auf „Aktiv".
        </p>
      </div>

      <div className="panel">
        <h2>Offene Anfragen ({open.length})</h2>
        {open.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Keine offenen Anfragen.</p>
        ) : (
          open.map((n) => (
            <div
              key={n.id}
              style={{
                borderBottom: '1px solid var(--border)',
                padding: '0.75rem 0',
              }}
            >
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{orgNames.get(n.org_id) ?? n.org_id}</strong>
                <span className="badge" style={statusStyles[n.status]}>
                  {STATUS_LABELS[n.status]}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  Typ: {n.number_type}
                  {n.desired_region ? ` · Wunsch: ${n.desired_region}` : ''}
                </span>
              </div>
              {n.note ? (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.35rem 0' }}>
                  Notiz: {n.note}
                </p>
              ) : null}
              <code className="invite-link" style={{ whiteSpace: 'pre', display: 'block', marginTop: '0.4rem' }}>
                {provisionCommand(n)}
              </code>
            </div>
          ))
        )}
      </div>

      <div className="panel">
        <h2>Bestand</h2>
        {rest.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine provisionierten Nummern.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nummer</th>
                <th>Kunde</th>
                <th>Typ</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((n) => (
                <tr key={n.id}>
                  <td>
                    <code className="invite-link" style={{ display: 'inline' }}>
                      {n.e164 ?? '—'}
                    </code>
                  </td>
                  <td>{orgNames.get(n.org_id) ?? n.org_id}</td>
                  <td>{n.number_type}</td>
                  <td>
                    <span className="badge" style={statusStyles[n.status]}>
                      {STATUS_LABELS[n.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
