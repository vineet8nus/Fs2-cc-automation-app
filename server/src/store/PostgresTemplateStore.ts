import { Pool } from "pg";
import { StoredTemplate, TemplateKey, TemplateStore } from "./TemplateStore";

/** Durable storage for the two org-wide document templates — same schema/pattern as PostgresProgramStore, own table since it's unrelated data. */
export class PostgresTemplateStore implements TemplateStore {
  private pool: Pool;
  private static readonly SCHEMA = "fs2cc";
  private static readonly TABLE = "fs2cc.templates";

  constructor(connectionString: string, ssl: { rejectUnauthorized: boolean; ca?: string }) {
    this.pool = new Pool({ connectionString, ssl });
  }

  /** Must be awaited once before first use — see server/src/store/index.ts. */
  async init(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${PostgresTemplateStore.SCHEMA}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${PostgresTemplateStore.TABLE} (
        key TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        data BYTEA NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async save(key: TemplateKey, filename: string, data: Buffer): Promise<StoredTemplate> {
    const uploadedAt = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO ${PostgresTemplateStore.TABLE} (key, filename, data, uploaded_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET filename = $2, data = $3, uploaded_at = $4`,
      [key, filename, data, uploadedAt]
    );
    return { key, filename, data, uploadedAt };
  }

  async get(key: TemplateKey): Promise<StoredTemplate | undefined> {
    const result = await this.pool.query(`SELECT key, filename, data, uploaded_at FROM ${PostgresTemplateStore.TABLE} WHERE key = $1`, [key]);
    const row = result.rows[0];
    if (!row) return undefined;
    return { key: row.key, filename: row.filename, data: row.data, uploadedAt: row.uploaded_at.toISOString() };
  }
}
