'use client';

// The banner that asks owners and admins to set up billing once the operator
// switched their organization to Stripe billing (Phase 15): shown on every app
// page until billing details AND a payment method are on file. Both are
// required with Stripe billing (owner decision 2026-11-27: a customer who is
// billed through Stripe pays by SEPA direct debit or card; customers who are
// not are invoiced by hand and never see this) — so the banner cannot be put off.
//
// The shell cannot read the billing tables (service role only); it asks
// /api/billing/setup-notice, which answers only for owners and admins.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { BillingSetupNotice } from '@/app/api/billing/setup-notice/route';
import Callout from '@/components/ui/Callout';

export default function BillingSetupBanner() {
  const pathname = usePathname();
  const org = useSearchParams().get('org') ?? '';
  const [notice, setNotice] = useState<BillingSetupNotice | null>(null);

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
        if (active) setNotice(body.notice);
      } catch {
        // no banner is better than a broken page
      }
    })();
    return () => {
      active = false;
    };
  }, [org, onBillingPage]);

  const visible = !hidden && notice !== null;

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

  return (
    <div className="app-banner" ref={box}>
      <Callout
        tone="warn"
        title={
          notice.missing === 'details'
            ? 'Bitte hinterlege deine Rechnungsdaten und eine Zahlungsart'
            : 'Bitte hinterlege eine Zahlungsart'
        }
        action={
          <Link
            className="btn btn--sm"
            href={`/settings/billing?org=${encodeURIComponent(notice.orgId)}`}
          >
            Zur Abrechnung
          </Link>
        }
      >
        {notice.missing === 'details'
          ? 'Die Abrechnung läuft über unseren Zahlungsanbieter Stripe. Dafür brauchen wir deine Rechnungsdaten und eine Zahlungsart.'
          : 'Die Abrechnung läuft über unseren Zahlungsanbieter Stripe. Dafür ist eine Zahlungsart erforderlich: SEPA-Lastschrift oder Karte.'}
        {notice.livemode ? '' : ' Testmodus: Es wird nichts belastet.'}
      </Callout>
    </div>
  );
}
