// Minimal in-memory stand-in for the Supabase query builder, for worker tests
// that need real row state (claims, state transitions) instead of a recording
// proxy. Supports exactly what the code under test uses: select / insert /
// update / delete with eq, in, gte, lt, lte, is, order, limit, maybeSingle,
// single and `{ count: 'exact', head: true }`.
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@zendori/core';

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface MemoryDb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  /** Rows of a table (created on first access). */
  rows(table: string): Row[];
}

class Query implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: Filter[] = [];
  private limitCount: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private returning = false;
  private mode: 'many' | 'maybeSingle' | 'single' = 'many';

  constructor(
    private readonly table: Row[],
    private readonly kind: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row | Row[] | null,
    private readonly head: boolean
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

  private run(): { data: unknown; error: null; count?: number } {
    let affected: Row[];
    if (this.kind === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      affected = list.map((row) => ({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        ...row,
      }));
      this.table.push(...affected);
    } else if (this.kind === 'update') {
      affected = this.table.filter((row) => this.matches(row));
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

  then<TResult1 = { data: unknown; error: null; count?: number }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: unknown;
          error: null;
          count?: number;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onfulfilled, onrejected);
  }
}

export function createMemoryDb(seed: Record<string, Row[]> = {}): MemoryDb {
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
          return new Query(data, 'insert', payload, false);
        },
        update(payload: Row) {
          return new Query(data, 'update', payload, false);
        },
        delete() {
          return new Query(data, 'delete', null, false);
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, tables, rows };
}
