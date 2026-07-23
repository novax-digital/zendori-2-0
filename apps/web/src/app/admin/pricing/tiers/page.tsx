// Price tiers (Preiskonditionen): named sell-price conditions assignable to
// customers/packages. Each category shows our purchase price (Einkauf) and the
// recommended minimum (cost × target margin) so pricing never runs below cost.
// Empty field ⇒ the recommendation applies. Platform-admin only.
import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { loadBillingCatalog } from '@/lib/billing';
import {
  BILLING_CATEGORY_LABELS,
  MARKUP_PRICED_CATEGORIES,
  UNIT_PRICED_CATEGORIES,
  recommendedUnitPriceEur,
  unitCostEur,
} from '@zendori/core';
import { createTier, deleteTier, updateTier } from '../actions';

function fmtUnit(value: number): string {
  return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)} €`;
}

export default async function PriceTiersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { error, notice } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return (
      <div className="shell">
        <div className="page-head">
          <h1>Preisstaffeln</h1>
        </div>
        <p className="error">Service-Role ist serverseitig nicht konfiguriert.</p>
      </div>
    );
  }

  const catalog = await loadBillingCatalog(admin);
  const tiers = [...catalog.tiers.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const ctx = catalog.ctx;

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Preisstaffeln</h1>
        <p>
          Benannte Konditionssätze mit Verkaufspreisen je Kategorie. Weise sie Kunden (bessere
          Konditionen) oder Paketen zu. Leeres Feld = Empfehlung (Einkauf × Ziel-Marge {ctx.targetMargin}).{' '}
          <Link href="/admin/pricing/packages">Zu den Paketen →</Link>
        </p>
      </div>

      {error ? <p className="error" style={{ marginBottom: '1rem' }}>{error}</p> : null}
      {notice ? <p className="notice" style={{ marginBottom: '1rem' }}>{notice}</p> : null}

      {tiers.map((tier) => (
        <div className="panel" key={tier.id}>
          <form className="stack" action={updateTier} id={`tier-${tier.id}`}>
            <input type="hidden" name="id" value={tier.id} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={80}
                defaultValue={tier.name}
                style={{ maxWidth: '18rem', fontWeight: 600 }}
              />
              {tier.isDefault ? <span className="badge badge--success">Standard</span> : null}
            </div>

            <table>
              <thead>
                <tr>
                  <th>Kategorie</th>
                  <th style={{ textAlign: 'right' }}>Einkauf</th>
                  <th style={{ textAlign: 'right' }}>Empfehlung</th>
                  <th style={{ textAlign: 'right' }}>Dein Preis</th>
                </tr>
              </thead>
              <tbody>
                {UNIT_PRICED_CATEGORIES.map((category) => {
                  const rule = tier.pricing[category];
                  const stored = rule?.mode === 'unit' ? rule.unitPriceEur : undefined;
                  const cost = unitCostEur(category, ctx);
                  const recommended = recommendedUnitPriceEur(category, ctx);
                  const belowCost = stored !== undefined && stored < cost;
                  const unitWord =
                    category === 'voice'
                      ? '/Min.'
                      : category === 'numbers_mobile' || category === 'numbers_landline'
                        ? '/Nummer'
                        : '/Stück';
                  return (
                    <tr key={category}>
                      <td>
                        {BILLING_CATEGORY_LABELS[category]}
                        <span style={{ color: 'var(--text-muted)' }}> {unitWord}</span>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{fmtUnit(cost)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{fmtUnit(recommended)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          name={`price_${category}`}
                          type="text"
                          inputMode="decimal"
                          placeholder={fmtUnit(recommended)}
                          defaultValue={stored ?? ''}
                          style={{
                            maxWidth: '7rem',
                            textAlign: 'right',
                            borderColor: belowCost ? 'var(--danger)' : undefined,
                          }}
                        />
                        {belowCost ? (
                          <div style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>unter Einkauf</div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {MARKUP_PRICED_CATEGORIES.map((category) => {
                  const rule = tier.pricing[category];
                  const stored = rule?.mode === 'markup' ? rule.factor : undefined;
                  const belowCost = stored !== undefined && stored < 1;
                  return (
                    <tr key={category}>
                      <td>
                        {BILLING_CATEGORY_LABELS[category]}
                        <span style={{ color: 'var(--text-muted)' }}> (Aufschlag ×)</span>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>Einkauf × 1</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>× {ctx.targetMargin}</td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          name={`markup_${category}`}
                          type="text"
                          inputMode="decimal"
                          placeholder={`× ${ctx.targetMargin}`}
                          defaultValue={stored ?? ''}
                          style={{
                            maxWidth: '7rem',
                            textAlign: 'right',
                            borderColor: belowCost ? 'var(--danger)' : undefined,
                          }}
                        />
                        {belowCost ? (
                          <div style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>unter Einkauf</div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </form>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <button className="primary" type="submit" form={`tier-${tier.id}`}>
              Speichern
            </button>
            {tier.isDefault ? null : (
              <form action={deleteTier}>
                <input type="hidden" name="id" value={tier.id} />
                <button className="ghost" type="submit">Löschen</button>
              </form>
            )}
          </div>
        </div>
      ))}

      <div className="panel">
        <h2>Neue Preisstaffel</h2>
        <form className="stack" action={createTier} style={{ maxWidth: '22rem' }}>
          <div>
            <label htmlFor="new-tier-name">Name</label>
            <input id="new-tier-name" name="name" type="text" required minLength={2} maxLength={80} placeholder="z. B. Partner" />
          </div>
          <button className="primary" type="submit">Anlegen</button>
        </form>
      </div>
    </div>
  );
}
