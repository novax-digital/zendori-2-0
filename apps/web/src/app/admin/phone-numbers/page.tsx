import { areaCodeFromWish, type PhoneNumberStatus, type PhoneNumberType } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { href } from '@/lib/href';
import AutoRefresh from '@/components/AutoRefresh';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
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
import { orderPhoneNumber, rejectPhoneNumberRequest, resumePhoneNumber } from './actions';

// Platform-admin view over ALL phone numbers/requests (0016). Fulfilment is
// automatic since 0033: "Kostenpflichtig bestellen" queues the request and the
// worker buys the Twilio number, creates the voice channel and registers it at
// xAI. Failures show the provider error and resume on "Erneut versuchen".

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
  // 0033 (absent before the migration — the select falls back)
  twilio_phone_number_sid?: string | null;
  channel_name?: string | null;
  area_code?: string | null;
  provision_error?: string | null;
  provision_attempts?: number;
  provision_started_at?: string | null;
};

const BASE_FIELDS =
  'id, org_id, e164, number_type, status, desired_region, note, channel_id, created_at';
const PROVISION_FIELDS =
  'twilio_phone_number_sid, channel_name, area_code, provision_error, provision_attempts, provision_started_at';

const STATUS_LABELS: Record<PhoneNumberStatus, string> = {
  requested: 'Angefragt',
  provisioning: 'Wird eingerichtet …',
  failed: 'Fehlgeschlagen',
  active: 'Aktiv',
  released: 'Gekündigt',
};

const STATUS_TONE: Record<PhoneNumberStatus, BadgeTone> = {
  requested: 'warn',
  provisioning: 'accent',
  failed: 'danger',
  active: 'success',
  released: 'muted',
};

const TYPE_LABELS: Record<PhoneNumberType, string> = {
  local: 'Festnetz (Ortsnetz)',
  mobile: 'Mobilfunk',
  national: 'National (032)',
};

const BASE = '/admin/phone-numbers';

/** A request can be ordered while nothing has been bought for it yet. */
const canOrder = (row: NumberRow): boolean =>
  row.status === 'requested' || (row.status === 'failed' && !row.twilio_phone_number_sid);

