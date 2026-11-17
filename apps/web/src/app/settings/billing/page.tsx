// Customer billing area (self-service). Shows the org's own monthly invoice —
// package fees + consumption — with € amounts only; never our USD cost or the
// markup. Owner-only. requireActiveOrg verifies membership, so the service-role
// rollup scoped to that orgId is safe and keeps cost data server-side.
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  currentMonth,
  formatEur,
  formatQuantity,
  getOrgInvoice,
  loadBillingCatalog,
  parseMonthKey,
  recentMonths,
  resolveOrgTier,
} from '@/lib/billing';
import { categoryPriceEur, canViewArea, type BillingCategory } from '@zendori/core';
import { href } from '@/lib/href';
import SettingsFrame from '@/components/SettingsTabs';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { EmptyState, Section, Stat, Stats } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';

// The per-event log mirrors the SQL rollup's step→category mapping (0021
// billing_org_rollup) so each row is priced exactly like its invoice line:
// tier rule ⇒ unit price per event, no rule ⇒ cost pass-through in EUR.
const AI_EVENT_META: Record<string, { label: string; category: BillingCategory }> = {
  classify: { label: 'Klassifikation', category: 'ai' },
  extract: { label: 'Extraktion', category: 'ai' },
  draft: { label: 'Antwort-Entwurf', category: 'ai' },
  rerank: { label: 'Re-Ranking', category: 'ai' },
  learn: { label: 'Lernen', category: 'ai' },
  retrieve: { label: 'Wissensdatenbank-Suche', category: 'embeddings' },
  transcribe: { label: 'Sprachnachricht-Transkription', category: 'transcription' },
};

// Only usage events that appear on the invoice as their own transactional
// position. WhatsApp/e-mail/numbers are counted from their own tables and shown
// as monthly lines, never as single events; sip_minutes is an internal cost
// component of 'voice' and would double-display a call.
const USAGE_EVENT_META: Record<string, { label: string; category: BillingCategory }> = {
  voice_minutes: { label: 'Telefonat', category: 'voice' },
  index_embeddings: { label: 'Wissensdatenbank-Indexierung', category: 'embeddings' },
  index_vision: { label: 'Bild-Beschreibung (Indexierung)', category: 'embeddings' },
};

const LOG_TOTAL = 100;
const LOG_PAGE_SIZE = 20;

