'use client';

import { useState } from 'react';
import { formatTicketId, validateTicketIdFormat } from '@zendori/core/tickets';

// Live preview for org_settings.ticket_id_format (Einstellungen → Tickets).
// Imports the client-safe core subpath only.

export default function TicketIdFormatField({
  defaultFormat,
  nextNumber,
  disabled,
}: {
  defaultFormat: string;
  nextNumber: number;
  disabled: boolean;
}) {
  const [format, setFormat] = useState(defaultFormat);
  const check = validateTicketIdFormat(format);
  return (
    <div className="field field--short">
      <label htmlFor="ticket-id-format">Format der Ticket-ID</label>
      <input
        id="ticket-id-format"
        name="ticketIdFormat"
        type="text"
        value={format}
        maxLength={40}
        disabled={disabled}
        aria-invalid={check.ok ? undefined : true}
        aria-describedby="ticket-id-format-status ticket-id-format-help"
        onChange={(e) => setFormat(e.target.value)}
      />
      {check.ok ? (
        <p id="ticket-id-format-status" className="field-help">
          Nächstes Ticket:{' '}
          <strong className="mono">{formatTicketId(check.format, nextNumber)}</strong>
        </p>
      ) : (
        <p id="ticket-id-format-status" className="field-error" role="alert">
          {check.error}
        </p>
      )}
      <p id="ticket-id-format-help" className="field-help">
        Platzhalter: <code>{'{N}'}</code> laufende Nummer, <code>{'{NNNN}'}</code> mit führenden
        Nullen, <code>{'{YYYY}'}</code> oder <code>{'{YY}'}</code> Jahr. Beispiele:{' '}
        <code>{'#{N}'}</code>, <code>{'ZD-{YYYY}-{NNNN}'}</code>. Gilt nur für neue Tickets —
        vergebene Nummern bleiben unverändert.
      </p>
    </div>
  );
}
