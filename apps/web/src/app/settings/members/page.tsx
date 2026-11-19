// Team management (0024): owners/admins invite members by e-mail (invitee sets
// the password via a mailed link), edit roles/granular permissions and remove
// members. Non-admin members see a read-only list. E-mails and invite status
// resolve server-side via the service role.
//
// Redesign: a list page. Inviting and editing happen in drawers
// (?panel=invite, ?panel=edit&member=<user id>); row actions sit in a menu.
import Link from 'next/link';
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
import { href } from '@/lib/href';
import TeamMemberForm from '@/components/TeamMemberForm';
import DismissibleBanners from '@/components/DismissibleBanners';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Avatar } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import { inviteMember, removeMember, resendInvite, updateMember } from './actions';

type MemberRow = {
  org_id: string;
  user_id: string;
  role: OrgRole;
  permissions?: unknown;
  created_at: string;
};

const MEMBER_FORM_ID = 'member-form';

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{
    org?: string;
    error?: string;
    notice?: string;
    panel?: string;
    member?: string;
  }>;
}) {
  const { org, error, notice, panel, member } = await searchParams;
  const { orgId, role, orgs, userId: selfId } = await requireActiveOrg(org);
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

  const emailOf = (m: MemberRow): string =>
    emailByUserId.get(m.user_id) ?? `${m.user_id.slice(0, 8)}…`;
  // who the caller may edit or remove: never themselves, never the owner,
  // admins only as owner (the actions enforce the same)
  const canEdit = (m: MemberRow): boolean =>
    manager && m.user_id !== selfId && m.role !== 'owner' && (m.role !== 'admin' || role === 'owner');

  const listHref = href('/settings/members', { org: orgId });
  const inviting = manager && panel === 'invite';
  const editing = panel === 'edit' ? members.find((m) => m.user_id === member && canEdit(m)) : undefined;
  const editingPermissions = editing ? parseMemberPermissions(editing.permissions) : null;
  const drawerOpen = inviting || Boolean(editing);
  const cancelButton = (
    <Button href={listHref} scroll={false}>
      Abbrechen
    </Button>
  );

  return (
    <div className="page">
      <PageHeader
        title="Team"
        subtitle={
          manager
            ? `Die Mitglieder von ${orgName} und was sie sehen und bearbeiten dürfen.`
            : `Die Mitglieder von ${orgName}. Team-Verwaltung ist Inhabern und Admins vorbehalten.`
        }
        actions={
          manager ? (
            <Button
              href={href('/settings/members', { org: orgId, panel: 'invite' })}
              variant="primary"
              icon="plus"
              scroll={false}
            >
              Mitglied einladen
            </Button>
          ) : null
        }
      />

      <div className="page-body">
        {/* while a drawer is open its error shows inside the drawer */}
        <DismissibleBanners
          error={drawerOpen ? undefined : error}
          notice={notice}
        />

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mitglied</th>
                <th>Rolle</th>
                <th>Berechtigungen</th>
                <th>Status</th>
                {manager ? <th aria-label="Aktionen" /> : null}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const email = emailOf(m);
                const pending = pendingByUserId.get(m.user_id) === true;
                const editable = canEdit(m);
                return (
                  <tr key={m.user_id}>
                    <td>
                      <div className="cell-main">
                        <Avatar name={email} />
                        <div className="tm-member">
                          <div className="cell-title">{email}</div>
                          {m.user_id === selfId ? <div className="cell-sub">Du</div> : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge>{ORG_ROLE_LABELS[m.role] ?? m.role}</Badge>
                    </td>
                    <td className="muted">{permissionSummary(m)}</td>
                    <td>
                      {pending ? (
                        <Badge tone="warn" dot>
                          Einladung ausstehend
                        </Badge>
                      ) : (
                        <Badge tone="success" dot>
                          Aktiv
                        </Badge>
                      )}
                    </td>
                    {manager ? (
                      <td className="cell-actions">
                        {pending || editable ? (
                          <Menu label={`Aktionen für ${email}`}>
                            {editable ? (
                              <Link
                                className="menu-item"
                                href={href('/settings/members', {
                                  org: orgId,
                                  panel: 'edit',
                                  member: m.user_id,
                                })}
                                scroll={false}
                              >
                                <span className="menu-label">Bearbeiten</span>
                              </Link>
                            ) : null}
                            {pending ? (
                              <form action={resendInvite}>
                                <input type="hidden" name="org" value={orgId} />
                                <input type="hidden" name="userId" value={m.user_id} />
                                <button className="menu-item" type="submit">
                                  <span className="menu-label">Einladung erneut senden</span>
                                </button>
                              </form>
                            ) : null}
                            {editable ? (
                              <form action={removeMember}>
                                <input type="hidden" name="org" value={orgId} />
                                <input type="hidden" name="userId" value={m.user_id} />
                                <ConfirmDeleteButton
                                  inMenu
                                  label="Entfernen"
                                  confirmLabel="Endgültig entfernen"
                                />
                              </form>
                            ) : null}
                          </Menu>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {inviting ? (
        <Drawer
          title="Mitglied einladen"
          closeHref={listHref}
          footer={
            <>
              {cancelButton}
              <Button type="submit" form={MEMBER_FORM_ID} variant="primary">
                Einladung senden
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <TeamMemberForm
            formId={MEMBER_FORM_ID}
            orgId={orgId}
            channels={channels}
            action={inviteMember}
            showEmail
          />
        </Drawer>
      ) : null}

      {editing && editingPermissions ? (
        <Drawer
          title="Mitglied bearbeiten"
          closeHref={listHref}
          footer={
            <>
              {cancelButton}
              <Button type="submit" form={MEMBER_FORM_ID} variant="primary">
                Änderungen speichern
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <div className="cell-main">
            <Avatar name={emailOf(editing)} size="md" />
            <div className="tm-member">
              <div className="cell-title">{emailOf(editing)}</div>
              <div className="cell-sub">
                {ORG_ROLE_LABELS[editing.role]}
                {editing.role === 'agent'
                  ? ` · ${Object.keys(editingPermissions.areas).map(areaLabel).join(', ') || 'keine Bereiche'}`
                  : ''}
              </div>
            </div>
          </div>
          <TeamMemberForm
            // a fresh form per member: its state must not carry over
            key={editing.user_id}
            formId={MEMBER_FORM_ID}
            orgId={orgId}
            channels={channels}
            action={updateMember}
            initial={{
              role: editing.role === 'admin' ? 'admin' : 'agent',
              permissions: editingPermissions,
            }}
            hidden={{ userId: editing.user_id }}
          />
        </Drawer>
      ) : null}
    </div>
  );
}
