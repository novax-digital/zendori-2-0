import type { Logger } from '@zendori/core';
import { summarizeCompanyWebsite } from '@zendori/ai';
import { crawledHtmlToText, safeFetch } from '../pipeline/index-source.js';
import { toErrorInfo } from '../db.js';

// Demo-Anruf (0032): one-page company briefing from the lead's homepage. Uses
// the KB crawler's SSRF-hardened fetch (public addresses only, manual
// re-validated redirects). Best-effort: any failure → null and the demo runs
// without company knowledge (the prompt then forbids inventing facts).

export const WEBSITE_SUMMARY_MAX_CHARS = 1500;
const MAX_HTML_CHARS = 1_000_000;
const MIN_TEXT_CHARS = 80;
/** Whole step budget — the lead is waiting for the phone to ring. */
const STEP_TIMEOUT_MS = 15_000;

async function summarize(url: string, companyName: string): Promise<string | null> {
  const response = await safeFetch(url);
  if (!response.ok) return null;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('html')) return null;
  const html = (await response.text()).slice(0, MAX_HTML_CHARS);
  const text = crawledHtmlToText(html).trim();
  if (text.length < MIN_TEXT_CHARS) return null;
  const { result } = await summarizeCompanyWebsite({ companyName, pageText: text });
  if (!result.usable) return null;
  const profile = result.profile.trim().slice(0, WEBSITE_SUMMARY_MAX_CHARS);
  return profile.length > 0 ? profile : null;
}

export async function buildWebsiteSummary(
  url: string,
  companyName: string,
  logger: Logger,
  demoCallId: string
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      summarize(url, companyName),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STEP_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    logger.warn({ demoCallId, err: toErrorInfo(err) }, 'demo website summary failed');
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
