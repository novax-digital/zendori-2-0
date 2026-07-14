import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/admin-auth';

export default async function AdminIndexPage() {
  await requirePlatformAdmin();
  redirect('/admin/users');
}
