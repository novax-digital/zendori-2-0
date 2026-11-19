import Link from 'next/link';
import {
  DEMO_PROMPT_MAX_CHARS,
  demoTranscriptSchema,
  isTerminalDemoStatus,
  type DemoStatus,
} from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isDemoStatus } from '@/lib/demo/server';
import { href } from '@/lib/href';
import AutoRefresh from '@/components/AutoRefresh';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState, Property, PropertyList, Section } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../_components/AdminUnavailable';
import { deleteDemoCall, redialDemoCall, startAdminDemo } from './actions';

// Demo-Anrufe (0032): internal demo launcher (no e-mail opt-in) + every demo
// lead from the public embed with outcome and transcript. Leads live only in
// demo_calls (+ the sales mail) — never in a tenant's inbox.

type DemoRow = {
  id: string;
  created_at: string;
  source: 'public' | 'admin';
  company_name: string;
  contact_name: string;
  email: string | null;
  phone_e164: string;
  website_url: string | null;
  website_summary: string | null;
  prompt: string;
  status: DemoStatus;
  status_detail: string | null;
  duration_seconds: number | null;
  transcript: unknown;
};

const STATUS_LABELS: Record<DemoStatus, string> = {
  awaiting_confirmation: 'Wartet auf SMS-Code',
  queued: 'In Warteschlange',
  preparing: 'Wird vorbereitet',
  dialing: 'Klingelt',
  connecting: 'Verbindet',
  in_call: 'Im Gespräch',
  completed: 'Beendet',
  no_answer: 'Nicht abgenommen',
  busy: 'Besetzt',
  failed: 'Fehlgeschlagen',
  expired: 'Nicht bestätigt',
};

function statusTone(status: DemoStatus): BadgeTone {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (isTerminalDemoStatus(status)) return 'neutral';
  // still waiting for the lead's code vs. the call is on its way
  return status === 'awaiting_confirmation' ? 'warn' : 'accent';
}

const dateFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Berlin',
});

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const BASE = '/admin/demo';

