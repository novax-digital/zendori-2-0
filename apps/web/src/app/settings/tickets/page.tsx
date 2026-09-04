import { canViewArea, isAdminRole } from '@zendori/core';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsTabs from '@/components/SettingsTabs';
import TicketIdFormatField from '@/components/tickets/TicketIdFormatField';
import { requireActiveOrg } from '@/lib/org';
import { getTicketSettings } from '@/lib/tickets/queries';
import { saveTicketSettings } from './actions';

export default async function TicketSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, role, access } = await requireActiveOrg(org);
  if (!isAdminRole(role) && !canViewArea(access, 'tickets')) {
    return <NoAccessPanel title="Tickets" />;
  }
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const disabled = !isAdminRole(role);
  const settings = await getTicketSettings(orgId);

  return (
    <div className="shell">
      <SettingsTabs active="tickets" access={access} orgId={orgId} />
      <div className="page-head">
        <h1>Tickets</h1>
        <p>Nummerierung der Tickets von {orgName}.</p>
      </div>
      <DismissibleBanners error={error} notice={notice} />
      <div className="panel">
        {!settings ? (
          <p className="hint">Tickets sind noch nicht verfügbar (Migration 0030 ausstehend).</p>
        ) : (
          <form action={saveTicketSettings} className="stack">
            <input type="hidden" name="org" value={orgId} />
            <TicketIdFormatField
              defaultFormat={settings.format}
              nextNumber={settings.nextNumber}
              disabled={disabled}
            />
            <div>
              <label htmlFor="ticket-number-start">Startnummer</label>
              <input
                id="ticket-number-start"
                name="ticketNumberStart"
                type="number"
                min={1}
                step={1}
                defaultValue={settings.counterStarted ? settings.nextNumber : settings.start}
                disabled={disabled || settings.counterStarted}
                style={{ maxWidth: '10rem' }}
              />
              <p className="hint">
                {settings.counterStarted
                  ? `Die Zählung läuft bereits (nächste Nummer ${settings.nextNumber}) — die Startnummer ist nicht mehr änderbar.`
                  : 'Gilt für das erste Ticket dieser Organisation (z. B. Fortsetzung einer bestehenden Nummerierung).'}
              </p>
            </div>
            {disabled ? (
              <p className="hint">Nur Inhaber und Admins können diese Einstellungen ändern.</p>
            ) : (
              <div>
                <button type="submit">Speichern</button>
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
