import { DependencyObject } from "../domain/types";
import { AtcRawFinding, ObjectSource, SapClient, UnitTestCaseResult } from "./SapClient";

/**
 * Extension point for real connectivity to SHD200SYSTEM (RISE S/4HANA 2023,
 * client 200) via its BTP destination, over the ADT REST API and the
 * central ATC check system already configured there.
 *
 * Deliberately NOT implemented yet — wiring this up needs, per
 * docs/design/clean-core-migration-design.md §3a/§9:
 *   1. The confirmed OAuth grant for the SHD200SYSTEM destination
 *      (client-credentials vs. SAML-bearer/principal propagation).
 *   2. A bound BTP destination service instance exposing SHD200SYSTEM to
 *      this app (see mta.yaml `fs2ccauto-destination` resource).
 *   3. Read-only vs. read-write technical user scoping (§6.5).
 *
 * Once available, implement each method against the ADT REST surface
 * (source read/write, syntax check, activation, ABAP Unit run,
 * `/atc/runs`-style endpoints) — see the abap-adt-api / erpl-adt reference
 * clients cited in §3 for the concrete request shapes to reverse-engineer
 * against this release. Every method below fails loudly rather than
 * silently returning mock data, so a misconfigured deployment is obvious
 * instead of quietly analyzing fake findings.
 */
export class RealAdtClient implements SapClient {
  constructor(private readonly destinationName: string) {}

  private notConfigured(method: string): never {
    throw new Error(
      `RealAdtClient.${method}() is not implemented yet. ` +
        `SAP_INTEGRATION_MODE=real was set but the ADT REST integration against ` +
        `destination "${this.destinationName}" still needs to be built once the OAuth ` +
        `grant type and comm scenario are confirmed (see design doc §9). ` +
        `Set SAP_INTEGRATION_MODE=mock to run against the built-in mock data.`
    );
  }

  async readObjectSource(_programName: string): Promise<ObjectSource> {
    this.notConfigured("readObjectSource");
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
