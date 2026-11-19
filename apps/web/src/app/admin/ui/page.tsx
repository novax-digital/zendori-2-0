// UI-Bausteine: a living reference of the redesign's building blocks
// (components/ui, docs/design-redesign.md §4/§5). Platform admins only. It
// exists so the kit can be reviewed in the real app before pages are built on
// it; sample data only, nothing here reads or writes the database.
import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import ChannelIcon from '@/components/ui/ChannelIcon';
import Drawer from '@/components/ui/Drawer';
import { Field, OptionGroup, SettingRow } from '@/components/ui/Field';
import {
  Avatar,
  CodeBlock,
  EmptyState,
  Property,
  PropertyList,
  Section,
  Stat,
  Stats,
  Tabs,
} from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';

export const metadata = { title: 'UI-Bausteine' };

const BASE = '/admin/ui';

const CHANNEL_TYPES = [
  { value: 'email', title: 'E-Mail-Weiterleitung', help: 'Bestehendes Postfach per Weiterleitung anbinden' },
  { value: 'form', title: 'Formular-Weiterleitung', help: 'Kontaktformular einer bestehenden Website' },
  { value: 'chat', title: 'Chat-Widget', help: 'Chat für deine Website, ein Script-Tag' },
];

const ROWS = [
  { kind: 'email', name: 'E-Mail Support', address: 'support-x7k2m9@in.zendori.de', agent: 'Support-Agent', active: true },
  { kind: 'voice', name: 'Zentrale', address: '+49 30 1234560', agent: 'Telefon-Agent', active: true },
  { kind: 'whatsapp', name: 'WhatsApp Service', address: '+49 151 12345678', agent: '', active: true },
  { kind: 'chat', name: 'Website-Chat', address: 'beispiel.de', agent: 'Support-Agent', active: false },
];

