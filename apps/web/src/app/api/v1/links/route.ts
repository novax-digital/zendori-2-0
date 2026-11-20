import { apiPutLink } from '@zendori/core';
import { handleApiRequest, readJsonBody } from '@/lib/public-api/handler';

// PUT /api/v1/links — tell Zendori the end system's own id for a ticket,
// conversation or contact. Afterwards "ext:<id>" addresses that record and the
// id comes back as external_id in events and responses.
export const runtime = 'nodejs';

export async function PUT(request: Request): Promise<Response> {
  return handleApiRequest(request, async ({ db, ctx }) =>
    apiPutLink(db, ctx, await readJsonBody(request))
  );
}
