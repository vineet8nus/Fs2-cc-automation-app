import { UnitTestCaseResult } from "./SapClient";

/**
 * Parses an ABAP Unit test-run response (see RealAdtClient.runAbapUnit) into
 * our UnitTestCaseResult shape. A test method counts as failed only if it
 * carries an "exception" or "failedAssertion" alert — a "warning" alert
 * doesn't fail the test itself (matches the ADT client's own
 * UnitTestAlertKind distinction), so a merely-noisy test isn't reported as a
 * regression.
 */
export function parseAbapUnitResults(xml: string): UnitTestCaseResult[] {
  const results: UnitTestCaseResult[] = [];
  const classBlocks = [...xml.matchAll(/<testClass\b[^>]*>([\s\S]*?)<\/testClass>/g)];
  for (const classBlock of classBlocks) {
    const classBody = classBlock[1];
    const methodBlocks = [...classBody.matchAll(/<testMethod\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testMethod>)/g)];
    for (const m of methodBlocks) {
      const attrs = m[1];
      const body = m[2] ?? "";
      const name = attrs.match(/adtcore:name="([^"]*)"/)?.[1] ?? attrs.match(/\bname="([^"]*)"/)?.[1] ?? "unknown_test";
      const hasFailure = /<alert\b[^>]*kind="(?:failedAssertion|exception)"/i.test(body);
      results.push({ name, pass: !hasFailure });
    }
  }
  return results;
}
