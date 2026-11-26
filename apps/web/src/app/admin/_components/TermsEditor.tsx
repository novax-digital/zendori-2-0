'use client';

// What applies to ONE customer (Abrechnung → Kunde → Konditionen): the package,
// the term and — only where it differs — the customer's own values. Left of
// every field stands the value from the package (or the usage price list), the
// field itself is "für diesen Kunden"; empty = as in the package.
//
// Four groups, closed unless they hold own values, so the page never shows 30
// fields at once. The first three are monthly (fees, channels, phone numbers)
// and come from the package; the last is the usage price list. The rail calculates what this customer pays while typing,
// with the functions the invoice uses (@zendori/core/billing — the package
// index is not importable here, it pulls node:crypto into the browser bundle).
// The text is read by readOwnTerms, the same function the server action uses.
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  BILLING_CATEGORY_GROUPS,
  NUMBER_KINDS,
  NUMBER_KIND_LABELS,
  PACKAGE_CHANNEL_KINDS,
  PACKAGE_CHANNEL_LABELS,
  applicableOwnTerms,
  countOwnValues,
  formatEuroInput,
  ownTermsToText,
  readOwnTerms,
  recurringFeeLines,
  recurringMonthlyTotalEur,
  resolveTerms,
  termsYearlyTotalEur,
  type BillingCategory,
  type BillingInterval,
  type NumberCounts,
  type NumberKind,
  type OwnTermsText,
  type PackageChannelKind,
  type PackageTerms,
  type SubscriptionOwnTerms,
} from '@zendori/core/billing';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { Field, SettingRow } from '@/components/ui/Field';
import { Property, PropertyList, Section } from '@/components/ui/Layout';
import Segmented from '@/components/ui/Segmented';
import { saveTerms } from '../billing/actions';

export interface TermsEditorPackage {
  id: string;
  name: string;
  isActive: boolean;
  /** null = the standard list. */
  priceTierId: string | null;
  terms: PackageTerms;
}

export interface TermsEditorList {
  id: string;
  name: string;
  isDefault: boolean;
  /** Sell price per position; absent = not priced on this list. */
  prices: Partial<Record<BillingCategory, number>>;
}

export interface TermsEditorPosition {
  category: BillingCategory;
  label: string;
  unitWords: string;
  /** false = nothing is bought in (data actions). */
  hasCost: boolean;
  /** null = no data yet for an averaged position. */
  costEur: number | null;
  costLabel: string;
}

export interface TermsEditorProps {
  orgId: string;
  /** null = no package assigned. */
  packageId: string | null;
  interval: BillingInterval;
  /** The customer's own price list; null = the list of the package. */
  priceTierId: string | null;
  own: SubscriptionOwnTerms;
  /** Active packages plus the customer's current one. */
  packages: TermsEditorPackage[];
  lists: TermsEditorList[];
  positions: TermsEditorPosition[];
  /** What one phone number costs us per month, per kind. */
  numberCosts: Record<NumberKind, number>;
  /** The customer's active phone numbers, per kind. */
  numberCounts: NumberCounts;
  /** Notice / error banners of the page, rendered above the form fields. */
  banners?: ReactNode;
}

type GroupKey = 'fees' | 'channels' | 'numbers' | 'usage';

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const unit = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const unitEur = (value: number): string => `${unit.format(value)} €`;
const percent = (value: number): string => `${formatEuroInput(value).replace(/,00$/, '')} %`;
const ownValuesText = (count: number): string =>
  `${count} ${count === 1 ? 'eigener Wert' : 'eigene Werte'}`;

const NO_FIXED_TEXT = { setupFeeEur: '', baseFeeMonthlyEur: '', yearlyDiscountPercent: '' };

