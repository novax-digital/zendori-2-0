// Images belonging to one outbound widget message (migration 0025).
//
// Why a separate request instead of putting the URL in the realtime payload: the
// 0003 broadcast trigger fires AFTER INSERT on messages, and a reply's attachment
// rows are written after that insert (their storage path is keyed by the message
// id). At broadcast time there is nothing to announce. Just as importantly, the
// widget's realtime topic is public by design — its unguessable session secret is
// the access control — so a signed URL must never travel over it.
//
// The visitor therefore asks for a specific message's images over this
// authenticated route, which re-proves the session on every call and mints a
// short-lived URL.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INLINE_RENDERABLE_MIMES } from '@zendori/core';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import { verifySession, WidgetDbError } from '@/lib/widget/session';

/** Long enough to load the image, short enough that a leaked URL is worthless. */
const URL_TTL_SECONDS = 300;
/** Defensive cap; the bot attaches at most MAX_OUTBOUND_ATTACHMENTS anyway. */
const MAX_IMAGES = 3;

const bodySchema = z.object({
  conversationId: z.uuid(),
  secret: z.string().regex(/^[0-9a-f]{48}$/),
  messageId: z.uuid(),
});

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await checkRateLimit('widget-attachment-ip', clientIp(request)))) {
    return json({ error: 'Zu viele Anfragen.' }, 429);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return json({ error: 'Ungültige Anfrage.' }, 400);

  const admin = createSupabaseAdminClient();
  if (!admin) return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);

  let verified: Awaited<ReturnType<typeof verifySession>>;
  try {
    verified = await verifySession(admin, parsed.data.conversationId, parsed.data.secret);
  } catch (error) {
    if (error instanceof WidgetDbError) {
      return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);
    }
    throw error;
  }
  // Same response for a wrong secret and an unknown conversation — do not reveal
  // which of the two it was.
  if (!verified) return json({ error: 'Sitzung ist abgelaufen.' }, 401);
  const { session } = verified;

  // The message must belong to THIS conversation and be outbound. Without the
  // conversation_id predicate, a valid session could read any message id.
  const { data: messageRow } = await admin
    .from('messages')
    .select('id')
    .eq('org_id', session.org_id)
    .eq('conversation_id', session.conversation_id)
    .eq('id', parsed.data.messageId)
    .eq('direction', 'out')
    .maybeSingle();
  if (!messageRow) return json({ images: [] }, 200);

  const { data: attachmentRows } = await admin
    .from('attachments')
    .select('id, storage_path, mime')
    .eq('org_id', session.org_id)
    .eq('message_id', parsed.data.messageId)
    .limit(MAX_IMAGES);

  // Only ever hand out raster images, and only against the exact allowlist —
  // never `startsWith('image/')`, which would admit image/svg+xml and let a
  // signed URL execute script on the storage domain. Documents are deliberately
  // NOT exposed here: a chat bubble cannot render them, and a download link into
  // storage is a separate decision.
  const images = ((attachmentRows ?? []) as { id: string; storage_path: string; mime: string }[])
    .filter((row) => INLINE_RENDERABLE_MIMES.has(row.mime));
  if (images.length === 0) return json({ images: [] }, 200);

  const { data: signed } = await admin.storage
    .from('attachments')
    .createSignedUrls(
      images.map((row) => row.storage_path),
      URL_TTL_SECONDS
    );
  const urlByPath = new Map<string, string>();
  for (const entry of signed ?? []) {
    if (entry.path && entry.signedUrl) urlByPath.set(entry.path, entry.signedUrl);
  }

  return json(
    {
      images: images
        .map((row) => ({
          id: row.id,
          mime: row.mime,
          url: urlByPath.get(row.storage_path) ?? null,
        }))
        .filter((image) => image.url !== null),
    },
    200
  );
}
