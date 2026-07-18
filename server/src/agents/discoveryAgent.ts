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
 */
export async function runDiscovery(programName: string, sap: SapClient): Promise<DiscoveryResult> {
  const programSource = await sap.readObjectSource(programName);
  const dependencies = await sap.getDependencies(programName);
  const dependencySources = await Promise.all(
    dependencies.map((dep) => sap.readObjectSource(dep.name))
  );
  return { programSource, dependencies, dependencySources };
}
