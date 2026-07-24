// Shown to Mitarbeiter without view permission for an area (0024). Server
// component — page-level guard, the matching server actions enforce edit rights
// independently.
export default function NoAccessPanel({ title }: { title: string }) {
  return (
    <div className="shell">
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <div className="panel">
        <h2>Kein Zugriff</h2>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Dieser Bereich ist für dein Konto nicht freigeschaltet. Wende dich an einen Admin deiner
          Organisation, wenn du Zugriff benötigst.
        </p>
      </div>
    </div>
  );
}
