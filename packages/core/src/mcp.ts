import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DATA_ACTION_MAX_PARAMETERS,
  DATA_ACTION_RESERVED_NAMES,
  dataActionParametersSchema,
  mapActionResponse,
  type DataActionKind,
  type DataActionParamType,
  type DataActionParameter,
} from './data-actions.js';

// Phase 14a — MCP connections: an org connects a remote MCP server instead of
// describing every endpoint by hand. Its tools are IMPORTED as data actions, so
// everything Phase 13 built keeps applying: the owner decides which tools exist
// for an agent, write actions wait for confirmation, identity values can be
// bound server-side (`context` parameters) and every call is a run.
//
// Trust model for a server we do not control:
//   · The model never sees the server's live tool list. It sees the action the
//     owner imported and reviewed — name, description and parameters are a
//     SNAPSHOT in data_actions. A server that later rewrites a description
//     ("tool poisoning") cannot reach the prompt.
//   · Every catalog entry carries a hash of name + description + input schema.
//     The worker re-reads the list regularly and flags imported actions whose
//     tool changed or disappeared (`mcp_drift`).
//   · The argument object is built by Zendori from validated parameter values
//     (buildActionArguments) — the model cannot add arguments.
//
// Pure logic only; the wire protocol lives in @zendori/integrations (mcp client).

// --- connection ------------------------------------------------------------------

export const apiConnectionKindSchema = z.enum(['http', 'mcp']);
export type ApiConnectionKind = z.infer<typeof apiConnectionKindSchema>;

/**
 * Endpoint of a remote MCP server (Streamable HTTP): https only, no credentials,
 * no query/fragment. Unlike apiBaseUrlSchema the value is kept exactly as typed —
 * a trailing slash matters here: many servers redirect "/mcp" to "/mcp/", and
 * redirects are never followed.
 */
export const mcpEndpointUrlSchema = z
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
  });

/**
 * What data_actions.method / path hold for an MCP action: a tools/call is a
 * POST to the endpoint itself. The columns keep their NOT NULL contract (0039
 * pins exactly these values for rows with mcp_tool_name).
 */
export const MCP_ACTION_METHOD = 'POST';
export const MCP_ACTION_PATH = '/';
/** Default time budget of an imported tool: handshake + call. */
export const MCP_ACTION_TIMEOUT_DEFAULT_MS = 15_000;

// --- tools as the server reports them ------------------------------------------------

/** One tool of a server, normalized by the client. */
export interface McpToolInfo {
  name: string;
  title: string | null;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** Server hints — NOT trusted, only used as a default the owner reviews. */
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
}

/** A tool result, normalized by the client (transport- and version-agnostic). */
export interface McpToolResultData {
  /** Text blocks in order (incl. the text of embedded resources). */
  texts: string[];
  /** Blocks without text (image, audio, links) — counted, never forwarded. */
  otherBlocks: number;
  structuredContent: Record<string, unknown> | null;
  isError: boolean;
}

// --- catalog (api_connections.mcp_catalog) ---------------------------------------------

export const MCP_CATALOG_MAX_TOOLS = 100;
export const MCP_TOOL_NAME_MAX = 200;
export const MCP_TOOL_DESCRIPTION_MAX = 2_000;
/** A stored input schema is capped; a larger one makes the tool non-importable. */
export const MCP_TOOL_SCHEMA_MAX_CHARS = 16_000;

export const mcpCatalogToolSchema = z.object({
  name: z.string().min(1).max(MCP_TOOL_NAME_MAX),
  title: z.string().max(200).nullable(),
  /** Clipped for storage; the hash covers the full text. */
  description: z.string().max(MCP_TOOL_DESCRIPTION_MAX),
  /** Null = too large to store. */
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
  readOnlyHint: z.boolean().nullable(),
  destructiveHint: z.boolean().nullable(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type McpCatalogTool = z.infer<typeof mcpCatalogToolSchema>;

/** Worker-written snapshot of a server's tool list. */
export const mcpCatalogSchema = z.object({
  server: z.object({
    name: z.string().max(200),
    version: z.string().max(100),
    protocolVersion: z.string().max(40),
  }),
  tools: z.array(mcpCatalogToolSchema).max(MCP_CATALOG_MAX_TOOLS),
  /** True when the server offers more tools than Zendori keeps. */
  truncated: z.boolean(),
});
export type McpCatalog = z.infer<typeof mcpCatalogSchema>;

/** JSON with sorted keys, so equal values always produce the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Fingerprint of what a tool claims to be: name, description and argument schema. */
export function mcpToolHash(
  tool: Pick<McpToolInfo, 'name' | 'description' | 'inputSchema'>
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }),
      'utf8'
    )
    .digest('hex');
}

