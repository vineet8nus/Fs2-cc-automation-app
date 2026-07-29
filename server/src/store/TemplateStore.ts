export type TemplateKey = "tsd" | "unit_test";

export interface StoredTemplate {
  key: TemplateKey;
  filename: string;
  data: Buffer;
  uploadedAt: string;
}

/**
 * Org-wide document templates (one TSD .docx, one Unit Test .xlsx) an admin
 * uploads once and every program's generated docs are filled from — not
 * per-program state, so this is deliberately a separate store from
 * ProgramStore.
 */
export interface TemplateStore {
  save(key: TemplateKey, filename: string, data: Buffer): Promise<StoredTemplate>;
  get(key: TemplateKey): Promise<StoredTemplate | undefined>;
}

export class InMemoryTemplateStore implements TemplateStore {
  private templates = new Map<TemplateKey, StoredTemplate>();

  async save(key: TemplateKey, filename: string, data: Buffer): Promise<StoredTemplate> {
    const stored: StoredTemplate = { key, filename, data, uploadedAt: new Date().toISOString() };
    this.templates.set(key, stored);
    return stored;
  }

  async get(key: TemplateKey): Promise<StoredTemplate | undefined> {
    return this.templates.get(key);
  }
}
