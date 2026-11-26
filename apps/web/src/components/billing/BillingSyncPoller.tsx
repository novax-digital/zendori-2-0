'use client';

// Shown while the worker brings Stripe up to date (Phase 15a): after the
// billing details were saved, and after the customer came back from Stripe's
// payment page. Polls until the worker is done, then refreshes the page — the
// server components then render the new state and this component is gone.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Callout from '@/components/ui/Callout';
import { getBillingSyncState } from '@/app/settings/billing/actions';

const POLL_MS = 1_500;
/** After this many polls (~30 s) the worker is probably not picking it up. */
const SLOW_AFTER_POLLS = 20;
const MAX_POLLS = 80;

export default function BillingSyncPoller({
  orgId,
  awaitPaymentMethod,
  knownPaymentMethodId,
  doneHref,
}: {
  orgId: string;
  /** The customer just returned from the payment page: wait for a new method. */
  awaitPaymentMethod: boolean;
  /** The method that was on file when the page rendered. */
  knownPaymentMethodId: string | null;
  /** The page without the ?payment= marker. */
  doneHref: string;
}) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    const timer = setInterval(() => {
      void (async () => {
        polls += 1;
        const state = await getBillingSyncState(orgId).catch(() => null);
        if (cancelled) return;
        const done =
          state !== null &&
          !state.pending &&
          (!awaitPaymentMethod || state.paymentMethodId !== knownPaymentMethodId);
        if (done) {
          clearInterval(timer);
          if (awaitPaymentMethod) router.replace(doneHref, { scroll: false });
          else router.refresh();
          return;
        }
        if (polls >= SLOW_AFTER_POLLS) setSlow(true);
        if (polls >= MAX_POLLS) clearInterval(timer);
      })();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orgId, awaitPaymentMethod, knownPaymentMethodId, doneHref, router]);

  if (slow) {
    return (
      <Callout tone="warn">
        Der Abgleich mit dem Zahlungsanbieter dauert länger als üblich. Deine Angaben sind
        gespeichert — lade die Seite später neu.
      </Callout>
    );
  }
  return (
    <Callout>
      {awaitPaymentMethod
        ? 'Deine Zahlungsart wird übernommen …'
        : 'Deine Angaben werden mit dem Zahlungsanbieter abgeglichen …'}
    </Callout>
  );
}
