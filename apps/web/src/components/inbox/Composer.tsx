'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { sendReply } from '@/app/inbox/actions';
import type { CannedResponseItem } from '@/lib/inbox/types';

function SendButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="primary" type="submit" disabled={disabled || pending}>
      {pending ? 'Senden…' : 'Senden'}
    </button>
  );
}

type ComposerProps = {
  orgId: string;
  conversationId: string;
  filterStatus: string;
  filterChannel: string;
  cannedResponses: CannedResponseItem[];
};

export default function Composer({
  orgId,
  conversationId,
  filterStatus,
  filterChannel,
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
      {error ? <p className="error">{error}</p> : null}
      {cannedResponses.length > 0 ? (
        <select
          className="inbox-canned-select"
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
      <textarea
        name="content"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Antwort schreiben …"
        rows={3}
        required
      />
      <div className="inbox-composer-row">
        <SendButton disabled={content.trim().length === 0} />
      </div>
    </form>
  );
}
