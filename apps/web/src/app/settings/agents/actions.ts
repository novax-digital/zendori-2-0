'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { agentKindSchema, agentModeSchema, type AgentKind, type AgentMode } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function agentsUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/agents?${params.toString()}`;
}

/**
 * Owner gate: agent identity/mode steer the bot and channel assignment changes
 * live behavior — owner-only (RLS enforces this for the agents table itself,
 * but channel assignment runs under the member-level channels policy, so the
 * explicit check here is load-bearing, same pattern as the voice settings).
 */
async function requireOwner(org: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org)
    .eq('user_id', user.id)
    .maybeSingle();
  if ((data as { role: string } | null)?.role !== 'owner') {
    redirect(agentsUrl(org, { error: 'Nur Inhaber können Agenten verwalten.' }));
  }
}

const agentFieldsSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(80),
  identity: z.string().max(8000),
  mode: agentModeSchema,
  confidenceThreshold: z.coerce.number().min(0).max(1),
});

function parseAgentFields(formData: FormData) {
  return agentFieldsSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
    identity: textField(formData.get('identity')),
    mode: textField(formData.get('mode')),
    // Voice agents post no threshold field (hidden in the UI) — default applies.
    confidenceThreshold: textField(formData.get('confidenceThreshold')) || '0.7',
  });
}

/** 0015: voice agents know only intake_only|autopilot (no drafts on a live call). */
function modeAllowedForKind(kind: AgentKind, mode: AgentMode): boolean {
  return kind === 'voice' ? mode === 'intake_only' || mode === 'autopilot' : true;
}

// --- create ------------------------------------------------------------------

export async function createAgent(formData: FormData): Promise<void> {
  const parsed = parseAgentFields(formData);
  const kindParsed = agentKindSchema.safeParse(textField(formData.get('kind')) || 'text');
  if (!parsed.success || !kindParsed.success) {
    redirect(
      agentsUrl(textField(formData.get('org')), {
        error: 'Bitte Name (2–80 Zeichen), Typ, Modus und Schwellwert (0–1) prüfen.',
      })
    );
  }
  const { org, name, identity, mode, confidenceThreshold } = parsed.data;
  const kind = kindParsed.data;
  if (!modeAllowedForKind(kind, mode)) {
    redirect(
      agentsUrl(org, {
        error: 'Voice-Agenten kennen nur „Reine Annahme" und „Autopilot".',
      })
    );
  }
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  const { data: created, error } = await supabase
    .from('agents')
    .insert({
      org_id: org,
      name,
      identity: identity === '' ? null : identity,
      kind,
      mode,
      confidence_threshold: confidenceThreshold,
    })
    .select('id')
    .single();
  if (error || !created) {
    redirect(agentsUrl(org, { error: 'Agent konnte nicht angelegt werden.' }));
  }

  // Default: link ALL current knowledge bases (least surprise — matches the
  // pre-0012 behavior where every agent searched everything; owner can unlink).
  const { data: kbData, error: kbLoadError } = await supabase
    .from('knowledge_bases')
    .select('id')
    .eq('org_id', org);
  const kbIds = ((kbData ?? []) as { id: string }[]).map((r) => r.id);
  let linkError: unknown = kbLoadError;
  if (!linkError && kbIds.length > 0) {
    const { error } = await supabase.from('agent_knowledge_bases').insert(
      kbIds.map((kbId) => ({
        org_id: org,
        agent_id: (created as { id: string }).id,
        knowledge_base_id: kbId,
      }))
    );
    linkError = error;
  }
  if (linkError) {
    // The agent exists but has no knowledge — say so instead of faking success
    // (per []-semantics it would silently answer nothing).
    redirect(
      agentsUrl(org, {
        error: `Agent „${name}" angelegt, aber Wissensdatenbanken konnten nicht verknüpft werden — bitte im Agenten manuell anhaken.`,
      })
    );
  }

  revalidatePath('/settings/agents');
  redirect(agentsUrl(org, { notice: `Agent „${name}" angelegt.` }));
}

// --- update (fields + channel assignments) --------------------------------------

