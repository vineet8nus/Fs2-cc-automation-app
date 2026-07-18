import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parseIntakeExcel } from "../src/utils/excelParser";

function buildExcel(rows: Record<string, unknown>[]): Buffer {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Programs");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

describe("parseIntakeExcel", () => {
  it("parses the documented column schema", () => {
    const buf = buildExcel([
      {
        "Program Name": "ZPROG1",
        Package: "ZPKG",
        "Business Process Area": "Sales",
        "Business Criticality": "H",
        "Notes/Owner": "jane.doe",
      },
    ]);
    const rows = parseIntakeExcel(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      programName: "ZPROG1",
      package: "ZPKG",
      businessArea: "Sales",
      criticality: "H",
      owner: "jane.doe",
    });
  });

  it("skips rows without a program name", () => {
    const buf = buildExcel([{ "Program Name": "" }, { "Program Name": "ZPROG2" }]);
    expect(parseIntakeExcel(buf)).toHaveLength(1);
  });

  it("defaults criticality to M and tolerates missing optional columns", () => {
    const buf = buildExcel([{ "Program Name": "ZPROG3" }]);
    const rows = parseIntakeExcel(buf);
    expect(rows[0].criticality).toBe("M");
    expect(rows[0].package).toBe("UNKNOWN");
    expect(rows[0].owner).toBe("Unassigned");
  });

  it("is header-case-insensitive", () => {
    const buf = buildExcel([{ "program name": "ZPROG4", criticality: "low" }]);
    const rows = parseIntakeExcel(buf);
    expect(rows[0].programName).toBe("ZPROG4");
    expect(rows[0].criticality).toBe("L");
  });
});
