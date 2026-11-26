'use client';

// One price list on its own page (Preise & Pakete → Preisliste): nine positions
// in three groups. Next to every sell price stands what the position costs us,
// and the margin is calculated while typing — a price below purchase cost is
// visible before it is saved. An empty field is not "nothing": it says what
// will be charged instead (the purchase cost, or nothing for data actions).
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  BILLING_CATEGORY_GROUPS,
  euroInputError,
  formatEuroInput,
  readEuro,
  type BillingCategory,
} from '@zendori/core/billing';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Property, PropertyList, Section } from '@/components/ui/Layout';
import { updatePriceList } from '../actions';

export interface PriceListEditorPosition {
  category: BillingCategory;
  label: string;
  unitWords: string;
  hasCost: boolean;
  costEur: number | null;
  costLabel: string;
  priceEur: number | null;
}

export interface PriceListEditorProps {
  id: string;
  name: string;
  isDefault: boolean;
  positions: PriceListEditorPosition[];
  packages: { id: string; name: string }[];
  customerCount: number;
  /** Notice / error banners of the page, rendered above the form fields. */
  banners?: ReactNode;
}

const unit = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const unitEur = (value: number): string => `${unit.format(value)} €`;

type RowState =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'priced'; margin: number | null };

export default function PriceListEditor(props: PriceListEditorProps) {
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      props.positions.map((position) => [
        position.category,
        position.priceEur === null ? '' : formatEuroInput(position.priceEur),
      ])
    )
  );

  const states = useMemo(() => {
    const out: Record<string, RowState> = {};
    for (const position of props.positions) {
      const result = readEuro(prices[position.category] ?? '');
      if (result.ok) {
        out[position.category] = {
          kind: 'priced',
          margin: position.costEur === null ? null : result.value - position.costEur,
        };
      } else if (result.reason === 'empty') {
        out[position.category] = { kind: 'empty' };
      } else {
        out[position.category] = { kind: 'error', message: euroInputError(result.reason) };
      }
    }
    return out;
  }, [prices, props.positions]);

  const errorCount = Object.values(states).filter((state) => state.kind === 'error').length;
  const belowCount = Object.values(states).filter(
    (state) => state.kind === 'priced' && state.margin !== null && state.margin < 0
  ).length;
  const byCategory = new Map(props.positions.map((position) => [position.category, position]));
  const usedBy = props.packages.length + props.customerCount;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // the server checks again; this only saves a round trip that loses the typing
    if (errorCount > 0) event.preventDefault();
  };

  return (
    <form className="page-form" action={updatePriceList} onSubmit={onSubmit} noValidate>
      <input type="hidden" name="id" value={props.id} />
      <div className="page-split">
        <div className="page-body">
          {props.banners}
          <Section title="Preisliste">
            <div className="form-narrow">
              <Field label="Name" htmlFor="list-name">
                <input
                  id="list-name"
                  name="name"
                  type="text"
                  required
                  minLength={2}
                  maxLength={80}
                  defaultValue={props.name}
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Verkaufspreise"
            help="Ein Preis je Einheit, netto. Ein leeres Feld gibt unseren Einkaufspreis weiter."
          >
            <div className="table-wrap">
              <table className="table--compact">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th className="num">Einkauf</th>
                    <th className="num">Verkaufspreis</th>
                    <th className="num">Marge</th>
                  </tr>
                </thead>
                {BILLING_CATEGORY_GROUPS.map((group) => (
                  <tbody key={group.key}>
                    <tr className="pricing-group">
                      <th colSpan={4} scope="rowgroup">
                        {group.label}
                      </th>
                    </tr>
                    {group.categories.map((category) => {
                      const position = byCategory.get(category);
                      if (!position) return null;
                      const state = states[category] ?? { kind: 'empty' };
                      return (
                        <tr key={category}>
                          <td>
                            {position.label}
                            <div className="cell-sub">{position.unitWords}</div>
                          </td>
                          <td className="num muted">{position.costLabel}</td>
                          <td className="num">
                            <span className="num-cell">
                              <input
                                name={`price_${category}`}
                                type="text"
                                inputMode="decimal"
                                className="num-input"
                                aria-label={`Verkaufspreis ${position.label}`}
                                value={prices[category] ?? ''}
                                onChange={(event) =>
                                  setPrices((current) => ({
                                    ...current,
                                    [category]: event.target.value,
                                  }))
                                }
                                aria-invalid={
                                  state.kind === 'error' ||
                                  (state.kind === 'priced' &&
                                    state.margin !== null &&
                                    state.margin < 0)
                                    ? true
                                    : undefined
                                }
                              />
                              <span className="muted small">€</span>
                            </span>
                            {state.kind === 'error' ? (
                              <div className="field-error">{state.message}</div>
                            ) : null}
                          </td>
                          <td className="num">
                            {state.kind === 'empty' ? (
                              <span className="muted">
                                {position.hasCost
                                  ? position.costEur === null
                                    ? '= Einkaufspreis'
                                    : `= Einkaufspreis ${unitEur(position.costEur)}`
                                  : 'wird nicht berechnet'}
                              </span>
                            ) : state.kind === 'priced' && state.margin !== null ? (
                              state.margin < 0 ? (
                                <Badge tone="danger">unter Einkauf ({unitEur(state.margin)})</Badge>
                              ) : (
                                <>+{unitEur(state.margin)}</>
                              )
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          </Section>
        </div>

        <aside className="page-rail" aria-label="Verwendung">
          <div className="rail-section">
            <h2>Verwendet von</h2>
            <PropertyList>
              <Property label="Pakete">
                {props.packages.length === 0
                  ? 'keinem'
                  : props.packages.map((pkg, index) => (
                      <span key={pkg.id}>
                        {index > 0 ? ', ' : ''}
                        <Link href={`/admin/pricing/packages/${pkg.id}`}>{pkg.name}</Link>
                      </span>
                    ))}
              </Property>
              <Property label="Kunden">{props.customerCount}</Property>
            </PropertyList>
            {props.isDefault ? (
              <p className="muted small">
                Das ist die Standardliste: Sie gilt für jedes Paket und jeden Kunden ohne eigene
                Preisliste.
              </p>
            ) : null}
            <p className="muted small">
              Einzelne Kunden können eigene Preise haben; die bleiben bei einer Änderung hier
              unberührt.
            </p>
          </div>
        </aside>
      </div>

      <div className="save-bar">
        <Button type="submit" variant="primary">
          Speichern
        </Button>
        <span className="muted small">
          {errorCount > 0
            ? `${errorCount} ${errorCount === 1 ? 'Eingabe' : 'Eingaben'} bitte prüfen.`
            : belowCount > 0
              ? `Achtung: ${belowCount} ${belowCount === 1 ? 'Preis liegt' : 'Preise liegen'} unter dem Einkauf.`
              : usedBy > 0
                ? 'Wirkt sofort — auch auf den laufenden Monat.'
                : 'Diese Liste wird noch nicht verwendet.'}
        </span>
      </div>
    </form>
  );
}
