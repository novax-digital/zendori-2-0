import { apiGetContact, apiPatchContact } from '@zendori/core';
import { handleApiRequest, pathRef, readJsonBody } from '@/lib/public-api/handler';

// /api/v1/contacts/{ref} — {ref} is the Zendori contact id or "ext:<external id>".
//   GET    read the contact
//   PATCH  correct name, email, phone or company
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ ref: string }> };

export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const { ref } = await params;
  return handleApiRequest(request, ({ db, ctx }) => apiGetContact(db, ctx, pathRef(ref)));
}

export async function PATCH(request: Request, { params }: RouteContext): Promise<Response> {
  const { ref } = await params;
  return handleApiRequest(request, async ({ db, ctx }) =>
    apiPatchContact(db, ctx, pathRef(ref), await readJsonBody(request))
  );
}
