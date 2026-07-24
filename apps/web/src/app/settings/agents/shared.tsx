// Shared pieces of the two-level agents UI (list + detail, owner 2026-07-24).
import type { AgentKind, AgentMode, ChannelType } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import AgentBehaviorFields from '@/components/AgentBehaviorFields';

export type AgentRow = {
  id: string;
  name: string;
  identity: string | null;
  kind: AgentKind;
  mode: AgentMode;
  confidence_threshold: number;
  is_active: boolean;
  handoff_enabled: boolean;
};

export const MODE_LABELS: Record<AgentMode, string> = {
  draft_only: 'Nur Entwürfe',
  autopilot: 'Autopilot',
  intake_only: 'Reine Annahme',
};

export const channelTypeLabels: Record<ChannelType, string> = {
  chat: 'Chat',
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  voice: 'Telefon',
};

export async function listAgents(orgId: string): Promise<AgentRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('agents')
    .select('id, name, identity, kind, mode, confidence_threshold, is_active, handoff_enabled')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  return (data ?? []) as unknown as AgentRow[];
}

export async function loadKbs(orgId: string): Promise<{ id: string; name: string }[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('knowledge_bases')
    .select('id, name')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  return (data ?? []) as { id: string; name: string }[];
}

export async function loadKbLinks(
  orgId: string
): Promise<{ agent_id: string; knowledge_base_id: string }[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('agent_knowledge_bases')
    .select('agent_id, knowledge_base_id')
    .eq('org_id', orgId);
  return (data ?? []) as { agent_id: string; knowledge_base_id: string }[];
}

/** An answering agent (not intake_only) without a linked KB retrieves nothing (C33). */
export function agentLacksKb(
  agent: Pick<AgentRow, 'mode'>,
  kbCount: number,
  linkedCount: number
): boolean {
  return agent.mode !== 'intake_only' && kbCount > 0 && linkedCount === 0;
}

/** Shared field block for the create form (the detail page renders its own tabs). */
export function AgentFields({
  idPrefix,
  agent,
  disabled,
}: {
  idPrefix: string;
  agent?: AgentRow;
  disabled: boolean;
}) {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          type="text"
          required
          minLength={2}
          maxLength={80}
          defaultValue={agent?.name ?? ''}
          disabled={disabled}
          placeholder="z. B. Chat-Agent, Telefon-Annahme"
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-identity`}>Identität (System-Prompt)</label>
        <textarea
          id={`${idPrefix}-identity`}
          name="identity"
          rows={7}
          maxLength={8000}
          defaultValue={agent?.identity ?? ''}
          disabled={disabled}
          placeholder={
            'Wer ist dieser Agent, wie spricht er, was darf er (nicht)?\nz. B. „Du bist Lisa, die freundliche Support-Assistentin von Strong Energy. Du duzt Kunden, hältst dich kurz und verweist bei Vertragsfragen immer an das Team."'
          }
        />
        <p className="hint">Fließt in jede Antwort dieses Agenten ein — Rolle, Tonfall, Regeln.</p>
      </div>
      {/* kind/mode/threshold interplay lives in the client component (0015) */}
      <AgentBehaviorFields
        idPrefix={idPrefix}
        kindFixed={agent?.kind}
        defaultMode={agent?.mode}
        defaultThreshold={agent?.confidence_threshold}
        defaultHandoffEnabled={agent?.handoff_enabled}
        disabled={disabled}
      />
    </>
  );
}
