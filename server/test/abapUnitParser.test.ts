import { describe, expect, it } from "vitest";
import { parseAbapUnitResults } from "../src/sap/abapUnitParser";

// Captured live from a real ABAP Unit run against ZTEST_VK2 on
// SHD200SYSTEM — 8 real test methods, all passing (self-closing
// <testMethod/>, no <alerts> children).
const REAL_PASSING_RESULT = `<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program adtcore:uri="/sap/bc/adt/programs/programs/ztest_vk2" adtcore:type="PROG/P" adtcore:name="ZTEST_VK2" uriType="semantic" xmlns:adtcore="http://www.sap.com/adt/core"><testClasses><testClass adtcore:uri="/sap/bc/adt/programs/programs/ztest_vk2#testclass=ZCL_TEST_ZMIGRATION_TEST" adtcore:type="PROG/PP" adtcore:name="ZCL_TEST_ZMIGRATION_TEST" uriType="semantic" durationCategory="short" riskLevel="harmless"><testMethods><testMethod adtcore:uri="x" adtcore:type="PROG/PLM" adtcore:name="TEST_COUNT_INCREMENT_WORKS" executionTime="0" uriType="semantic" unit="s"/><testMethod adtcore:uri="x" adtcore:type="PROG/PLM" adtcore:name="TEST_DB001_USES_CDS_VIEWS" executionTime="0" uriType="semantic" unit="s"/></testMethods></testClass></testClasses></program></aunit:runResult>`;

// Synthetic failure case, modeled on the documented alert schema
// (adtcore alert kind="failedAssertion"/"exception"/"warning") since no
// live failing test was available to capture.
const SYNTHETIC_MIXED_RESULT = `<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program adtcore:name="ZTEST" xmlns:adtcore="http://www.sap.com/adt/core"><testClasses><testClass adtcore:name="ZCL_TEST"><testMethods>
  <testMethod adtcore:name="TEST_PASSES"/>
  <testMethod adtcore:name="TEST_FAILS_ASSERTION"><alerts><alert kind="failedAssertion" severity="critical"><title>Assertion failed</title></alert></alerts></testMethod>
  <testMethod adtcore:name="TEST_THROWS"><alerts><alert kind="exception" severity="fatal"><title>Exception raised</title></alert></alerts></testMethod>
  <testMethod adtcore:name="TEST_ONLY_WARNS"><alerts><alert kind="warning" severity="tolerant"><title>Deprecation notice</title></alert></alerts></testMethod>
</testMethods></testClass></testClasses></program></aunit:runResult>`;

describe("parseAbapUnitResults", () => {
  it("parses a real passing run with correct names and pass=true", () => {
    const results = parseAbapUnitResults(REAL_PASSING_RESULT);
    expect(results).toEqual([
      { name: "TEST_COUNT_INCREMENT_WORKS", pass: true },
      { name: "TEST_DB001_USES_CDS_VIEWS", pass: true },
    ]);
  });

  it("fails a test on an assertion or exception alert, but not on a mere warning", () => {
    const results = parseAbapUnitResults(SYNTHETIC_MIXED_RESULT);
    expect(results).toEqual([
      { name: "TEST_PASSES", pass: true },
      { name: "TEST_FAILS_ASSERTION", pass: false },
      { name: "TEST_THROWS", pass: false },
      { name: "TEST_ONLY_WARNS", pass: true },
    ]);
  });

  it("returns an empty array for a run with no test classes", () => {
    expect(parseAbapUnitResults(`<aunit:runResult xmlns:aunit="x"><program><testClasses/></program></aunit:runResult>`)).toEqual([]);
  });
});
