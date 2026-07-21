import { requireActiveOrg } from '@/lib/org';
import { listCannedResponses } from '@/lib/inbox/queries';
import { deleteCannedResponse, saveCannedResponse } from '@/app/inbox/actions';


export default async function CannedResponsesPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const responses = await listCannedResponses(orgId);

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Textbausteine</h1>
        <p>
          Wiederverwendbare Antworten von {orgName} — sie stehen beim Antworten in der Inbox zur
          Auswahl.
        </p>
      </div>

      {error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {notice}
        </p>
      ) : null}

      <div className="panel">
        <h2>Deine Textbausteine</h2>
        {responses.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine Textbausteine vorhanden. Lege unten den ersten an — Textbausteine stehen beim
            Antworten in der Inbox zur Auswahl.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kürzel</th>
                <th>Text</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {responses.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>/{r.shortcut}</code>
                  </td>
                  <td style={{ whiteSpace: 'pre-wrap' }}>{r.content}</td>
                  <td style={{ textAlign: 'right' }}>
                    <form action={deleteCannedResponse}>
                      <input type="hidden" name="org" value={orgId} />
                      <input type="hidden" name="id" value={r.id} />
                      <button className="ghost" type="submit">
                        Löschen
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Textbaustein anlegen oder aktualisieren</h2>
        <form className="stack" action={saveCannedResponse} style={{ maxWidth: '32rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <div>
            <label htmlFor="shortcut">Kürzel</label>
            <input
              id="shortcut"
              name="shortcut"
              type="text"
              required
              pattern="[a-z0-9-]{2,30}"
              placeholder="z. B. begruessung"
            />
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              Nur Kleinbuchstaben, Ziffern und Bindestriche (2–30 Zeichen). Ein bestehendes Kürzel
              wird überschrieben.
            </p>
          </div>
          <div>
            <label htmlFor="content">Text</label>
            <textarea id="content" name="content" rows={4} required />
          </div>
          <button className="primary" type="submit">
            Textbaustein speichern
          </button>
        </form>
      </div>
    </div>
  );
}
