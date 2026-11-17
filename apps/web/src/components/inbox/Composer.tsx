'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { sendReply } from '@/app/inbox/actions';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import type { CannedResponseItem } from '@/lib/inbox/types';

function SendButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={disabled || pending}>
      {pending ? 'Senden…' : 'Senden'}
    </Button>
  );
}

type ComposerProps = {
  orgId: string;
  conversationId: string;
  filterStatus: string;
  filterChannel: string;
  filterQ: string;
  cannedResponses: CannedResponseItem[];
};

/** Reply box at the bottom of the thread: one outlined box with the text and
 *  its bar (canned responses left, "Senden" right). Styles: app/styles/inbox.css. */
export default function Composer({
  orgId,
  conversationId,
  filterStatus,
  filterChannel,
  filterQ,
  cannedResponses,
}: ComposerProps) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(formData: FormData): Promise<void> {
    const result = await sendReply(formData);
    if (result?.error) {
      // keep the draft so the agent can retry
      setError(result.error);
      return;
    }
    setContent('');
    setError(null);
  }

  return (
    <form className="inbox-composer" action={submit}>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="filterStatus" value={filterStatus} />
      <input type="hidden" name="filterChannel" value={filterChannel} />
      <input type="hidden" name="filterQ" value={filterQ} />
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <div className="inbox-composer-box">
        <textarea
          name="content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Antwort schreiben …"
          aria-label="Antwort schreiben"
          rows={3}
          required
        />
        <div className="inbox-composer-bar">
          {cannedResponses.length > 0 ? (
            <select
              className="inbox-canned"
              value=""
              aria-label="Textbaustein einfügen"
              onChange={(event) => {
                const canned = cannedResponses.find((item) => item.id === event.target.value);
                if (canned) setContent(canned.content);
              }}
            >
              <option value="" disabled>
                Textbaustein einfügen …
              </option>
              {cannedResponses.map((item) => (
                <option key={item.id} value={item.id}>
                  /{item.shortcut}
                </option>
              ))}
            </select>
          ) : null}
          <SendButton disabled={content.trim().length === 0} />
        </div>
      </div>
    </form>
  );
}
