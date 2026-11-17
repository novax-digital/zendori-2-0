import { canViewArea, isAdminRole } from '@zendori/core';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsFrame from '@/components/SettingsTabs';
import TicketIdFormatField from '@/components/tickets/TicketIdFormatField';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
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
    <SettingsFrame access={access} orgId={orgId}>
      <div className="page">
        <PageHeader title="Tickets" subtitle={`Nummerierung der Tickets von ${orgName}.`} />

        <div className="page-body">
          <DismissibleBanners error={error} notice={notice} />

          {!settings ? (
            <Callout>Tickets sind noch nicht verfügbar (Migration 0030 ausstehend).</Callout>
          ) : (
            <>
              {disabled ? (
                <Callout>Nur Inhaber und Admins können diese Einstellungen ändern.</Callout>
              ) : null}
              <div className="form-narrow">
                <Section title="Ticket-Nummern">
                  <form id="ticket-settings-form" action={saveTicketSettings} className="stack">
                    <input type="hidden" name="org" value={orgId} />
                    <TicketIdFormatField
                      defaultFormat={settings.format}
                      nextNumber={settings.nextNumber}
                      disabled={disabled}
                    />
                    <div className="field--short">
                      <Field
                        label="Startnummer"
                        htmlFor="ticket-number-start"
                        help={
                          settings.counterStarted
                            ? `Die Zählung läuft bereits (nächste Nummer ${settings.nextNumber}) — die Startnummer ist nicht mehr änderbar.`
                            : 'Gilt für das erste Ticket dieser Organisation (z. B. Fortsetzung einer bestehenden Nummerierung).'
                        }
                      >
                        <input
                          id="ticket-number-start"
                          name="ticketNumberStart"
                          type="number"
                          min={1}
                          step={1}
                          defaultValue={
                            settings.counterStarted ? settings.nextNumber : settings.start
                          }
                          disabled={disabled || settings.counterStarted}
                        />
                      </Field>
                    </div>
                  </form>
                </Section>
              </div>
            </>
          )}
        </div>

        {settings && !disabled ? (
          <div className="save-bar">
            <Button type="submit" form="ticket-settings-form" variant="primary">
              Speichern
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsFrame>
  );
}
