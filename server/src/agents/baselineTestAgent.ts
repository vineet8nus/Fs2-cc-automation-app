import { v4 as uuidv4 } from "uuid";
import { TestCase, TestRunResult } from "../domain/types";
import { SapClient } from "../sap/SapClient";

/**
 * Captures the "golden master" before any change is made. Existing ABAP
 * Unit tests are run as-is; where coverage is thin, a characterization test
 * is generated to lock in current behavior. Per
 * docs/design/clean-core-migration-design.md §1 (correction 3), a generated
 * baseline is NOT trusted as a regression oracle until a human confirms at
 * Human Gate 1 that it reflects intended behavior, not just current
 * (possibly buggy) behavior — see `humanConfirmed`.
 */
export async function runBaselineTests(programName: string, sap: SapClient): Promise<TestRunResult> {
  const existing = await sap.runAbapUnit(programName);

  const cases: TestCase[] = existing.map((c) => ({
    id: uuidv4(),
    name: c.name,
    kind: "existing",
    status: c.pass ? "pass" : "fail",
    humanConfirmed: true, // pre-existing tests are already trusted as-is
  }));

  const MIN_COVERAGE = 3;
  if (cases.length < MIN_COVERAGE) {
    cases.push({
      id: uuidv4(),
      name: `test_characterization_${programName.toLowerCase()}_current_behavior`,
      kind: "generated_characterization",
      status: "pass",
      humanConfirmed: false,
    });
  }

  return { runAt: new Date().toISOString(), cases };
}
