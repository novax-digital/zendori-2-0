// Einstellungen → Benachrichtigungen (migration 0038): PERSONAL settings — every
// member chooses which events they want an e-mail for, per organization. Each
// event has its own template; "Testmail senden" sends it with sample content to
// the member's own address.
import {
  NOTIFICATION_EVENT_DEFS,
  canSubscribeNotification,
  isMissingRelationError,
  parseNotificationEvents,
} from '@zendori/core';
import DismissibleBanners from '@/components/DismissibleBanners';
import SettingsFrame from '@/components/SettingsTabs';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/supabase/session';
import { saveNotificationPreferences, sendTestNotification } from './actions';

export default async function NotificationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, userId, access } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const email = (await getSessionUser())?.email ?? '';

  const supabase = await createSupabaseServerClient();
  const prefRes = await supabase
    .from('notification_preferences')
    .select('events')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  // Before migration 0038 the table is missing — the page then explains itself
  // (the templates can still be tried with a test mail).
  const available = !prefRes.error || !isMissingRelationError(prefRes.error);
  const enabled = new Set(
    parseNotificationEvents((prefRes.data as { events?: unknown } | null)?.events)
  );

  return (
    <SettingsFrame access={access} orgId={orgId}>
      <div className="page">
        <PageHeader
          title="Benachrichtigungen"
          subtitle={`Welche E-Mails du zu ${orgName} bekommst.`}
        />

        <div className="page-body">
          <DismissibleBanners error={error} notice={notice} />

          {!available ? (
            <Callout>
              Benachrichtigungen sind noch nicht verfügbar (Migration 0038 ausstehend). Die Vorlagen
              kannst du schon per Testmail ansehen.
            </Callout>
          ) : null}

          <div className="form-narrow">
            <Section
              title="E-Mail-Benachrichtigungen"
              help={
                email ? (
                  <>
                    Die E-Mails gehen an <strong>{email}</strong>. Die Auswahl gilt nur für dich und
                    nur für diese Organisation.
                  </>
                ) : (
                  'Die Auswahl gilt nur für dich und nur für diese Organisation.'
                )
              }
            >
              <form id="notification-form" action={saveNotificationPreferences} className="stack">
                <input type="hidden" name="org" value={orgId} />
                <ul className="notify-list">
                  {NOTIFICATION_EVENT_DEFS.map((def) => {
                    const allowed = canSubscribeNotification(access, def.key);
                    return (
                      <li key={def.key} className="notify-row">
                        <label className="check-row">
                          <input
                            type="checkbox"
                            name="events"
                            value={def.key}
                            defaultChecked={allowed && enabled.has(def.key)}
                            disabled={!available || !allowed}
                          />
                          <span className="notify-row-text">
                            <span>{def.label}</span>
                            <span className="muted small">
                              {allowed
                                ? def.description
                                : 'Für diesen Bereich hast du keinen Zugriff.'}
                            </span>
                          </span>
                        </label>
                        <Button
                          type="submit"
                          size="sm"
                          formAction={sendTestNotification}
                          name="testEvent"
                          value={def.key}
                          disabled={!allowed}
                        >
                          Testmail senden
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </form>
            </Section>

            <Callout>
              Du bekommst nur E-Mails zu Kanälen und Bereichen, auf die du Zugriff hast, und nie zu
              deinen eigenen Aktionen. Die E-Mails nennen Betreff, Kontakt und Kanal und verlinken
              in Zendori — Nachrichtentexte stehen nicht darin. Eine Testmail enthält Beispieldaten
              und ändert nichts an deiner Auswahl.
            </Callout>
          </div>
        </div>

        {available ? (
          <div className="save-bar">
            <Button type="submit" form="notification-form" variant="primary">
              Speichern
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsFrame>
  );
}
