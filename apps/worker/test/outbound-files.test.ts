import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@zendori/core';
import {
  loadReleasedFiles,
  persistOutboundAttachments,
  resolveReleasedFiles,
  type LoadedFile,
} from '../src/pipeline/outbound-files.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SOURCE_A = '22222222-2222-4222-8222-222222222222';
const SOURCE_B = '33333333-3333-4333-8333-333333333333';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

/**
 * Minimal stand-in for the chained Supabase query builder: every filter returns
 * `this` and the terminal call resolves. `filters` records what was asked for so a
 * test can assert the gate was applied at the DATABASE, not in JS afterwards —
 * which is the whole security property of the release flag.
 */
function stubSelect(result: { data?: unknown; error?: unknown }) {
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    },
    in: (column: string, value: unknown) => {
      filters[`in:${column}`] = value;
      return builder;
    },
    limit: (value: number) => {
      filters.limit = value;
      return Promise.resolve({ data: result.data ?? [], error: result.error ?? null });
    },
  };
  return { builder, filters };
}

function clientWithSources(result: { data?: unknown; error?: unknown }) {
  const stub = stubSelect(result);
  let queried = 0;
  const client = {
    from: (table: string) => {
      if (table !== 'kb_sources') throw new Error(`unexpected table ${table}`);
      queried += 1;
      return stub.builder;
    },
  } as unknown as SupabaseClient;
  return { client, filters: stub.filters, queryCount: () => queried };
}

describe('resolveReleasedFiles', () => {
  it('asks the database for released files only, and never for other orgs', async () => {
    const { client, filters } = clientWithSources({
      data: [{ id: SOURCE_A, uri: 'anleitung.pdf' }],
    });

    const files = await resolveReleasedFiles(client, {
      orgId: ORG,
      usedSourceIds: [SOURCE_A],
    });

    // The two gates that make this safe must be SQL predicates.
    expect(filters.is_shareable).toBe(true);
    expect(filters.org_id).toBe(ORG);
    expect(filters.type).toBe('file');
    expect(filters.status).toBe('indexed');
    expect(filters['in:id']).toEqual([SOURCE_A]);

    expect(files).toEqual([
      {
        sourceId: SOURCE_A,
        filename: 'anleitung.pdf',
        storagePath: `${ORG}/${SOURCE_A}/anleitung.pdf`,
      },
    ]);
  });

  it('does not query at all when the answer used no sources', async () => {
    const { client, queryCount } = clientWithSources({ data: [] });
    await expect(resolveReleasedFiles(client, { orgId: ORG, usedSourceIds: [] })).resolves.toEqual(
      []
    );
    expect(queryCount()).toBe(0);
  });

  it('deduplicates repeated source ids from the model', async () => {
    const { client, filters } = clientWithSources({ data: [] });
    await resolveReleasedFiles(client, {
      orgId: ORG,
      usedSourceIds: [SOURCE_A, SOURCE_A, SOURCE_B, ''],
    });
    expect(filters['in:id']).toEqual([SOURCE_A, SOURCE_B]);
  });

  // Pre-0025 the column does not exist. Sending text is the correct degradation.
  it('sends nothing rather than failing when the column is missing', async () => {
    const { client } = clientWithSources({ error: { code: '42703' } });
    await expect(
      resolveReleasedFiles(client, { orgId: ORG, usedSourceIds: [SOURCE_A] })
    ).resolves.toEqual([]);
  });

  it('skips rows whose filename is missing', async () => {
    const { client } = clientWithSources({
      data: [
        { id: SOURCE_A, uri: null },
        { id: SOURCE_B, uri: 'foto.png' },
      ],
    });
    const files = await resolveReleasedFiles(client, {
      orgId: ORG,
      usedSourceIds: [SOURCE_A, SOURCE_B],
    });
    expect(files.map((f) => f.filename)).toEqual(['foto.png']);
  });
});

/** Storage stub: serves bytes per path, or an error for paths not listed. */
function clientWithStorage(byPath: Record<string, Buffer>) {
  const client = {
    storage: {
      from: () => ({
        download: (path: string) => {
          const bytes = byPath[path];
          if (!bytes) return Promise.resolve({ data: null, error: { message: 'not found' } });
          return Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(bytes) },
            error: null,
          });
        },
      }),
    },
  } as unknown as SupabaseClient;
  return client;
}

