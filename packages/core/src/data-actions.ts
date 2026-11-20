import { z } from 'zod';

// Phase 13 — API-Integration: data actions (agent tools that call an org's own
// end system). Pure, dependency-free logic shared by the settings UI (validate
// on save), the worker (execute) and both agent kinds (tool schema). Nothing in
// here does I/O; the HTTP call lives in @zendori/integrations (custom-api).
//
// Trust model: the model only ever supplies `agent` parameters. Identity values
// (`context` parameters: contact e-mail, phone, conversation id …) are bound
// server-side and `fixed` parameters come from the action definition, so a
// prompt-injected model cannot look up somebody else's data or reach another
// path/host than the one the owner configured.

/** Built-in tool names an action must never shadow (mirrors the 0035 check). */
export const DATA_ACTION_RESERVED_NAMES = [
  'kb_search',
  'create_ticket',
  'handoff_human',
  'end_call',
] as const;

export const dataActionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,39}$/)
  .refine((name) => !(DATA_ACTION_RESERVED_NAMES as readonly string[]).includes(name));

export const dataActionKindSchema = z.enum(['read', 'write']);
export type DataActionKind = z.infer<typeof dataActionKindSchema>;

export const dataActionMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export type DataActionMethod = z.infer<typeof dataActionMethodSchema>;

/** Values the server knows about the conversation — never taken from the model. */
export const DATA_ACTION_CONTEXT_KEYS = [
  'contact.id',
  'contact.name',
  'contact.email',
  'contact.phone',
  'conversation.id',
  'channel.type',
] as const;
export const dataActionContextKeySchema = z.enum(DATA_ACTION_CONTEXT_KEYS);
export type DataActionContextKey = z.infer<typeof dataActionContextKeySchema>;
export type DataActionContext = Partial<Record<DataActionContextKey, string | null>>;

export const dataActionParamLocationSchema = z.enum(['path', 'query', 'body']);
export type DataActionParamLocation = z.infer<typeof dataActionParamLocationSchema>;

export const dataActionParamSourceSchema = z.enum(['agent', 'context', 'fixed']);
export type DataActionParamSource = z.infer<typeof dataActionParamSourceSchema>;

export const dataActionParamTypeSchema = z.enum(['string', 'number', 'integer', 'boolean']);
export type DataActionParamType = z.infer<typeof dataActionParamTypeSchema>;

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function hasUnsafeSegment(path: string): boolean {
  return path.split('.').some((segment) => UNSAFE_SEGMENTS.has(segment));
}

export const dataActionParameterSchema = z
  .object({
    /** Argument name: what the model passes, and the `{placeholder}` in the path. */
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    in: dataActionParamLocationSchema,
    /**
     * Name in the request when it differs from `key`: the query parameter name,
     * or a dot path inside the JSON body ("customer.email"). Unused for `path`.
     */
    field: z
      .string()
      .regex(/^[A-Za-z0-9_\-.[\]]{1,120}$/)
      .optional(),
    source: dataActionParamSourceSchema,
    type: dataActionParamTypeSchema.default('string'),
    /** Model-facing hint for `agent` parameters. */
    description: z.string().max(300).default(''),
    required: z.boolean().default(true),
    /** Closed value list (`agent` parameters of type string). */
    options: z.array(z.string().min(1).max(80)).max(30).optional(),
    contextKey: dataActionContextKeySchema.optional(),
    fixedValue: z.string().max(500).optional(),
  })
  .superRefine((param, ctx) => {
    if (param.source === 'context' && !param.contextKey) {
      ctx.addIssue({
        code: 'custom',
        message: 'context parameter needs contextKey',
        path: ['contextKey'],
      });
    }
    if (param.source === 'fixed' && (param.fixedValue === undefined || param.fixedValue === '')) {
      ctx.addIssue({
        code: 'custom',
        message: 'fixed parameter needs fixedValue',
        path: ['fixedValue'],
      });
    }
    if (param.field !== undefined && hasUnsafeSegment(param.field)) {
      ctx.addIssue({ code: 'custom', message: 'unsafe field name', path: ['field'] });
    }
    if (param.in === 'path' && !param.required) {
      ctx.addIssue({
        code: 'custom',
        message: 'path parameters are always required',
        path: ['required'],
      });
    }
  });
export type DataActionParameter = z.infer<typeof dataActionParameterSchema>;

export const DATA_ACTION_MAX_PARAMETERS = 20;

