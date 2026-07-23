import { Program } from "../domain/types";

/**
 * Async so a real persistent implementation (PostgresProgramStore) is a
 * drop-in — see docs/design/clean-core-migration-design.md §6.5. Every call
 * site was already inside an async function/handler, so this was a
 * mechanical `await`-adding change, not a control-flow rewrite.
 */
export interface ProgramStore {
  save(program: Program): Promise<Program>;
  get(id: string): Promise<Program | undefined>;
  list(): Promise<Program[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryProgramStore implements ProgramStore {
  private programs = new Map<string, Program>();

  async save(program: Program): Promise<Program> {
    program.updatedAt = new Date().toISOString();
    this.programs.set(program.id, program);
    return program;
  }

  async get(id: string): Promise<Program | undefined> {
    return this.programs.get(id);
  }

  async list(): Promise<Program[]> {
    return Array.from(this.programs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(id: string): Promise<void> {
    this.programs.delete(id);
  }

  async clear(): Promise<void> {
    this.programs.clear();
  }
}

export const programStore = new InMemoryProgramStore();
