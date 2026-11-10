/**
 * D1 Database Adapter
 *
 * Wraps Cloudflare D1 binding with typed query interface.
 * Uses prepared statements (FR-402) and batch writes (FR-403).
 * Compatible API shape for use alongside SQLite in Node runtime.
 *
 * Bounded context: integration-core
 */

// --- Types ---

/** Cloudflare D1 binding interface (minimal subset) */
export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<D1ExecResult>
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
  raw<T = unknown[]>(): Promise<T[]>
}

export interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: {
    duration: number
    rows_read: number
    rows_written: number
  }
}

export interface D1ExecResult {
  count: number
  duration: number
}

// --- Adapter ---

export interface D1QueryResult<T> {
  ok: true
  rows: T[]
  meta: { duration: number; rowsRead: number; rowsWritten: number }
}

export interface D1QueryError {
  ok: false
  error: string
  code: "query_error" | "binding_error" | "timeout"
}

export type D1AdapterResult<T> = D1QueryResult<T> | D1QueryError

export class D1Adapter {
  private readonly db: D1Database

  constructor(db: D1Database) {
    this.db = db
  }

  /**
   * Execute a SELECT query with prepared statement (FR-402).
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<D1AdapterResult<T>> {
    try {
      const stmt = this.db.prepare(sql).bind(...params)
      const result = await stmt.all<T>()
      return {
        ok: true,
        rows: result.results,
        meta: {
          duration: result.meta.duration,
          rowsRead: result.meta.rows_read,
          rowsWritten: result.meta.rows_written,
        },
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown D1 query error",
        code: "query_error",
      }
    }
  }

  /**
   * Execute a single mutation (INSERT/UPDATE/DELETE) with prepared statement.
   */
  async execute(sql: string, params: unknown[] = []): Promise<D1AdapterResult<never>> {
    try {
      const stmt = this.db.prepare(sql).bind(...params)
      const result = await stmt.run()
      return {
        ok: true,
        rows: [],
        meta: {
          duration: result.meta.duration,
          rowsRead: result.meta.rows_read,
          rowsWritten: result.meta.rows_written,
        },
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown D1 execute error",
        code: "query_error",
      }
    }
  }

  /**
   * Batch multiple mutations atomically (FR-403).
   * D1 auto-commits per statement — batch provides atomicity.
   */
  async batch(
    operations: Array<{ sql: string; params?: unknown[] }>
  ): Promise<D1AdapterResult<never>> {
    try {
      const statements = operations.map((op) =>
        this.db.prepare(op.sql).bind(...(op.params ?? []))
      )
      const results = await this.db.batch(statements)

      const totalDuration = results.reduce((sum, r) => sum + r.meta.duration, 0)
      const totalRowsWritten = results.reduce((sum, r) => sum + r.meta.rows_written, 0)

      return {
        ok: true,
        rows: [],
        meta: {
          duration: totalDuration,
          rowsRead: 0,
          rowsWritten: totalRowsWritten,
        },
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown D1 batch error",
        code: "query_error",
      }
    }
  }

  /**
   * Get a single row by query.
   */
  async first<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | null> {
    try {
      const stmt = this.db.prepare(sql).bind(...params)
      return await stmt.first<T>()
    } catch {
      return null
    }
  }
}
