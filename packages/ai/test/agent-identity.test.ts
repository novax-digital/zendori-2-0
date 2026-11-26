import { describe, expect, it } from 'vitest';
import { AGENT_IDENTITY_MAX_CHARS, cleanAgentIdentity } from '../src/anthropic.js';

// The suggested identity goes into a form field as it is — wrappers a model
// sometimes adds must not end up in an agent's system prompt.

describe('cleanAgentIdentity', () => {
  it('leaves a plain text alone, apart from the space around it', () => {
    expect(cleanAgentIdentity('\n  Du bist Lisa.\n- Du duzt Kunden.\n')).toBe(
      'Du bist Lisa.\n- Du duzt Kunden.'
    );
  });

  it('takes a code fence off', () => {
    expect(cleanAgentIdentity('```\nDu bist Lisa.\n```')).toBe('Du bist Lisa.');
    expect(cleanAgentIdentity('```text\nDu bist Lisa.\n- kurz\n```')).toBe('Du bist Lisa.\n- kurz');
  });

  it('takes quotes off only when they wrap the whole text', () => {
    expect(cleanAgentIdentity('„Du bist Lisa.“')).toBe('Du bist Lisa.');
    expect(cleanAgentIdentity('"Du bist Lisa."')).toBe('Du bist Lisa.');
    // quotes inside belong to the text
    const quoting = '„Du bist Lisa.“ Sage niemals „garantiert“';
    expect(cleanAgentIdentity(quoting)).toBe(quoting);
    const example = 'Du bist Lisa. Beginne mit „Hallo“.';
    expect(cleanAgentIdentity(example)).toBe(example);
  });

  it('never exceeds what the identity field takes', () => {
    expect(cleanAgentIdentity('a'.repeat(AGENT_IDENTITY_MAX_CHARS + 500))).toHaveLength(
      AGENT_IDENTITY_MAX_CHARS
    );
  });

  it('an empty answer stays empty', () => {
    expect(cleanAgentIdentity('  \n ')).toBe('');
    expect(cleanAgentIdentity('```\n```')).toBe('');
  });
});
