'use client';

// The loading state of every app route (the loading.tsx files render this).
// While a page loads its data on the server, the area right of the sidebar
// shows a skeleton in the shape of the page that is coming: Next mounts it
// immediately on navigation (and prefetches it in production), so a click is
// answered at once instead of leaving the old page frozen.
//
// Which shape depends on the target path — it is read here from the router,
// so one component serves all routes. Navigations that only change the query
// string (a drawer, a tab, a filter, another inbox conversation) keep the
// current page on screen: Next keys loading boundaries by path, not by query.
import { Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  DetailSkeleton,
  InboxSkeleton,
  ListSkeleton,
  SettingsSkeleton,
} from '@/components/ui/Skeleton';

type Variant = 'inbox' | 'list' | 'detail' | 'settings';

/** /settings/<area> that are lists (page type B); everything below them is a detail page. */
const SETTINGS_LISTS = new Set(['channels', 'agents', 'knowledge', 'members']);
/** /settings/<page> of the Einstellungen hub — they render the sub-navigation (SettingsFrame). */
const SETTINGS_HUB = new Set([
  'organization',
  'phone-numbers',
  'ai',
  'tickets',
  'canned-responses',
  'integrations',
  'billing',
  'notifications',
]);
/** /admin/<page> that are lists; the sub-navigation there is a layout and stays mounted. */
const ADMIN_LISTS = new Set(['users', 'phone-numbers', 'demo', 'billing', 'pricing']);

export function skeletonVariant(pathname: string): Variant {
  const [area, page, ...rest] = pathname.split('/').filter(Boolean);
  if (area === 'inbox') return 'inbox';
  if (area === 'tickets') return page ? 'detail' : 'list';
  // /admin itself redirects to the user list
  if (area === 'admin') return !page || (ADMIN_LISTS.has(page) && rest.length === 0) ? 'list' : 'detail';
  if (area === 'settings') {
    // pages BELOW a hub page (an API connection, a data action) are detail pages
    if (!page || (SETTINGS_HUB.has(page) && rest.length === 0)) return 'settings';
    return SETTINGS_LISTS.has(page) && rest.length === 0 ? 'list' : 'detail';
  }
  return 'detail';
}

/** Inbox: bubbles and detail rows only when the URL already names a conversation. */
function InboxRouteSkeleton() {
  const hasConversation = Boolean(useSearchParams().get('c'));
  return <InboxSkeleton thread={hasConversation} />;
}

export default function RouteSkeleton() {
  const variant = skeletonVariant(usePathname());
  if (variant === 'inbox') {
    return (
      <Suspense fallback={<InboxSkeleton />}>
        <InboxRouteSkeleton />
      </Suspense>
    );
  }
  if (variant === 'list') return <ListSkeleton />;
  if (variant === 'settings') return <SettingsSkeleton />;
  return <DetailSkeleton />;
}
