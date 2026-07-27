import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Channel, ChannelKind } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { CHANNEL_KIND_LABELS, countChannelsByKind } from '@/lib/channel-limits';
import { loadBillingCatalog } from '@/lib/billing';
import { addMember } from '../actions';
import { assignPackage, removeSubscription } from '../../billing/actions';

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

  // Effective quotas (0017, plan-derived since the unification) + live counts.
  const [{ data: limitData }, { data: channelData }, catalog] = await Promise.all([
    admin.from('org_channel_limits').select('channel_kind, max_count').eq('org_id', orgId),
    admin.from('channels').select('type, config').eq('org_id', orgId),
    loadBillingCatalog(admin),
  ]);
  const limits = new Map(
    ((limitData ?? []) as { channel_kind: ChannelKind; max_count: number }[]).map((r) => [
      r.channel_kind,
      r.max_count,
    ])
  );
  const counts = countChannelsByKind((channelData ?? []) as Pick<Channel, 'type' | 'config'>[]);

  const sub = catalog.subscriptions.get(orgId);
  const currentPackage = sub?.packageId ? catalog.packages.get(sub.packageId) : undefined;
  const tiers = [...catalog.tiers.values()].sort((a, b) => a.name.localeCompare(b.name));
  const packages = [...catalog.packages.values()]
    .filter((p) => p.isActive)
    .sort((a, b) => a.name.localeCompare(b.name));

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
        <h2>Plan</h2>
        <p className="help">
          Der Plan bestimmt Paketgebühren, Verbrauchspreise und die Kanal-Kontingente dieser
          Organisation. Kontingente werden beim Zuweisen aus dem Plan übernommen — Kanalarten
          ohne Eintrag im Plan sind unbegrenzt. Pläne pflegst du unter{' '}
          <Link href="/admin/pricing">Preise &amp; Pakete</Link>.
        </p>
        <form className="stack" action={assignPackage} style={{ maxWidth: '26rem' }}>
          <input type="hidden" name="orgId" value={org.id} />
          <input type="hidden" name="returnTo" value="org" />
          <div>
            <label htmlFor="packageId">Plan</label>
            <select id="packageId" name="packageId" defaultValue={sub?.packageId ?? ''}>
              <option value="">— kein Plan —</option>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="priceTierId">Preisliste (optional, bessere Konditionen)</label>
            <select id="priceTierId" name="priceTierId" defaultValue={sub?.priceTierId ?? ''}>
              <option value="">— aus Plan übernehmen —</option>
              {tiers.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="interval">Laufzeit</label>
            <select id="interval" name="interval" defaultValue={sub?.interval ?? 'monthly'}>
              <option value="monthly">Monatlich</option>
              <option value="yearly">Jährlich</option>
            </select>
          </div>
          <div>
            <label htmlFor="setupFeeEur">Setup-Gebühr-Override (€, optional)</label>
            <input
              id="setupFeeEur"
              name="setupFeeEur"
              type="text"
              inputMode="decimal"
              placeholder="aus Plan"
              defaultValue={sub?.setupFeeEur != null ? String(sub.setupFeeEur) : ''}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="primary" type="submit">
              {sub?.packageId ? 'Plan aktualisieren' : 'Plan zuweisen'}
            </button>
          </div>
        </form>
        {sub ? (
          <form action={removeSubscription} style={{ marginTop: '0.75rem' }}>
            <input type="hidden" name="orgId" value={org.id} />
            <input type="hidden" name="returnTo" value="org" />
            <button className="ghost" type="submit">Zuweisung entfernen</button>
          </form>
        ) : null}
      </div>

      <div className="panel">
        <h2>Wirksame Kanal-Kontingente</h2>
        <p className="help">
          {currentPackage
            ? `Aus dem Plan „${currentPackage.name}" übernommen — hier nur zur Kontrolle.`
            : 'Kein Plan zugewiesen. Ohne Plan gelten keine Kontingent-Grenzen.'}
        </p>
        <table style={{ maxWidth: '30rem' }}>
          <thead>
            <tr>
              <th>Kanalart</th>
              <th style={{ textAlign: 'right' }}>Vorhanden</th>
              <th style={{ textAlign: 'right' }}>Kontingent</th>
            </tr>
          </thead>
          <tbody>
            {KIND_ORDER.map((kind) => (
              <tr key={kind}>
                <td>{CHANNEL_KIND_LABELS[kind]}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                  {counts.get(kind) ?? 0}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {limits.has(kind) ? String(limits.get(kind)) : 'unbegrenzt'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
