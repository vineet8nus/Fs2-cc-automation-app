import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { DependencyObject } from "../domain/types";
import { AtcRawFinding, ObjectSource, SapClient, UnitTestCaseResult } from "./SapClient";

/**
 * Real connectivity to SHD200SYSTEM (RISE S/4HANA 2023, client 200) over the
 * ADT REST API, via the BTP destination + Cloud Connector on-premise proxy
 * (confirmed live per docs/design/clean-core-migration-design.md §3a/§9 —
 * BasicAuthentication against a named user, routed through Cloud Connector
 * location "Training-BC-Dev").
 *
 * Status: only `readObjectSource` is implemented, as a read-only proof of
 * connectivity (see the /api/diagnostics/sap-source route). Every other
 * method still fails loudly rather than silently returning mock data —
 * deliberately unimplemented until:
 *   1. A dedicated technical/communication user replaces the current
 *      personal-user (named `VINEET`) Basic Auth credential for anything
 *      beyond manual read-only testing — see §6.5's read-only-vs-write
 *      scoping rationale, which applies doubly to a named personal login.
 *   2. Dependency discovery, ATC run, ABAP Unit run, and write/activate are
 *      each built out against the real ADT REST surface.
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

  async getDependencies(_programName: string): Promise<DependencyObject[]> {
    this.notConfigured("getDependencies");
  }

  async runAtcCheck(_objectNames: string[], _currentSource: string): Promise<AtcRawFinding[]> {
    this.notConfigured("runAtcCheck");
  }

  async runAbapUnit(_programName: string): Promise<UnitTestCaseResult[]> {
    this.notConfigured("runAbapUnit");
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
