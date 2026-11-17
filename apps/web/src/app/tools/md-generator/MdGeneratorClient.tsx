'use client';

// Client half of the MD generator: URL form → server action crawl → preview,
// .md download (client-side blob) and "in Wissensdatenbank übernehmen".
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { href } from '@/lib/href';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
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
    <div className="form-narrow">
      <Section
        title="Website in Markdown umwandeln"
        help="Der Generator lädt die Seite, auf Wunsch mit Unterseiten derselben Domain (höchstens 12), entfernt Navigation und Beiwerk und erzeugt eine saubere Markdown-Datei."
      >
        <div className="stack">
          <Field label="Website-URL" htmlFor="md-url" help="Auch eine sitemap.xml ist möglich.">
            <input
              id="md-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.beispiel.de"
              disabled={pending}
            />
          </Field>
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeSubpages}
              onChange={(e) => setIncludeSubpages(e.target.checked)}
              disabled={pending}
            />
            Unterseiten derselben Domain einbeziehen
          </label>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <div>
            <Button type="button" variant="primary" onClick={run} disabled={pending || !url.trim()}>
              {pending ? 'Erzeuge Markdown … (kann bis zu einer Minute dauern)' : 'Markdown erzeugen'}
            </Button>
          </div>
        </div>
      </Section>

      {result ? (
        <>
          <Section
            title={`Ergebnis: ${result.title}`}
            help={
              <>
                {result.pageCount} Seite{result.pageCount === 1 ? '' : 'n'} ·{' '}
                {new Intl.NumberFormat('de-DE').format(result.markdown.length)} Zeichen
                {result.skipped.length > 0
                  ? ` · ${result.skipped.length} übersprungen (Fehler oder Budget)`
                  : ''}
              </>
            }
            actions={
              <Button type="button" size="sm" onClick={download}>
                Als .md herunterladen
              </Button>
            }
          >
            <textarea
              readOnly
              value={result.markdown}
              rows={16}
              className="kb-md-preview"
              aria-label="Erzeugtes Markdown"
            />
          </Section>

          {canSave ? (
            <Section title="In Wissensdatenbank übernehmen">
              {kbs.length === 0 ? (
                <p className="muted small">
                  Noch keine Wissensdatenbank vorhanden.{' '}
                  <Link href={href('/settings/knowledge', { org: orgId, panel: 'new' })}>
                    Wissensdatenbank anlegen
                  </Link>
                </p>
              ) : (
                <form className="stack" action={saveMarkdownToKb}>
                  <input type="hidden" name="org" value={orgId} />
                  <input type="hidden" name="markdown" value={result.markdown} />
                  <Field label="Wissensdatenbank" htmlFor="md-kb">
                    <select id="md-kb" name="knowledgeBaseId" required defaultValue={kbs[0]?.id}>
                      {kbs.map((kb) => (
                        <option key={kb.id} value={kb.id}>
                          {kb.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Titel der Quelle" htmlFor="md-title">
                    <input
                      id="md-title"
                      name="title"
                      type="text"
                      required
                      minLength={2}
                      maxLength={150}
                      defaultValue={`Website: ${result.title}`}
                    />
                  </Field>
                  <div>
                    <Button type="submit">Übernehmen und indizieren</Button>
                  </div>
                </form>
              )}
            </Section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
