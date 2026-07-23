// Packages (Pakete): sellable bundles = a price tier + setup fee + monthly/yearly
// base fee + per-channel-type fee & quota. The recurring fee is base + Σ(quota ×
// per-channel fee). Assigning a package to a customer (on the billing drill-down)
// pushes its quotas into org_channel_limits. Platform-admin only.
import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { formatEur, loadBillingCatalog } from '@/lib/billing';
import {
  PACKAGE_CHANNEL_KINDS,
  PACKAGE_CHANNEL_LABELS,
  packageMonthlyTotalEur,
  packageYearlyTotalEur,
} from '@zendori/core';
import { createPackage, deletePackage, updatePackage } from '../actions';

export default async function PackagesPage({
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
          <h1>Pakete</h1>
        </div>
        <p className="error">Service-Role ist serverseitig nicht konfiguriert.</p>
      </div>
    );
  }

  const catalog = await loadBillingCatalog(admin);
  const tiers = [...catalog.tiers.values()].sort((a, b) => a.name.localeCompare(b.name));
  const packages = [...catalog.packages.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Pakete</h1>
        <p>
          Bündel aus Preisstaffel, Setup-Gebühr, Grundgebühr und Kanal-Fees je Typ (inkl.
          Kontingent). Monats-/Jahres-Fee = Grundgebühr + Summe der Kanal-Fees.{' '}
          <Link href="/admin/pricing/tiers">Zu den Preisstaffeln →</Link>
        </p>
      </div>

      {error ? <p className="error" style={{ marginBottom: '1rem' }}>{error}</p> : null}
      {notice ? <p className="notice" style={{ marginBottom: '1rem' }}>{notice}</p> : null}

      {packages.map((pkg) => (
        <div className="panel" key={pkg.id}>
          <form className="stack" action={updatePackage} id={`pkg-${pkg.id}`}>
            <input type="hidden" name="id" value={pkg.id} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end' }}>
              <div>
                <label>Name</label>
                <input name="name" type="text" required minLength={2} maxLength={80} defaultValue={pkg.name} />
              </div>
              <div>
                <label>Preisstaffel</label>
                <select name="priceTierId" defaultValue={pkg.priceTierId ?? ''}>
                  <option value="">Standard</option>
                  {tiers.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input type="checkbox" name="isActive" defaultChecked={pkg.isActive} /> Aktiv
              </label>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <label>Setup-Gebühr (€)</label>
                <input name="setupFeeEur" type="text" inputMode="decimal" defaultValue={String(pkg.setupFeeEur)} style={{ maxWidth: '9rem' }} />
              </div>
              <div>
                <label>Grundgebühr Monat (€)</label>
                <input name="baseFeeMonthlyEur" type="text" inputMode="decimal" defaultValue={String(pkg.baseFeeMonthlyEur)} style={{ maxWidth: '9rem' }} />
              </div>
              <div>
                <label>Grundgebühr Jahr (€)</label>
                <input name="baseFeeYearlyEur" type="text" inputMode="decimal" defaultValue={String(pkg.baseFeeYearlyEur)} style={{ maxWidth: '9rem' }} />
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Kanal-Typ</th>
                  <th style={{ textAlign: 'right' }}>Kontingent</th>
                  <th style={{ textAlign: 'right' }}>Fee/Monat (€)</th>
                  <th style={{ textAlign: 'right' }}>Fee/Jahr (€)</th>
                </tr>
              </thead>
              <tbody>
                {PACKAGE_CHANNEL_KINDS.map((kind) => {
                  const term = pkg.channels[kind];
                  return (
                    <tr key={kind}>
                      <td>{PACKAGE_CHANNEL_LABELS[kind]}</td>
                      <td style={{ textAlign: 'right' }}>
                        <input name={`quota_${kind}`} type="text" inputMode="numeric" placeholder="0" defaultValue={term ? String(term.quota) : ''} style={{ maxWidth: '5rem', textAlign: 'right' }} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input name={`feem_${kind}`} type="text" inputMode="decimal" placeholder="0" defaultValue={term ? String(term.feeMonthlyEur) : ''} style={{ maxWidth: '6rem', textAlign: 'right' }} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input name={`feey_${kind}`} type="text" inputMode="decimal" placeholder="0" defaultValue={term ? String(term.feeYearlyEur) : ''} style={{ maxWidth: '6rem', textAlign: 'right' }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </form>

          <p className="help" style={{ marginTop: '0.5rem' }}>
            Aktuell gespeichert: <strong>{formatEur(packageMonthlyTotalEur(pkg))}/Monat</strong> ·{' '}
            <strong>{formatEur(packageYearlyTotalEur(pkg))}/Jahr</strong> + Setup{' '}
            {formatEur(pkg.setupFeeEur)}. (Nach dem Speichern aktualisiert.)
          </p>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="primary" type="submit" form={`pkg-${pkg.id}`}>Speichern</button>
            <form action={deletePackage}>
              <input type="hidden" name="id" value={pkg.id} />
              <button className="ghost" type="submit">Löschen</button>
            </form>
          </div>
        </div>
      ))}

      <div className="panel">
        <h2>Neues Paket</h2>
        <form className="stack" action={createPackage} style={{ maxWidth: '22rem' }}>
          <div>
            <label htmlFor="new-pkg-name">Name</label>
            <input id="new-pkg-name" name="name" type="text" required minLength={2} maxLength={80} placeholder="z. B. Starter" />
          </div>
          <button className="primary" type="submit">Anlegen</button>
        </form>
      </div>
    </div>
  );
}
