// Former "Widget-Demo". Trying a chat channel out now happens on the channel's
// own tab "Test" (0050, docs/webchat-test.md): there it also works for a draft,
// and the conversation is a test — no ticket, no mail to the team. This route
// only sends old links and bookmarks to that tab.
import { redirect } from 'next/navigation';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { href } from '@/lib/href';

export default async function WidgetDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  const { orgId } = await requireActiveOrg(org);

  // user-scoped query — members read their org's channels via RLS
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('channels')
    .select('id')
    .eq('org_id', orgId)
    .eq('type', 'chat')
    .contains('config', { widget: true })
    .order('created_at', { ascending: true })
    .limit(1);
  const channelId = ((data ?? [])[0] as { id: string } | undefined)?.id;

  redirect(
    channelId
      ? href(`/settings/channels/${channelId}`, { org: orgId, tab: 'test' })
      : href('/settings/channels', { org: orgId })
  );
}
