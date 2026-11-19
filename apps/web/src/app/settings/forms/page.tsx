import { redirect } from 'next/navigation';
import { href } from '@/lib/href';

// Forms are a channel type: they are listed, created and opened on the Kanäle
// page (the builder itself stays on /settings/forms/[formId]). This route only
// keeps old links and bookmarks working — ?panel=new opens the "Neuer Kanal"
// drawer on the form type.
export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string; panel?: string }>;
}) {
  const { org, error, notice, panel } = await searchParams;
  const creating = panel === 'new';
  redirect(
    href('/settings/channels', {
      org,
      panel: creating ? 'new' : undefined,
      type: creating ? 'webform' : undefined,
      error,
      notice,
    })
  );
}
