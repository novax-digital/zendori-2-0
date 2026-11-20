// Minimal in-memory stand-in for the Supabase query builder, for tests that
// need real row state instead of a recording proxy. Supports exactly what the
// code under test uses: select / insert / update / delete with eq, in, gte, lt,
// lte, is, order, limit, maybeSingle, single and `{ count: 'exact', head: true }`
// — plus unique constraints (a violating insert/update returns SQLSTATE 23505,
// like PostgREST does). Sibling of apps/worker/test/memory-supabase.ts.
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '../src/db.js';

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type QueryResult = { data: unknown; error: { code: string } | null; count?: number };
/** Column sets that must be unique within a table. */
export type UniqueConstraints = Record<string, string[][]>;

export interface MemoryDb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  /** Rows of a table (created on first access). */
  rows(table: string): Row[];
}

class Query implements PromiseLike<QueryResult> {
  private filters: Filter[] = [];
  private limitCount: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private returning = false;
  private mode: 'many' | 'maybeSingle' | 'single' = 'many';

  constructor(
    private readonly table: Row[],
    private readonly kind: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row | Row[] | null,
    private readonly head: boolean,
    private readonly unique: string[][] = []
  ) {
    if (kind === 'select') this.returning = true;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  gte(column: string, value: string | number): this {
    this.filters.push((row) => (row[column] as string | number) >= value);
    return this;
  }
  lt(column: string, value: string | number): this {
    this.filters.push((row) => row[column] != null && (row[column] as string | number) < value);
    return this;
  }
  lte(column: string, value: string | number): this {
    this.filters.push((row) => row[column] != null && (row[column] as string | number) <= value);
    return this;
  }
  is(column: string, value: null): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  select(): this {
    this.returning = true;
    return this;
  }
  maybeSingle(): this {
    this.mode = 'maybeSingle';
    return this;
  }
  single(): this {
    this.mode = 'single';
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => filter(row));
  }

  /** True when `candidate` collides with another row on a unique column set. */
  private violatesUnique(candidate: Row, self: Row | null): boolean {
    return this.unique.some((columns) =>
      this.table.some(
        (row) =>
          row !== self &&
          columns.every((column) => row[column] != null && row[column] === candidate[column])
      )
    );
  }

  private run(): QueryResult {
    let affected: Row[];
    if (this.kind === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      affected = list.map((row) => ({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        ...row,
      }));
      if (affected.some((row) => this.violatesUnique(row, null))) {
        return { data: null, error: { code: '23505' } };
      }
      this.table.push(...affected);
    } else if (this.kind === 'update') {
      affected = this.table.filter((row) => this.matches(row));
      if (affected.some((row) => this.violatesUnique({ ...row, ...(this.payload as Row) }, row))) {
        return { data: null, error: { code: '23505' } };
      }
      for (const row of affected) Object.assign(row, this.payload as Row);
    } else if (this.kind === 'delete') {
      affected = this.table.filter((row) => this.matches(row));
      for (const row of affected) this.table.splice(this.table.indexOf(row), 1);
    } else {
      affected = this.table.filter((row) => this.matches(row));
    }

    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      affected = [...affected].sort((a, b) => {
        const left = a[column] as string | number;
        const right = b[column] as string | number;
        return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    const count = affected.length;
    if (this.limitCount !== null) affected = affected.slice(0, this.limitCount);

    if (this.head) return { data: null, error: null, count };
    if (!this.returning) return { data: null, error: null };
    // Copies, so the code under test cannot mutate table state by accident.
    const copies = affected.map((row) => ({ ...row }));
    if (this.mode === 'many') return { data: copies, error: null, count };
    return { data: copies[0] ?? null, error: null };
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onfulfilled, onrejected);
  }
}

export function createMemoryDb(
  seed: Record<string, Row[]> = {},
  unique: UniqueConstraints = {}
): MemoryDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const rows = (table: string): Row[] => {
    if (!tables[table]) tables[table] = [];
    return tables[table] as Row[];
  };

  const client = {
    from(table: string) {
      const data = rows(table);
      return {
        select(_columns?: string, options?: { count?: string; head?: boolean }) {
          return new Query(data, 'select', null, options?.head === true);
        },
        insert(payload: Row | Row[]) {
          return new Query(data, 'insert', payload, false, unique[table]);
        },
        update(payload: Row) {
          return new Query(data, 'update', payload, false, unique[table]);
        },
        delete() {
          return new Query(data, 'delete', null, false);
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, tables, rows };
}
