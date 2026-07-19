import { DependencyObject } from "../domain/types";
import { ObjectSource, SapClient } from "../sap/SapClient";

export interface DiscoveryResult {
  programSource: ObjectSource;
  dependencies: DependencyObject[];
  dependencySources: ObjectSource[];
}

/**
 * Pulls the program's source and its full dependency tree (includes,
 * classes, function modules, tables/CDS views) via the SAP client, so both
 * the Git Sync Agent and the Clean Core Analysis Agent have everything they
 * need without re-querying SAP themselves.
 *
 * Dependency source reads are best-effort: ADT addresses different object
 * types (tables, CDS views, function modules...) via different URI
 * patterns, and only the program-source endpoint is implemented so far
 * (see RealAdtClient). A dependency whose source can't be fetched yet still
 * shows up in the dependency list — with a placeholder body, not silently
 * dropped — rather than failing the whole discovery run over one
 * unimplemented object-type endpoint.
 */
export async function runDiscovery(programName: string, sap: SapClient): Promise<DiscoveryResult> {
  const programSource = await sap.readObjectSource(programName);
  const dependencies = await sap.getDependencies(programName);
  const dependencySources = await Promise.all(
    dependencies.map(async (dep) => {
      try {
        return await sap.readObjectSource(dep.name);
      } catch (err) {
        return {
          name: dep.name,
          type: dep.type,
          source: `-- source not retrieved (${dep.type} objects aren't readable via the current ADT integration yet): ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    })
  );
  return { programSource, dependencies, dependencySources };
}
