import Link from 'next/link';
import {
  CONTACT_STATUSES,
  CONTACT_TOPIC_LABELS,
  type ContactStatus,
  type ContactTopic,
} from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { contactNotifyEmail } from '@/lib/contact/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { href } from '@/lib/href';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState, Property, PropertyList, Section, Tabs } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../_components/AdminUnavailable';
import { deleteContactRequest, updateContactRequest } from './actions';

// Kontaktanfragen (0034): every message from the contact form on zendori.ai
// (contact.js embed). Requests live only in contact_requests (+ the
// notification mail to the operator inbox) — never in a tenant's inbox.

export const metadata = { title: 'Kontaktanfragen' };

type ContactRow = {
  id: string;
  created_at: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  topic: ContactTopic;
  message: string;
  status: ContactStatus;
  note: string;
  handled_at: string | null;
  notified_at: string | null;
};

type Filter = 'open' | 'done' | 'all';

const BASE = '/admin/contact';

const STATUS_LABELS: Record<ContactStatus, string> = {
  new: 'Neu',
  in_progress: 'In Arbeit',
  done: 'Erledigt',
};
const STATUS_TONE: Record<ContactStatus, BadgeTone> = {
  new: 'warn',
  in_progress: 'info',
  done: 'success',
};

const dateFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Berlin',
});

function parseFilter(value: string | undefined): Filter {
  return value === 'done' || value === 'all' ? value : 'open';
}

function excerpt(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > 110 ? `${line.slice(0, 110)}…` : line;
}

function isContactRow(row: ContactRow): boolean {
  return (CONTACT_STATUSES as readonly string[]).includes(row.status);
}

