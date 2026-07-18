import { Program } from "../domain/types";

/**
 * In-memory program store. Swappable for a bound Postgres/HANA service
 * (see docs/design/clean-core-migration-design.md §6.5) — the interface is
 * intentionally narrow so a persistent implementation is a drop-in.
 */
export interface ProgramStore {
  save(program: Program): Program;
  get(id: string): Program | undefined;
  list(): Program[];
  clear(): void;
}

export class InMemoryProgramStore implements ProgramStore {
  private programs = new Map<string, Program>();

  save(program: Program): Program {
    program.updatedAt = new Date().toISOString();
    this.programs.set(program.id, program);
    return program;
  }

  get(id: string): Program | undefined {
    return this.programs.get(id);
  }

  list(): Program[] {
    return Array.from(this.programs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  clear(): void {
    this.programs.clear();
  }
}

export const programStore = new InMemoryProgramStore();
