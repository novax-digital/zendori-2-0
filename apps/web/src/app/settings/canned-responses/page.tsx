// "Textbausteine" page of the Einstellungen hub: the org's canned responses as
// a table; creating and editing happen in a drawer (?panel=new | ?panel=edit&id=…).
// Saving upserts by shortcut (saveCannedResponse), so "edit" keeps the shortcut
// fixed and only changes the text.
import Link from 'next/link';
import { canEditArea, canViewArea } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { listCannedResponses } from '@/lib/inbox/queries';
import { deleteCannedResponse, saveCannedResponse } from '@/app/inbox/actions';
import { href } from '@/lib/href';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsFrame from '@/components/SettingsTabs';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';

const PATH = '/settings/canned-responses';

export default async function CannedResponsesPage({
  searchParams,
}: {
  searchParams: Promise<{
    org?: string;
    error?: string;
    notice?: string;
    panel?: string;
    id?: string;
  }>;
}) {
  const { org, error, notice, panel, id } = await searchParams;
  const { orgId, orgs, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'canned')) return <NoAccessPanel title="Textbausteine" />;
  const canEdit = canEditArea(access, 'canned');
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const responses = await listCannedResponses(orgId);

  const listHref = href(PATH, { org: orgId });
  const newHref = href(PATH, { org: orgId, panel: 'new' });
  const editing = panel === 'edit' ? responses.find((r) => r.id === id) : undefined;
  const drawerOpen = canEdit && (panel === 'new' || Boolean(editing));

  return (
    <SettingsFrame access={access} orgId={orgId}>
      <div className="page">
        <PageHeader
          title="Textbausteine"
          subtitle={`Wiederverwendbare Antworten von ${orgName}, die beim Antworten in der Inbox zur Auswahl stehen.`}
          actions={
            canEdit ? (
              <Button href={newHref} variant="primary" icon="plus" scroll={false}>
                Neuer Textbaustein
              </Button>
            ) : null
          }
        />

        <div className="page-body">
          <DismissibleBanners error={error} notice={notice} />

          {!canEdit ? (
            <Callout>Du kannst Textbausteine ansehen, aber nicht ändern.</Callout>
          ) : null}

          {responses.length === 0 ? (
            <EmptyState
              title="Noch keine Textbausteine"
              text="Textbausteine sparen Tipparbeit bei wiederkehrenden Antworten."
              action={
                canEdit ? (
                  <Button href={newHref} variant="primary" icon="plus" scroll={false}>
                    Neuer Textbaustein
                  </Button>
                ) : null
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kürzel</th>
                    <th>Text</th>
                    {canEdit ? <th aria-label="Aktionen" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {responses.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">
                        {canEdit ? (
                          <Link
                            href={href(PATH, { org: orgId, panel: 'edit', id: r.id })}
                            scroll={false}
                            className="cell-title mono"
                          >
                            /{r.shortcut}
                          </Link>
                        ) : (
                          <span className="cell-title mono">/{r.shortcut}</span>
                        )}
                      </td>
                      <td>
                        <div className="canned-text">{r.content}</div>
                      </td>
                      {canEdit ? (
                        <td className="cell-actions">
                          <Menu label={`Aktionen für /${r.shortcut}`}>
                            <Link
                              className="menu-item"
                              href={href(PATH, { org: orgId, panel: 'edit', id: r.id })}
                              scroll={false}
                            >
                              <span className="menu-label">Bearbeiten</span>
                            </Link>
                            <form action={deleteCannedResponse}>
                              <input type="hidden" name="org" value={orgId} />
                              <input type="hidden" name="id" value={r.id} />
                              <button className="menu-item menu-item--danger" type="submit">
                                <span className="menu-label">Löschen</span>
                              </button>
                            </form>
                          </Menu>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {drawerOpen ? (
          <Drawer
            title={editing ? 'Textbaustein bearbeiten' : 'Neuer Textbaustein'}
            closeHref={listHref}
            footer={
              <>
                <Button href={listHref} scroll={false}>
                  Abbrechen
                </Button>
                <Button type="submit" form="canned-form" variant="primary">
                  Textbaustein speichern
                </Button>
              </>
            }
          >
            {/* key: switching between two entries must reset the uncontrolled fields */}
            <form
              id="canned-form"
              key={editing?.id ?? 'new'}
              className="stack"
              action={saveCannedResponse}
            >
              <input type="hidden" name="org" value={orgId} />
              <Field
                label="Kürzel"
                htmlFor="shortcut"
                help={
                  editing
                    ? 'Das Kürzel ist fest. Zum Umbenennen lege einen neuen Textbaustein an und lösche diesen.'
                    : 'Nur Kleinbuchstaben, Ziffern und Bindestriche (2–30 Zeichen). Ein bestehendes Kürzel wird überschrieben.'
                }
              >
                <input
                  id="shortcut"
                  name="shortcut"
                  type="text"
                  required
                  pattern="[a-z0-9-]{2,30}"
                  placeholder="z. B. begruessung"
                  defaultValue={editing?.shortcut ?? ''}
                  readOnly={Boolean(editing)}
                />
              </Field>
              <Field label="Text" htmlFor="content">
                <textarea
                  id="content"
                  name="content"
                  rows={8}
                  required
                  defaultValue={editing?.content ?? ''}
                />
              </Field>
            </form>
          </Drawer>
        ) : null}
      </div>
    </SettingsFrame>
  );
}