export default function TermsEditor(props: TermsEditorProps) {
  const [packageId, setPackageId] = useState(props.packageId ?? '');
  const [interval, setIntervalValue] = useState<BillingInterval>(props.interval);
  const [listId, setListId] = useState(props.priceTierId ?? '');
  const [text, setText] = useState<OwnTermsText>(() => ownTermsToText(props.own));
  // a group starts open only when it holds own values
  const [open, setOpen] = useState<Record<GroupKey, boolean>>(() => ({
    fees:
      props.own.setupFeeEur !== null ||
      props.own.baseFeeMonthlyEur !== null ||
      props.own.yearlyDiscountPercent !== null,
    channels: Object.keys(props.own.channels).length > 0,
    numbers: Object.keys(props.own.numbers).length > 0,
    usage: Object.keys(props.own.pricing).length > 0 || props.priceTierId !== null,
  }));

  const calc = useMemo(() => {
    const pkg = props.packages.find((option) => option.id === packageId) ?? null;

    // A field that is not shown or is disabled does not count — exactly what the
    // browser submits: no fixed values without a package, no fee for a channel
    // kind that is not limited.
    const channels: OwnTermsText['channels'] = {};
    const feeOff: Partial<Record<PackageChannelKind, boolean>> = {};
    for (const kind of PACKAGE_CHANNEL_KINDS) {
      const row = text.channels[kind] ?? { quota: '', feeMonthlyEur: '' };
      feeOff[kind] = !pkg?.terms.channels[kind] && row.quota.trim() === '';
      channels[kind] = feeOff[kind] ? { quota: row.quota, feeMonthlyEur: '' } : row;
    }
    const read = readOwnTerms(
      pkg
        ? { ...text, channels }
        : { ...NO_FIXED_TEXT, channels: {}, numbers: {}, pricing: text.pricing }
    );
    const own = applicableOwnTerms(read.own, pkg?.terms ?? null);

    const standard = pkg ? resolveTerms(pkg.terms) : null;
    const effective = pkg ? resolveTerms(pkg.terms, own) : null;
    const lines = effective ? recurringFeeLines(effective, interval) : [];
    const lineAmount = new Map(lines.map((line) => [line.key, line.amountEur]));

    const defaultList = props.lists.find((list) => list.isDefault) ?? null;
    const packageList =
      props.lists.find((list) => list.id === (pkg?.priceTierId ?? '')) ?? defaultList;
    const list = props.lists.find((list) => list.id === listId) ?? packageList;

    const priceRows = new Map(
      props.positions.map((position) => {
        const listPrice = list?.prices[position.category] ?? null;
        const ownPrice = own.pricing[position.category]?.unitPriceEur ?? null;
        const sellPrice = ownPrice ?? listPrice;
        const margin =
          sellPrice !== null && position.costEur !== null ? sellPrice - position.costEur : null;
        return [position.category, { listPrice, ownPrice, sellPrice, margin }] as const;
      })
    );
    // Phone numbers: fee per number from the package, the customer's own fee on
    // top; without either our purchase cost is passed on. Charged per ACTIVE number.
    const numberRows = new Map(
      NUMBER_KINDS.map((kind) => {
        const costEur = props.numberCosts[kind];
        const packageFee = pkg?.terms.numbers[kind]?.feeMonthlyEur ?? null;
        const ownFee = own.numbers[kind]?.feeMonthlyEur ?? null;
        const chargedEur = ownFee ?? packageFee ?? costEur;
        const count = props.numberCounts[kind];
        return [
          kind,
          {
            costEur,
            packageFee,
            ownFee,
            chargedEur,
            margin: chargedEur - costEur,
            count,
            monthly: Math.round(count * chargedEur * 100) / 100,
          },
        ] as const;
      })
    );
    const numbersMonthly =
      Math.round([...numberRows.values()].reduce((sum, row) => sum + row.monthly, 0) * 100) / 100;

    const belowCost =
      [...priceRows.values()].filter(
        (row) => row.ownPrice !== null && row.margin !== null && row.margin < 0
      ).length +
      [...numberRows.values()].filter((row) => row.ownFee !== null && row.margin < 0).length;

    const fixedCount =
      (own.setupFeeEur !== null ? 1 : 0) +
      (own.baseFeeMonthlyEur !== null ? 1 : 0) +
      (own.yearlyDiscountPercent !== null ? 1 : 0);
    const channelCount = PACKAGE_CHANNEL_KINDS.reduce((sum, kind) => {
      const term = own.channels[kind];
      return (
        sum + (term?.quota !== undefined ? 1 : 0) + (term?.feeMonthlyEur !== undefined ? 1 : 0)
      );
    }, 0);
    const priceCount = Object.keys(own.pricing).length;
    const numberCount = Object.keys(own.numbers).length;

    const errorGroups: Record<GroupKey, boolean> = {
      fees: false,
      channels: false,
      numbers: false,
      usage: false,
    };
    for (const field of Object.keys(read.errors)) {
      if (field.startsWith('price:')) errorGroups.usage = true;
      else if (field.startsWith('number:')) errorGroups.numbers = true;
      else if (field.startsWith('quota:') || field.startsWith('fee:')) errorGroups.channels = true;
      else errorGroups.fees = true;
    }

    return {
      pkg,
      errors: read.errors,
      errorCount: Object.keys(read.errors).length,
      errorGroups,
      standard,
      effective,
      lines,
      lineAmount,
      feeOff,
      monthly: effective ? recurringMonthlyTotalEur(effective, interval) : 0,
      standardMonthly: standard ? recurringMonthlyTotalEur(standard, interval) : 0,
      yearly: effective ? termsYearlyTotalEur(effective) : 0,
      list,
      packageList,
      priceRows,
      numberRows,
      numbersMonthly,
      belowCost,
      fixedCount,
      channelCount,
      numberCount,
      priceCount,
      ownCount: countOwnValues(own),
    };
  }, [
    packageId,
    interval,
    listId,
    text,
    props.packages,
    props.lists,
    props.positions,
    props.numberCosts,
    props.numberCounts,
  ]);

  const setFixed = (patch: Partial<typeof NO_FIXED_TEXT>): void =>
    setText((current) => ({ ...current, ...patch }));
  const setChannel = (
    kind: PackageChannelKind,
    patch: { quota?: string; feeMonthlyEur?: string }
  ): void =>
    setText((current) => ({
      ...current,
      channels: {
        ...current.channels,
        [kind]: { quota: '', feeMonthlyEur: '', ...current.channels[kind], ...patch },
      },
    }));
  const setNumberFee = (kind: NumberKind, value: string): void =>
    setText((current) => ({ ...current, numbers: { ...current.numbers, [kind]: value } }));
  const setPrice = (category: BillingCategory, value: string): void =>
    setText((current) => ({ ...current, pricing: { ...current.pricing, [category]: value } }));
  const toggle = (group: GroupKey, value: boolean): void =>
    setOpen((current) => (current[group] === value ? current : { ...current, [group]: value }));

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    if (calc.errorCount === 0) return;
    // the server checks again; this only saves a round trip that loses the typing
    event.preventDefault();
    setOpen((current) => ({
      fees: current.fees || calc.errorGroups.fees,
      channels: current.channels || calc.errorGroups.channels,
      numbers: current.numbers || calc.errorGroups.numbers,
      usage: current.usage || calc.errorGroups.usage,
    }));
  };

  const { pkg, standard, effective } = calc;
  const packageLabel = pkg ? `Paket „${pkg.name}“` : 'Paket';
  const showListChoice = props.lists.length > 1 || listId !== '';
  const positionByCategory = new Map(
    props.positions.map((position) => [position.category, position])
  );

  const usageSummary = [
    listId !== '' && calc.list ? `eigene Liste „${calc.list.name}“` : null,
    calc.priceCount > 0
      ? `${calc.priceCount} ${calc.priceCount === 1 ? 'eigener Preis' : 'eigene Preise'}`
      : null,
  ].filter(Boolean);

  return (
    <form className="page-form" action={saveTerms} onSubmit={onSubmit} noValidate>
      <input type="hidden" name="orgId" value={props.orgId} />
      {showListChoice ? null : <input type="hidden" name="priceTierId" value={listId} />}
      <div className="page-split">
        <div className="page-body">
          {props.banners}
          <div className="form-narrow">
            <Section title="Paket und Laufzeit">
              <SettingRow
                label="Paket"
                help="Das Paket ist der Standard. Abweichungen für diesen Kunden trägst du unten ein."
                htmlFor="terms-package"
              >
                <select
                  id="terms-package"
                  name="packageId"
                  value={packageId}
                  onChange={(event) => setPackageId(event.target.value)}
                >
                  <option value="">Kein Paket</option>
                  {props.packages.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.isActive ? option.name : `${option.name} (inaktiv)`}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow
                label="Laufzeit"
                help={
                  effective && effective.yearlyDiscountPercent > 0
                    ? `Jährlich: jeder Monat kostet ${percent(effective.yearlyDiscountPercent)} weniger.`
                    : 'Jährlich: derselbe Monatsbetrag, solange kein Rabatt eingetragen ist.'
                }
              >
                <Segmented
                  label="Laufzeit"
                  name="interval"
                  value={interval}
                  onChange={(value) => setIntervalValue(value === 'yearly' ? 'yearly' : 'monthly')}
                  options={[
                    { value: 'monthly', label: 'Monatlich' },
                    { value: 'yearly', label: 'Jährlich' },
                  ]}
                />
              </SettingRow>
            </Section>

            <Section
              title="Für diesen Kunden"
              help="Ein leeres Feld heißt: wie im Paket. Trage nur ein, was bei diesem Kunden anders ist."
            >
              {pkg && standard && effective ? (
                <>
                  <details
                    className="disclosure terms-group"
                    open={open.fees}
                    onToggle={(event) => toggle('fees', event.currentTarget.open)}
                  >
                    <summary>
                      Feste Gebühren
                      <span className="terms-group-note">
                        {calc.fixedCount > 0 ? ownValuesText(calc.fixedCount) : 'wie Paket'}
                      </span>
                    </summary>
                    <div className="table-wrap">
                      <table className="table--compact">
                        <thead>
                          <tr>
                            <th>Gebühr</th>
                            <th className="num">{packageLabel}</th>
                            <th className="num">Für diesen Kunden</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>Grundgebühr pro Monat</td>
                            <td className="num muted">{eur.format(standard.baseFeeMonthlyEur)}</td>
                            <td className="num">
                              <span className="num-cell">
                                <input
                                  name="own_base"
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="wie Paket"
                                  className="num-input"
                                  aria-label="Eigene Grundgebühr pro Monat"
                                  value={text.baseFeeMonthlyEur}
                                  onChange={(event) =>
                                    setFixed({ baseFeeMonthlyEur: event.target.value })
                                  }
                                  aria-invalid={calc.errors.base ? true : undefined}
                                />
                                <span className="muted small">€</span>
                              </span>
                              {calc.errors.base ? (
                                <div className="field-error">{calc.errors.base}</div>
                              ) : null}
                            </td>
                            <td>
                              {text.baseFeeMonthlyEur !== '' ? (
                                <button
                                  type="button"
                                  className="link-button small"
                                  onClick={() => setFixed({ baseFeeMonthlyEur: '' })}
                                >
                                  Zurücksetzen
                                </button>
                              ) : null}
                            </td>
                          </tr>
                          <tr>
                            <td>Einrichtung, einmalig</td>
                            <td className="num muted">{eur.format(standard.setupFeeEur)}</td>
                            <td className="num">
                              <span className="num-cell">
                                <input
                                  name="own_setup"
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="wie Paket"
                                  className="num-input"
                                  aria-label="Eigene Einrichtungsgebühr"
                                  value={text.setupFeeEur}
                                  onChange={(event) =>
                                    setFixed({ setupFeeEur: event.target.value })
                                  }
                                  aria-invalid={calc.errors.setup ? true : undefined}
                                />
                                <span className="muted small">€</span>
                              </span>
                              {calc.errors.setup ? (
                                <div className="field-error">{calc.errors.setup}</div>
                              ) : null}
                            </td>
                            <td>
                              {text.setupFeeEur !== '' ? (
                                <button
                                  type="button"
                                  className="link-button small"
                                  onClick={() => setFixed({ setupFeeEur: '' })}
                                >
                                  Zurücksetzen
                                </button>
                              ) : null}
                            </td>
                          </tr>
                          <tr>
                            <td>Rabatt bei Jahreslaufzeit</td>
                            <td className="num muted">{percent(standard.yearlyDiscountPercent)}</td>
                            <td className="num">
                              <span className="num-cell">
                                <input
                                  name="own_discount"
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="wie Paket"
                                  className="num-input"
                                  aria-label="Eigener Rabatt bei Jahreslaufzeit"
                                  value={text.yearlyDiscountPercent}
                                  onChange={(event) =>
                                    setFixed({ yearlyDiscountPercent: event.target.value })
                                  }
                                  aria-invalid={calc.errors.discount ? true : undefined}
                                />
                                <span className="muted small">%</span>
                              </span>
                              {calc.errors.discount ? (
                                <div className="field-error">{calc.errors.discount}</div>
                              ) : null}
                            </td>
                            <td>
                              {text.yearlyDiscountPercent !== '' ? (
                                <button
                                  type="button"
                                  className="link-button small"
                                  onClick={() => setFixed({ yearlyDiscountPercent: '' })}
                                >
                                  Zurücksetzen
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </details>

                  <details
                    className="disclosure terms-group"
                    open={open.channels}
                    onToggle={(event) => toggle('channels', event.currentTarget.open)}
                  >
                    <summary>
                      Kanäle
                      <span className="terms-group-note">
                        {calc.channelCount > 0 ? ownValuesText(calc.channelCount) : 'wie Paket'}
                      </span>
                    </summary>
                    <p className="field-help">
                      Anzahl 0 sperrt die Kanalart. Ohne Anzahl im Paket ist sie unbegrenzt und
                      kostet nichts.
                    </p>
                    <div className="table-wrap">
                      <table className="table--compact">
                        <thead>
                          <tr>
                            <th>Kanal</th>
                            <th className="num">{packageLabel}</th>
                            <th className="num">Anzahl</th>
                            <th className="num">je Kanal pro Monat</th>
                            <th className="num">= pro Monat</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {effective.channels.map((channel) => {
                            const kind = channel.kind;
                            const inPackage = pkg.terms.channels[kind];
                            const row = text.channels[kind] ?? { quota: '', feeMonthlyEur: '' };
                            const feeOff = calc.feeOff[kind] === true;
                            const quotaError = calc.errors[`quota:${kind}`];
                            const feeError = calc.errors[`fee:${kind}`];
                            const hasOwn =
                              row.quota !== '' || (!feeOff && row.feeMonthlyEur !== '');
                            return (
                              <tr key={kind}>
                                <td>{PACKAGE_CHANNEL_LABELS[kind]}</td>
                                <td className="num muted">
                                  {inPackage
                                    ? `${inPackage.quota} × ${eur.format(inPackage.feeMonthlyEur)}`
                                    : 'unbegrenzt'}
                                </td>
                                <td className="num">
                                  <input
                                    name={`own_quota_${kind}`}
                                    type="text"
                                    inputMode="numeric"
                                    placeholder="wie Paket"
                                    className="num-input num-input--sm"
                                    aria-label={`Eigene Anzahl ${PACKAGE_CHANNEL_LABELS[kind]}`}
                                    value={row.quota}
                                    onChange={(event) =>
                                      setChannel(kind, { quota: event.target.value })
                                    }
                                    aria-invalid={quotaError ? true : undefined}
                                  />
                                  {quotaError ? (
                                    <div className="field-error">{quotaError}</div>
                                  ) : null}
                                </td>
                                <td className="num">
                                  <span className="num-cell">
                                    <input
                                      name={`own_fee_${kind}`}
                                      type="text"
                                      inputMode="decimal"
                                      placeholder={feeOff ? '—' : 'wie Paket'}
                                      className="num-input"
                                      aria-label={`Eigene Gebühr je Kanal pro Monat ${PACKAGE_CHANNEL_LABELS[kind]}`}
                                      value={feeOff ? '' : row.feeMonthlyEur}
                                      disabled={feeOff}
                                      onChange={(event) =>
                                        setChannel(kind, { feeMonthlyEur: event.target.value })
                                      }
                                      aria-invalid={feeError ? true : undefined}
                                    />
                                    <span className="muted small">€</span>
                                  </span>
                                  {feeError ? <div className="field-error">{feeError}</div> : null}
                                </td>
                                <td className="num muted">
                                  {channel.quota === null
                                    ? '—'
                                    : eur.format(calc.lineAmount.get(`channel:${kind}`) ?? 0)}
                                </td>
                                <td>
                                  {hasOwn ? (
                                    <button
                                      type="button"
                                      className="link-button small"
                                      onClick={() =>
                                        setChannel(kind, { quota: '', feeMonthlyEur: '' })
                                      }
                                    >
                                      Zurücksetzen
                                    </button>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>

                  <details
                    className="disclosure terms-group"
                    open={open.numbers}
                    onToggle={(event) => toggle('numbers', event.currentTarget.open)}
                  >
                    <summary>
                      Rufnummern
                      <span className="terms-group-note">
                        {calc.numberCount > 0 ? ownValuesText(calc.numberCount) : 'wie Paket'}
                      </span>
                    </summary>
                    <p className="field-help">
                      Berechnet wird je aktiver Nummer und Monat, ohne Rabatt bei Jahreslaufzeit.
                      Ohne Gebühr im Paket wird unser Einkaufspreis weitergegeben.
                    </p>
                    <div className="table-wrap">
                      <table className="table--compact">
                        <thead>
                          <tr>
                            <th>Rufnummer</th>
                            <th className="num">Einkauf</th>
                            <th className="num">{packageLabel}</th>
                            <th className="num">Für diesen Kunden</th>
                            <th className="num">Aktiv</th>
                            <th className="num">= pro Monat</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {NUMBER_KINDS.map((kind) => {
                            const row = calc.numberRows.get(kind);
                            if (!row) return null;
                            const error = calc.errors[`number:${kind}`];
                            const below = row.ownFee !== null && row.margin < 0;
                            const value = text.numbers[kind] ?? '';
                            return (
                              <tr key={kind}>
                                <td>{NUMBER_KIND_LABELS[kind]}</td>
                                <td className="num muted">{eur.format(row.costEur)}</td>
                                <td className="num muted">
                                  {row.packageFee !== null
                                    ? eur.format(row.packageFee)
                                    : '= Einkauf'}
                                </td>
                                <td className="num">
                                  <span className="num-cell">
                                    <input
                                      name={`own_number_${kind}`}
                                      type="text"
                                      inputMode="decimal"
                                      placeholder="wie Paket"
                                      className="num-input"
                                      aria-label={`Eigene Gebühr je Nummer pro Monat ${NUMBER_KIND_LABELS[kind]}`}
                                      value={value}
                                      onChange={(event) => setNumberFee(kind, event.target.value)}
                                      aria-invalid={error || below ? true : undefined}
                                    />
                                    <span className="muted small">€</span>
                                  </span>
                                  {error ? <div className="field-error">{error}</div> : null}
                                  {below ? (
                                    <div className="field-error">Unter dem Einkauf.</div>
                                  ) : null}
                                </td>
                                <td className="num muted">{row.count}</td>
                                <td className="num muted">{eur.format(row.monthly)}</td>
                                <td>
                                  {value !== '' ? (
                                    <button
                                      type="button"
                                      className="link-button small"
                                      onClick={() => setNumberFee(kind, '')}
                                    >
                                      Zurücksetzen
                                    </button>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </>
              ) : (
                <p className="muted">
                  Ohne Paket gibt es keine festen Gebühren und keine Kanal-Vorgaben. Berechnet
                  werden nur der Verbrauch und die Rufnummern zum Einkaufspreis. Eigene Gebühren und
                  Kanal-Werte werden beim Speichern entfernt.
                </p>
              )}

              <details
                className="disclosure terms-group"
                open={open.usage}
                onToggle={(event) => toggle('usage', event.currentTarget.open)}
              >
                <summary>
                  Verbrauchspreise
                  <span className="terms-group-note">
                    {usageSummary.length > 0
                      ? usageSummary.join(' · ')
                      : calc.list
                        ? `wie Liste „${calc.list.name}“`
                        : 'zum Einkaufspreis'}
                  </span>
                </summary>
                {showListChoice ? (
                  <Field
                    label="Verbrauchspreisliste"
                    htmlFor="terms-list"
                    help="Eine ganze Liste für diesen Kunden. Für einzelne Preise genügt das Feld in der Tabelle."
                  >
                    <select
                      id="terms-list"
                      name="priceTierId"
                      value={listId}
                      onChange={(event) => setListId(event.target.value)}
                    >
                      <option value="">
                        {pkg ? 'Wie im Paket' : 'Standardliste'}
                        {calc.packageList ? ` (derzeit „${calc.packageList.name}“)` : ''}
                      </option>
                      {props.lists.map((list) => (
                        <option key={list.id} value={list.id}>
                          {list.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <div className="table-wrap">
                  <table className="table--compact">
                    <thead>
                      <tr>
                        <th>Position</th>
                        <th className="num">Einkauf</th>
                        <th className="num">
                          {calc.list ? `Liste „${calc.list.name}“` : 'Liste'}
                        </th>
                        <th className="num">Für diesen Kunden</th>
                        <th className="num">Marge</th>
                      </tr>
                    </thead>
                    {BILLING_CATEGORY_GROUPS.map((group) => (
                      <tbody key={group.key}>
                        <tr className="pricing-group">
                          <th colSpan={5} scope="rowgroup">
                            {group.label}
                          </th>
                        </tr>
                        {group.categories.map((category) => {
                          const position = positionByCategory.get(category);
                          const row = calc.priceRows.get(category);
                          if (!position || !row) return null;
                          const error = calc.errors[`price:${category}`];
                          const below =
                            row.ownPrice !== null && row.margin !== null && row.margin < 0;
                          return (
                            <tr key={category}>
                              <td>
                                {position.label}
                                <div className="cell-sub">{position.unitWords}</div>
                              </td>
                              <td className="num muted">{position.costLabel}</td>
                              <td className="num muted">
                                {row.listPrice !== null
                                  ? unitEur(row.listPrice)
                                  : position.hasCost
                                    ? '= Einkauf'
                                    : 'nicht berechnet'}
                              </td>
                              <td className="num">
                                <span className="num-cell">
                                  <input
                                    name={`own_price_${category}`}
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="wie Liste"
                                    className="num-input"
                                    aria-label={`Eigener Preis ${position.label}`}
                                    value={text.pricing[category] ?? ''}
                                    onChange={(event) => setPrice(category, event.target.value)}
                                    aria-invalid={error || below ? true : undefined}
                                  />
                                  <span className="muted small">€</span>
                                </span>
                                {error ? <div className="field-error">{error}</div> : null}
                              </td>
                              <td className="num">
                                {row.margin === null ? (
                                  <span className="muted">—</span>
                                ) : row.margin < 0 ? (
                                  <Badge tone="danger">unter Einkauf ({unitEur(row.margin)})</Badge>
                                ) : (
                                  <>+{unitEur(row.margin)}</>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    ))}
                  </table>
                </div>
              </details>
            </Section>
          </div>
        </div>

        <aside className="page-rail" aria-label="Ergebnis">
          <div className="rail-section" aria-live="polite">
            <h2>Das zahlt dieser Kunde</h2>
            {pkg && effective ? (
              <>
                <PropertyList>
                  <Property label="Fest pro Monat">
                    <strong>{eur.format(calc.monthly)}</strong>
                  </Property>
                  {calc.lines.map((line) => (
                    <Property key={line.key} label={line.label}>
                      {eur.format(line.amountEur)}
                    </Property>
                  ))}
                  {interval === 'yearly' ? (
                    <Property label="Im Jahr">
                      <strong>{eur.format(calc.yearly)}</strong>
                    </Property>
                  ) : null}
                  <Property label="Einrichtung, einmalig">
                    {eur.format(effective.setupFeeEur)}
                  </Property>
                  <Property label="Rufnummern pro Monat">
                    {calc.numbersMonthly > 0 ? (
                      <>
                        {eur.format(calc.numbersMonthly)}
                        <div className="cell-sub">
                          {NUMBER_KINDS.filter((kind) => (calc.numberRows.get(kind)?.count ?? 0) > 0)
                            .map((kind) => {
                              const row = calc.numberRows.get(kind);
                              return row
                                ? `${row.count} × ${NUMBER_KIND_LABELS[kind].replace('Rufnummer ', '')} ${eur.format(row.chargedEur)}`
                                : '';
                            })
                            .join(' · ')}
                        </div>
                      </>
                    ) : (
                      'keine aktive Nummer'
                    )}
                  </Property>
                  <Property label="Verbrauch">
                    {calc.list ? `nach „${calc.list.name}“` : 'zum Einkaufspreis'}
                    {calc.priceCount > 0
                      ? `, ${calc.priceCount} ${calc.priceCount === 1 ? 'eigener Preis' : 'eigene Preise'}`
                      : ''}
                  </Property>
                </PropertyList>
                <p className="muted small">
                  {calc.ownCount === 0
                    ? `Genau wie im Paket „${pkg.name}“.`
                    : calc.monthly === calc.standardMonthly
                      ? `${ownValuesText(calc.ownCount)}. Fest pro Monat wie im Paket „${pkg.name}“.`
                      : `${ownValuesText(calc.ownCount)}. Im Paket „${pkg.name}“ wären es ${eur.format(calc.standardMonthly)} pro Monat.`}
                </p>
              </>
            ) : (
              <p className="muted small">
                Kein Paket: keine festen Gebühren. Berechnet wird nur der Verbrauch
                {calc.list ? ` nach „${calc.list.name}“` : ' zum Einkaufspreis'}
                {calc.priceCount > 0
                  ? `, mit ${calc.priceCount} ${calc.priceCount === 1 ? 'eigenem Preis' : 'eigenen Preisen'}`
                  : ''}
                {calc.numbersMonthly > 0
                  ? `, dazu Rufnummern zum Einkaufspreis (${eur.format(calc.numbersMonthly)} pro Monat)`
                  : ''}
                .
              </p>
            )}
          </div>
        </aside>
      </div>

      <div className="save-bar">
        <Button type="submit" variant="primary">
          Speichern
        </Button>
        <span className="muted small">
          {calc.errorCount > 0
            ? `${calc.errorCount} ${calc.errorCount === 1 ? 'Eingabe' : 'Eingaben'} bitte prüfen.`
            : calc.belowCost > 0
              ? `Achtung: ${calc.belowCost} ${calc.belowCost === 1 ? 'eigener Preis liegt' : 'eigene Preise liegen'} unter dem Einkauf.`
              : 'Wirkt sofort, auch auf den laufenden Monat.'}
        </span>
      </div>
    </form>
  );
}
