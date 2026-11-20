import { apiGetTicket, apiPatchTicket } from '@zendori/core';
import { handleApiRequest, pathRef, readJsonBody } from '@/lib/public-api/handler';

// /api/v1/tickets/{ref} — {ref} is the Zendori ticket id or "ext:<external id>".
//   GET    read the ticket (with its contact, without message content)
//   PATCH  change status, priority or category
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ ref: string }> };

export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const { ref } = await params;
  return handleApiRequest(request, ({ db, ctx }) => apiGetTicket(db, ctx, pathRef(ref)));
}

export async function PATCH(request: Request, { params }: RouteContext): Promise<Response> {
  const { ref } = await params;
  return handleApiRequest(request, async ({ db, ctx }) =>
    apiPatchTicket(db, ctx, pathRef(ref), await readJsonBody(request))
  );
}