export const dataActionParametersSchema = z
  .array(dataActionParameterSchema)
  .max(DATA_ACTION_MAX_PARAMETERS)
  .superRefine((params, ctx) => {
    const seen = new Set<string>();
    params.forEach((param, index) => {
      if (seen.has(param.key)) {
        ctx.addIssue({ code: 'custom', message: 'duplicate parameter key', path: [index, 'key'] });
      }
      seen.add(param.key);
    });
  });

/**
 * Path below the connection's base URL. Starts with "/", may carry
 * `{placeholders}`; no query string, no fragment, no dot segments — the query
 * is built from parameters, and "/../" must not climb out of the base path.
 */
export const dataActionPathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/{}]*$/)
  .refine((path) => !path.split('/').some((segment) => segment === '.' || segment === '..'))
  .refine((path) => {
    // every brace belongs to a well-formed {key} placeholder
    const stripped = path.replace(/\{[a-z][a-z0-9_]{0,39}\}/g, '');
    return !stripped.includes('{') && !stripped.includes('}');
  });

/** Dot paths into the JSON response that the model (and the run log) may see. */
export const dataActionResponseFieldsSchema = z
  .array(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/)
      .max(120)
      .refine((path) => !hasUnsafeSegment(path))
  )
  .max(30);

export const DATA_ACTION_TIMEOUT_MIN_MS = 1_000;
export const DATA_ACTION_TIMEOUT_MAX_MS = 20_000;
export const DATA_ACTION_TIMEOUT_DEFAULT_MS = 8_000;

/** The owner-editable definition of one action (settings form → DB row). */
export const dataActionDefinitionSchema = z.object({
  name: dataActionNameSchema,
  label: z.string().min(2).max(80),
  description: z.string().min(10).max(1000),
  kind: dataActionKindSchema,
  method: dataActionMethodSchema,
  path: dataActionPathSchema,
  parameters: dataActionParametersSchema,
  responseFields: dataActionResponseFieldsSchema,
  requiresConfirmation: z.boolean(),
  timeoutMs: z.number().int().min(DATA_ACTION_TIMEOUT_MIN_MS).max(DATA_ACTION_TIMEOUT_MAX_MS),
});
export type DataActionDefinition = z.infer<typeof dataActionDefinitionSchema>;

export type DataActionDefinitionIssue =
  | 'placeholder_without_parameter'
  | 'path_parameter_without_placeholder'
  | 'body_parameter_on_bodyless_method';

/** `{placeholder}` names used in a path, in order of appearance. */
export function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(/\{([a-z][a-z0-9_]{0,39})\}/g)].map((match) => match[1] as string);
}

/**
 * Cross-field consistency the per-field schemas cannot express. Returns the
 * first problem (the settings form shows one message at a time) or null.
 */
export function checkDataActionDefinition(
  def: Pick<DataActionDefinition, 'method' | 'path' | 'parameters'>
): DataActionDefinitionIssue | null {
  const pathParams = new Set(def.parameters.filter((p) => p.in === 'path').map((p) => p.key));
  const placeholders = new Set(pathPlaceholders(def.path));
  for (const name of placeholders) {
    if (!pathParams.has(name)) return 'placeholder_without_parameter';
  }
  for (const key of pathParams) {
    if (!placeholders.has(key)) return 'path_parameter_without_placeholder';
  }
  const bodyless = def.method === 'GET' || def.method === 'DELETE';
  if (bodyless && def.parameters.some((p) => p.in === 'body')) {
    return 'body_parameter_on_bodyless_method';
  }
  return null;
}

// --- connection ------------------------------------------------------------------

/** Request headers an auth header must never override. */
const BLOCKED_AUTH_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'user-agent',
  'idempotency-key',
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
]);

export const apiConnectionAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('bearer'), secret_encrypted: z.string().min(1) }),
  z.object({
    kind: z.literal('header'),
    header_name: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .refine((name) => !BLOCKED_AUTH_HEADERS.has(name.toLowerCase())),
    secret_encrypted: z.string().min(1),
  }),
  z.object({
    kind: z.literal('basic'),
    username: z.string().min(1).max(200),
    secret_encrypted: z.string().min(1),
  }),
]);
export type ApiConnectionAuth = z.infer<typeof apiConnectionAuthSchema>;
export type ApiConnectionAuthKind = ApiConnectionAuth['kind'];

/** `api_connections.config` — secrets only ever as libsodium ciphertext (§7). */
export const apiConnectionConfigSchema = z.object({
  auth: apiConnectionAuthSchema.default({ kind: 'none' }),
  /** HMAC key Zendori signs every request with (Standard Webhooks scheme). */
  signing_secret_encrypted: z.string().min(1).optional(),
});
export type ApiConnectionConfig = z.infer<typeof apiConnectionConfigSchema>;

