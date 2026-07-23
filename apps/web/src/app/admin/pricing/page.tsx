import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/admin-auth';

export default async function AdminPricingIndexPage() {
  await requirePlatformAdmin();
  redirect('/admin/pricing/tiers');
}