describe('loadReleasedFiles', () => {
  it('derives an image type from the bytes, not from the filename', async () => {
    // Named .pdf but really a PNG — the recipient must be told what it IS.
    const path = `${ORG}/${SOURCE_A}/getarnt.pdf`;
    const loaded = await loadReleasedFiles(clientWithStorage({ [path]: PNG_BYTES }), [
      { sourceId: SOURCE_A, filename: 'getarnt.pdf', storagePath: path },
    ]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.mime).toBe('image/png');
  });

  it('falls back to the extension for non-image files', async () => {
    const path = `${ORG}/${SOURCE_A}/handbuch.pdf`;
    const loaded = await loadReleasedFiles(
      clientWithStorage({ [path]: Buffer.from('%PDF-1.7 ...', 'utf8') }),
      [{ sourceId: SOURCE_A, filename: 'handbuch.pdf', storagePath: path }]
    );
    expect(loaded[0]?.mime).toBe('application/pdf');
  });

  it('drops a missing file instead of throwing, so the text still sends', async () => {
    const loaded = await loadReleasedFiles(clientWithStorage({}), [
      { sourceId: SOURCE_A, filename: 'weg.png', storagePath: 'fehlt' },
    ]);
    expect(loaded).toEqual([]);
  });

  it('drops empty files', async () => {
    const path = `${ORG}/${SOURCE_A}/leer.png`;
    const loaded = await loadReleasedFiles(clientWithStorage({ [path]: Buffer.alloc(0) }), [
      { sourceId: SOURCE_A, filename: 'leer.png', storagePath: path },
    ]);
    expect(loaded).toEqual([]);
  });

  it('enforces the per-message total so one reply cannot ship 30 MB', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    const pathA = `${ORG}/${SOURCE_A}/a.pdf`;
    const pathB = `${ORG}/${SOURCE_B}/b.pdf`;
    const pathC = `${ORG}/${SOURCE_B}/c.pdf`;
    const loaded = await loadReleasedFiles(
      clientWithStorage({ [pathA]: big, [pathB]: big, [pathC]: big }),
      [
        { sourceId: SOURCE_A, filename: 'a.pdf', storagePath: pathA },
        { sourceId: SOURCE_B, filename: 'b.pdf', storagePath: pathB },
        { sourceId: SOURCE_B, filename: 'c.pdf', storagePath: pathC },
      ]
    );
    // 9 + 9 fits under 20 MB; the third would exceed it.
    expect(loaded).toHaveLength(2);
  });

  it('drops a single file over the per-file cap', async () => {
    const path = `${ORG}/${SOURCE_A}/riesig.pdf`;
    const loaded = await loadReleasedFiles(
      clientWithStorage({ [path]: Buffer.alloc(11 * 1024 * 1024, 1) }),
      [{ sourceId: SOURCE_A, filename: 'riesig.pdf', storagePath: path }]
    );
    expect(loaded).toEqual([]);
  });
});

describe('persistOutboundAttachments', () => {
  const MESSAGE = '44444444-4444-4444-8444-444444444444';

  function file(name: string): LoadedFile {
    return {
      sourceId: SOURCE_A,
      filename: name,
      storagePath: `${ORG}/${SOURCE_A}/${name}`,
      bytes: PNG_BYTES,
      mime: 'image/png',
    };
  }

  it('stores under the message id and reports the new attachments path', async () => {
    const uploads: { path: string; contentType?: string }[] = [];
    const inserts: Record<string, unknown>[] = [];
    const client = {
      storage: {
        from: () => ({
          upload: (path: string, _bytes: Buffer, opts: { contentType?: string }) => {
            uploads.push({ path, contentType: opts?.contentType });
            return Promise.resolve({ error: null });
          },
        }),
      },
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    const stored = await persistOutboundAttachments(client, {
      orgId: ORG,
      messageId: MESSAGE,
      files: [file('foto.png')],
    });

    // Path must start with the org id: the storage policy scopes access by the
    // first segment, so anything else would be readable by the wrong tenant.
    expect(uploads[0]?.path).toBe(`${ORG}/${MESSAGE}/foto.png`);
    expect(uploads[0]?.contentType).toBe('image/png');
    expect(inserts[0]).toMatchObject({
      org_id: ORG,
      message_id: MESSAGE,
      mime: 'image/png',
      size: PNG_BYTES.byteLength,
    });
    expect(stored[0]?.storagePath).toBe(`${ORG}/${MESSAGE}/foto.png`);
    // The bytes ride along so the email path does not download them twice.
    expect(stored[0]?.bytes).toBe(PNG_BYTES);
  });

  it('reports nothing stored when the upload fails', async () => {
    const client = {
      storage: { from: () => ({ upload: () => Promise.resolve({ error: { message: 'nope' } }) }) },
      from: () => ({ insert: () => Promise.resolve({ error: null }) }),
    } as unknown as SupabaseClient;
    await expect(
      persistOutboundAttachments(client, { orgId: ORG, messageId: MESSAGE, files: [file('a.png')] })
    ).resolves.toEqual([]);
  });
});
