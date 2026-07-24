import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Channel, ChannelKind } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { CHANNEL_KIND_LABELS, countChannelsByKind } from '@/lib/channel-limits';
import { addMember, setChannelLimits } from '../actions';

type MemberRow = { user_id: string; role: string; created_at: string };

const KIND_ORDER: ChannelKind[] = ['form', 'email', 'whatsapp', 'voice', 'chat', 'test'];


export default async function AdminOrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { orgId } = await params;
  const { error, notice } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return (
      <div className="shell">
        <div className="page-head">
          <h1>Nutzer</h1>
        </div>
        <p className="error">Service-Role ist serverseitig nicht konfiguriert.</p>
      </div>
    );
  }

  const { data: orgRow } = await admin
    .from('organizations')
    .select('id, name, slug')
    .eq('id', orgId)
    .maybeSingle();
  if (!orgRow) notFound();
  const org = orgRow as { id: string; name: string; slug: string };

  const { data: memberData } = await admin
    .from('org_members')
    .select('user_id, role, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  const members = (memberData ?? []) as MemberRow[];

  // Channel quotas (0017): current limits + live counts per kind.
  const [{ data: limitData }, { data: channelData }] = await Promise.all([
    admin.from('org_channel_limits').select('channel_kind, max_count').eq('org_id', orgId),
    admin.from('channels').select('type, config').eq('org_id', orgId),
  ]);
  const limits = new Map(
    ((limitData ?? []) as { channel_kind: ChannelKind; max_count: number }[]).map((r) => [
      r.channel_kind,
      r.max_count,
    ])
  );
  const counts = countChannelsByKind((channelData ?? []) as Pick<Channel, 'type' | 'config'>[]);

  const emailByUserId = new Map<string, string>();
  await Promise.all(
    members.map(async (m) => {
      const { data } = await admin.auth.admin.getUserById(m.user_id);
      if (data.user?.email) emailByUserId.set(m.user_id, data.user.email);
    })
  );

  return (
    <div className="shell">
      <div className="page-head">
        <p style={{ marginBottom: '0.35rem' }}>
          <Link href="/admin/users" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Nutzer
          </Link>
          <span style={{ color: 'var(--text-subtle)' }}> / {org.name}</span>
        </p>
        <h1>{org.name}</h1>
        <p>
          Team dieser Organisation. Hier legst du weitere Zugänge an (Owner oder Agent).
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
        <h2>Mitglieder</h2>
        <table>
          <thead>
            <tr>
              <th>Mitglied</th>
              <th>Rolle</th>
              <th>Dabei seit</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td style={{ wordBreak: 'break-all' }}>
                  {emailByUserId.get(m.user_id) ?? `${m.user_id.slice(0, 8)}…`}
                </td>
                <td>
                  <span className="badge">{m.role === 'owner' ? 'Owner' : 'Agent'}</span>
                </td>
                <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  {new Date(m.created_at).toLocaleDateString('de-DE')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Kanal-Kontingente</h2>
        <p className="help">
          Wie viele Kanäle dieser Kunde je Kanalart anlegen darf. Leer = unbegrenzt, 0 = gesperrt
          (die Kanalart verschwindet beim Kunden aus der Galerie, solange keine Kanäle existieren).
          Bestehende Kanäle bleiben immer erhalten.
        </p>
        <form className="stack" action={setChannelLimits} style={{ maxWidth: '30rem' }}>
          <input type="hidden" name="orgId" value={org.id} />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: '0.75rem',
            }}
          >
            {KIND_ORDER.map((kind) => (
              <div key={kind}>
                <label htmlFor={`limit-${kind}`}>
                  {CHANNEL_KIND_LABELS[kind]}{' '}
                  <span style={{ color: 'var(--text-subtle)', fontWeight: 400 }}>
                    ({counts.get(kind) ?? 0} vorhanden)
                  </span>
                </label>
                <input
                  id={`limit-${kind}`}
                  name={`limit_${kind}`}
                  type="number"
                  min={0}
                  max={999}
                  defaultValue={limits.has(kind) ? String(limits.get(kind)) : ''}
                  placeholder="∞"
                />
              </div>
            ))}
          </div>
          <button className="primary" type="submit">
            Kontingente speichern
          </button>
        </form>
      </div>

      <div className="panel">
        <h2>Mitglied hinzufügen</h2>
        <p className="help">
          Fügt ein Konto per E-Mail-Einladung hinzu — das Mitglied legt sein Passwort selbst fest.
          Granulare Mitarbeiter-Rechte verwaltet der Kunde unter Einstellungen → Team.
        </p>
        <form className="stack" action={addMember} style={{ maxWidth: '28rem' }}>
          <input type="hidden" name="orgId" value={org.id} />
          <div>
            <label htmlFor="mem-email">E-Mail</label>
            <input
              id="mem-email"
              name="email"
              type="email"
              required
              autoComplete="off"
              placeholder="mitarbeiter@kunde.de"
            />
          </div>
          <div>
            <label htmlFor="mem-role">Rolle</label>
            <select id="mem-role" name="role" defaultValue="agent">
              <option value="agent">Mitarbeiter</option>
              <option value="admin">Admin</option>
              <option value="owner">Inhaber</option>
            </select>
          </div>
          <button className="primary" type="submit">
            Mitglied einladen
          </button>
        </form>
      </div>
    </div>
  );
}
