// Shown to Mitarbeiter without view permission for an area (0024). Server
// component — page-level guard, the matching server actions enforce edit rights
// independently.
import { EmptyState } from './ui/Layout';
import PageHeader from './ui/PageHeader';

export default function NoAccessPanel({ title }: { title: string }) {
  return (
    <div className="page">
      <PageHeader title={title} />
      <div className="page-body">
        <EmptyState
          title="Kein Zugriff"
          text="Dieser Bereich ist für dein Konto nicht freigeschaltet. Wende dich an einen Admin deiner Organisation, wenn du Zugriff benötigst."
        />
      </div>
    </div>
  );
}
