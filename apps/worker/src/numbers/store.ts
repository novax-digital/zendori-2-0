import type { SupabaseClient } from '@zendori/core';
import {
  ProvisionError,
  type ProvisionRowPatch,
  type ProvisionStore,
  type VoiceChannelRecord,
} from './provision.js';

// Supabase-backed ProvisionStore (service role — operator-level writes on
// phone_numbers/channels across orgs; org_id is always passed explicitly).

type ChannelRow = { id: string; name: string; is_active: boolean; config: unknown };

function toChannel(row: ChannelRow): VoiceChannelRecord {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    config:
      row.config && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {},
  };
}

function dbError(what: string, error: { message: string }): Error {
  return new Error(`${what}: ${error.message}`);
}

export function createSupabaseProvisionStore(supabase: SupabaseClient): ProvisionStore {
  return {
    async voiceQuota(orgId) {
      const [limitRes, countRes] = await Promise.all([
        supabase
          .from('org_channel_limits')
          .select('max_count')
          .eq('org_id', orgId)
          .eq('channel_kind', 'voice')
          .maybeSingle(),
        supabase
          .from('channels')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('type', 'voice'),
      ]);
      if (limitRes.error) throw dbError('Kontingent lesen', limitRes.error);
      if (countRes.error) throw dbError('Voice-Kanäle zählen', countRes.error);
      const limit = (limitRes.data as { max_count: number | null } | null)?.max_count ?? null;
      return { limit, count: countRes.count ?? 0 };
    },

    async orgName(orgId) {
      const { data, error } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', orgId)
        .maybeSingle();
      if (error) throw dbError('Organisation lesen', error);
      return (data as { name: string } | null)?.name ?? null;
    },

    async updateRow(id, patch: ProvisionRowPatch) {
      const { error } = await supabase.from('phone_numbers').update(patch).eq('id', id);
      if (error) throw dbError('Nummern-Eintrag speichern', error);
    },

    async findVoiceChannelByNumber(orgId, e164) {
      const { data, error } = await supabase
        .from('channels')
        .select('id, name, is_active, config')
        .eq('org_id', orgId)
        .eq('type', 'voice')
        .eq('config->>phoneNumber', e164)
        .limit(1)
        .maybeSingle();
      if (error) throw dbError('Voice-Kanal suchen', error);
      return data ? toChannel(data as ChannelRow) : null;
    },

    async getChannel(id) {
      const { data, error } = await supabase
        .from('channels')
        .select('id, name, is_active, config')
        .eq('id', id)
        .maybeSingle();
      if (error) throw dbError('Voice-Kanal lesen', error);
      return data ? toChannel(data as ChannelRow) : null;
    },

    async insertChannel(orgId, name, config) {
      const { data, error } = await supabase
        .from('channels')
        .insert({ org_id: orgId, type: 'voice', name, is_active: false, config })
        .select('id')
        .single();
      if (error || !data) {
        // 0017 BEFORE-INSERT quota trigger (raised after the purchase on a resume)
        if (error && /channel limit reached/i.test(error.message)) {
          throw new ProvisionError(
            'Voice-Kanal-Kontingent des Kunden erreicht – in Admin → Kunde erhöhen, dann „Erneut versuchen" (die Nummer ist bereits gekauft und wird wiederverwendet).'
          );
        }
        throw dbError('Voice-Kanal anlegen', error ?? { message: 'keine Zeile' });
      }
      return (data as { id: string }).id;
    },

    async activateChannel(id, config) {
      const { error } = await supabase
        .from('channels')
        .update({ config, is_active: true })
        .eq('id', id);
      if (error) throw dbError('Voice-Kanal aktivieren', error);
    },
  };
}