/** Catalog entry of a tool: clipped for storage, hashed over the full definition. */
export function toCatalogTool(tool: McpToolInfo): McpCatalogTool {
  const schemaText = JSON.stringify(tool.inputSchema);
  return {
    name: tool.name,
    title: tool.title ? tool.title.slice(0, 200) : null,
    description: tool.description.slice(0, MCP_TOOL_DESCRIPTION_MAX),
    inputSchema: schemaText.length <= MCP_TOOL_SCHEMA_MAX_CHARS ? tool.inputSchema : null,
    readOnlyHint: tool.readOnlyHint,
    destructiveHint: tool.destructiveHint,
    hash: mcpToolHash(tool),
  };
}

// --- drift -----------------------------------------------------------------------

export const mcpDriftSchema = z.enum(['changed', 'missing']);
/** `changed`: the server redefined the tool since the import · `missing`: it is gone. */
export type McpDrift = z.infer<typeof mcpDriftSchema>;

/**
 * Compare an imported action with the current catalog. `undefined` = cannot
 * tell (the tool is not in a truncated list) — the stored flag then stays.
 */
export function computeMcpDrift(
  importedHash: string | null,
  catalogTool: Pick<McpCatalogTool, 'hash'> | undefined,
  catalogTruncated: boolean
): McpDrift | null | undefined {
  if (!catalogTool) return catalogTruncated ? undefined : 'missing';
  return importedHash !== null && importedHash === catalogTool.hash ? null : 'changed';
}

// --- input schema → parameters ---------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const UNSAFE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
/** Property names that survive as a segment of a parameter's dot path. */
const PROPERTY_NAME = /^[A-Za-z0-9_-]{1,60}$/;
const MAX_UNWRAP_DEPTH = 8;
/** Nested objects are flattened down to this many path segments. */
const MAX_PATH_SEGMENTS = 3;
const MAX_FIELD_LENGTH = 120;
const MAX_OPTIONS = 30;
const MAX_OPTION_LENGTH = 80;
const MAX_FIXED_LENGTH = 500;

/** Follow a local JSON pointer ("#/$defs/Name"). Remote references are not supported. */
function resolveLocalRef(ref: string, root: JsonObject): JsonObject | null {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (UNSAFE_NAMES.has(segment)) return null;
    if (!isObject(node) || !Object.prototype.hasOwnProperty.call(node, segment)) return null;
    node = node[segment];
  }
  return isObject(node) ? node : null;
}

/** The use site's description wins over the one of the referenced schema. */
function withUseSiteText(inner: JsonObject, outer: JsonObject): JsonObject {
  return {
    ...inner,
    ...(typeof outer.description === 'string' ? { description: outer.description } : {}),
    ...(typeof outer.title === 'string' && typeof inner.title !== 'string'
      ? { title: outer.title }
      : {}),
  };
}

/**
 * Reduce a schema to one plain schema: follows $ref, unwraps a single-entry
 * allOf and "X or null" unions (how optional fields usually arrive). Null = a
 * real union or something else the flat parameter model cannot express.
 */
function simplify(schema: unknown, root: JsonObject, depth = 0): JsonObject | null {
  if (!isObject(schema) || depth > MAX_UNWRAP_DEPTH) return null;
  if (typeof schema.$ref === 'string') {
    const target = resolveLocalRef(schema.$ref, root);
    const inner = target ? simplify(target, root, depth + 1) : null;
    return inner ? withUseSiteText(inner, schema) : null;
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    const nonNull = variants.filter((variant) => !(isObject(variant) && variant.type === 'null'));
    if (nonNull.length !== 1) return null;
    const inner = simplify(nonNull[0], root, depth + 1);
    return inner ? withUseSiteText(inner, schema) : null;
  }
  if (Array.isArray(schema.allOf)) {
    if (schema.allOf.length !== 1) return null;
    const inner = simplify(schema.allOf[0], root, depth + 1);
    return inner ? withUseSiteText(inner, schema) : null;
  }
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((entry) => entry !== 'null');
    if (nonNull.length !== 1) return null;
    return { ...schema, type: nonNull[0] };
  }
  return schema;
}

