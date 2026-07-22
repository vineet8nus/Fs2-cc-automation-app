import { describe, expect, it } from "vitest";
import { extractDependencies, runStaticAtcRules } from "../src/sap/staticCleanCoreRules";

// Excerpted from the real ZTEST_VK2 source pulled live from SHD200SYSTEM —
// used here as a fixture so the rule engine is tested against the exact
// pattern that surfaced the real finding, not a synthetic stand-in.
const ZTEST_VK2_EXCERPT = `
REPORT ztest_vk2.

CLASS lcl_vk2_clean DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING iv_product_type TYPE IPRODUCT-producttype
      RETURNING VALUE(rt)       TYPE ty_t_product.
ENDCLASS.

CLASS lcl_vk2_clean IMPLEMENTATION.
  METHOD run.
    SELECT
      product AS product
      FROM IPRODUCT
      WHERE producttype = @iv_product_type
      INTO TABLE @rt.

      SELECT * from vbrk INTO TABLE @DATA(lt_vbrk).

  ENDMETHOD.
ENDCLASS.
`;

// Real comment text pulled verbatim from ZTEST_VK2's embedded test class —
// this is exactly what caused false positives before comment stripping was
// added: the comments *describe* antipatterns (as things to avoid) using
// the same keywords the rules look for, and an earlier version of the
// engine matched the comment text as if it were executable code.
const COMMENT_ONLY_ANTIPATTERN_MENTIONS = `
METHOD get_materials_via_cds.
  " Simulates reading from CDS view I_Material instead of SELECT * FROM mara
  LOOP AT mt_mara INTO DATA(ls_mara) WHERE matnr CP iv_pattern.
    APPEND ls_mara TO rt_result.
  ENDLOOP.
ENDMETHOD.

METHOD test_db002_no_faglflexa.
  " Guard: FI-GL line items must come from I_GLAccountLineItem / ACDOCA,
  " never the obsolete faglflexa pool table.
  DATA(lv_used_cds_for_gl) = abap_true.
ENDMETHOD.

METHOD test_db003_no_bseg_join.
  " Guard: Document line items must be read from ACDOCA / CDS,
  " not via JOIN on obsolete cluster table BSEG.
  DATA(lv_uses_acdoca) = abap_true.
ENDMETHOD.

METHOD test_pf001_no_select_in_loop.
  " Guard: sales documents must be fetched once before the loop (set-based),
  " not inside a LOOP over materials (N+1 antipattern).
  DATA: lv_select_count TYPE i VALUE 0.
  lv_select_count = 1.
  LOOP AT mt_mara INTO DATA(ls_mara).
    " No SELECT inside the loop in the refactored code
  ENDLOOP.
ENDMETHOD.
`;

// Real string-literal text pulled verbatim from ZTEST_VK2 — assertion
// failure messages that *name* the antipattern being guarded against.
// Comment stripping alone doesn't fix this: these are genuine ABAP string
// literals (single-quoted), not comments.
const STRING_LITERAL_ANTIPATTERN_MENTIONS = `
METHOD test_db002_no_faglflexa.
  DATA(lv_used_cds_for_gl) = abap_true.
  cl_abap_unit_assert=>assert_true(
    act = lv_used_cds_for_gl
    msg = 'DB002: GL access must use I_GLAccountLineItem / ACDOCA, not FAGLFLEXA' ).
ENDMETHOD.

METHOD test_db003_no_bseg_join.
  DATA(lv_uses_acdoca) = abap_true.
  cl_abap_unit_assert=>assert_true(
    act = lv_uses_acdoca
    msg = 'DB003: JOIN on obsolete BSEG must be replaced by ACDOCA / CDS view access' ).
ENDMETHOD.
`;

describe("string-literal false positives (regression: real ZTEST_VK2 assertion messages)", () => {
  it("does not flag FAGLFLEXA or BSEG when they only appear inside assertion message strings", () => {
    const findings = runStaticAtcRules(STRING_LITERAL_ANTIPATTERN_MENTIONS);
    const flaggedObjects = findings.map((f) => f.objectName.toUpperCase());
    expect(flaggedObjects).not.toContain("FAGLFLEXA");
    expect(flaggedObjects).not.toContain("BSEG");
  });

  it("still flags a real FROM bseg / FROM faglflexa in actual code", () => {
    const findings = runStaticAtcRules("SELECT * FROM bseg INTO TABLE @DATA(lt).\nSELECT * FROM faglflexa INTO TABLE @DATA(lt2).");
    const flaggedObjects = findings.map((f) => f.objectName.toUpperCase());
    expect(flaggedObjects).toContain("BSEG");
    expect(flaggedObjects).toContain("FAGLFLEXA");
  });
});

