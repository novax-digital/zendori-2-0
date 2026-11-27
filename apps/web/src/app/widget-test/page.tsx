// The page inside the frame of a chat channel's "Test" tab (0050,
// docs/webchat-test.md): a stand-in for the customer's website with nothing on
// it but the REAL widget of that channel — the same script, loaded the same
// way, plus data-zendori-test. That attribute lets the widget API answer for a
// draft channel and marks the conversation as a test; it only works because
// this page is served to a signed-in member (lib/widget/test-mode.ts).
//
// It is a frame on purpose: the widget mounts itself on document.body and
// stays there. In a frame it goes away with the tab.
import type { Metadata } from 'next';
import Script from 'next/script';
import { notFound } from 'next/navigation';
import { canAccessChannel, canViewArea, type Channel } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toWidgetChannelView } from '@/app/settings/channels/shared';

export const metadata: Metadata = { title: 'Chat-Test' };

export default async function WidgetTestPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; channel?: string }>;
}) {
  const { org, channel: channelId } = await searchParams;
  if (!channelId || !/^[0-9a-f-]{36}$/.test(channelId)) notFound();
  const { orgId, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'channels') || !canAccessChannel(access, channelId)) notFound();

  // user-scoped query — members read their org's channels via RLS
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('channels')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', channelId)
    .maybeSingle();
  const widget = data ? toWidgetChannelView(data as unknown as Channel) : null;
  if (!widget) notFound();

  return (
    <div className="wt-site">
      {/* a faint page, so the widget sits on something like a website */}
      <div className="wd-page-mock" aria-hidden="true">
        <b />
        <span />
        <span />
        <span className="short" />
      </div>
      <Script
        src="/widget.js"
        data-zendori-token={widget.publicToken}
        data-zendori-test="1"
        strategy="afterInteractive"
      />
    </div>
  );
}