function leafType(schema: JsonObject): DataActionParamType | null {
  const type = schema.type;
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') {
    return type;
  }
  if (type !== undefined) return null;
  // untyped enum / const: the values say what it is
  const sample = Array.isArray(schema.enum) ? schema.enum[0] : schema.const;
  if (typeof sample === 'string') return 'string';
  if (typeof sample === 'boolean') return 'boolean';
  if (typeof sample === 'number') return Number.isInteger(sample) ? 'integer' : 'number';
  return null;
}

function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `base`, or `base_2`, `base_3` … — never longer than `max`. */
function uniqueName(base: string, taken: Set<string>, max: number): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

interface Leaf {
  path: string[];
  type: DataActionParamType;
  description: string;
  required: boolean;
  options: string[] | null;
  /** Set for a `const` schema: the value is fixed by the tool definition. */
  constValue: string | null;
}

interface Collected {
  leaves: Leaf[];
  unsupported: { path: string; required: boolean }[];
}

function collect(
  schema: unknown,
  root: JsonObject,
  path: string[],
  required: boolean,
  out: Collected
): void {
  const label = path.join('.');
  const plain = simplify(schema, root);
  if (!plain) {
    out.unsupported.push({ path: label, required });
    return;
  }

  const isObjectSchema =
    plain.type === 'object' || (plain.type === undefined && isObject(plain.properties));
  if (isObjectSchema) {
    if (!isObject(plain.properties)) {
      // the root without properties = a tool without arguments; elsewhere a
      // free-form object, which a flat parameter cannot carry
      if (path.length > 0) out.unsupported.push({ path: label, required });
      return;
    }
    if (path.length >= MAX_PATH_SEGMENTS) {
      out.unsupported.push({ path: label, required });
      return;
    }
    const requiredNames = new Set(
      Array.isArray(plain.required)
        ? plain.required.filter((entry): entry is string => typeof entry === 'string')
        : []
    );
    for (const [name, child] of Object.entries(plain.properties)) {
      const childRequired = required && requiredNames.has(name);
      if (!PROPERTY_NAME.test(name) || UNSAFE_NAMES.has(name)) {
        out.unsupported.push({ path: [...path, name].join('.'), required: childRequired });
        continue;
      }
      collect(child, root, [...path, name], childRequired, out);
    }
    return;
  }

  const type = leafType(plain);
  if (!type || path.length === 0 || label.length > MAX_FIELD_LENGTH) {
    out.unsupported.push({ path: label, required });
    return;
  }

  let constValue: string | null = null;
  if (plain.const !== undefined) {
    const text =
      typeof plain.const === 'string' ||
      typeof plain.const === 'number' ||
      typeof plain.const === 'boolean'
        ? String(plain.const)
        : '';
    if (text === '' || text.length > MAX_FIXED_LENGTH) {
      out.unsupported.push({ path: label, required });
      return;
    }
    constValue = text;
  }

  const enumValues = Array.isArray(plain.enum) ? plain.enum : null;
  const options =
    type === 'string' &&
    enumValues !== null &&
    enumValues.length > 0 &&
    enumValues.length <= MAX_OPTIONS &&
    enumValues.every(
      (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_OPTION_LENGTH
    )
      ? (enumValues as string[])
      : null;

  const description =
    typeof plain.description === 'string'
      ? plain.description
      : typeof plain.title === 'string'
        ? plain.title
        : '';
  out.leaves.push({
    path,
    type,
    description: description.replace(/\s+/g, ' ').trim().slice(0, 300),
    required,
    options,
    constValue,
  });
}

export type McpSchemaIssue =
  /** The stored schema was too large, or is not an object schema. */
  | 'invalid_schema'
  /** A required argument is a list, a free-form object or a real union. */
  | 'unsupported_required'
  /** More required arguments than an action has parameters. */
  | 'too_many_required';

export type McpSchemaConversion =
  | {
      ok: true;
      parameters: DataActionParameter[];
      /** Optional arguments that were left out (unsupported shape, or over the limit). */
      dropped: string[];
    }
  | { ok: false; issue: McpSchemaIssue; path?: string };

/**
 * Turn a tool's JSON Schema into the flat parameter list of a data action.
 * Supported: text, numbers, yes/no, closed value lists, and nested objects
 * (flattened to dot paths). Lists, free-form objects and real unions are left
 * out when optional and make the tool non-importable when required.
 *
 * Every parameter starts as `agent` (the model supplies it) — the owner moves
 * identity values to `context` afterwards.
 */
export function convertMcpInputSchema(
  inputSchema: Record<string, unknown> | null
): McpSchemaConversion {
  if (!inputSchema) return { ok: false, issue: 'invalid_schema' };
  const root = simplify(inputSchema, inputSchema);
  if (!root || !(root.type === 'object' || root.type === undefined)) {
    return { ok: false, issue: 'invalid_schema' };
  }

  const collected: Collected = { leaves: [], unsupported: [] };
  collect(root, inputSchema, [], true, collected);

  const blocking = collected.unsupported.find((entry) => entry.required);
  if (blocking) return { ok: false, issue: 'unsupported_required', path: blocking.path };

  const requiredCount = collected.leaves.filter((leaf) => leaf.required).length;
  if (requiredCount > DATA_ACTION_MAX_PARAMETERS) return { ok: false, issue: 'too_many_required' };

  const dropped = collected.unsupported.map((entry) => entry.path);
  let optionalBudget = DATA_ACTION_MAX_PARAMETERS - requiredCount;
  const takenKeys = new Set<string>();
  const parameters: unknown[] = [];
  for (const leaf of collected.leaves) {
    const field = leaf.path.join('.');
    if (!leaf.required && leaf.constValue === null) {
      if (optionalBudget <= 0) {
        dropped.push(field);
        continue;
      }
      optionalBudget -= 1;
    }
    let base = toSnake(leaf.path.join('_'));
    if (!/^[a-z]/.test(base)) base = `p_${base}`.replace(/_+$/, '');
    const key = uniqueName(base.slice(0, 40).replace(/_+$/, ''), takenKeys, 40);
    takenKeys.add(key);
    parameters.push({
      key,
      in: 'body',
      ...(field !== key ? { field } : {}),
      source: leaf.constValue !== null ? 'fixed' : 'agent',
      type: leaf.type,
      description: leaf.constValue !== null ? '' : leaf.description,
      required: leaf.constValue !== null ? true : leaf.required,
      ...(leaf.options && leaf.constValue === null ? { options: leaf.options } : {}),
      ...(leaf.constValue !== null ? { fixedValue: leaf.constValue } : {}),
    });
  }

  // a const parameter counts against the limit too
  if (parameters.length > DATA_ACTION_MAX_PARAMETERS) {
    return { ok: false, issue: 'too_many_required' };
  }
  const parsed = dataActionParametersSchema.safeParse(parameters);
  if (!parsed.success) return { ok: false, issue: 'invalid_schema' };
  return { ok: true, parameters: parsed.data, dropped };
}

/** Parameters of an MCP action are arguments of the tool call — nothing else. */
export function isMcpParameterList(parameters: DataActionParameter[]): boolean {
  return parameters.every((param) => param.in === 'body');
}

const IDENTITY_HINT =
  /(e_?mail|phone|telefon|mobil|handy|customer_?(id|no|nr|number)|kunden|contact_?id|user_?id|account_?id)/;

/**
 * `agent` parameters that look like an identity value. The owner should bind
 * them to the conversation (`context`): otherwise a customer who claims another
 * e-mail address gets that person's data.
 */
export function identityLikeParameters(parameters: DataActionParameter[]): string[] {
  return parameters
    .filter(
      (param) =>
        param.source === 'agent' &&
        (IDENTITY_HINT.test(param.key) || IDENTITY_HINT.test(toSnake(param.field ?? '')))
    )
    .map((param) => param.key);
}

/**
 * Re-import of a changed tool: take the server's new argument list, but keep
 * what the owner decided per argument — its name for the model and where the
 * value comes from (`context` binding, fixed value). Arguments are matched by
 * their path in the tool call. Type, required flag, value list and the hint
 * text follow the server's new definition.
 */
export function mergeReimportedParameters(
  previous: DataActionParameter[],
  fresh: DataActionParameter[]
): DataActionParameter[] {
  const byPath = new Map(previous.map((param) => [param.field ?? param.key, param]));
  const merged: unknown[] = fresh.map((param) => {
    const path = param.field ?? param.key;
    const old = byPath.get(path);
    // a value the tool itself fixes (const) is not the owner's to rebind
    if (!old || param.source === 'fixed') return param;
    const { field: _field, options, ...rest } = param;
    const base = { ...rest, key: old.key, ...(path !== old.key ? { field: path } : {}) };
    if (old.source === 'context' && old.contextKey) {
      return { ...base, source: 'context', contextKey: old.contextKey, description: '' };
    }
    if (old.source === 'fixed' && old.fixedValue !== undefined && old.fixedValue !== '') {
      return { ...base, source: 'fixed', fixedValue: old.fixedValue, description: '' };
    }
    return { ...base, ...(options ? { options } : {}) };
  });
  // kept names may collide with a new argument's name — then the server's list wins
  const parsed = dataActionParametersSchema.safeParse(merged);
  return parsed.success ? parsed.data : fresh;
}

// --- tool → action draft -----------------------------------------------------------------

const ACTION_NAME = /^[a-z][a-z0-9_]{2,39}$/;

/** A valid, free data-action name for a tool ("getOrder" → "get_order", "get_order_2" …). */
export function deriveDataActionName(toolName: string, takenNames: Iterable<string>): string {
  let base = toSnake(toolName);
  if (!/^[a-z]/.test(base)) base = `tool_${base}`.replace(/_+$/, '');
  if (base.length < 3) base = `${base}_tool`;
  base = base.slice(0, 40).replace(/_+$/, '');
  if (!ACTION_NAME.test(base)) base = 'mcp_tool';
  const taken = new Set<string>([...DATA_ACTION_RESERVED_NAMES, ...takenNames]);
  return uniqueName(base, taken, 40);
}

function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  return words === '' ? '' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export interface McpActionDraft {
  name: string;
  label: string;
  description: string;
  kind: DataActionKind;
  requiresConfirmation: boolean;
  parameters: DataActionParameter[];
  dropped: string[];
}

export type McpActionDraftResult =
  { ok: true; draft: McpActionDraft } | { ok: false; issue: McpSchemaIssue; path?: string };

/**
 * The action an imported tool starts as. Deliberately cautious: only a tool the
 * server marks read-only starts as `read`; everything else is `write` and waits
 * for a team member's confirmation until the owner decides otherwise.
 */
export function draftActionFromMcpTool(
  tool: Pick<McpCatalogTool, 'name' | 'title' | 'description' | 'inputSchema' | 'readOnlyHint'>,
  takenNames: Iterable<string>
): McpActionDraftResult {
  const converted = convertMcpInputSchema(tool.inputSchema);
  if (!converted.ok) return converted;

  const title = (tool.title ?? '').replace(/\s+/g, ' ').trim() || humanize(tool.name);
  const label = (title.length >= 2 ? title : `Werkzeug ${tool.name}`).slice(0, 80);
  const text = tool.description.trim();
  const description =
    text.length >= 10
      ? text.length > 1000
        ? `${text.slice(0, 999)}…`
        : text
      : `Werkzeug „${tool.name.slice(0, 120)}“ des verbundenen MCP-Servers.`;
  const kind: DataActionKind = tool.readOnlyHint === true ? 'read' : 'write';

  return {
    ok: true,
    draft: {
      name: deriveDataActionName(tool.name, takenNames),
      label,
      description,
      kind,
      requiresConfirmation: kind === 'write',
      parameters: converted.parameters,
      dropped: converted.dropped,
    },
  };
}

// --- result ----------------------------------------------------------------------

function parseJsonContainer(text: string): unknown {
  const first = text.charAt(0);
  if (first !== '{' && first !== '[') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reduce a tool result to what the model and the run log may see. Structured
 * content (or a single text block that is JSON) goes through the action's
 * response allowlist like an HTTP response; plain text is passed as `{ text }`.
 * An error result is shown as it came — the allowlist describes the success
 * shape. Size-capping is the caller's job (capActionResult).
 */
export function mapMcpToolResult(
  result: McpToolResultData,
  responseFields: string[]
): { isError: boolean; value: unknown } {
  let value: unknown = null;
  let structured = false;
  if (result.structuredContent) {
    value = result.structuredContent;
    structured = true;
  } else {
    const text = result.texts.join('\n').trim();
    if (text !== '') {
      const parsed = result.texts.length === 1 ? parseJsonContainer(text) : undefined;
      if (parsed !== undefined) {
        value = parsed;
        structured = true;
      } else {
        value = { text };
      }
    } else if (result.otherBlocks > 0) {
      value = { note: 'non_text_content', blocks: result.otherBlocks };
    }
  }
  if (structured && !result.isError) value = mapActionResponse(value, responseFields);
  return { isError: result.isError, value };
}

// --- sync ------------------------------------------------------------------------

/** Why reading a server's tool list failed (api_connections.mcp_sync_error) — content-free. */
export type McpSyncErrorCode =
  | 'config_invalid'
  | 'blocked_url'
  | 'timeout'
  | 'network'
  | 'response_too_large'
  | 'http_error'
  | 'redirected'
  | 'protocol_error'
  | 'rpc_error'
  | 'internal';
