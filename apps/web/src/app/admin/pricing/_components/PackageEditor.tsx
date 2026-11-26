'use client';

// One package on its own page (Preise & Pakete → Paket). The form is plain
// fields of a server action; the client part exists for one reason: the rail on
// the right calculates what a customer pays WHILE the numbers are typed, with
// the same functions the invoice uses (@zendori/core/billing — the package index
// is not importable here, it pulls node:crypto into the browser bundle).
//
// Only monthly amounts are entered. The yearly price is 12 × monthly minus the
// discount, so it can no longer be forgotten.
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  euroInputError,
  formatEuroInput,
  readEuro,
  recurringFeeLines,
  recurringMonthlyTotalEur,
  resolveTerms,
  termsYearlyTotalEur,
  type PackageChannelKind,
  type PackageTerms,
} from '@zendori/core/billing';
import Button from '@/components/ui/Button';
import { Field, SettingRow } from '@/components/ui/Field';
import { Property, PropertyList, Section } from '@/components/ui/Layout';
import { updatePackage } from '../actions';

export interface PackageEditorChannel {
  kind: PackageChannelKind;
  label: string;
  /** null = not limited. */
  quota: number | null;
  feeMonthlyEur: number;
}

export interface PackageEditorProps {
  id: string;
  name: string;
  isActive: boolean;
  /** null = the standard list. */
  priceTierId: string | null;
  setupFeeEur: number;
  baseFeeMonthlyEur: number;
  yearlyDiscountPercent: number;
  channels: PackageEditorChannel[];
  lists: { id: string; name: string; isDefault: boolean }[];
  customers: { orgId: string; name: string; ownValues: number }[];
  /** Notice / error banners of the page, rendered above the form fields. */
  banners?: ReactNode;
}

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

/** An optional amount field: empty counts as 0. Returns the value or the message. */
function readAmount(text: string): { value: number; error: string | null } {
  const result = readEuro(text);
  if (result.ok) return { value: result.value, error: null };
  if (result.reason === 'empty') return { value: 0, error: null };
  return { value: 0, error: euroInputError(result.reason) };
}

/** The number of channels: empty = not limited, otherwise a whole number 0–9999. */
function readQuota(text: string): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null, error: null };
  if (!/^\d{1,4}$/.test(trimmed)) return { value: null, error: 'Ganze Zahl von 0 bis 9999.' };
  return { value: Number(trimmed), error: null };
}