export async function updateAgent(formData: FormData): Promise<void> {
  const idParsed = z.uuid().safeParse(formData.get('agentId'));
  const parsed = parseAgentFields(formData);
  if (!idParsed.success || !parsed.success) {
    redirect(
      agentsUrl(textField(formData.get('org')), {
        error: 'Bitte Name (2–80 Zeichen), Modus und Schwellwert (0–1) prüfen.',
      })
    );
  }
  const agentId = idParsed.data;
  const { org, name, identity, mode, confidenceThreshold } = parsed.data;
  const isActive = formData.get('isActive') != null;
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();

  // kind is immutable (0015 DB guard) — load it to validate the posted mode.
  const { data: kindRow } = await supabase
    .from('agents')
    .select('kind')
    .eq('org_id', org)
    .eq('id', agentId)
    .maybeSingle();
  const kind = ((kindRow as { kind?: AgentKind } | null)?.kind ?? 'text') as AgentKind;
  if (!modeAllowedForKind(kind, mode)) {
    redirect(
      agentsUrl(org, { error: 'Voice-Agenten kennen nur „Reine Annahme" und „Autopilot".' })
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from('agents')
    .update({
      name,
      identity: identity === '' ? null : identity,
      mode,
      confidence_threshold: confidenceThreshold,
      is_active: isActive,
    })
    .eq('org_id', org)
    .eq('id', agentId)
    .select('id');
  if (updateError || !updated || updated.length === 0) {
    redirect(agentsUrl(org, { error: 'Agent konnte nicht gespeichert werden.' }));
  }

  // Channel assignments: checked channels point to this agent. Detaching is
  // scoped to boxes the form actually RENDERED as assigned — an assignment made
  // elsewhere after render (other tab, channels page) must not be silently
  // reverted by a stale checklist.
  const uuidStrings = (values: FormDataEntryValue[]) =>
    values.filter((v): v is string => typeof v === 'string' && z.uuid().safeParse(v).success);
  const selected = new Set(uuidStrings(formData.getAll('channels')));
  const renderedAssigned = new Set(uuidStrings(formData.getAll('renderedAssigned')));
  const { data: channelData, error: channelLoadError } = await supabase
    .from('channels')
    .select('id, agent_id, type')
    .eq('org_id', org);
  if (channelLoadError) {
    redirect(agentsUrl(org, { error: 'Kanal-Zuweisung konnte nicht gespeichert werden.' }));
  }
  const channels = (channelData ?? []) as { id: string; agent_id: string | null; type: string }[];
  // Kind gate (0015): a stale checklist may post channels the agent cannot
  // serve — filter them here so one bad box does not fail the whole batch (the
  // DB trigger would reject the update outright).
  const kindMatches = (type: string): boolean =>
    kind === 'voice' ? type === 'voice' : type !== 'voice';
  const toAssign = channels.filter(
    (c) => selected.has(c.id) && c.agent_id !== agentId && kindMatches(c.type)
  );
  const toDetach = channels.filter(
    (c) => c.agent_id === agentId && !selected.has(c.id) && renderedAssigned.has(c.id)
  );

  if (toAssign.length > 0) {
    const { error } = await supabase
      .from('channels')
      .update({ agent_id: agentId })
      .eq('org_id', org)
      .in(
        'id',
        toAssign.map((c) => c.id)
      );
    if (error) {
      redirect(agentsUrl(org, { error: 'Kanal-Zuweisung konnte nicht gespeichert werden.' }));
    }
  }
  if (toDetach.length > 0) {
    const { error } = await supabase
      .from('channels')
      .update({ agent_id: null })
      .eq('org_id', org)
      .in(
        'id',
        toDetach.map((c) => c.id)
      );
    if (error) {
      redirect(agentsUrl(org, { error: 'Kanal-Zuweisung konnte nicht gespeichert werden.' }));
    }
  }

  // Knowledge-base links (0012): same render-scoped semantics as channels —
  // only unlink bases the form actually showed as linked.
  const selectedKbs = new Set(uuidStrings(formData.getAll('kbs')));
  const renderedLinkedKbs = new Set(uuidStrings(formData.getAll('renderedLinkedKbs')));
  const { data: linkData, error: linkLoadError } = await supabase
    .from('agent_knowledge_bases')
    .select('knowledge_base_id')
    .eq('org_id', org)
    .eq('agent_id', agentId);
  if (linkLoadError) {
    redirect(agentsUrl(org, { error: 'Wissensdatenbank-Verknüpfung konnte nicht gespeichert werden.' }));
  }
  const linked = new Set(
    ((linkData ?? []) as { knowledge_base_id: string }[]).map((r) => r.knowledge_base_id)
  );
  // Stale checkbox for a meanwhile-deleted base must not fail the whole batch:
  // only link bases that still exist (mirrors the channels handling).
  const { data: kbRows } = await supabase.from('knowledge_bases').select('id').eq('org_id', org);
  const existingKbs = new Set(((kbRows ?? []) as { id: string }[]).map((r) => r.id));
  const kbsToLink = [...selectedKbs].filter((id) => existingKbs.has(id) && !linked.has(id));
  const kbsToUnlink = [...linked].filter(
    (id) => !selectedKbs.has(id) && renderedLinkedKbs.has(id)
  );
  if (kbsToLink.length > 0) {
    const { error } = await supabase.from('agent_knowledge_bases').insert(
      kbsToLink.map((kbId) => ({ org_id: org, agent_id: agentId, knowledge_base_id: kbId }))
    );
    if (error) {
      redirect(
        agentsUrl(org, { error: 'Wissensdatenbank-Verknüpfung konnte nicht gespeichert werden.' })
      );
    }
  }
  if (kbsToUnlink.length > 0) {
    const { error } = await supabase
      .from('agent_knowledge_bases')
      .delete()
      .eq('org_id', org)
      .eq('agent_id', agentId)
      .in('knowledge_base_id', kbsToUnlink);
    if (error) {
      redirect(
        agentsUrl(org, { error: 'Wissensdatenbank-Verknüpfung konnte nicht gespeichert werden.' })
      );
    }
  }

  revalidatePath('/settings/agents');
  revalidatePath('/settings/channels');
  revalidatePath('/settings/knowledge');
  redirect(agentsUrl(org, { notice: 'Agent gespeichert.' }));
}

// --- delete ------------------------------------------------------------------

const deleteAgentSchema = z.object({ org: z.uuid(), agentId: z.uuid() });

export async function deleteAgent(formData: FormData): Promise<void> {
  const parsed = deleteAgentSchema.safeParse({
    org: formData.get('org'),
    agentId: formData.get('agentId'),
  });
  if (!parsed.success) {
    redirect(agentsUrl(textField(formData.get('org')), { error: 'Agent wurde nicht gefunden.' }));
  }
  const { org, agentId } = parsed.data;
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  // FK channels_agent_same_org detaches assigned channels (agent_id → null).
  const { data, error } = await supabase
    .from('agents')
    .delete()
    .eq('org_id', org)
    .eq('id', agentId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(agentsUrl(org, { error: 'Agent konnte nicht gelöscht werden.' }));
  }

  revalidatePath('/settings/agents');
  revalidatePath('/settings/channels');
  redirect(agentsUrl(org, { notice: 'Agent gelöscht. Zugewiesene Kanäle sind jetzt ohne Agent.' }));
}