export default async function AdminPhoneNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; panel?: string; id?: string }>;
}) {
  await requirePlatformAdmin();
  const { error, notice, panel, id } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Telefonnummern" />;

  const loadNumbers = (fields: string) =>
    admin.from('phone_numbers').select(fields).order('created_at', { ascending: false });
  const [numbersRes, { data: orgData }] = await Promise.all([
    loadNumbers(`${BASE_FIELDS}, ${PROVISION_FIELDS}`),
    admin.from('organizations').select('id, name'),
  ]);
  // Pre-0033 database: show the list without the provisioning columns.
  let numberData: unknown = numbersRes.data;
  const migrationMissing = numbersRes.error?.code === '42703';
  if (migrationMissing) numberData = (await loadNumbers(BASE_FIELDS)).data;
  const numbers = (numberData ?? []) as NumberRow[];
  const orgNames = new Map(
    ((orgData ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name])
  );
  const orgName = (n: NumberRow): string => orgNames.get(n.org_id) ?? n.org_id;

  const open = numbers.filter(
    (n) => n.status === 'requested' || n.status === 'provisioning' || n.status === 'failed'
  );
  const rest = numbers.filter((n) => n.status === 'active' || n.status === 'released');
  const anyProvisioning = numbers.some((n) => n.status === 'provisioning');

  // The order form lives in a drawer (?panel=order&id=<request>); its errors show inside.
  const ordering =
    !migrationMissing && panel === 'order' ? open.find((n) => n.id === id && canOrder(n)) : undefined;
  const orderAreaCode = ordering
    ? (ordering.area_code ?? areaCodeFromWish(ordering.desired_region))
    : null;

  return (
    <div className="page">
      <AutoRefresh active={anyProvisioning} />
      <PageHeader
        title="Telefonnummern"
        subtitle="Nummern-Anfragen und eingerichtete Nummern aller Kunden."
      />

      <div className="page-body">
        <DismissibleBanners
          error={ordering ? undefined : error}
          notice={notice}
        />
        {migrationMissing ? (
          <Callout tone="danger" className="page-notice">
            Migration 0033 ist noch nicht eingespielt. Bestellen ist erst danach möglich.
          </Callout>
        ) : null}

        <Section
          title={`Offene Anfragen (${open.length})`}
          help="Eine Bestellung kauft die Nummer bei Twilio, hängt sie an den SIP-Trunk, legt den Voice-Kanal an und registriert sie bei xAI. Das läuft automatisch im Hintergrund."
        >
          {open.length === 0 ? (
            <EmptyState title="Keine offenen Anfragen" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kunde</th>
                    <th>Wunsch</th>
                    <th>Status</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  {open.map((n) => {
                    const bought = Boolean(n.twilio_phone_number_sid);
                    const orderable = !migrationMissing && canOrder(n);
                    const wish = [
                      n.desired_region ? `Wunsch: ${n.desired_region}` : null,
                      n.e164 ? `Nummer: ${n.e164}` : null,
                    ].filter(Boolean);
                    return (
                      <tr key={n.id}>
                        <td>
                          <div className="cell-title">{orgName(n)}</div>
                          {n.note ? <div className="cell-sub">Notiz: {n.note}</div> : null}
                        </td>
                        <td>
                          {TYPE_LABELS[n.number_type]}
                          {wish.length > 0 ? <div className="cell-sub">{wish.join(' · ')}</div> : null}
                        </td>
                        <td>
                          <Badge tone={STATUS_TONE[n.status]} dot>
                            {STATUS_LABELS[n.status]}
                          </Badge>
                          {n.status === 'provisioning' ? (
                            <div className="cell-sub">
                              {n.provision_started_at
                                ? 'Der Worker richtet die Nummer gerade ein …'
                                : 'Wartet auf den Worker …'}
                              {(n.provision_attempts ?? 0) > 1
                                ? ` (Versuch ${n.provision_attempts})`
                                : ''}
                            </div>
                          ) : null}
                          {n.status === 'failed' && n.provision_error ? (
                            <div className="field-error">{n.provision_error}</div>
                          ) : null}
                          {n.status === 'failed' && bought ? (
                            <div className="cell-sub">
                              Die Nummer ist bereits gekauft. Ein neuer Versuch setzt fort, ohne
                              erneut zu kaufen.
                            </div>
                          ) : null}
                        </td>
                        <td className="cell-actions">
                          <div className="cell-buttons">
                            {orderable ? (
                              <Button
                                href={href(BASE, { panel: 'order', id: n.id })}
                                size="sm"
                                scroll={false}
                              >
                                {n.status === 'failed' ? 'Erneut versuchen' : 'Bestellen'}
                              </Button>
                            ) : null}
                            {!migrationMissing && n.status === 'failed' && bought ? (
                              <form action={resumePhoneNumber}>
                                <input type="hidden" name="id" value={n.id} />
                                <Button type="submit" size="sm">
                                  Erneut versuchen
                                </Button>
                              </form>
                            ) : null}
                            {orderable ? (
                              <Menu label={`Aktionen für die Anfrage von ${orgName(n)}`}>
                                <form action={rejectPhoneNumberRequest}>
                                  <input type="hidden" name="id" value={n.id} />
                                  <ConfirmDeleteButton
                                    inMenu
                                    label="Anfrage ablehnen"
                                    confirmLabel="Ja, Anfrage ablehnen"
                                  />
                                </form>
                              </Menu>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Bestand">
          {rest.length === 0 ? (
            <EmptyState title="Noch keine eingerichteten Nummern" />
          ) : (
            <div className="table-wrap">
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
                      <td className="mono">{n.e164 ?? '—'}</td>
                      <td>{orgName(n)}</td>
                      <td>{TYPE_LABELS[n.number_type]}</td>
                      <td>
                        <Badge tone={STATUS_TONE[n.status]} dot>
                          {STATUS_LABELS[n.status]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      {ordering ? (
        <Drawer
          title="Nummer bestellen"
          closeHref={BASE}
          footer={
            <>
              <Button href={BASE} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="order-number" variant="primary">
                {ordering.status === 'failed' ? 'Erneut versuchen' : 'Kostenpflichtig bestellen'}
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <PropertyList>
            <Property label="Kunde">{orgName(ordering)}</Property>
            {ordering.desired_region ? (
              <Property label="Wunsch">{ordering.desired_region}</Property>
            ) : null}
            {ordering.note ? <Property label="Notiz">{ordering.note}</Property> : null}
          </PropertyList>
          <form id="order-number" action={orderPhoneNumber} className="stack">
            <input type="hidden" name="id" value={ordering.id} />
            <Field
              label="Kanalname"
              htmlFor="pn-name"
              help="Unter diesem Namen erscheint der Voice-Kanal beim Kunden."
            >
              <input
                id="pn-name"
                name="channelName"
                type="text"
                required
                maxLength={120}
                defaultValue={ordering.channel_name ?? `Telefon ${orgName(ordering)}`}
              />
            </Field>
            <Field label="Nummerntyp" htmlFor="pn-type">
              <select id="pn-type" name="numberType" defaultValue={ordering.number_type}>
                {(Object.keys(TYPE_LABELS) as PhoneNumberType[]).map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Vorwahl (optional)" htmlFor="pn-area">
              <input
                id="pn-area"
                name="areaCode"
                type="text"
                inputMode="numeric"
                maxLength={20}
                placeholder="z. B. 0511"
                defaultValue={orderAreaCode ? `0${orderAreaCode}` : ''}
              />
            </Field>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
