// /settings index: the nav's single "Einstellungen" entry lands here and gets
// forwarded to the first tab the member may open.
import { redirect } from 'next/navigation';
import { requireActiveOrg } from '@/lib/org';
import { firstVisibleSettingsTab } from '@/components/SettingsTabs';
import NoAccessPanel from '@/components/NoAccessPanel';

export default async function SettingsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  const { orgId, access } = await requireActiveOrg(org);
  const target = firstVisibleSettingsTab(access);
  if (!target) return <NoAccessPanel title="Einstellungen" />;
  redirect(`${target}?org=${orgId}`);
}