describe("comment stripping (regression: real ZTEST_VK2 false positives)", () => {
  it("does not flag MARA, FAGLFLEXA, or BSEG when they only appear inside comments", () => {
    const findings = runStaticAtcRules(COMMENT_ONLY_ANTIPATTERN_MENTIONS);
    const flaggedObjects = findings.map((f) => f.objectName.toUpperCase());
    expect(flaggedObjects).not.toContain("MARA");
    expect(flaggedObjects).not.toContain("FAGLFLEXA");
    expect(flaggedObjects).not.toContain("BSEG");
  });

  it("does not flag SELECT-in-LOOP when the SELECT mention is only in a comment inside the loop", () => {
    const findings = runStaticAtcRules(COMMENT_ONLY_ANTIPATTERN_MENTIONS);
    expect(findings.some((f) => f.atcCheckId === "STATIC_PF001_SELECT_IN_LOOP")).toBe(false);
  });

  it("does not extract MARA as a dependency when it only appears in a comment", () => {
    const deps = extractDependencies(COMMENT_ONLY_ANTIPATTERN_MENTIONS);
    expect(deps.some((d) => d.name === "MARA")).toBe(false);
  });

  it("still flags a real SELECT * FROM vbrk alongside these comment-only mentions", () => {
    const findings = runStaticAtcRules(ZTEST_VK2_EXCERPT + COMMENT_ONLY_ANTIPATTERN_MENTIONS);
    expect(findings.some((f) => f.objectName.toUpperCase() === "VBRK")).toBe(true);
  });
});

describe("runStaticAtcRules", () => {
  it("flags the real unfiltered SELECT * FROM vbrk as a standard-table usage-of-APIs finding", () => {
    const findings = runStaticAtcRules(ZTEST_VK2_EXCERPT);
    const vbrkFinding = findings.find((f) => f.objectName.toUpperCase() === "VBRK");
    expect(vbrkFinding).toBeTruthy();
    expect(vbrkFinding?.atcCheckId).toBe("STATIC_USAGE_API_SELECT_STAR");
    expect(vbrkFinding?.extensibilityLevel).toBe("C");
  });

  it("does NOT flag the released CDS view IPRODUCT the program correctly uses", () => {
    const findings = runStaticAtcRules(ZTEST_VK2_EXCERPT);
    expect(findings.some((f) => f.objectName.toUpperCase() === "IPRODUCT")).toBe(false);
  });

  it("offers a native quick fix with a known CDS successor for MARA", () => {
    const findings = runStaticAtcRules("SELECT * FROM mara INTO TABLE @DATA(lt).");
    const finding = findings.find((f) => f.objectName.toUpperCase() === "MARA");
    expect(finding?.fixOrigin).toBe("native_quick_fix");
    expect(finding?.replacementObject).toBe("I_Product");
  });

  it("does not flag custom Z/Y tables", () => {
    const findings = runStaticAtcRules("SELECT * FROM ztest_table INTO TABLE @DATA(lt).");
    expect(findings).toHaveLength(0);
  });

  it("regression: does not re-flag a CDS view a fix just switched TO as a new violation", () => {
    // Live-tested bug: re-running this check against the post-fix source
    // ("SELECT * FROM vbrk" -> "SELECT * FROM I_BillingDocument") flagged
    // I_BillingDocument itself as an unfixed standard-table violation,
    // since it doesn't start with Y/Z either — validation could never
    // confirm a real fix actually cleared the finding.
    const findings = runStaticAtcRules("SELECT * from I_BillingDocument INTO TABLE @DATA(lt_vbrk).");
    expect(findings.some((f) => f.objectName.toUpperCase() === "I_BILLINGDOCUMENT")).toBe(false);
  });

  it("does not flag names following the released view naming convention generally", () => {
    const findings = runStaticAtcRules("SELECT * FROM C_SomeConsumptionView INTO TABLE @DATA(lt).");
    expect(findings).toHaveLength(0);
  });

  it("flags obsolete REFRESH with a native quick fix", () => {
    const findings = runStaticAtcRules("REFRESH lt_data.");
    const finding = findings.find((f) => f.atcCheckId === "STATIC_OBSOLETE_STMT_REFRESH");
    expect(finding?.fixOrigin).toBe("native_quick_fix");
    expect(finding?.fixDescription).toContain("CLEAR lt_data");
  });

  it("flags SELECT inside a LOOP as a performance antipattern", () => {
    const source = "LOOP AT lt_mat INTO ls_mat.\n  SELECT SINGLE * FROM makt INTO ls_makt WHERE matnr = ls_mat-matnr.\nENDLOOP.";
    const findings = runStaticAtcRules(source);
    expect(findings.some((f) => f.atcCheckId === "STATIC_PF001_SELECT_IN_LOOP")).toBe(true);
  });
});

describe("extractDependencies", () => {
  it("extracts real referenced objects from the ZTEST_VK2 excerpt", () => {
    const deps = extractDependencies(ZTEST_VK2_EXCERPT);
    const names = deps.map((d) => d.name);
    expect(names).toContain("IPRODUCT");
    expect(names).toContain("VBRK");
  });

  it("excludes locally-defined classes from the dependency list", () => {
    const deps = extractDependencies(ZTEST_VK2_EXCERPT);
    expect(deps.some((d) => d.name === "LCL_VK2_CLEAN")).toBe(false);
  });

  it("classifies CALL FUNCTION targets as FUNCTION_MODULE", () => {
    const deps = extractDependencies("CALL FUNCTION 'BAPI_MATERIAL_GET_DETAIL'.");
    expect(deps).toContainEqual({ name: "BAPI_MATERIAL_GET_DETAIL", type: "FUNCTION_MODULE" });
  });
});
