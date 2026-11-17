// Every Plattform page reads across organisations through the service role.
// Without it there is nothing to show — one shared fallback for all of them.
import Callout from '@/components/ui/Callout';
import PageHeader from '@/components/ui/PageHeader';

export default function AdminUnavailable({ title }: { title: string }) {
  return (
    <div className="page">
      <PageHeader title={title} />
      <div className="page-body">
        <Callout tone="danger">Service-Role ist serverseitig nicht konfiguriert.</Callout>
      </div>
    </div>
  );
}
