import { InMemoryProgramStore, ProgramStore } from "./store";
import { PostgresProgramStore } from "./PostgresProgramStore";

/**
 * Selects a durable Postgres-backed store whenever one is actually bound
 * (VCAP_SERVICES carries a "postgresql-db" entry — see `cf bind-service
 * fs2-cc-automation-app zepcappg-postgres`), falling back to the in-memory
 * store otherwise (local dev, tests, or if init/connection genuinely fails
 * — logged loudly rather than silently losing durability with no trace).
 *
 * Async because PostgresProgramStore.init() must run (create schema/table)
 * before the store is safe to use — callers must `await` this once at
 * startup, before constructing the app (see index.ts). createApp() itself
 * stays synchronous and unaware of any of this: it just receives an
 * already-initialized ProgramStore.
 */
export async function createProgramStore(): Promise<ProgramStore> {
  const vcapRaw = process.env.VCAP_SERVICES;
  if (!vcapRaw) return new InMemoryProgramStore();

  let credentials: { uri?: string; sslrootcert?: string; sslcert?: string } | undefined;
  try {
    const vcap = JSON.parse(vcapRaw);
    credentials = vcap["postgresql-db"]?.[0]?.credentials;
  } catch {
    console.warn("[store] VCAP_SERVICES present but not valid JSON — falling back to in-memory store.");
    return new InMemoryProgramStore();
  }

  if (!credentials?.uri) return new InMemoryProgramStore();

  try {
    const store = new PostgresProgramStore(credentials.uri, {
      rejectUnauthorized: true,
      ca: credentials.sslrootcert ?? credentials.sslcert,
    });
    await store.init();
    console.log("[store] Using PostgresProgramStore (durable) — schema/table confirmed.");
    return store;
  } catch (err) {
    console.warn(
      `[store] Postgres binding present but init failed (${err instanceof Error ? err.message : String(err)}) — falling back to in-memory store. Programs will NOT survive a restart.`
    );
    return new InMemoryProgramStore();
  }
}

export * from "./store";
