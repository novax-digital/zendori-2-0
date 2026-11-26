'use client';

// The banner that asks owners and admins to set up billing once the operator
// switched their organization to Stripe billing (Phase 15): shown on every app
// page until billing details and a payment method are on file.
//
//   · billing details missing → stays: without them no invoice can be issued;
//   · only the payment method missing → can be put off ("Später") for a week
//     in this browser: paying each invoice by link is allowed.
//
// The shell cannot read the billing tables (service role only); it asks
// /api/billing/setup-notice, which answers only for owners and admins.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { BillingSetupNotice } from '@/app/api/billing/setup-notice/route';
import Callout from '@/components/ui/Callout';

const SNOOZE_MS = 7 * 24 * 60 * 60_000;
const snoozeKey = (orgId: string): string => `zendori-billing-notice:${orgId}`;

function isSnoozed(orgId: string): boolean {
  try {
    const until = Number(localStorage.getItem(snoozeKey(orgId)) ?? '0');
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

export default function BillingSetupBanner() {
  const pathname = usePathname();
  const org = useSearchParams().get('org') ?? '';
  const [notice, setNotice] = useState<BillingSetupNotice | null>(null);
  const [snoozed, setSnoozed] = useState(false);

  // The billing page says the same thing in place, and the platform area is not
  // about the member's own organization.
  const onBillingPage = pathname.startsWith('/settings/billing');
  const hidden = onBillingPage || pathname.startsWith('/admin');

  // Asked again whenever the organization changes and when the member leaves
  // the billing page (where the missing things get filled in).
  useEffect(() => {
    if (onBillingPage) return;
    let active = true;
    (async () => {
      try {
        const response = await fetch(
          `/api/billing/setup-notice${org ? `?org=${encodeURIComponent(org)}` : ''}`,
          { cache: 'no-store' }
        );
        if (!response.ok) return;
        const body = (await response.json()) as { notice: BillingSetupNotice | null };
        if (!active) return;
        setNotice(body.notice);
        setSnoozed(body.notice ? isSnoozed(body.notice.orgId) : false);
      } catch {
        // no banner is better than a broken page
      }
    })();
    return () => {
      active = false;
    };
  }, [org, onBillingPage]);

  const canSnooze = notice?.missing === 'payment';
  const visible = !hidden && notice !== null && !(canSnooze && snoozed);

  // Full-height pages (the inbox) subtract the banner from the window height.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const element = box.current;
    if (!visible || !element) return;
    const write = (): void =>
      root.style.setProperty('--app-banner-h', `${element.offsetHeight}px`);
    write();
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--app-banner-h');
    };
  }, [visible]);

  if (!visible || !notice) return null;

  const snooze = (): void => {
    try {
      localStorage.setItem(snoozeKey(notice.orgId), String(Date.now() + SNOOZE_MS));
    } catch {
      // private mode: the banner is hidden for this visit only
    }
    setSnoozed(true);
  };

  return (
    <div className="app-banner" ref={box}>
      <Callout
        tone="warn"
        title={
          notice.missing === 'details'
            ? 'Bitte hinterlege deine Rechnungsdaten'
            : 'Bitte hinterlege eine Zahlungsart'
        }
        action={
          <span className="row">
            {canSnooze ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={snooze}>
                Später
              </button>
            ) : null}
            <Link
              className="btn btn--sm"
              href={`/settings/billing?org=${encodeURIComponent(notice.orgId)}`}
            >
              Zur Abrechnung
            </Link>
          </span>
        }
      >
        {notice.missing === 'details'
          ? 'Die Abrechnung läuft über unseren Zahlungsanbieter Stripe. Ohne Rechnungsdaten können wir keine Rechnung stellen.'
          : 'Mit SEPA-Lastschrift oder Karte ziehen wir Rechnungen automatisch ein. Ohne Zahlungsart bekommst du sie per E-Mail mit einem Bezahllink.'}
        {notice.livemode ? '' : ' Testmodus: Es wird nichts belastet.'}
      </Callout>
    </div>
  );
}
