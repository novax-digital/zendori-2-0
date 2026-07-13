import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@zendori/core';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import {
  findWidgetChannelByToken,
  generateSessionSecret,
  hashSecret,
  verifySession,
  WidgetDbError,
} from '@/lib/widget/session';

const bodySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32}$/),
  // shape is validated separately below: only requests WITHOUT a resume field
  // create a fresh session, so a malformed resume must count as invalid
  // (→ expired) rather than as "no resume"
  resume: z.unknown().optional(),
});

const resumeSchema = z.object({
  conversationId: z.uuid(),
  secret: z.string().regex(/^[0-9a-f]{48}$/),
});

type HistoryMessage = {
  id: string;
  content: string;
  content_type: string;
  sender_type: string;
  created_at: string;
};

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

function serviceUnavailable(): NextResponse {
  return json(
    { error: 'Dienst vorübergehend nicht verfügbar. Bitte versuchen Sie es gleich erneut.' },
    503
  );
}

/** Last 100 text messages of the conversation, chronological. */
async function loadHistory(
  admin: SupabaseClient,
  conversationId: string
): Promise<HistoryMessage[]> {
  const { data } = await admin
    .from('messages')
    .select('id, content, content_type, sender_type, created_at')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'text')
    .order('created_at', { ascending: false })
    .limit(100);
  return ((data ?? []) as HistoryMessage[]).reverse();
}

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(request: Request): Promise<NextResponse> {
  const allowed = await checkRateLimit('widget-session-ip', clientIp(request));
  if (!allowed) {
    return json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es gleich erneut.' }, 429);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  const { token, resume: rawResume } = parsed.data;

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return serviceUnavailable();
  }
  if (!admin) {
    return serviceUnavailable();
  }

  let channel;
  try {
    channel = await findWidgetChannelByToken(admin, token);
  } catch (error) {
    if (error instanceof WidgetDbError) return serviceUnavailable();
    throw error;
  }
  if (!channel) {
    return json({ error: 'Widget wurde nicht gefunden.' }, 404);
  }

  // --- resume: validate the full chain (secret hash + session belongs to this channel).
  // A resume request NEVER creates a fresh session — an invalid one gets
  // { expired: true } and the widget starts over as a first-time visitor.
  if (rawResume !== undefined) {
    const resumeParsed = resumeSchema.safeParse(rawResume);
    if (!resumeParsed.success) {
      return json({ expired: true }, 200);
    }
    const resume = resumeParsed.data;
    let verified;
    try {
      verified = await verifySession(admin, resume.conversationId, resume.secret);
    } catch (error) {
      if (error instanceof WidgetDbError) return serviceUnavailable();
      throw error;
    }
    if (!verified || verified.session.channel_id !== channel.id) {
      // session gone or wrong secret — never reveal which
      return json({ expired: true }, 200);
    }
    const { data: touched, error: touchError } = await admin
      .from('widget_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', verified.session.id)
      .eq('org_id', channel.org_id)
      .select('broadcast_topic')
      .maybeSingle();
    if (touchError) {
      return serviceUnavailable();
    }
    const topic = (touched as { broadcast_topic: string } | null)?.broadcast_topic;
    if (!topic) {
      return json({ expired: true }, 200);
    }
    const messages = await loadHistory(admin, verified.session.conversation_id);
    // never echo the plaintext secret back — the widget keeps its stored one
    return json(
      {
        conversationId: verified.session.conversation_id,
        secret: '',
        topic,
        messages,
      },
      200
    );
  }

  // --- new session: contact → conversation → widget_session
  const { data: contactRow, error: contactError } = await admin
    .from('contacts')
    .insert({ org_id: channel.org_id, name: null, email: null })
    .select('id')
    .single();
  if (contactError || !contactRow) {
    return json({ error: 'Sitzung konnte nicht erstellt werden.' }, 500);
  }
  const contactId = (contactRow as { id: string }).id;

  const { data: conversationRow, error: conversationError } = await admin
    .from('conversations')
    .insert({
      org_id: channel.org_id,
      channel_id: channel.id,
      contact_id: contactId,
      subject: null,
      status: 'open',
      mode: 'bot',
    })
    .select('id')
    .single();
  if (conversationError || !conversationRow) {
    return json({ error: 'Sitzung konnte nicht erstellt werden.' }, 500);
  }
  const conversationId = (conversationRow as { id: string }).id;

  const secret = generateSessionSecret();
  const { data: sessionRow, error: sessionError } = await admin
    .from('widget_sessions')
    .insert({
      org_id: channel.org_id,
      channel_id: channel.id,
      conversation_id: conversationId,
      secret_hash: hashSecret(secret),
    })
    .select('broadcast_topic')
    .single();
  if (sessionError || !sessionRow) {
    return json({ error: 'Sitzung konnte nicht erstellt werden.' }, 500);
  }
  const topic = (sessionRow as { broadcast_topic: string }).broadcast_topic;

  // the secret leaves the server exactly once — only its hash is stored
  return json({ conversationId, secret, topic, messages: [] }, 200);
}
