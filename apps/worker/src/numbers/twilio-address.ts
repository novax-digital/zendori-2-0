// Shared by the number provisioner (src/numbers/provision.ts) and the operator
// scripts (scripts/provision-voice-number.ts, scripts/provision-demo-number.ts).
//
// Local (geographic) DE numbers require an AddressSid on purchase IN ADDITION
// to the bundle (Twilio 21631 "Phone Number Requires an Address", live
// 2026-11-11). The address must lie in the number's local area and is the one
// already proven in the bundle's supporting documents — so derive it from the
// bundle instead of adding another env var. TWILIO_ADDRESS_SID_LOCAL overrides.

export interface AddressLookupOptions {
  /** Explicit override (TWILIO_ADDRESS_SID_LOCAL); falls back to the env var. */
  override?: string;
  fetchImpl?: typeof fetch;
  numbersBase?: string;
}

export async function addressSidForBundle(
  bundleSid: string,
  creds: { accountSid: string; authToken: string },
  options: AddressLookupOptions = {}
): Promise<string> {
  const override = (options.override ?? process.env.TWILIO_ADDRESS_SID_LOCAL)?.trim();
  if (override) return override;
  const fetchImpl = options.fetchImpl ?? fetch;
  const numbersBase = (
    options.numbersBase ??
    (process.env.TWILIO_NUMBERS_API_BASE || 'https://numbers.twilio.com')
  ).replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;
  const get = async (url: string): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`Twilio ${url} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const items = await get(
    `${numbersBase}/v2/RegulatoryCompliance/Bundles/${bundleSid}/ItemAssignments`
  );
  const results = Array.isArray(items.results) ? (items.results as { object_sid?: string }[]) : [];
  for (const item of results) {
    if (!item.object_sid?.startsWith('RD')) continue; // supporting documents only
    const doc = await get(
      `${numbersBase}/v2/RegulatoryCompliance/SupportingDocuments/${item.object_sid}`
    );
    const attributes = (doc.attributes ?? {}) as { address_sids?: unknown };
    const sids = Array.isArray(attributes.address_sids)
      ? attributes.address_sids
      : [attributes.address_sids];
    const address = sids.find((s): s is string => typeof s === 'string' && s.startsWith('AD'));
    if (address) return address;
  }
  throw new Error(
    `bundle ${bundleSid} has no address in its supporting documents — set TWILIO_ADDRESS_SID_LOCAL`
  );
}