export default async function UiKitPage({
  searchParams,
}: {
  searchParams: Promise<{ panel?: string; type?: string; view?: string }>;
}) {
  await requirePlatformAdmin();
  const { panel, type, view } = await searchParams;
  const channelType = CHANNEL_TYPES.some((option) => option.value === type) ? type : 'email';
  const empty = view === 'empty';
  const here = empty ? `${BASE}?view=empty` : BASE;

  return (
    <div className="page">
      <PageHeader
        title="UI-Bausteine"
        badges={<Badge tone="accent">Redesign</Badge>}
        subtitle="Alle Bausteine der App an einem Ort. Seiten setzen sich nur daraus zusammen."
        actions={
          <>
            <Menu>
              <Link className="menu-item" href={`${BASE}?view=empty`}>
                <span className="menu-label">Leerzustand zeigen</span>
              </Link>
              <button className="menu-item menu-item--danger" type="button">
                <span className="menu-label">Löschen (Beispiel)</span>
              </button>
            </Menu>
            <Button href={`${BASE}?panel=demo`} variant="primary" icon="plus" scroll={false}>
              Drawer öffnen
            </Button>
          </>
        }
        tabs={
          <Tabs
            label="Ansicht"
            items={[
              { label: 'Bausteine', href: BASE, active: !empty },
              { label: 'Leerzustand', href: `${BASE}?view=empty`, count: 0, active: empty },
            ]}
          />
        }
      />

      {empty ? (
        <div className="page-body">
          <EmptyState
            title="Noch keine Kanäle"
            text="Jeder Kanal liefert Nachrichten in die Inbox. Lege den ersten an."
            action={
              <Button href={`${BASE}?view=empty&panel=demo`} variant="primary" icon="plus" scroll={false}>
                Neuer Kanal
              </Button>
            }
          />
        </div>
      ) : (
        <div className="page-split">
          <div className="page-body">
            <Section title="Buttons" help="36 px hoch. Ein Primär-Button pro Ansicht. 32 px nur in Leisten, Tabellen und Karten.">
              <div className="toolbar">
                <Button type="button" variant="primary">Primär</Button>
                <Button type="button">Sekundär</Button>
                <Button type="button" variant="ghost">Ghost</Button>
                <Button type="button" variant="danger">Löschen</Button>
                <Button type="button" variant="primary" disabled>Deaktiviert</Button>
                <Button type="button" size="sm" icon="plus">Klein</Button>
                <Button type="button" variant="ghost" iconOnly aria-label="Bearbeiten" icon="edit" />
              </div>
            </Section>

            <Section title="Badges" help="Ein System für alle Status. Mit Punkt für Lebenszyklus-Status.">
              <div className="toolbar">
                <Badge>Neutral</Badge>
                <Badge tone="muted">Gedämpft</Badge>
                <Badge tone="accent" dot>In Arbeit</Badge>
                <Badge tone="info" dot>Offen</Badge>
                <Badge tone="warn" dot>Wartet</Badge>
                <Badge tone="success" dot>Erledigt</Badge>
                <Badge tone="danger">Dringend</Badge>
                <Badge tone="hubspot">HubSpot</Badge>
              </div>
            </Section>

            <Section title="Hinweise">
              <Callout>Nur Inhaber und Admins können Kanäle anlegen.</Callout>
              <Callout tone="success">Der Kanal wurde gespeichert.</Callout>
              <Callout tone="warn" title="Kein Agent zugewiesen">
                Nachrichten auf diesem Kanal bleiben ohne KI-Antwort.
              </Callout>
              <Callout tone="danger">Die Adresse ist bereits vergeben.</Callout>
            </Section>

            <Section title="Felder" help="Label über dem Feld, Hilfe oder Fehler darunter. Formulare sind höchstens 720 px breit.">
              <div className="stack form-narrow">
                <Field label="Name" htmlFor="kit-name" help="So erscheint der Kanal in der Inbox.">
                  <input id="kit-name" type="text" defaultValue="Support-Postfach" />
                </Field>
                <Field label="Kürzel" htmlFor="kit-slug" error="Nur Kleinbuchstaben, Ziffern und Bindestrich.">
                  <input id="kit-slug" type="text" defaultValue="support postfach" aria-invalid="true" />
                </Field>
                <Field label="Agent" htmlFor="kit-agent">
                  <select id="kit-agent" defaultValue="support">
                    <option value="support">Support-Agent</option>
                    <option value="phone">Telefon-Agent</option>
                  </select>
                </Field>
                <OptionGroup
                  label="Antwortmodus"
                  name="kit-mode"
                  value="autopilot"
                  options={[
                    { value: 'draft_only', title: 'Nur Entwürfe', help: 'Der Agent schlägt Antworten vor, ein Mensch sendet sie.' },
                    { value: 'autopilot', title: 'Autopilot', help: 'Der Agent antwortet selbst, wenn er sicher genug ist.' },
                    { value: 'intake_only', title: 'Reine Annahme', help: 'Der Agent nimmt das Anliegen auf und legt ein Ticket an.' },
                  ]}
                />
                <div>
                  <SettingRow
                    label="Auch bei Unsicherheit eskalieren"
                    help="Ist das aus, bleibt eine unsichere Antwort ein Entwurf."
                    htmlFor="kit-handoff"
                  >
                    <input id="kit-handoff" type="checkbox" className="switch" defaultChecked />
                  </SettingRow>
                  <SettingRow
                    label="Erinnerung bei wartender Übergabe"
                    help="Leer lassen schaltet sie aus."
                    htmlFor="kit-sla"
                  >
                    <input id="kit-sla" type="number" defaultValue={30} />
                    Minuten
                  </SettingRow>
                </div>
              </div>
            </Section>

            <Section title="Kennzahlen und Code" help="Kennzahlen als eine Zeile mit Linien. Alles, was kopiert wird, steht im Code-Block.">
              <Stats>
                <Stat label="Konversationen" value="1.204" note="diesen Monat" />
                <Stat label="Autopilot-Quote" value="62 %" />
                <Stat label="Offene Tickets" value="4" note="2 warten auf Rückruf" />
              </Stats>
              <CodeBlock>{'<script src="https://app.zendori.ai/widget.js" data-zendori-token="…" async></script>'}</CodeBlock>
              <div className="row">
                <button type="button" role="switch" aria-checked="true" aria-label="Kanal aktiv" className="switch-btn" />
                <span className="muted small">Schalter als Absende-Button (ein Klick schaltet um)</span>
              </div>
            </Section>

            <Section
              title="Lade-Zustand"
              help="Während eine Seite ihre Daten lädt, steht an ihrer Stelle ein Skelett in derselben Form (Kopf, Tabelle, Abschnitte, Inbox-Spalten). Es wird je Route automatisch gewählt; eigene Balken nur dort, wo ein Teil einer Seite nachlädt."
            >
              <div className="cell-main">
                <Skeleton shape="icon" />
                <div className="grow skeleton-lines">
                  <Skeleton width="lg" />
                  <Skeleton width="sm" />
                </div>
                <Skeleton shape="button" />
              </div>
            </Section>

            <Section
              title="Tabelle mit Leiste"
              help="Suche zuerst, Filter danach. Die erste Spalte trägt den Link, seltene Aktionen stehen im Menü."
            >
              <div>
                <div className="toolbar">
                  <input type="search" aria-label="Kanäle durchsuchen" placeholder="Name, Adresse oder Nummer" />
                  <select aria-label="Typ" defaultValue="">
                    <option value="">Alle Typen</option>
                    <option value="email">E-Mail</option>
                  </select>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Kanal</th>
                        <th>Agent</th>
                        <th>Status</th>
                        <th>Zuständig</th>
                        <th aria-label="Aktionen" />
                      </tr>
                    </thead>
                    <tbody>
                      {ROWS.map((row) => (
                        <tr key={row.name}>
                          <td>
                            <div className="cell-main">
                              <ChannelIcon kind={row.kind} size="md" />
                              <div>
                                <Link href={BASE} className="cell-title">
                                  {row.name}
                                </Link>
                                <div className="cell-sub mono">{row.address}</div>
                              </div>
                            </div>
                          </td>
                          <td>{row.agent || <Badge tone="warn">Kein Agent</Badge>}</td>
                          <td>
                            {row.active ? (
                              <Badge tone="success" dot>Aktiv</Badge>
                            ) : (
                              <Badge tone="muted" dot>Pausiert</Badge>
                            )}
                          </td>
                          <td>
                            <div className="cell-main">
                              <Avatar name="Anna Schmidt" />
                              Anna Schmidt
                            </div>
                          </td>
                          <td className="cell-actions">
                            <Menu label={`Aktionen für ${row.name}`}>
                              <Link className="menu-item" href={BASE}>
                                <span className="menu-label">Bearbeiten</span>
                              </Link>
                              <button className="menu-item menu-item--danger" type="button">
                                <span className="menu-label">Löschen (Beispiel)</span>
                              </button>
                            </Menu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Section>
          </div>

          <aside className="page-rail" aria-label="Seitenleiste">
            <div className="rail-section">
              <h2>Bearbeitung</h2>
              <PropertyList>
                <Property label="Status">
                  <select aria-label="Status" defaultValue="open">
                    <option value="open">Offen</option>
                    <option value="done">Erledigt</option>
                  </select>
                </Property>
                <Property label="Priorität">
                  <Badge tone="warn">Hoch</Badge>
                </Property>
              </PropertyList>
            </div>
            <div className="rail-section">
              <h2>Details</h2>
              <PropertyList>
                <Property label="Kanal">E-Mail Support</Property>
                <Property label="Herkunft">Nur-Entwürfe-Agent</Property>
                <Property label="E-Mail">j.weber@example.com</Property>
              </PropertyList>
            </div>
          </aside>
        </div>
      )}

      {empty ? null : (
        <div className="save-bar">
          <Button type="button" variant="primary">Speichern</Button>
          <Button type="button" variant="ghost">Verwerfen</Button>
        </div>
      )}

      {panel === 'demo' ? (
        <Drawer
          title="Neuer Kanal"
          closeHref={here}
          footer={
            <>
              <span className="drawer-foot-note">6 von 10 Kanälen genutzt</span>
              <Button href={here} scroll={false}>
                Abbrechen
              </Button>
              <Button type="button" variant="primary">
                Kanal anlegen
              </Button>
            </>
          }
        >
          <OptionGroup
            label="Kanaltyp"
            value={channelType}
            options={CHANNEL_TYPES.map((option) => ({
              ...option,
              href: `${here}${empty ? '&' : '?'}panel=demo&type=${option.value}`,
            }))}
          />
          <div className="stack">
            <Field label="Name" htmlFor="kit-drawer-name">
              <input id="kit-drawer-name" type="text" placeholder="z. B. Support-Postfach" />
            </Field>
            {channelType === 'chat' ? null : (
              <Field
                label="Kürzel für die Adresse"
                htmlFor="kit-drawer-slug"
                help="Daraus entsteht die Zendori-Adresse."
              >
                <input id="kit-drawer-slug" type="text" placeholder="z. B. support" />
              </Field>
            )}
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
