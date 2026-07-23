import { Pool } from "pg";
import { Program } from "../domain/types";
import { ProgramStore } from "./store";

/**
 * Durable persistence for Program (object/finding/state/audit) records —
 * replaces InMemoryProgramStore, which lost everything on every restart
 * (docs/design/clean-core-migration-design.md §7: "relational DB for
 * object/finding/state/audit tracking").
 *
 * The whole Program is stored as one JSONB blob per row rather than
 * normalized across tables — the domain model is a single nested object
 * with no cross-program relationships, so there's nothing a relational
 * schema would buy here that JSONB-plus-an-id-index doesn't already give.
 *
 * Deliberately namespaced into its own `fs2cc` schema, not the default
 * `public` one: this Postgres instance (`zepcappg-postgres`, a BTP
 * "postgresql-db" free-tier service) is shared across several unrelated
 * apps' bindings in this space (zepcappg-srv, zepcapjournal5-srv,
 * fs2-bp-ext-app-srv, ...) against what turned out to be the *same*
 * underlying database (each binding gets its own role/credentials, not an
 * isolated database as first assumed) — a bare `programs` table name in
 * `public` would risk colliding with, or shadowing, another app's table.
 */
export class PostgresProgramStore implements ProgramStore {
  private pool: Pool;
  private static readonly SCHEMA = "fs2cc";
  private static readonly TABLE = "fs2cc.programs";

  constructor(connectionString: string, ssl: { rejectUnauthorized: boolean; ca?: string }) {
    this.pool = new Pool({ connectionString, ssl });
  }

  /** Must be awaited once before first use — see server/src/store/index.ts. */
  async init(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${PostgresProgramStore.SCHEMA}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${PostgresProgramStore.TABLE} (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async save(program: Program): Promise<Program> {
    program.updatedAt = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO ${PostgresProgramStore.TABLE} (id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = $4`,
      [program.id, JSON.stringify(program), program.createdAt, program.updatedAt]
    );
    return program;
  }

  async get(id: string): Promise<Program | undefined> {
    const result = await this.pool.query(`SELECT data FROM ${PostgresProgramStore.TABLE} WHERE id = $1`, [id]);
    return result.rows[0]?.data;
  }

  async list(): Promise<Program[]> {
    const result = await this.pool.query(`SELECT data FROM ${PostgresProgramStore.TABLE} ORDER BY created_at ASC`);
    return result.rows.map((r) => r.data);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${PostgresProgramStore.TABLE} WHERE id = $1`, [id]);
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM ${PostgresProgramStore.TABLE}`);
  }
}