/**
 * Base URL of an end system: https only, no credentials, no query/fragment.
 * Returned without a trailing slash so `base + path` never doubles one.
 */
export const apiBaseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === '' &&
        url.hostname !== ''
      );
    } catch {
      return false;
    }
  })
  .transform((value) => value.replace(/\/+$/, ''));

// --- values ----------------------------------------------------------------------

export type ActionValue = string | number | boolean;
export type ActionValues = Record<string, ActionValue>;

const MAX_STRING_VALUE = 2_000;

/** Coerce one raw value to the parameter's type; undefined = absent/unusable. */
function coerceValue(param: DataActionParameter, raw: unknown): ActionValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  switch (param.type) {
    case 'string': {
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        return undefined;
      }
      const text = String(raw).trim();
      if (text === '' || text.length > MAX_STRING_VALUE) return undefined;
      if (param.options && param.options.length > 0 && !param.options.includes(text)) {
        return undefined;
      }
      return text;
    }
    case 'number':
    case 'integer': {
      const num =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(num)) return undefined;
      if (param.type === 'integer' && !Number.isInteger(num)) return undefined;
      return num;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return undefined;
    }
  }
}

export type ActionValuesResult =
  | { ok: true; values: ActionValues }
  /** `invalid_args`: the caller supplied a bad/missing value · `missing_context`: the conversation lacks it. */
  | { ok: false; error: 'invalid_args' | 'missing_context'; key: string };

/**
 * Validate a FLAT record of values (keyed by parameter key) for every
 * non-fixed parameter. Used directly for test runs and stored (approved) runs,
 * and by resolveActionValues for agent calls.
 */
export function coerceActionValues(
  parameters: DataActionParameter[],
  raw: Record<string, unknown>
): ActionValuesResult {
  const values: ActionValues = {};
  for (const param of parameters) {
    if (param.source === 'fixed') continue;
    const present = Object.prototype.hasOwnProperty.call(raw, param.key)
      ? raw[param.key]
      : undefined;
    const value = coerceValue(param, present);
    const supplied = present !== null && present !== undefined && present !== '';
    if (value === undefined) {
      if (supplied && param.source === 'agent') {
        // wrong type / not in the option list — never silently dropped
        return { ok: false, error: 'invalid_args', key: param.key };
      }
      if (param.required) {
        return {
          ok: false,
          error: param.source === 'context' ? 'missing_context' : 'invalid_args',
          key: param.key,
        };
      }
      continue;
    }
    values[param.key] = value;
  }
  return { ok: true, values };
}

/**
 * Agent call: take `agent` parameters from the model's arguments and `context`
 * parameters from the server-side context. Anything else the model sent is
 * ignored — it cannot set a context or fixed parameter.
 */
export function resolveActionValues(
  parameters: DataActionParameter[],
  modelArgs: unknown,
  context: DataActionContext
): ActionValuesResult {
  const args =
    modelArgs !== null && typeof modelArgs === 'object' && !Array.isArray(modelArgs)
      ? (modelArgs as Record<string, unknown>)
      : {};
  const raw: Record<string, unknown> = {};
  for (const param of parameters) {
    if (param.source === 'agent') {
      if (Object.prototype.hasOwnProperty.call(args, param.key)) raw[param.key] = args[param.key];
    } else if (param.source === 'context' && param.contextKey) {
      raw[param.key] = context[param.contextKey] ?? undefined;
    }
  }
  return coerceActionValues(parameters, raw);
}

// --- request ---------------------------------------------------------------------

export interface ActionRequest {
  url: string;
  method: DataActionMethod;
  /** JSON text, or null when the request carries no body. */
  body: string | null;
}

function setNested(target: Record<string, unknown>, path: string, value: ActionValue): void {
  const segments = path.split('.');
  let node = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = Object.prototype.hasOwnProperty.call(node, segment) ? node[segment] : undefined;
    if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    }
  }
  node[segments[segments.length - 1] as string] = value;
}

/**
 * Build the concrete HTTP request from the definition and the resolved values.
 * Path values are percent-encoded as ONE segment, so a value can never add a
 * path segment or a query string; the origin always stays the base URL's.
 */
