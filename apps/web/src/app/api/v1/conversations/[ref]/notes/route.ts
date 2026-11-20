import { apiAddNote } from '@zendori/core';
import { handleApiRequest, pathRef, readJsonBody } from '@/lib/public-api/handler';

// POST /api/v1/conversations/{ref}/notes — add an internal note to the
// conversation. Send an Idempotency-Key header to make retries safe.
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ref: string }> }
): Promise<Response> {
  const { ref } = await params;
  return handleApiRequest(request, async ({ db, ctx }) =>
    apiAddNote(
      db,
      ctx,
      'conversation',
      pathRef(ref),
      await readJsonBody(request),
      request.headers.get('idempotency-key')
    )
  );
}
