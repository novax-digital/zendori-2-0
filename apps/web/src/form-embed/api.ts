import type { FormBootstrapResponse, FormValues, PublicFormDefinition } from './types';

/**
 * HTTP layer for /api/forms/*. Responses are shape-checked by hand (no zod in
 * the browser bundle); the server validates all inputs with zod.
 */

export class FormApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`Form API request failed with status ${status}`);
    this.name = 'FormApiError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let code: string | null = null;
    try {
      const data: unknown = await response.json();
      if (isRecord(data) && typeof data.code === 'string') code = data.code;
    } catch {
      // no JSON body — keep code null
    }
    throw new FormApiError(response.status, code);
  }
  return (await response.json()) as unknown;
}

function parseDefinition(value: unknown): PublicFormDefinition | null {
  if (!isRecord(value) || !Array.isArray(value.fields) || !isRecord(value.design)) return null;
  return value as unknown as PublicFormDefinition;
}

export async function fetchFormBootstrap(
  apiBase: string,
  token: string
): Promise<FormBootstrapResponse> {
  const data = await postJson(`${apiBase}/api/forms/bootstrap`, { token });
  if (!isRecord(data) || typeof data.renderToken !== 'string') {
    throw new Error('Form API returned an unexpected response shape');
  }
  const definition = parseDefinition(data.definition);
  if (!definition) throw new Error('Form API returned an unexpected response shape');
  return {
    name: typeof data.name === 'string' ? data.name : '',
    definition,
    renderToken: data.renderToken,
  };
}

export interface SubmitResult {
  ok: true;
  successMessage: string | null;
}

export async function submitForm(
  apiBase: string,
  params: {
    token: string;
    clientSubmissionId: string;
    renderToken: string;
    values: FormValues;
  }
): Promise<SubmitResult> {
  const data = await postJson(`${apiBase}/api/forms/submit`, params);
  if (!isRecord(data) || data.ok !== true) {
    throw new Error('Form API returned an unexpected response shape');
  }
  return {
    ok: true,
    successMessage: typeof data.successMessage === 'string' ? data.successMessage : null,
  };
}
