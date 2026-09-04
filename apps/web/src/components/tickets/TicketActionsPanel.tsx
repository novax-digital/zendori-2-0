'use client';

import type { ConversationPriority } from '@zendori/core/tickets';
import { setTicketAssignee, setTicketPriority, setTicketStatus } from '@/app/tickets/actions';
import type { MemberOption } from '@/lib/inbox/types';
import {
  PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_ORDER,
  type TicketStatus,
} from '@/lib/tickets/labels';

// Status / priority / assignee of a ticket — uncontrolled selects keyed by the
// server value (realtime refreshes re-sync them), auto-submitting on change
// like the inbox sidebar's assignee select.

export default function TicketActionsPanel({
  orgId,
  ticketId,
  status,
  priority,
  assigneeId,
  members,
  disabled,
}: {
  orgId: string;
  ticketId: string;
  status: TicketStatus;
  priority: ConversationPriority;
  assigneeId: string | null;
  members: MemberOption[];
  disabled: boolean;
}) {
  const hidden = (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="ticketId" value={ticketId} />
    </>
  );
  const submitOnChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    event.currentTarget.form?.requestSubmit();
  };
  return (
    <div className="inbox-badges-row" style={{ flexWrap: 'wrap', gap: '1rem' }}>
      <form action={setTicketStatus}>
        {hidden}
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          <span className="hint">Status</span>
          <select key={status} name="status" defaultValue={status} disabled={disabled} onChange={submitOnChange}>
            {TICKET_STATUS_ORDER.map((value) => (
              <option key={value} value={value}>
                {TICKET_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </form>
      <form action={setTicketPriority}>
        {hidden}
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          <span className="hint">Priorität</span>
          <select key={priority} name="priority" defaultValue={priority} disabled={disabled} onChange={submitOnChange}>
            {(Object.keys(PRIORITY_LABELS) as ConversationPriority[]).map((value) => (
              <option key={value} value={value}>
                {PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </form>
      <form action={setTicketAssignee}>
        {hidden}
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          <span className="hint">Zuständig</span>
          <select
            key={assigneeId ?? 'none'}
            name="assigneeId"
            defaultValue={assigneeId ?? ''}
            disabled={disabled}
            onChange={submitOnChange}
          >
            <option value="">Niemand</option>
            {members.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.email ?? `${member.user_id.slice(0, 8)}…`}
              </option>
            ))}
          </select>
        </label>
      </form>
    </div>
  );
}
