'use client';

// Create an API key and show it ONCE (Phase 13d). The key comes back from the
// server action as a return value — never through a redirect URL — and lives
// only in this component's state until the page is left.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { createApiKey } from '@/app/settings/integrations/api/actions';

export default function ApiKeyCreator({
  orgId,
  connectionId,
}: {
  orgId: string;
  connectionId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const result = await createApiKey(orgId, connectionId, name);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setCreated(result.key);
      setName('');
      // the list below is server-rendered — reload it to show the new key
      router.refresh();
    } catch {
      setError('Schlüssel konnte nicht angelegt werden.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="stack">
      {created ? (
        <Callout tone="success" title="Schlüssel angelegt — jetzt kopieren">
          <div className="stack stack--sm">
            <span>
              Der Schlüssel wird nur dieses eine Mal angezeigt. Zendori speichert ihn nicht im
              Klartext; geht er verloren, lege einen neuen an.
            </span>
            <code className="code-block">{created}</code>
            <div className="row">
              <Button type="button" size="sm" icon="copy" onClick={() => void copy()}>
                {copied ? 'Kopiert' : 'Kopieren'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setCreated(null)}>
                Ausblenden
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}

      {error ? <Callout tone="danger">{error}</Callout> : null}

      <div className="row row--top">
        <div className="field grow">
          <label htmlFor="api-key-name">Name des neuen Schlüssels</label>
          <input
            id="api-key-name"
            type="text"
            value={name}
            maxLength={80}
            placeholder="z. B. ERP Produktion"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </div>
      <div>
        <Button
          type="button"
          variant="primary"
          icon="plus"
          disabled={busy || name.trim().length < 2}
          onClick={() => void submit()}
        >
          {busy ? 'Wird angelegt …' : 'Schlüssel anlegen'}
        </Button>
      </div>
    </div>
  );
}
