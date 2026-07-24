'use client';

// Client half of the MD generator: URL form → server action crawl → preview,
// .md download (client-side blob) and "in Wissensdatenbank übernehmen".
import { useState, useTransition } from 'react';
import { generateMarkdown, saveMarkdownToKb, type GenerateResult } from './actions';

export default function MdGeneratorClient({
  orgId,
  kbs,
  canSave,
}: {
  orgId: string;
  kbs: { id: string; name: string }[];
  canSave: boolean;
}) {
  const [url, setUrl] = useState('');
  const [includeSubpages, setIncludeSubpages] = useState(true);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Extract<GenerateResult, { ok: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await generateMarkdown(orgId, url, includeSubpages);
      if (res.ok) setResult(res);
      else setError(res.error);
    });
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${result.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'website'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="panel">
        <h2>Website → Markdown</h2>
        <p className="help">
          Trage eine Website-URL (oder direkt eine sitemap.xml) ein. Der Generator lädt die Seite —
          optional inklusive Unterseiten derselben Domain (max. 12) — entfernt Navigation und
          Beiwerk und erzeugt eine saubere Markdown-Datei: ideal als Wissensquelle.
        </p>
        <div className="stack" style={{ maxWidth: '32rem' }}>
          <div>
            <label htmlFor="md-url">Website-URL</label>
            <input
              id="md-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.strong-energy.eu"
              disabled={pending}
            />
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeSubpages}
              onChange={(e) => setIncludeSubpages(e.target.checked)}
              disabled={pending}
            />
            Unterseiten derselben Domain einbeziehen
          </label>
          <div>
            <button className="primary" type="button" onClick={run} disabled={pending || !url.trim()}>
              {pending ? 'Erzeuge Markdown… (kann bis zu einer Minute dauern)' : 'Markdown erzeugen'}
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </div>
      </div>

      {result ? (
        <>
          <div className="panel">
            <h2>Ergebnis: {result.title}</h2>
            <p className="help">
              {result.pageCount} Seite{result.pageCount === 1 ? '' : 'n'} ·{' '}
              {new Intl.NumberFormat('de-DE').format(result.markdown.length)} Zeichen
              {result.skipped.length > 0
                ? ` · ${result.skipped.length} übersprungen (Fehler/Budget)`
                : ''}
            </p>
            <textarea
              readOnly
              value={result.markdown}
              rows={16}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.8rem' }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button className="ghost" type="button" onClick={download}>
                Als .md herunterladen
              </button>
            </div>
          </div>

          {canSave ? (
            <div className="panel">
              <h2>In Wissensdatenbank übernehmen</h2>
              {kbs.length === 0 ? (
                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                  Noch keine Wissensdatenbank vorhanden — anlegen unter Einstellungen →
                  Wissensdatenbank.
                </p>
              ) : (
                <form className="stack" action={saveMarkdownToKb} style={{ maxWidth: '32rem' }}>
                  <input type="hidden" name="org" value={orgId} />
                  <input type="hidden" name="markdown" value={result.markdown} />
                  <div>
                    <label htmlFor="md-kb">Wissensdatenbank</label>
                    <select id="md-kb" name="knowledgeBaseId" required defaultValue={kbs[0]?.id}>
                      {kbs.map((kb) => (
                        <option key={kb.id} value={kb.id}>
                          {kb.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="md-title">Titel der Quelle</label>
                    <input
                      id="md-title"
                      name="title"
                      type="text"
                      required
                      minLength={2}
                      maxLength={150}
                      defaultValue={`Website: ${result.title}`}
                    />
                  </div>
                  <button className="primary" type="submit">
                    Übernehmen &amp; indizieren
                  </button>
                </form>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
