// Loading state of this route segment's pages: Next shows it at once on
// navigation (and prefetches it), until the page has its data. One shared
// component picks the skeleton's shape from the target path.
import RouteSkeleton from '@/components/RouteSkeleton';

export default function Loading() {
  return <RouteSkeleton />;
}
