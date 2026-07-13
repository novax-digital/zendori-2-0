/**
 * CORS for the public widget API (/api/widget/*): any origin may POST,
 * no cookies/credentials are involved. Every response — including errors —
 * must carry these headers.
 */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  };
}

/** OPTIONS preflight response. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
