import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { DependencyObject } from "../domain/types";
import { AtcRawFinding, ObjectSource, SapClient, UnitTestCaseResult } from "./SapClient";
import { extractDependencies, runStaticAtcRules } from "./staticCleanCoreRules";

/**
 * Real connectivity to SHD200SYSTEM (RISE S/4HANA 2023, client 200) over the
 * ADT REST API, via the BTP destination + Cloud Connector on-premise proxy
 * (confirmed live per docs/design/clean-core-migration-design.md §3a/§9 —
 * BasicAuthentication against a named user, routed through Cloud Connector
 * location "Training-BC-Dev").
 *
 * Status: read path is implemented — readObjectSource (live ADT source
 * read), getDependencies (static-text extraction, not a full ADT
 * where-used call), runAtcCheck (a static rule engine standing in for real
 * ATC — see staticCleanCoreRules.ts), and runAbapUnit (honestly returns no
 * cases rather than fabricating results, since real ABAP Unit execution
 * isn't wired up). This is enough for the full read-only pipeline —
 * discovery, analysis, baseline capture — to run against real programs.
 *
 * The write path (syntaxCheckAndActivate, objectExists, and by extension
 * any real remediation) is still deliberately unimplemented, and should
 * stay that way until a dedicated technical/communication user replaces
 * the current personal-user (named `VINEET`) Basic Auth credential — see
 * §6.5's read-only-vs-write scoping rationale, which applies doubly to a
 * named personal login being driven by automation.
 */
export class RealAdtClient implements SapClient {
  constructor(private readonly destinationName: string) {}

  private notConfigured(method: string): never {
    throw new Error(
      `RealAdtClient.${method}() is not implemented yet against destination "${this.destinationName}". ` +
        `Set SAP_INTEGRATION_MODE=mock to run against the built-in mock data.`
    );
  }

  async readObjectSource(programName: string): Promise<ObjectSource> {
    const encodedName = encodeURIComponent(programName.toLowerCase());
    const response = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: "get",
        url: `/sap/bc/adt/programs/programs/${encodedName}/source/main`,
        headers: { Accept: "text/plain" },
      },
      { fetchCsrfToken: false }
    );
    return { name: programName, type: "PROG", source: String(response.data) };
  }

  async getDependencies(programName: string): Promise<DependencyObject[]> {
    const source = await this.readObjectSource(programName);
    return extractDependencies(source.source);
  }

  /**
   * Real ATC on SAP BTP / central S/4HANA (`/atc/runs`-style endpoints,
   * worklist XML) isn't wired up yet — this runs the static rule engine
   * (see staticCleanCoreRules.ts) against the real source instead, so real
   * programs get real findings now rather than waiting on the full ATC
   * integration. `_objectNames` is accepted for interface parity with the
   * mock client but isn't needed by the static engine.
   */
  async runAtcCheck(_objectNames: string[], currentSource: string): Promise<AtcRawFinding[]> {
    return runStaticAtcRules(currentSource);
  }

  /**
   * Real ADT Unit Test execution (`/sap/bc/adt/abapunit/testruns`) isn't
   * wired up yet. Returning no cases (rather than throwing) is the honest
   * answer — "nothing has actually been run" — and lets
   * baselineTestAgent's existing not-yet-verified placeholder do its job
   * instead of crashing real-mode discovery over an unimplemented method.
   */
  async runAbapUnit(_programName: string): Promise<UnitTestCaseResult[]> {
    return [];
  }

  async syntaxCheckAndActivate(
    _objectName: string,
    _source: string
  ): Promise<{ syntaxOk: boolean; activated: boolean; messages: string[] }> {
    this.notConfigured("syntaxCheckAndActivate");
  }

  async objectExists(_objectName: string): Promise<boolean> {
    this.notConfigured("objectExists");
  }
}