export default function PackageEditor(props: PackageEditorProps) {
  const [setup, setSetup] = useState(formatEuroInput(props.setupFeeEur));
  const [base, setBase] = useState(formatEuroInput(props.baseFeeMonthlyEur));
  const [discount, setDiscount] = useState(
    props.yearlyDiscountPercent === 0 ? '' : formatEuroInput(props.yearlyDiscountPercent)
  );
  const [listId, setListId] = useState(props.priceTierId ?? '');
  const [rows, setRows] = useState(() =>
    props.channels.map((channel) => ({
      kind: channel.kind,
      label: channel.label,
      quota: channel.quota === null ? '' : String(channel.quota),
      fee: channel.quota === null ? '' : formatEuroInput(channel.feeMonthlyEur),
    }))
  );

  const calc = useMemo(() => {
    const setupFee = readAmount(setup);
    const baseFee = readAmount(base);
    const discountRead = readAmount(discount);
    const discountError =
      discountRead.error ?? (discountRead.value > 100 ? 'Höchstens 100 %.' : null);
    const terms: PackageTerms = {
      setupFeeEur: setupFee.value,
      baseFeeMonthlyEur: baseFee.value,
      yearlyDiscountPercent: discountError ? 0 : discountRead.value,
      channels: {},
    };
    const channelState = rows.map((row) => {
      const quota = readQuota(row.quota);
      const fee = quota.value === null ? { value: 0, error: null } : readAmount(row.fee);
      if (quota.value !== null && !quota.error) {
        terms.channels[row.kind] = { quota: quota.value, feeMonthlyEur: fee.value };
      }
      return {
        quotaError: quota.error,
        feeError: fee.error,
        unlimited: quota.value === null && !quota.error,
        monthly:
          quota.value !== null && !fee.error ? Math.round(quota.value * fee.value * 100) / 100 : 0,
      };
    });
    const effective = resolveTerms(terms);
    const errors =
      [setupFee.error, baseFee.error, discountError].filter(Boolean).length +
      channelState.filter((c) => c.quotaError || c.feeError).length;
    return {
      setupError: setupFee.error,
      baseError: baseFee.error,
      discountError,
      channelState,
      lines: recurringFeeLines(effective, 'monthly'),
      monthly: recurringMonthlyTotalEur(effective, 'monthly'),
      yearly: termsYearlyTotalEur(effective),
      setup: setupFee.value,
      discountPercent: terms.yearlyDiscountPercent,
      errors,
    };
  }, [setup, base, discount, rows]);

  const listName =
    props.lists.find((list) => (listId === '' ? list.isDefault : list.id === listId))?.name ??
    'Standard';
  const standardName = props.lists.find((list) => list.isDefault)?.name ?? 'Standard';
  const customerCount = props.customers.length;

  const setRow = (index: number, patch: { quota?: string; fee?: string }): void =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // the server checks again; this only saves a round trip that loses the typing
    if (calc.errors > 0) event.preventDefault();
  };

  return (
    <form className="page-form" action={updatePackage} onSubmit={onSubmit} noValidate>
      <input type="hidden" name="id" value={props.id} />
      <div className="page-split">
        <div className="page-body">
          {props.banners}
          <div className="form-narrow">
            <Section title="Paket">
              <Field label="Name" htmlFor="pkg-name">
                <input
                  id="pkg-name"
                  name="name"
                  type="text"
                  required
                  minLength={2}
                  maxLength={80}
                  defaultValue={props.name}
                />
              </Field>
              <SettingRow
                label="Aktiv"
                help="Nur aktive Pakete lassen sich neuen Kunden zuweisen. Bestehende Kunden behalten ihr Paket."
                htmlFor="pkg-active"
              >
                <input
                  id="pkg-active"
                  name="isActive"
                  type="checkbox"
                  className="switch"
                  defaultChecked={props.isActive}
                />
              </SettingRow>
            </Section>

            <Section
              title="Feste Gebühren"
              help="Du trägst nur Monatsbeträge ein. Der Jahrespreis ergibt sich aus 12 Monaten abzüglich Rabatt."
            >
              <div className="field-row">
                <Field label="Grundgebühr pro Monat" htmlFor="pkg-base" error={calc.baseError}>
                  <span className="num-cell">
                    <input
                      id="pkg-base"
                      name="baseFeeMonthlyEur"
                      type="text"
                      inputMode="decimal"
                      className="num-input"
                      value={base}
                      onChange={(event) => setBase(event.target.value)}
                      aria-invalid={calc.baseError ? true : undefined}
                    />
                    <span className="muted small">€</span>
                  </span>
                </Field>
                <Field label="Einrichtung, einmalig" htmlFor="pkg-setup" error={calc.setupError}>
                  <span className="num-cell">
                    <input
                      id="pkg-setup"
                      name="setupFeeEur"
                      type="text"
                      inputMode="decimal"
                      className="num-input"
                      value={setup}
                      onChange={(event) => setSetup(event.target.value)}
                      aria-invalid={calc.setupError ? true : undefined}
                    />
                    <span className="muted small">€</span>
                  </span>
                </Field>
                <Field
                  label="Rabatt bei Jahreslaufzeit"
                  htmlFor="pkg-discount"
                  error={calc.discountError}
                >
                  <span className="num-cell">
                    <input
                      id="pkg-discount"
                      name="yearlyDiscountPercent"
                      type="text"
                      inputMode="decimal"
                      className="num-input num-input--sm"
                      placeholder="0"
                      value={discount}
                      onChange={(event) => setDiscount(event.target.value)}
                      aria-invalid={calc.discountError ? true : undefined}
                    />
                    <span className="muted small">%</span>
                  </span>
                </Field>
              </div>
            </Section>

            <Section
              title="Kanäle"
              help="Wie viele Kanäle je Art enthalten sind und was jeder einzelne pro Monat kostet. Leere Anzahl = unbegrenzt und ohne Gebühr, 0 = gesperrt."
            >
              <div className="table-wrap">
                <table className="table--compact">
                  <thead>
                    <tr>
                      <th>Kanal</th>
                      <th className="num">Anzahl</th>
                      <th className="num">je Kanal pro Monat</th>
                      <th className="num">= pro Monat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const state = calc.channelState[index];
                      return (
                        <tr key={row.kind}>
                          <td>{row.label}</td>
                          <td className="num">
                            <input
                              name={`quota_${row.kind}`}
                              type="text"
                              inputMode="numeric"
                              placeholder="unbegrenzt"
                              className="num-input num-input--sm"
                              aria-label={`Anzahl ${row.label}`}
                              value={row.quota}
                              onChange={(event) => setRow(index, { quota: event.target.value })}
                              aria-invalid={state?.quotaError ? true : undefined}
                            />
                            {state?.quotaError ? (
                              <div className="field-error">{state.quotaError}</div>
                            ) : null}
                          </td>
                          <td className="num">
                            <span className="num-cell">
                              <input
                                name={`fee_${row.kind}`}
                                type="text"
                                inputMode="decimal"
                                placeholder={state?.unlimited ? '—' : '0,00'}
                                className="num-input"
                                aria-label={`Gebühr je Kanal pro Monat ${row.label}`}
                                value={state?.unlimited ? '' : row.fee}
                                disabled={state?.unlimited}
                                onChange={(event) => setRow(index, { fee: event.target.value })}
                                aria-invalid={state?.feeError ? true : undefined}
                              />
                              <span className="muted small">€</span>
                            </span>
                            {state?.feeError ? (
                              <div className="field-error">{state.feeError}</div>
                            ) : null}
                          </td>
                          <td className="num muted">
                            {state && !state.unlimited ? eur.format(state.monthly) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section
              title="Verbrauchspreise"
              help="Was Minuten, Nachrichten und KI-Vorgänge kosten, steht in der Preisliste."
            >
              <Field label="Preisliste" htmlFor="pkg-list">
                <select
                  id="pkg-list"
                  name="priceTierId"
                  value={listId}
                  onChange={(event) => setListId(event.target.value)}
                >
                  <option value="">Standardliste (derzeit „{standardName}“)</option>
                  {props.lists
                    .filter((list) => !list.isDefault)
                    .map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                </select>
              </Field>
            </Section>
          </div>
        </div>

        <aside className="page-rail" aria-label="Ergebnis">
          <div className="rail-section" aria-live="polite">
            <h2>Das zahlt ein Kunde</h2>
            <PropertyList>
              <Property label="Pro Monat">
                <strong>{eur.format(calc.monthly)}</strong>
              </Property>
              {calc.lines.map((line) => (
                <Property key={line.key} label={line.label}>
                  {eur.format(line.amountEur)}
                </Property>
              ))}
              <Property label="Bei Jahreslaufzeit">
                <strong>{eur.format(calc.yearly)}</strong>
              </Property>
              <Property label="Einrichtung, einmalig">{eur.format(calc.setup)}</Property>
              <Property label="Verbrauch">nach „{listName}“</Property>
            </PropertyList>
            <p className="muted small">
              Jahr = 12 × {eur.format(calc.monthly)}
              {calc.discountPercent > 0
                ? ` abzüglich ${formatEuroInput(calc.discountPercent).replace(/,00$/, '')} %`
                : ', ohne Rabatt'}
              .
            </p>
          </div>
          <div className="rail-section">
            <h2>Kunden mit diesem Paket</h2>
            {customerCount === 0 ? (
              <p className="muted small">Noch keinem Kunden zugewiesen.</p>
            ) : (
              <PropertyList>
                {props.customers.map((customer) => (
                  <Property
                    key={customer.orgId}
                    label={<Link href={`/admin/billing/${customer.orgId}`}>{customer.name}</Link>}
                  >
                    {customer.ownValues > 0
                      ? `${customer.ownValues} ${customer.ownValues === 1 ? 'eigener Wert' : 'eigene Werte'}`
                      : 'wie Paket'}
                  </Property>
                ))}
              </PropertyList>
            )}
          </div>
        </aside>
      </div>

      <div className="save-bar">
        <Button type="submit" variant="primary">
          Speichern
        </Button>
        <span className="muted small">
          {calc.errors > 0
            ? `${calc.errors} ${calc.errors === 1 ? 'Eingabe' : 'Eingaben'} bitte prüfen.`
            : customerCount > 0
              ? `Wirkt sofort auf ${customerCount} ${customerCount === 1 ? 'Kunden' : 'Kunden'} — auch auf den laufenden Monat.`
              : 'Noch keinem Kunden zugewiesen.'}
        </span>
      </div>
    </form>
  );
}
