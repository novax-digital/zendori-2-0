// MD generator (Werkzeuge, owner 2026-07-24): turn a website into one clean
// Markdown document — downloadable or stored straight into a knowledge base.
import { canEditArea, canViewArea } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import MdGeneratorClient from './MdGeneratorClient';

// The crawl fetches up to 12 pages with an internal ~45s wall budget — give the
// server action room beyond the default function duration.
export const maxDuration = 120;

export default async function MdGeneratorPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'knowledge')) return <NoAccessPanel title="MD-Generator" />;

  const supabase = await createSupabaseServerClient();
  const { data: kbData } = await supabase
    .from('knowledge_bases')
    .select('id, name')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  const kbs = (kbData ?? []) as { id: string; name: string }[];

  return (
    <div className="shell">
      <div className="page-head">
        <h1>MD-Generator</h1>
        <p>
          Websites in saubere Markdown-Dateien verwandeln — zum Herunterladen oder direkt als
          Quelle in die Wissensdatenbank.
        </p>
      </div>

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />

      <MdGeneratorClient orgId={orgId} kbs={kbs} canSave={canEditArea(access, 'knowledge')} />
    </div>
  );
}
