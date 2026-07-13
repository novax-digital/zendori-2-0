// Custom ticket-property provisioning (docs/legacy-analysis.md §2.7). Idempotent:
// GET the property first (200 = exists), create only on 404.
//   zendori_ref    — "Zendori Referenz", hasUniqueValue: true (idempotency key)
//   zendori_source — "Zendori Quelle",   no hasUniqueValue
import { isSuccess, request, requestFailed } from './client.js';
import type { HubSpotConfig } from './schemas.js';

const PROPERTIES_PATH = '/crm/v3/properties/tickets';

interface PropertyDef {
  name: string;
  label: string;
  type: 'string';
  fieldType: 'text';
  groupName: 'ticketinformation';
  hasUniqueValue: boolean;
}

const PROPERTY_DEFS: readonly PropertyDef[] = [
  {
    name: 'zendori_ref',
    label: 'Zendori Referenz',
    type: 'string',
    fieldType: 'text',
    groupName: 'ticketinformation',
    hasUniqueValue: true,
  },
  {
    name: 'zendori_source',
    label: 'Zendori Quelle',
    type: 'string',
    fieldType: 'text',
    groupName: 'ticketinformation',
    hasUniqueValue: false,
  },
];

async function propertyExists(config: HubSpotConfig, name: string): Promise<boolean> {
  const path = `${PROPERTIES_PATH}/${encodeURIComponent(name)}`;
  const res = await request(config, 'GET', path);
  if (res.status === 404) return false;
  if (isSuccess(res.status)) return true;
  throw requestFailed('GET', path, res);
}

async function createProperty(config: HubSpotConfig, def: PropertyDef): Promise<void> {
  const res = await request(config, 'POST', PROPERTIES_PATH, {
    name: def.name,
    label: def.label,
    type: def.type,
    fieldType: def.fieldType,
    groupName: def.groupName,
    hasUniqueValue: def.hasUniqueValue,
  });
  if (!isSuccess(res.status)) throw requestFailed('POST', PROPERTIES_PATH, res);
}

/**
 * Ensure zendori_ref / zendori_source exist on tickets. Returns which were
 * newly created vs already present.
 */
export async function provisionTicketProperties(
  config: HubSpotConfig
): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const def of PROPERTY_DEFS) {
    if (await propertyExists(config, def.name)) {
      existing.push(def.name);
      continue;
    }
    await createProperty(config, def);
    created.push(def.name);
  }
  return { created, existing };
}
