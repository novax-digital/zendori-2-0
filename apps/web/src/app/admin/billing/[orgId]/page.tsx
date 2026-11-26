// Per-customer billing drill-down (platform admin): the combined invoice (usage
// priced through the org's tier + package fees + setup), the customer's terms in
// the rail (edited on …/terms), and the most recent measured transactions.
// Service-role reads behind requirePlatformAdmin.
import { notFound } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  currentChannelCounts,
  currentMonth,
  formatEur,
  formatEurCost,
  formatQuantity,
  getOrgInvoice,
  loadBillingCatalog,
  parseMonthKey,
  recentMonths,
  resolveOrgTerms,
} from '@/lib/billing';
import { loadBillingAccountState, loadSetupMailState } from '@/lib/billing-account';
import { href } from '@/lib/href';
import { stripeRuntime } from '@/lib/stripe';
import { periodKeyOf, shiftPeriodKey } from '@zendori/core';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { EmptyState, Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../../_components/AdminUnavailable';
import TermsSummary from '../../_components/TermsSummary';
import {
  StripeBillingDrawer,
  StripeBillingSummary,
  type MonthChoice,
} from '../../_components/StripeBillingPanel';

const STEP_LABELS: Record<string, string> = {
  classify: 'Klassifikation',
  extract: 'Extraktion',
  retrieve: 'Wissenssuche',
  rerank: 'Re-Ranking',
  draft: 'Antwort-Entwurf',
  learn: 'Lernen',
  transcribe: 'Transkription',
};

const USAGE_LABELS: Record<string, string> = {
  voice_minutes: 'Telefonminuten',
  index_embeddings: 'KB-Indexierung',
  whatsapp_message: 'WhatsApp',
  email: 'E-Mail',
  sip_minutes: 'SIP-Minuten',
  data_action: 'Data Action',
  other: 'Sonstiges',
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

type TxRow = { when: string; label: string; source: string; costUsd: number };

export default async function AdminOrgBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ month?: string; error?: string; notice?: string; panel?: string }>;
}) {
  await requirePlatformAdmin();
  const { orgId } = await params;
  const { month, error, notice, panel } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Abrechnung" />;

  const { data: orgRow } = await admin
    .from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();
  if (!orgRow) notFound();
  const org = orgRow as { id: string; name: string };

  const months = recentMonths(new Date(), 12);
  const period = parseMonthKey(month, currentMonth(new Date()));
  const catalog = await loadBillingCatalog(admin);
  const invoice = await getOrgInvoice(admin, orgId, period, catalog);
  // the side rail always describes the CURRENT month, whatever month is shown
  const chargedChannels = await currentChannelCounts(
    admin,
    orgId,
    resolveOrgTerms(catalog, orgId)
  );

  const costEur = (usd: number) => Math.round(usd * catalog.ctx.usdToEur * 100) / 100;

  const [{ data: aiRunsData }, { data: usageData }] = await Promise.all([
    admin
      .from('ai_runs')
      .select('step, cost_usd, created_at')
      .eq('org_id', orgId)
      .gte('created_at', period.fromIso)
      .lt('created_at', period.toIso)
      .order('created_at', { ascending: false })
      .limit(30),
    admin
      .from('usage_events')
      .select('category, cost_usd, occurred_at')
      .eq('org_id', orgId)
      .gte('occurred_at', period.fromIso)
      .lt('occurred_at', period.toIso)
      .order('occurred_at', { ascending: false })
      .limit(30),
  ]);

  const txns: TxRow[] = [
    ...((aiRunsData ?? []) as { step: string; cost_usd: number | null; created_at: string }[]).map(
      (r) => ({ when: r.created_at, label: STEP_LABELS[r.step] ?? r.step, source: 'KI', costUsd: Number(r.cost_usd) || 0 })
    ),
    ...((usageData ?? []) as { category: string; cost_usd: number | null; occurred_at: string }[]).map(
      (r) => ({ when: r.occurred_at, label: USAGE_LABELS[r.category] ?? r.category, source: 'Infrastruktur', costUsd: Number(r.cost_usd) || 0 })
    ),
  ]
    .sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
    .slice(0, 30);

  const base = `/admin/billing/${orgId}`;
  const closeHref = href(base, { month });

  // Stripe billing (Phase 15a): the switch and its drawer (?panel=stripe). The
  // row belongs to the CURRENT Stripe mode; without a key the block only says so.
  const runtime = stripeRuntime();
  const billingAccount = runtime
    ? await loadBillingAccountState(admin, orgId, runtime.livemode)
    : null;
  const setupMail =
    runtime && billingAccount?.available
      ? await loadSetupMailState(admin, orgId, runtime.livemode)
      : null;
  const stripeEditing =
    panel === 'stripe' && runtime !== null && billingAccount?.available === true;
  const monthLabel = (key: string): string => parseMonthKey(key, period).label;
  const thisMonthKey = periodKeyOf(new Date());
  const storedFrom = billingAccount?.stripe?.invoiceFrom ?? null;
  const fromChoices: MonthChoice[] = [
    shiftPeriodKey(thisMonthKey, -1),
    thisMonthKey,
    shiftPeriodKey(thisMonthKey, 1),
  ]
    .concat(storedFrom ? [storedFrom] : [])
    .filter((key, index, all) => all.indexOf(key) === index)
    .sort()
    .map((key) => ({ key, label: monthLabel(key) }));

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Abrechnung', href: `/admin/billing?month=${period.key}` },
          { label: org.name },
        ]}
        title={org.name}
        subtitle="Rechnung, Konditionen und letzte Vorgänge dieses Kunden."
      />

      <div className="page-split">
        <div className="page-body">
          <DismissibleBanners error={stripeEditing ? undefined : error} notice={notice} />

          <form method="get" className="toolbar">
            <select name="month" aria-label="Abrechnungsmonat" defaultValue={period.key}>
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
            <Button type="submit">Anzeigen</Button>
          </form>

          <Section
            title={`Rechnung ${period.label}`}
            help={
              invoice.packageName ? (
                <>
                  Paket <strong>{invoice.packageName}</strong>,{' '}
                  {invoice.interval === 'yearly' ? 'jährliche' : 'monatliche'} Laufzeit.
                </>
              ) : (
                'Kein Paket zugewiesen: Berechnet werden nur der Verbrauch und Rufnummern zum Einkaufspreis.'
              )
            }
            // 0045 missing: the database cannot say which channels were active
            actions={
              invoice.channelCountsByQuota && invoice.packageName ? (
                <Badge tone="warn">Kanäle nach Kontingent (Migration 0045 ausstehend)</Badge>
              ) : undefined
            }
          >
            <div className="table-wrap">
              <table className="table--compact">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th className="right">Menge</th>
                    <th className="right">Kosten</th>
                    <th className="right">Preis</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.recurring.map((line, i) => (
                    <tr key={`rec-${i}`}>
                      <td>{line.label}</td>
                      <td />
                      <td className="right muted">
                        {line.costEur === undefined ? '—' : formatEur(line.costEur)}
                      </td>
                      <td className="right strong">{formatEur(line.amountEur)}</td>
                    </tr>
                  ))}
                  {invoice.usage.lines.map((line) => (
                    <tr key={line.category}>
                      <td>{line.label}</td>
                      <td className="right muted">{formatQuantity(line.quantity, line.unit)}</td>
                      <td className="right muted">{formatEur(costEur(line.costUsd))}</td>
                      <td className="right strong">{formatEur(line.priceEur)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="table-sum">
                    <th scope="row">Summe</th>
                    <td />
                    <td className="right">{formatEur(invoice.totalCostEur)}</td>
                    <td className="right">{formatEur(invoice.grandTotalEur)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Section>

          <Section
            title="Letzte Vorgänge"
            help="WhatsApp-, E-Mail- und Rufnummern-Kosten werden aus Mengen × Preistabelle berechnet und erscheinen nur in der Rechnung, nicht als Einzelvorgang."
          >
            {txns.length === 0 ? (
              <EmptyState
                title="Keine Vorgänge"
                text={`In ${period.label} wurden noch keine kostenpflichtigen Vorgänge erfasst.`}
              />
            ) : (
              <div className="table-wrap">
                <table className="table--compact">
                  <thead>
                    <tr>
                      <th>Zeitpunkt</th>
                      <th>Vorgang</th>
                      <th>Quelle</th>
                      <th className="right">Kosten</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txns.map((t, i) => (
                      <tr key={`${t.when}-${i}`}>
                        <td className="muted nowrap">{formatDateTime(t.when)}</td>
                        <td>{t.label}</td>
                        <td className="muted">{t.source}</td>
                        {/* Unrounded: a single Haiku call is worth ~0,1–0,3 Cent, and
                            cent-rounding rendered every KI row as a misleading 0,00 €. */}
                        <td className="right">{formatEurCost(t.costUsd * catalog.ctx.usdToEur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>

        <aside className="page-rail" aria-label="Konditionen und Stripe">
          <TermsSummary catalog={catalog} orgId={orgId} channelCounts={chargedChannels} />
          <StripeBillingSummary
            orgId={orgId}
            livemode={runtime ? runtime.livemode : null}
            state={billingAccount}
            mail={setupMail}
            fromLabel={storedFrom ? monthLabel(storedFrom) : null}
            changeHref={href(base, { month, panel: 'stripe' })}
          />
        </aside>
      </div>

      {stripeEditing && runtime && billingAccount ? (
        <StripeBillingDrawer
          orgId={orgId}
          closeHref={closeHref}
          livemode={runtime.livemode}
          enabled={billingAccount.stripe?.enabled === true}
          invoiceFrom={storedFrom ?? thisMonthKey}
          months={fromChoices}
          stored={billingAccount.stored}
          mail={setupMail}
          setupComplete={
            billingAccount.details !== null && billingAccount.stripe?.paymentMethodId != null
          }
          error={error}
        />
      ) : null}
    </div>
  );
}
