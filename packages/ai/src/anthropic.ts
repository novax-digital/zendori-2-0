// Anthropic calls for the Phase-4 pipeline (CLAUDE.md §3, fixed models):
//  - classify + extract: claude-haiku-4-5 via messages.parse + zodOutputFormat
//    (structured outputs; no thinking, no effort — Haiku 4.5 rejects effort).
//  - draft: claude-sonnet-4-6 via messages.create with a strict-JSON system
//    prompt, defensively parsed against DraftResultSchema.
// No message content or secrets are logged here. Each call returns token usage
// plus the computed cost so the worker can log ai_runs.cost_usd per step.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AI_MODELS } from './index.js';
import { anthropicCost, type TokenUsage } from './cost.js';
import {
  buildClassifyPrompt,
  buildDraftPrompt,
  buildExtractPrompt,
  buildUserMessage,
  type DraftSource,
} from './prompts.js';
import {
  ClassificationResultSchema,
  DraftResultSchema,
  ExtractionResultSchema,
  type ClassificationResult,
  type DraftResult,
  type ExtractionResult,
} from './schemas.js';

/** Result shape shared by every Anthropic call: parsed result + usage + cost. */
export interface AiCallResult<T> {
  result: T;
  usage: TokenUsage;
  costUsd: number;
}

let cachedClient: Anthropic | undefined;

/** Lazily construct the Anthropic client, reading the key from process.env. */
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt.');
  // ANTHROPIC_API_BASE lets tests point the client at a local mock server.
  const baseURL = process.env.ANTHROPIC_API_BASE;
  cachedClient = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return cachedClient;
}

function toUsage(usage: { input_tokens: number | null; output_tokens: number }): TokenUsage {
  return { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens };
}

export interface ClassifyInput {
  companyName: string;
  toneInstructions?: string | null;
  channelType: string;
  subject?: string | null;
  body: string;
}

/** Classify an inbound message (language, intent, priority, spam/auto-reply). */
export async function classify(input: ClassifyInput): Promise<AiCallResult<ClassificationResult>> {
  const client = getClient();
  const message = await client.messages.parse({
    model: AI_MODELS.classify,
    max_tokens: 1024,
    system: buildClassifyPrompt({
      companyName: input.companyName,
      toneInstructions: input.toneInstructions,
    }),
    messages: [
      {
        role: 'user',
        content: buildUserMessage({
          channelType: input.channelType,
          subject: input.subject,
          body: input.body,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(ClassificationResultSchema) },
  });
  const result = message.parsed_output;
  if (!result) throw new Error('Die Klassifikation lieferte kein gültiges Ergebnis.');
  const usage = toUsage(message.usage);
  return { result, usage, costUsd: anthropicCost(AI_MODELS.classify, usage) };
}

export interface ExtractInput {
  companyName: string;
  categories: readonly string[];
  toneInstructions?: string | null;
  channelType: string;
  subject?: string | null;
  body: string;
}

/** Extract the real sender and request (ticketisation) from a message. */
export async function extract(input: ExtractInput): Promise<AiCallResult<ExtractionResult>> {
  const client = getClient();
  const message = await client.messages.parse({
    model: AI_MODELS.classify,
    max_tokens: 4096,
    system: buildExtractPrompt({
      companyName: input.companyName,
      categories: input.categories,
      toneInstructions: input.toneInstructions,
    }),
    messages: [
      {
        role: 'user',
        content: buildUserMessage({
          channelType: input.channelType,
          subject: input.subject,
          body: input.body,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(ExtractionResultSchema) },
  });
  const result = message.parsed_output;
  if (!result) throw new Error('Die Extraktion lieferte kein gültiges Ergebnis.');
  const usage = toUsage(message.usage);
  return { result, usage, costUsd: anthropicCost(AI_MODELS.classify, usage) };
}

export interface DraftInput {
  companyName: string;
  toneInstructions?: string | null;
  channelType: string;
  subject?: string | null;
  body: string;
  language?: string | null;
  sources: DraftSource[];
}

/** Produce a RAG answer draft with confidence and used source ids. */
export async function draft(input: DraftInput): Promise<AiCallResult<DraftResult>> {
  const client = getClient();
  const message = await client.messages.create({
    model: AI_MODELS.draft,
    max_tokens: 1500,
    system: buildDraftPrompt({
      companyName: input.companyName,
      toneInstructions: input.toneInstructions,
      sources: input.sources,
      language: input.language,
    }),
    messages: [
      {
        role: 'user',
        content: buildUserMessage({
          channelType: input.channelType,
          subject: input.subject,
          body: input.body,
        }),
      },
    ],
  });
  const result = parseDraftResponse(extractText(message));
  const usage = toUsage(message.usage);
  return { result, usage, costUsd: anthropicCost(AI_MODELS.draft, usage) };
}

/** Concatenate the text blocks of a message response. */
function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0.3;
  return Math.min(1, Math.max(0, value));
}

/** Try to isolate a JSON object from raw model text (handles code fences/prose). */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * Defensively parse the draft model's response. On any parse/validation failure
 * the whole text becomes the reply with a low confidence (0.3) — a safe default
 * since this is only a draft, never auto-sent in Phase 4.
 */
export function parseDraftResponse(text: string): DraftResult {
  const candidate = extractJsonObject(text);
  if (candidate !== undefined) {
    const parsed = DraftResultSchema.safeParse(candidate);
    if (parsed.success) {
      return {
        reply: parsed.data.reply,
        confidence: clampConfidence(parsed.data.confidence),
        used_source_ids: parsed.data.used_source_ids,
      };
    }
  }
  return { reply: text, confidence: 0.3, used_source_ids: [] };
}
