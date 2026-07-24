// Team management (0024): owners/admins invite members by e-mail (invitee sets
// the password via a mailed link), edit roles/granular permissions and remove
// members. Non-admin members see a read-only list. E-mails and invite status
// resolve server-side via the service role.
import {
  AREA_DEFS,
  ORG_ROLE_LABELS,
  isAdminRole,
  parseMemberPermissions,
  type OrgRole,
} from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import TeamMemberForm from '@/components/TeamMemberForm';
import DismissibleBanners from '@/components/DismissibleBanners';
import { inviteMember, removeMember, resendInvite, updateMember } from './actions';

type MemberRow = {
  org_id: string;
  user_id: string;
  role: OrgRole;
  permissions?: unknown;
  created_at: string;
};

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, role, orgs } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const manager = isAdminRole(role);
  const supabase = await createSupabaseServerClient();

  // permissions column is 0024 — fall back to the legacy select pre-migration.
  // eslint-disable-next-line prefer-const -- memberData IS reassigned in the fallback
  let { data: memberData, error: memberError } = await supabase
    .from('org_members')
    .select('org_id, user_id, role, permissions, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  if (memberError && (memberError as { code?: string }).code === '42703') {
    const retry = await supabase
      .from('org_members')
      .select('org_id, user_id, role, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true });
    memberData = retry.data as unknown as typeof memberData;
  }
  const members = (memberData ?? []) as MemberRow[];

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const selfId = user?.id ?? '';

  // e-mails + invite status via service role (key never reaches the client)
  const admin = createSupabaseAdminClient();
  const emailByUserId = new Map<string, string>();
  const pendingByUserId = new Map<string, boolean>();
  if (admin) {
    await Promise.all(
      members.map(async (m) => {
        const { data } = await admin.auth.admin.getUserById(m.user_id);
        if (data.user?.email) emailByUserId.set(m.user_id, data.user.email);
        pendingByUserId.set(m.user_id, !data.user?.last_sign_in_at);
      })
    );
  }

  // channels for the access list (name + type label for recognizability)
  const { data: channelData } = await supabase
    .from('channels')
    .select('id, name, type')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  const channels = ((channelData ?? []) as { id: string; name: string; type: string }[]).map(
    (c) => ({ id: c.id, name: `${c.name} (${c.type})` })
  );

  const areaLabel = (key: string): string => AREA_DEFS.find((d) => d.key === key)?.label ?? key;

  const permissionSummary = (m: MemberRow): string => {
    if (m.role !== 'agent') return 'Alle Bereiche';
    const permissions = parseMemberPermissions(m.permissions);
    const areaKeys = Object.keys(permissions.areas);
    const areasText =
      areaKeys.length === 0
        ? 'keine Bereiche'
        : `${areaKeys.length} ${areaKeys.length === 1 ? 'Bereich' : 'Bereiche'}`;
    const channelText =
      permissions.channelIds === null ? 'alle Kanäle' : `${permissions.channelIds.length} Kanäle`;
    return `${areasText} · ${channelText}`;
  };

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Team</h1>
        <p>
          Die Mitglieder von {orgName}.{' '}
          {manager
            ? 'Lade neue Mitglieder per E-Mail ein und lege fest, was Mitarbeiter sehen und bearbeiten dürfen.'
            : 'Team-Verwaltung ist Inhabern und Admins vorbehalten.'}
        </p>
      </div>

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />

      <div className="panel">
        <h2>Mitglieder</h2>
        <table>
          <thead>
            <tr>
              <th>Mitglied</th>
              <th>Rolle</th>
              <th>Berechtigungen</th>
              <th>Status</th>
              {manager ? <th></th> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const email = emailByUserId.get(m.user_id) ?? `${m.user_id.slice(0, 8)}…`;
              const pending = pendingByUserId.get(m.user_id) === true;
              const editable =
                manager &&
                m.user_id !== selfId &&
                m.role !== 'owner' &&
                (m.role !== 'admin' || role === 'owner');
              return (
                <tr key={m.user_id}>
                  <td style={{ wordBreak: 'break-all' }}>{email}</td>
                  <td>
                    <span className="badge">{ORG_ROLE_LABELS[m.role] ?? m.role}</span>
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {permissionSummary(m)}
                  </td>
                  <td>
                    {pending ? (
                      <span className="badge badge--warn">Einladung ausstehend</span>
                    ) : (
                      <span className="badge badge--success">Aktiv</span>
                    )}
                  </td>
                  {manager ? (
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {pending ? (
                        <form action={resendInvite} style={{ display: 'inline-block' }}>
                          <input type="hidden" name="org" value={orgId} />
                          <input type="hidden" name="userId" value={m.user_id} />
                          <button className="ghost" type="submit" style={{ fontSize: '0.8rem' }}>
                            Einladung erneut senden
                          </button>
                        </form>
                      ) : null}
                      {editable ? (
                        <form action={removeMember} style={{ display: 'inline-block', marginLeft: '0.4rem' }}>
                          <input type="hidden" name="org" value={orgId} />
                          <input type="hidden" name="userId" value={m.user_id} />
                          <button className="ghost" type="submit" style={{ fontSize: '0.8rem' }}>
                            Entfernen
                          </button>
                        </form>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {manager
        ? members
            .filter(
              (m) =>
                m.user_id !== selfId &&
                m.role !== 'owner' &&
                (m.role !== 'admin' || role === 'owner')
            )
            .map((m) => {
              const permissions = parseMemberPermissions(m.permissions);
              return (
                <details className="panel" key={`edit-${m.user_id}`}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                    Bearbeiten: {emailByUserId.get(m.user_id) ?? m.user_id.slice(0, 8)}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                      {' '}— {ORG_ROLE_LABELS[m.role]}
                      {m.role === 'agent'
                        ? ` · ${Object.keys(permissions.areas).map(areaLabel).join(', ') || 'keine Bereiche'}`
                        : ''}
                    </span>
                  </summary>
                  <div style={{ marginTop: '1rem' }}>
                    <TeamMemberForm
                      orgId={orgId}
                      channels={channels}
                      action={updateMember}
                      submitLabel="Änderungen speichern"
                      initial={{
                        role: m.role === 'admin' ? 'admin' : 'agent',
                        permissions,
                      }}
                      hidden={{ userId: m.user_id }}
                    />
                  </div>
                </details>
              );
            })
        : null}

      {manager ? (
        <div className="panel">
          <h2>Neues Mitglied einladen</h2>
          <TeamMemberForm
            orgId={orgId}
            channels={channels}
            action={inviteMember}
            submitLabel="Einladung senden"
            showEmail
          />
        </div>
      ) : null}
    </div>
  );
}
