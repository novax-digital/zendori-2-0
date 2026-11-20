import { apiWhoAmI } from '@zendori/core';
import { handleApiRequest } from '@/lib/public-api/handler';

// GET /api/v1/me — verifies an API key and names the connection it belongs to.
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async ({ ctx }) => apiWhoAmI(ctx));
}
