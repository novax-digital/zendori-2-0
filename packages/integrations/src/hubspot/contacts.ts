// Contact matching / upsert (docs/legacy-analysis.md §2.7).
//   email  → GET /contacts/{email}?idProperty=email (200 use / 404 create / 409 re-GET)
//   phone  → search phone EQ, retry with stripCountryCode(), else create
//   neither → error (a HubSpot ticket needs a contact association)
// contactProperties maps email, firstname/lastname (name split), phone,
// company (standard HubSpot contact property, 0027 — same mapping as the
// legacy bridge) and the stated callback number → mobilephone (0029).
// Properties are sent on CREATE; a matched existing HubSpot contact gets
// exactly ONE gap-only patch: empty company/mobilephone are filled from
// Zendori, existing HubSpot values are never overwritten (CRM data wins).
import { isSuccess, parseJson, request, requestFailed, type HubSpotResponse } from './client.js';
import {
  objectResponseSchema,
  searchResponseSchema,
  type ContactInput,
  type ContactRef,
  type HubSpotConfig,
} from './schemas.js';

const CONTACTS_PATH = '/crm/v3/objects/contacts';
const CONTACTS_SEARCH_PATH = '/crm/v3/objects/contacts/search';

/**
 * Strip a leading country calling code so a "+49…"/"+1…" number can also match a
 * locally-stored "0…" number (§2.7: `/^\+(1|7|\d\d)/` → '0'). Handles the 1-digit
 * NANP (+1) and Russia (+7) codes and the common two-digit codes.
 */
export function stripCountryCode(phone: string): string {
  return phone.replace(/^\+(1|7|\d\d)/, '0');
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function splitName(name: string | null | undefined): { firstname?: string; lastname?: string } {
  const trimmed = trimOrNull(name);
  if (!trimmed) return {};
  const parts = trimmed.split(/\s+/);
  const [first, ...rest] = parts;
  if (rest.length === 0) return { firstname: first };
  return { firstname: first, lastname: rest.join(' ') };
}

function contactProperties(
  contact: ContactInput,
  resolved: { email?: string; phone?: string }
): Record<string, string> {
  const props: Record<string, string> = {};
  if (resolved.email) props.email = resolved.email;
  const { firstname, lastname } = splitName(contact.name);
  if (firstname) props.firstname = firstname;
  if (lastname) props.lastname = lastname;
  if (resolved.phone) props.phone = resolved.phone;
  const company = trimOrNull(contact.company);
  if (company) props.company = company;
  const mobilephone = trimOrNull(contact.callbackPhone);
  if (mobilephone) props.mobilephone = mobilephone;
  return props;
}

/** The gap-fillable properties read back from a matched HubSpot contact. */
interface ExistingGaps {
  company: string | null;
  mobilephone: string | null;
}
const GAP_PROPERTIES = ['company', 'mobilephone'] as const;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function idFrom(response: HubSpotResponse, method: string, path: string): string {
  return parseJson(objectResponseSchema, response, method, path).id;
}

function gapsFrom(response: HubSpotResponse, method: string, path: string): ExistingGaps {
  const properties = parseJson(objectResponseSchema, response, method, path).properties;
  return { company: nonEmpty(properties?.company), mobilephone: nonEmpty(properties?.mobilephone) };
}

/**
 * Gap-only fill on a MATCHED contact (0027 company, 0029 mobilephone): only
 * properties Zendori knows AND HubSpot has empty are sent, in ONE patch.
 * Best-effort — a failed patch never fails the sync (the ticket association is
 * the critical part).
 */
async function patchGaps(
  config: HubSpotConfig,
  contactId: string,
  contact: ContactInput,
  existing: ExistingGaps
): Promise<void> {
  const properties: Record<string, string> = {};
  const company = trimOrNull(contact.company);
  if (company && !existing.company) properties.company = company;
  const mobilephone = trimOrNull(contact.callbackPhone);
  if (mobilephone && !existing.mobilephone) properties.mobilephone = mobilephone;
  if (Object.keys(properties).length === 0) return;
  const path = `${CONTACTS_PATH}/${encodeURIComponent(contactId)}`;
  await request(config, 'PATCH', path, { properties });
}

/** Upsert a HubSpot contact, matching on email first, else phone. */
export async function upsertContact(
  config: HubSpotConfig,
  contact: ContactInput
): Promise<ContactRef> {
  const email = trimOrNull(contact.email);
  const phone = trimOrNull(contact.phone);
  if (email) return upsertByEmail(config, contact, email, phone ?? undefined);
  if (phone) return upsertByPhone(config, contact, phone);
  throw new Error('Cannot upsert HubSpot contact: neither email nor phone provided');
}

async function upsertByEmail(
  config: HubSpotConfig,
  contact: ContactInput,
  email: string,
  phone?: string
): Promise<ContactRef> {
  const getPath = `${CONTACTS_PATH}/${encodeURIComponent(email)}?idProperty=email&properties=${GAP_PROPERTIES.join(',')}`;
  const getRes = await request(config, 'GET', getPath);
  if (isSuccess(getRes.status)) {
    const id = idFrom(getRes, 'GET', getPath);
    await patchGaps(config, id, contact, gapsFrom(getRes, 'GET', getPath));
    return { id };
  }
  if (getRes.status !== 404) throw requestFailed('GET', getPath, getRes);

  const createRes = await request(config, 'POST', CONTACTS_PATH, {
    properties: contactProperties(contact, { email, phone }),
  });
  if (isSuccess(createRes.status)) return { id: idFrom(createRes, 'POST', CONTACTS_PATH) };
  if (createRes.status === 409) {
    // Concurrent create: the contact now exists — re-GET by email.
    const reGet = await request(config, 'GET', getPath);
    if (isSuccess(reGet.status)) {
      const id = idFrom(reGet, 'GET', getPath);
      await patchGaps(config, id, contact, gapsFrom(reGet, 'GET', getPath));
      return { id };
    }
    throw requestFailed('GET', getPath, reGet);
  }
  throw requestFailed('POST', CONTACTS_PATH, createRes);
}

async function upsertByPhone(
  config: HubSpotConfig,
  contact: ContactInput,
  phone: string
): Promise<ContactRef> {
  let found = await searchContactByPhone(config, phone);
  if (!found) {
    const stripped = stripCountryCode(phone);
    if (stripped !== phone) found = await searchContactByPhone(config, stripped);
  }
  if (found) {
    await patchGaps(config, found.id, contact, found);
    return { id: found.id };
  }

  const createRes = await request(config, 'POST', CONTACTS_PATH, {
    properties: contactProperties(contact, { phone }),
  });
  if (isSuccess(createRes.status)) return { id: idFrom(createRes, 'POST', CONTACTS_PATH) };
  throw requestFailed('POST', CONTACTS_PATH, createRes);
}

async function searchContactByPhone(
  config: HubSpotConfig,
  phone: string
): Promise<({ id: string } & ExistingGaps) | null> {
  const res = await request(config, 'POST', CONTACTS_SEARCH_PATH, {
    filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
    properties: ['phone', ...GAP_PROPERTIES],
    limit: 1,
  });
  if (!isSuccess(res.status)) throw requestFailed('POST', CONTACTS_SEARCH_PATH, res);
  const parsed = parseJson(searchResponseSchema, res, 'POST', CONTACTS_SEARCH_PATH);
  const first = parsed.results[0];
  if (!first) return null;
  return {
    id: first.id,
    company: nonEmpty(first.properties?.company),
    mobilephone: nonEmpty(first.properties?.mobilephone),
  };
}
