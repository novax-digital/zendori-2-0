'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { autoAckTextsSchema, businessHoursSchema } from '@zendori/channels';
import { createSupabaseServerClient } from '@/lib/supabase/server';

// Weekday keys as expected by businessHoursSchema.hours (missing day = closed).
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
// Autopilot is stored per channel type as a jsonb object of booleans.
const CHANNEL_TYPES = ['chat', 'email', 'whatsapp', 'voice'] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A checkbox is present in FormData only when checked. */
function isChecked(formData: FormData, name: string): boolean {
  return formData.get(name) != null;
}

function aiSettingsUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/ai?${params.toString()}`;
}

/**
 * Persists the org-wide AI/autopilot settings. The RLS policy
 * `org_settings_update` restricts writes to owners — the update simply affects
 * zero rows for non-owners, which we surface as an owner hint. Never logs any
 * field values (§7).
 */
export async function saveAiSettings(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  if (!z.uuid().safeParse(org).success) {
    redirect('/settings/ai');
  }

  // confidence threshold (0..1) — reject an empty value instead of coercing to 0
  const confidenceRaw = textField(formData.get('confidence_threshold'));
  if (confidenceRaw === '') {
    redirect(aiSettingsUrl(org, { error: 'Bitte einen Schwellwert zwischen 0 und 1 angeben.' }));
  }
  const confidenceParsed = z.coerce.number().min(0).max(1).safeParse(confidenceRaw);
  if (!confidenceParsed.success) {
    redirect(aiSettingsUrl(org, { error: 'Bitte einen Schwellwert zwischen 0 und 1 angeben.' }));
  }
  const confidenceThreshold = confidenceParsed.data;

  // autopilot per channel type → { chat, email, whatsapp, voice }
  const autopilot: Record<string, boolean> = {};
  for (const type of CHANNEL_TYPES) {
    autopilot[type] = isChecked(formData, `autopilot_${type}`);
  }

  // tone instructions (optional free text)
  const toneRaw = textField(formData.get('tone_instructions'));
  const toneParsed = z.string().max(4000).safeParse(toneRaw);
  if (!toneParsed.success) {
    redirect(aiSettingsUrl(org, { error: 'Die Ton-Vorgaben sind zu lang (max. 4000 Zeichen).' }));
  }
  const toneInstructions = toneParsed.data === '' ? null : toneParsed.data;

  // escalation keywords: comma list → normalized (lowercased, deduped) text[]
  const keywords = Array.from(
    new Set(
      textField(formData.get('escalation_keywords'))
        .split(',')
        .map((keyword) => keyword.trim().toLowerCase())
        .filter((keyword) => keyword.length > 0)
    )
  );
  const keywordsParsed = z.array(z.string().min(1).max(100)).max(50).safeParse(keywords);
  if (!keywordsParsed.success) {
    redirect(
      aiSettingsUrl(org, {
        error: 'Bitte höchstens 50 Eskalations-Keywords mit je maximal 100 Zeichen angeben.',
      })
    );
  }

  // business hours: timezone + per weekday open/close (missing day = closed)
  const timezone = textField(formData.get('timezone')) || 'Europe/Berlin';
  const hours: Record<string, { open: string; close: string }> = {};
  for (const day of WEEKDAYS) {
    if (!isChecked(formData, `bh_${day}_enabled`)) continue;
    const open = textField(formData.get(`bh_${day}_open`));
    const close = textField(formData.get(`bh_${day}_close`));
    if (!TIME_RE.test(open) || !TIME_RE.test(close)) {
      redirect(
        aiSettingsUrl(org, {
          error: 'Bitte für geöffnete Tage gültige Uhrzeiten (HH:MM) angeben.',
        })
      );
    }
    hours[day] = { open, close };
  }
  const businessHoursParsed = businessHoursSchema.safeParse({ timezone, hours });
  if (!businessHoursParsed.success) {
    redirect(aiSettingsUrl(org, { error: 'Die Geschäftszeiten sind ungültig.' }));
  }

  // auto-ack texts: structural check first, then require both texts when enabled
  const autoAckParsed = autoAckTextsSchema.safeParse({
    enabled: isChecked(formData, 'ack_enabled'),
    in_hours: textField(formData.get('ack_in_hours')),
    out_of_hours: textField(formData.get('ack_out_of_hours')),
  });
  if (!autoAckParsed.success) {
    redirect(aiSettingsUrl(org, { error: 'Die Auto-Ack-Texte sind ungültig.' }));
  }
  const autoAck = autoAckParsed.data;
  if (autoAck.enabled && (autoAck.in_hours === '' || autoAck.out_of_hours === '')) {
    redirect(
      aiSettingsUrl(org, {
        error:
          'Bitte beide Auto-Ack-Texte (innerhalb und außerhalb der Geschäftszeiten) angeben, wenn die automatische Eingangsbestätigung aktiv ist.',
      })
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('org_settings')
    .update({
      confidence_threshold: confidenceThreshold,
      autopilot_enabled: autopilot,
      tone_instructions: toneInstructions,
      escalation_keywords: keywordsParsed.data,
      business_hours: businessHoursParsed.data,
      auto_ack_texts: autoAck,
    })
    .eq('org_id', org)
    .select('org_id');

  if (error) {
    redirect(aiSettingsUrl(org, { error: 'Einstellungen konnten nicht gespeichert werden.' }));
  }
  if (!data || data.length === 0) {
    // RLS blocked the write (non-owner) or the row is missing
    redirect(aiSettingsUrl(org, { error: 'Nur Owner dürfen die KI-Einstellungen ändern.' }));
  }

  revalidatePath('/settings/ai');
  redirect(aiSettingsUrl(org, { notice: 'KI-Einstellungen gespeichert.' }));
}