interface LogRow {
  when: string;
  label: string;
  detail: string | null;
  priceEur: number;
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export default async function CustomerBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; month?: string; vpage?: string }>;
}) {
  const { org, month, vpage } = await searchParams;
  const { orgId, access } = await requireActiveOrg(org);

  if (!canViewArea(access, 'billing')) {
    return (
      <div className="page">
        <PageHeader title="Abrechnung" />
        <div className="page-body">
          <Callout>Die Abrechnung ist nur für Inhaber der Organisation sichtbar.</Callout>
        </div>
      </div>
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return (
      <SettingsFrame access={access} orgId={orgId}>
        <div className="page">
          <PageHeader title="Abrechnung" />
          <div className="page-body">
            <Callout tone="danger">Die Abrechnung ist derzeit nicht verfügbar.</Callout>
          </div>
        </div>
      </SettingsFrame>
    );
  }

  // Only months the org actually existed in: a customer created in July must
  // not see empty May/June entries in the picker.
  const { data: orgRow } = await admin
    .from('organizations')
    .select('created_at')
    .eq('id', orgId)
    .maybeSingle();
  const createdAtMs = Date.parse(
    (orgRow as { created_at: string } | null)?.created_at ?? new Date().toISOString()
  );
  const months = recentMonths(new Date(), 12).filter((m) => Date.parse(m.toIso) > createdAtMs);
  if (months.length === 0) months.push(currentMonth(new Date()));

  const period = parseMonthKey(month, currentMonth(new Date()));
  const catalog = await loadBillingCatalog(admin);
  const invoice = await getOrgInvoice(admin, orgId, period, catalog);
  const tier = resolveOrgTier(catalog, orgId);

  const usedLines = invoice.usage.lines.filter((line) => line.quantity > 0 || line.priceEur > 0);
  const hasRecurring = invoice.recurring.length > 0;
  const isEmpty = usedLines.length === 0 && !hasRecurring;

  // --- per-event cost log (last LOG_TOTAL of the selected month) ---------------
  const [{ data: aiRunsData }, { data: usageData }] = await Promise.all([
    admin
      .from('ai_runs')
      .select('step, cost_usd, created_at')
      .eq('org_id', orgId)
      .gte('created_at', period.fromIso)
      .lt('created_at', period.toIso)
      .order('created_at', { ascending: false })
      .limit(LOG_TOTAL),
    admin
      .from('usage_events')
      .select('category, quantity, unit, cost_usd, occurred_at')
      .eq('org_id', orgId)
      .gte('occurred_at', period.fromIso)
      .lt('occurred_at', period.toIso)
      .order('occurred_at', { ascending: false })
      .limit(LOG_TOTAL),
  ]);

  const logRows: LogRow[] = [
    ...((aiRunsData ?? []) as { step: string; cost_usd: number | null; created_at: string }[])
      .map((r): LogRow | null => {
        const meta = AI_EVENT_META[r.step];
        if (!meta) return null;
        return {
          when: r.created_at,
          label: meta.label,
          detail: null,
          priceEur: categoryPriceEur(
            1,
            Number(r.cost_usd) || 0,
            tier?.[meta.category],
            catalog.ctx
          ),
        };
      })
      .filter((r): r is LogRow => r !== null),
    ...(
      (usageData ?? []) as {
        category: string;
        quantity: number | string | null;
        unit: string | null;
        cost_usd: number | null;
        occurred_at: string;
      }[]
    )
      .map((r): LogRow | null => {
        const meta = USAGE_EVENT_META[r.category];
        if (!meta) return null;
        const quantity = Number(r.quantity) || 0;
        return {
          when: r.occurred_at,
          label: meta.label,
          detail:
            r.category === 'voice_minutes' ? formatQuantity(quantity, 'Minuten') : null,
          priceEur: categoryPriceEur(
            // Voice is priced per minute; the index events per Vorgang.
            r.category === 'voice_minutes' ? quantity : 1,
            Number(r.cost_usd) || 0,
            tier?.[meta.category],
            catalog.ctx
          ),
        };
      })
      .filter((r): r is LogRow => r !== null),
  ]
    .sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
    .slice(0, LOG_TOTAL);

  const totalPages = Math.max(1, Math.ceil(logRows.length / LOG_PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Number.parseInt(vpage ?? '1', 10) || 1));
  const pageRows = logRows.slice((page - 1) * LOG_PAGE_SIZE, page * LOG_PAGE_SIZE);
  const logHref = (p: number) =>
    href('/settings/billing', { org: orgId, month: period.key, vpage: p });
  const usageTotalEur = usedLines.reduce((sum, line) => sum + line.priceEur, 0);

  return (
    <SettingsFrame access={access} orgId={orgId}>
      <div className="page">
        <PageHeader
          title="Abrechnung"
          subtitle="Deine Monatsrechnung aus Paketgebühren und Verbrauch, alle Beträge netto in Euro."
        />

        <div className="page-body">
          <form method="get" className="toolbar">
            <input type="hidden" name="org" value={orgId} />
            <select name="month" aria-label="Abrechnungsmonat" defaultValue={period.key}>
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
            <Button type="submit">Anzeigen</Button>
          </form>

          <Section title={period.label}>
            <Stats>
              <Stat label="Gesamt" value={formatEur(invoice.grandTotalEur)} note="netto" />
              <Stat label="Paketgebühren" value={formatEur(invoice.recurringTotalEur)} />
              <Stat label="Verbrauch" value={formatEur(usageTotalEur)} />
              <Stat
                label="Paket"
                value={invoice.packageName ?? '—'}
                note={
                  invoice.packageName
                    ? invoice.interval === 'yearly'
                      ? 'jährliche Laufzeit'
                      : 'monatliche Laufzeit'
                    : undefined
                }
              />
            </Stats>
          </Section>

          <Section
            title="Rechnungspositionen"
            help="Angaben ohne Gewähr — die endgültige Rechnung kann abweichen. Bei Fragen zur Abrechnung wende dich an deinen Ansprechpartner."
          >
            {isEmpty ? (
              <EmptyState title="In diesem Monat ist noch nichts angefallen" />
            ) : (
              <div className="table-wrap">
                <table className="table--compact">
                  <thead>
                    <tr>
                      <th>Leistung</th>
                      <th className="num">Verbrauch</th>
                      <th className="num">Betrag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.recurring.map((line, i) => (
                      <tr key={`rec-${i}`}>
                        <td>{line.label}</td>
                        <td />
                        <td className="num strong">{formatEur(line.amountEur)}</td>
                      </tr>
                    ))}
                    {usedLines.map((line) => (
                      <tr key={line.category}>
                        <td>{line.label}</td>
                        <td className="num muted">{formatQuantity(line.quantity, line.unit)}</td>
                        <td className="num strong">{formatEur(line.priceEur)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {/* td, not th: the global th style is the small muted table head */}
                    <tr className="table-sum">
                      <td>Gesamt</td>
                      <td />
                      <td className="num">{formatEur(invoice.grandTotalEur)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Section>

          <Section
            title="Kosten-Log"
            help={`Die letzten ${LOG_TOTAL} Einzelvorgänge dieses Monats mit ihrem Preis laut deiner Preisliste. WhatsApp-Nachrichten, E-Mails und Rufnummern werden monatlich gezählt und erscheinen nur in den Rechnungspositionen.`}
          >
            {pageRows.length === 0 ? (
              <EmptyState title="Keine Einzelvorgänge in diesem Monat" />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="table--compact">
                    <thead>
                      <tr>
                        <th>Zeitpunkt</th>
                        <th>Vorgang</th>
                        <th className="num">Menge</th>
                        <th className="num">Betrag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((row, i) => (
                        <tr key={`${row.when}-${i}`}>
                          <td className="muted nowrap">{formatDateTime(row.when)}</td>
                          <td>{row.label}</td>
                          <td className="num muted">{row.detail ?? ''}</td>
                          <td className="num">{formatEur(row.priceEur)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {totalPages > 1 ? (
                  <div className="row row--between">
                    <span className="muted small">
                      Seite {page} von {totalPages}
                    </span>
                    <div className="row">
                      {page > 1 ? (
                        <Button href={logHref(page - 1)} size="sm">
                          Neuere
                        </Button>
                      ) : null}
                      {page < totalPages ? (
                        <Button href={logHref(page + 1)} size="sm">
                          Ältere
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </Section>
        </div>
      </div>
    </SettingsFrame>
  );
}