export default async function AdminDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; panel?: string; id?: string }>;
}) {
  await requirePlatformAdmin();
  const { error, notice, panel, id } = await searchParams;

  const supabase = createSupabaseAdminClient();
  if (!supabase) return <AdminUnavailable title="Demo-Anrufe" />;

  const { data, error: loadError } = await supabase
    .from('demo_calls')
    .select(
      'id, created_at, source, company_name, contact_name, email, phone_e164, website_url, website_summary, prompt, status, status_detail, duration_seconds, transcript'
    )
    .order('created_at', { ascending: false })
    .limit(100);
  const rows = ((data ?? []) as DemoRow[]).filter((r) => isDemoStatus(r.status));
  const anyRunning = rows.some(
    (r) => !isTerminalDemoStatus(r.status) && r.status !== 'awaiting_confirmation'
  );
  const publicLeads = rows.filter((r) => r.source === 'public').length;

  // Two drawers: ?panel=new starts an internal demo (its errors show inside),
  // ?panel=call&id=… shows one call with instruction, profile and transcript.
  const starting = panel === 'new';
  const selected = panel === 'call' ? rows.find((r) => r.id === id) : undefined;
  const selectedTranscript = selected ? demoTranscriptSchema.safeParse(selected.transcript) : null;
  const turns = selectedTranscript?.success ? selectedTranscript.data : [];

  return (
    <div className="page">
      <AutoRefresh active={anyRunning} />
      <PageHeader
        title="Demo-Anrufe"
        subtitle="Der KI-Telefonassistent ruft im Namen eines Unternehmens an."
        actions={
          <Button href={`${BASE}?panel=new`} variant="primary" icon="phone" scroll={false}>
            Demo-Anruf starten
          </Button>
        }
      />

      <div className="page-body">
        <DismissibleBanners
          error={starting ? undefined : error}
          notice={notice}
        />
        {loadError ? (
          <Callout tone="danger" className="page-notice">
            Demo-Anrufe konnten nicht geladen werden. Ist Migration 0032 eingespielt?
          </Callout>
        ) : null}

        <Section
          title={`Verlauf (${rows.length})`}
          help={
            publicLeads > 0
              ? `Interne Demos und Anfragen über das Website-Embed, davon ${publicLeads} Website-Leads.`
              : 'Interne Demos und Anfragen über das Website-Embed.'
          }
        >
          {rows.length === 0 ? (
            <EmptyState
              title="Noch keine Demo-Anrufe"
              text="Starte eine interne Demo, zum Beispiel live in einer Kundenpräsentation."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Unternehmen</th>
                    <th>Kontakt</th>
                    <th>Status</th>
                    <th>Quelle</th>
                    <th>Zeitpunkt</th>
                    <th className="right">Dauer</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link
                          href={href(BASE, { panel: 'call', id: row.id })}
                          scroll={false}
                          className="cell-title"
                        >
                          {row.company_name}
                        </Link>
                        {row.website_url ? (
                          <div className="cell-sub admin-break">{row.website_url}</div>
                        ) : null}
                      </td>
                      <td>
                        {row.contact_name}
                        <div className="cell-sub admin-break">
                          {row.phone_e164}
                          {row.email ? ` · ${row.email}` : ''}
                        </div>
                      </td>
                      <td>
                        <Badge tone={statusTone(row.status)} dot>
                          {STATUS_LABELS[row.status]}
                        </Badge>
                        {row.status_detail ? (
                          <div className="cell-sub">{row.status_detail}</div>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone="muted">{row.source === 'public' ? 'Website' : 'Intern'}</Badge>
                      </td>
                      <td className="muted nowrap">{dateFormat.format(new Date(row.created_at))}</td>
                      <td className="right">{duration(row.duration_seconds)}</td>
                      <td className="cell-actions">
                        <Menu label={`Aktionen für den Anruf bei ${row.company_name}`}>
                          <Link
                            className="menu-item"
                            href={href(BASE, { panel: 'call', id: row.id })}
                            scroll={false}
                          >
                            <span className="menu-label">Details und Transkript</span>
                          </Link>
                          {isTerminalDemoStatus(row.status) ? (
                            <form action={redialDemoCall}>
                              <input type="hidden" name="id" value={row.id} />
                              <button className="menu-item" type="submit">
                                <span className="menu-label">Erneut anrufen</span>
                              </button>
                            </form>
                          ) : null}
                          <form action={deleteDemoCall}>
                            <input type="hidden" name="id" value={row.id} />
                            <button className="menu-item menu-item--danger" type="submit">
                              <span className="menu-label">Löschen</span>
                            </button>
                          </form>
                        </Menu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      {starting ? (
        <Drawer
          title="Interne Demo starten"
          closeHref={BASE}
          footer={
            <>
              <Button href={BASE} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="start-demo" variant="primary">
                Demo-Anruf starten
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <form id="start-demo" action={startAdminDemo} className="stack">
            <Field label="Unternehmen" htmlFor="demo-company">
              <input
                id="demo-company"
                name="company"
                type="text"
                required
                minLength={2}
                maxLength={120}
                placeholder="z. B. Müller Haustechnik GmbH"
              />
            </Field>
            <Field label="Ansprechpartner" htmlFor="demo-contact">
              <input
                id="demo-contact"
                name="contactName"
                type="text"
                required
                minLength={2}
                maxLength={120}
                placeholder="z. B. Anna Müller"
              />
            </Field>
            <Field
              label="Telefonnummer"
              htmlFor="demo-phone"
              help="Nur deutsche Mobil- und Festnetznummern. Interne Demos laufen ohne Bestätigung und ohne Tageslimit."
            >
              <input
                id="demo-phone"
                name="phone"
                type="tel"
                required
                maxLength={40}
                placeholder="0170 1234567"
              />
            </Field>
            <Field label="E-Mail (optional)" htmlFor="demo-email">
              <input id="demo-email" name="email" type="email" maxLength={200} autoComplete="off" />
            </Field>
            <Field
              label="Website (optional)"
              htmlFor="demo-website"
              help="Die Startseite wird gelesen und dem Assistenten als Firmenwissen mitgegeben."
            >
              <input
                id="demo-website"
                name="websiteUrl"
                type="text"
                maxLength={300}
                placeholder="www.kunde.de"
              />
            </Field>
            <Field label="Was soll der Assistent im Anruf tun? (optional)" htmlFor="demo-prompt">
              <textarea
                id="demo-prompt"
                name="prompt"
                rows={4}
                maxLength={DEMO_PROMPT_MAX_CHARS}
                placeholder="z. B. Ruf als Kundenservice an, bestätige den Wartungstermin morgen um 10 Uhr und frag, ob der Termin passt."
              />
            </Field>
            <label className="check-row">
              <input type="checkbox" name="consent" required />
              Die angerufene Person ist mit dem KI-Demo-Anruf einverstanden.
            </label>
          </form>
        </Drawer>
      ) : null}

      {selected ? (
        <Drawer
          title={selected.company_name}
          closeHref={BASE}
          footer={
            <>
              <span className="drawer-foot-note">
                <Button type="submit" form="demo-delete" variant="danger">
                  Löschen
                </Button>
              </span>
              <Button href={BASE} scroll={false}>
                Schließen
              </Button>
              {isTerminalDemoStatus(selected.status) ? (
                <Button type="submit" form="demo-redial" variant="primary" icon="phone">
                  Erneut anrufen
                </Button>
              ) : null}
            </>
          }
        >
          <PropertyList>
            <Property label="Status">
              <Badge tone={statusTone(selected.status)} dot>
                {STATUS_LABELS[selected.status]}
              </Badge>
            </Property>
            {selected.status_detail ? (
              <Property label="Detail">{selected.status_detail}</Property>
            ) : null}
            <Property label="Quelle">{selected.source === 'public' ? 'Website' : 'Intern'}</Property>
            <Property label="Zeitpunkt">{dateFormat.format(new Date(selected.created_at))}</Property>
            <Property label="Dauer">{duration(selected.duration_seconds)}</Property>
            <Property label="Ansprechpartner">{selected.contact_name}</Property>
            <Property label="Telefon">{selected.phone_e164}</Property>
            {selected.email ? <Property label="E-Mail">{selected.email}</Property> : null}
            {selected.website_url ? (
              <Property label="Website">{selected.website_url}</Property>
            ) : null}
          </PropertyList>

          <Section title="Anweisung">
            <p className="demo-text">{selected.prompt || 'Keine eigene Anweisung, Standard-Demo.'}</p>
          </Section>

          {selected.website_summary ? (
            <Section title="Firmenprofil aus der Website">
              <p className="demo-text">{selected.website_summary}</p>
            </Section>
          ) : null}

          {turns.length > 0 ? (
            <Section title={`Transkript (${turns.length})`}>
              <div className="stack stack--sm">
                {turns.map((turn, index) => (
                  <p key={index} className="demo-text">
                    <strong>{turn.role === 'assistant' ? 'Assistent' : 'Angerufener'}:</strong>{' '}
                    {turn.text}
                  </p>
                ))}
              </div>
            </Section>
          ) : null}

          <form id="demo-delete" action={deleteDemoCall}>
            <input type="hidden" name="id" value={selected.id} />
          </form>
          {isTerminalDemoStatus(selected.status) ? (
            <form id="demo-redial" action={redialDemoCall}>
              <input type="hidden" name="id" value={selected.id} />
            </form>
          ) : null}
        </Drawer>
      ) : null}
    </div>
  );
}