export default async function AdminContactPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    notice?: string;
    status?: string;
    panel?: string;
    id?: string;
  }>;
}) {
  await requirePlatformAdmin();
  const { error, notice, status, panel, id } = await searchParams;
  const filter = parseFilter(status);

  const supabase = createSupabaseAdminClient();
  if (!supabase) return <AdminUnavailable title="Kontaktanfragen" />;

  const { data, error: loadError } = await supabase
    .from('contact_requests')
    .select(
      'id, created_at, name, email, company, phone, topic, message, status, note, handled_at, notified_at'
    )
    .order('created_at', { ascending: false })
    .limit(300);
  const all = ((data ?? []) as ContactRow[]).filter(isContactRow);
  const open = all.filter((r) => r.status !== 'done');
  const done = all.filter((r) => r.status === 'done');
  const rows = filter === 'open' ? open : filter === 'done' ? done : all;
  const listHref = (extra: Record<string, string | undefined> = {}) =>
    href(BASE, { status: filter === 'open' ? undefined : filter, ...extra });

  const selected = panel === 'request' ? all.find((r) => r.id === id) : undefined;

  return (
    <div className="page">
      <PageHeader
        title="Kontaktanfragen"
        subtitle="Nachrichten aus dem Kontaktformular auf zendori.ai."
        tabs={
          <Tabs
            label="Status"
            items={[
              { label: 'Offen', href: BASE, count: open.length, active: filter === 'open' },
              {
                label: 'Erledigt',
                href: href(BASE, { status: 'done' }),
                count: done.length,
                active: filter === 'done',
              },
              {
                label: 'Alle',
                href: href(BASE, { status: 'all' }),
                count: all.length,
                active: filter === 'all',
              },
            ]}
          />
        }
      />

      <div className="page-body">
        <DismissibleBanners error={error} notice={notice} />
        {loadError ? (
          <Callout tone="danger" className="page-notice">
            Kontaktanfragen konnten nicht geladen werden. Ist Migration 0034 eingespielt?
          </Callout>
        ) : null}

        <Section
          title={`${filter === 'open' ? 'Offene Anfragen' : filter === 'done' ? 'Erledigte Anfragen' : 'Alle Anfragen'} (${rows.length})`}
          help={`Jede neue Anfrage geht zusätzlich per E-Mail an ${contactNotifyEmail()}. Eine Antwort auf diese E-Mail erreicht den Absender direkt.`}
        >
          {rows.length === 0 ? (
            <EmptyState
              title={filter === 'open' ? 'Keine offenen Kontaktanfragen' : 'Keine Kontaktanfragen'}
              text="Neue Nachrichten aus dem Kontaktformular erscheinen hier."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Absender</th>
                    <th>Anliegen</th>
                    <th>Status</th>
                    <th>Eingegangen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link
                          href={listHref({ panel: 'request', id: row.id })}
                          scroll={false}
                          className="cell-title"
                        >
                          {row.name}
                        </Link>
                        <div className="cell-sub admin-break">
                          {row.company ? `${row.company} · ` : ''}
                          {row.email}
                        </div>
                      </td>
                      <td>
                        {CONTACT_TOPIC_LABELS[row.topic] ?? row.topic}
                        <div className="cell-sub admin-break">{excerpt(row.message)}</div>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[row.status]} dot>
                          {STATUS_LABELS[row.status]}
                        </Badge>
                        {row.notified_at ? null : <div className="cell-sub">E-Mail nicht gesendet</div>}
                      </td>
                      <td className="muted nowrap">{dateFormat.format(new Date(row.created_at))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      {selected ? (
        <Drawer
          title={selected.name}
          closeHref={listHref()}
          footer={
            <>
              <span className="drawer-foot-note">
                <form action={deleteContactRequest}>
                  <input type="hidden" name="id" value={selected.id} />
                  <ConfirmDeleteButton label="Löschen" confirmLabel="Endgültig löschen" />
                </form>
              </span>
              <Button
                href={`mailto:${selected.email}?subject=${encodeURIComponent('Deine Anfrage an Zendori')}`}
                icon="mail"
              >
                Per E-Mail antworten
              </Button>
              <Button type="submit" form="contact-update" variant="primary">
                Speichern
              </Button>
            </>
          }
        >
          {selected.notified_at ? null : (
            <Callout tone="warn">
              Die Benachrichtigung an {contactNotifyEmail()} konnte für diese Anfrage nicht gesendet
              werden. Sie steht nur hier.
            </Callout>
          )}
          <PropertyList>
            <Property label="Eingegangen">{dateFormat.format(new Date(selected.created_at))}</Property>
            <Property label="E-Mail">
              <a href={`mailto:${selected.email}`}>{selected.email}</a>
            </Property>
            {selected.company ? <Property label="Unternehmen">{selected.company}</Property> : null}
            {selected.phone ? (
              <Property label="Telefon">
                <a href={`tel:${selected.phone.replace(/[^+\d]/g, '')}`}>{selected.phone}</a>
              </Property>
            ) : null}
            <Property label="Thema">{CONTACT_TOPIC_LABELS[selected.topic] ?? selected.topic}</Property>
            {selected.handled_at ? (
              <Property label="Zuletzt bearbeitet">
                {dateFormat.format(new Date(selected.handled_at))}
              </Property>
            ) : null}
          </PropertyList>

          <Section title="Nachricht">
            <p className="demo-text">{selected.message}</p>
          </Section>

          <Section title="Bearbeitung">
            <form id="contact-update" className="stack" action={updateContactRequest}>
              <input type="hidden" name="id" value={selected.id} />
              <Field label="Status" htmlFor="contact-status">
                <select id="contact-status" name="status" defaultValue={selected.status}>
                  {CONTACT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {STATUS_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Interne Notiz"
                htmlFor="contact-note"
                help="Nur für das Zendori-Team sichtbar, zum Beispiel wer geantwortet hat."
              >
                <textarea
                  id="contact-note"
                  name="note"
                  rows={4}
                  maxLength={2000}
                  defaultValue={selected.note}
                />
              </Field>
            </form>
          </Section>
        </Drawer>
      ) : null}
    </div>
  );
}
