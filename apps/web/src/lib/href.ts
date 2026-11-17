// In-app links with query parameters (redesign stage 4+): drawers, tabs and
// filters all live in the URL, so every page builds many of these. One helper
// keeps them consistent and never writes empty parameters.
//   href('/settings/channels', { org: orgId, panel: 'new', type })
type Param = string | number | boolean | null | undefined;

export function href(path: string, params: Record<string, Param> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === false || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