export function buildActionRequest(
  def: Pick<DataActionDefinition, 'method' | 'path' | 'parameters'>,
  baseUrl: string,
  values: ActionValues
): ActionRequest {
  const resolved = new Map<string, ActionValue>();
  for (const param of def.parameters) {
    if (param.source === 'fixed') {
      const fixed = coerceValue(param, param.fixedValue);
      if (fixed !== undefined) resolved.set(param.key, fixed);
    } else if (Object.prototype.hasOwnProperty.call(values, param.key)) {
      resolved.set(param.key, values[param.key] as ActionValue);
    }
  }

  const path = def.path.replace(/\{([a-z][a-z0-9_]{0,39})\}/g, (_match, key: string) => {
    const value = resolved.get(key);
    if (value === undefined) throw new Error(`missing value for path parameter ${key}`);
    return encodeURIComponent(String(value));
  });

  const base = new URL(baseUrl);
  const url = new URL(base.toString());
  url.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  url.search = '';
  url.hash = '';

  const body: Record<string, unknown> = {};
  let hasBody = false;
  for (const param of def.parameters) {
    const value = resolved.get(param.key);
    if (value === undefined) continue;
    if (param.in === 'query') {
      url.searchParams.append(param.field ?? param.key, String(value));
    } else if (param.in === 'body') {
      setNested(body, param.field ?? param.key, value);
      hasBody = true;
    }
  }

  if (url.origin !== base.origin) throw new Error('request left the connection origin');
  return { url: url.toString(), method: def.method, body: hasBody ? JSON.stringify(body) : null };
}

// --- tool schema -----------------------------------------------------------------

export interface ActionToolSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required: string[];
}

/** JSON schema of the arguments the MODEL supplies (agent parameters only). */
export function buildActionToolSchema(parameters: DataActionParameter[]): ActionToolSchema {
  const properties: ActionToolSchema['properties'] = {};
  const required: string[] = [];
  for (const param of parameters) {
    if (param.source !== 'agent') continue;
    properties[param.key] = {
      type: param.type,
      ...(param.description ? { description: param.description } : {}),
      ...(param.type === 'string' && param.options && param.options.length > 0
        ? { enum: param.options }
        : {}),
    };
    if (param.required) required.push(param.key);
  }
  return { type: 'object', properties, required };
}

// --- response --------------------------------------------------------------------

const ARRAY_CAP = 20;

/** Read a dot path; an array in the way applies the rest of the path to each element. */
export function pickPath(value: unknown, path: string): unknown {
  const segments = path.split('.');
  const walk = (node: unknown, index: number): unknown => {
    if (index >= segments.length) return node;
    if (node === null || node === undefined) return undefined;
    const segment = segments[index] as string;
    if (Array.isArray(node)) {
      if (/^\d+$/.test(segment)) return walk(node[Number(segment)], index + 1);
      return node.slice(0, ARRAY_CAP).map((entry) => walk(entry, index));
    }
    if (typeof node !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    return walk((node as Record<string, unknown>)[segment], index + 1);
  };
  return walk(value, 0);
}

/**
 * Reduce a JSON response to the allowlisted fields. No allowlist = the whole
 * body (still size-capped by capActionResult). A top-level array is mapped
 * element by element.
 */
export function mapActionResponse(json: unknown, fields: string[]): unknown {
  if (fields.length === 0) return json;
  const pick = (node: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = pickPath(node, field);
      if (value !== undefined) out[field] = value;
    }
    return out;
  };
  if (Array.isArray(json)) return json.slice(0, ARRAY_CAP).map(pick);
  return pick(json);
}

export const ACTION_RESULT_MAX_CHARS = 4_000;

/** Bound what is stored and handed to the model; oversized results become an excerpt. */
export function capActionResult(
  value: unknown,
  maxChars: number = ACTION_RESULT_MAX_CHARS
): unknown {
  const text = JSON.stringify(value ?? null) ?? 'null';
  if (text.length <= maxChars) return value ?? null;
  return { truncated: true, excerpt: text.slice(0, maxChars) };
}

// --- runs ------------------------------------------------------------------------

export const actionRunStateSchema = z.enum([
  'pending_approval',
  'queued',
  'running',
  'succeeded',
  'failed',
  'rejected',
]);
export type ActionRunState = z.infer<typeof actionRunStateSchema>;

export const actionRunTriggerSchema = z.enum(['agent', 'member', 'test']);
export type ActionRunTrigger = z.infer<typeof actionRunTriggerSchema>;

/** Why a run did not succeed (action_runs.error_code) — content-free. */
export type ActionRunErrorCode =
  | 'invalid_args'
  | 'missing_context'
  | 'action_inactive'
  | 'connection_inactive'
  | 'config_invalid'
  | 'blocked_url'
  | 'timeout'
  | 'network'
  | 'response_too_large'
  | 'http_error'
  | 'rate_limited';
