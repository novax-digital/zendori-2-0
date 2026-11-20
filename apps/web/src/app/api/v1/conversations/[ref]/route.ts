import { apiGetConversation } from '@zendori/core';
import { handleApiRequest, pathRef } from '@/lib/public-api/handler';

// GET /api/v1/conversations/{ref} — status, channel and contact of a
// conversation. Message content is deliberately not part of the API.
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ref: string }> }
): Promise<Response> {
  const { ref } = await params;
  return handleApiRequest(request, ({ db, ctx }) => apiGetConversation(db, ctx, pathRef(ref)));
}
