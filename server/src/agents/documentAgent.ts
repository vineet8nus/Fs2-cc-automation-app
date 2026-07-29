import fs from "node:fs";
import path from "node:path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import * as XLSX from "xlsx";
import { GeneratedDocument, Program } from "../domain/types";

/**
 * Bundled defaults so doc generation works before an admin has uploaded an
 * org template (see /api/templates) — same "works out of the box, override
 * later" shape as everything else that has a sensible fallback in this app.
 *
 * Two candidate locations because __dirname resolves differently depending
 * on how this module is run: compiled (dist/agents -> dist/templates, one
 * level up — see scripts/copy-templates.js) vs. directly against src (tests,
 * via tsx/vitest — src/agents -> server/templates, two levels up, since the
 * seed files live at server/templates, not server/src/templates).
 */
export function loadSeedTemplate(key: "tsd" | "unit_test"): Buffer {
  const filename = key === "tsd" ? "tsd-template.docx" : "unit-test-template.xlsx";
  const candidates = [path.join(__dirname, "..", "templates", filename), path.join(__dirname, "..", "..", "templates", filename)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
  }
  throw new Error(`Seed template not found: ${filename} (tried ${candidates.join(", ")})`);
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
  PROGRAM: "Program",
  CLASS: "Class",
  FUNCTION_GROUP: "Function Group",
  INCLUDE: "Include",
  INTERFACE: "Interface",
  CDS_VIEW: "CDS View",
};

function objectTypeLabel(objectType: string): string {
  return OBJECT_TYPE_LABELS[objectType] ?? objectType;
}

/**
 * Generates the TSD from the uploaded NUS template. Per the requirement,
 * this covers the program *logic* changes (Object Summary/Details, Program
 * Logic), not the audit trail — the RICEFW-only sections (Selection Screen,
 * Custom Table, Printing, Deadline Monitoring, Special Functions, Data
 * Mappings) don't apply to a remediation-only change, so the template
 * itself carries static "N/A" for those rather than this code filling them.
 */
export function generateTsdDocument(program: Program, templateBuffer: Buffer): GeneratedDocument {
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

  const generatedDate = new Date().toISOString().slice(0, 10);
  const fixedFindings = program.findings.filter((f) => f.status === "fixed" || f.status === "validated");

  const objects = [
    { no: 1, objectType: objectTypeLabel(program.objectType), objectName: program.name, description: `Primary object, package ${program.package}.` },
    ...program.dependencies.map((dep, i) => ({
      no: i + 2,
      objectType: dep.type,
      objectName: dep.name,
      description: dep.usedBy ? `Dependency, used by ${dep.usedBy}.` : "Dependency.",
    })),
  ];

  doc.render({
    objectName: program.name,
    title: program.name,
    description: `Clean Core remediation for ${program.name} (${objectTypeLabel(program.objectType)}) in package ${program.package}.`,
    author: program.owner,
    generatedDate,
    developmentType: "(  ) Report   (  ) Interface   (  ) Conversion   ( X ) Enhancement   (  ) Form   (  ) Workflow",
    developmentTool: "( X ) ABAP   (  ) Report Painter   (  ) Smart Forms   (  ) User Exit/BADI   (  ) .Net   (  ) Workflow   ( X ) Eclipse   (  ) Fiori RDE   (  ) HANA Studio   (  ) Cloud Platform Integration",
    impactedSystems: "( X ) S/4 HANA   (  ) Cloud Platform Integration (CPI)   (  ) Cloud Platform (SCP)   (  ) BPC   (  ) Open Text   (  ) Other",
    objectTypeLabel: objectTypeLabel(program.objectType),
    package: program.package,
    objects,
    findings: fixedFindings.map((f) => ({
      message: f.message,
      atcCheckId: f.atcCheckId,
      priority: f.priority,
      extensibilityLevel: f.extensibilityLevel,
      fixDescription: f.suggestedFix.description,
    })),
  });

  const buffer = doc.getZip().generate({ type: "nodebuffer" }) as Buffer;
  return {
    generatedAt: new Date().toISOString(),
    filename: `TSD_${program.name}.docx`,
    base64: buffer.toString("base64"),
  };
}

/** Fills the Summary + Test Case sheets of the uploaded Unit Test workbook template. */
export function generateUnitTestDocument(program: Program, templateBuffer: Buffer): GeneratedDocument {
  const wb = XLSX.read(templateBuffer, { type: "buffer" });

  const summary = wb.Sheets["Summary"];
  const gate2 = program.auditLog.find((a) => a.action === "gate2-approve-merge");
  const setCell = (addr: string, value: string) => {
    summary[addr] = { t: "s", v: value };
  };
  setCell("B2", program.name);
  setCell("B3", "N/A");
  setCell("B4", "N/A");
  setCell("B5", "N/A");
  setCell("B6", `Clean Core remediation — ${program.findings.filter((f) => f.status === "fixed" || f.status === "validated").length} finding(s) fixed.`);
  setCell("B7", program.businessArea);
  setCell("B8", program.owner);
  setCell("B9", program.transportNumber ?? "N/A");
  setCell("B10", program.createdAt.slice(0, 10));
  setCell("B11", (gate2?.timestamp ?? program.updatedAt).slice(0, 10));
  setCell("B12", gate2?.actor ?? "N/A");
  setCell("B13", (gate2?.timestamp ?? program.updatedAt).slice(0, 10));
  setCell("B14", program.state);

  const testCaseSheet = wb.Sheets["Test Case"];
  const rows: unknown[][] = [];
  let idx = 1;
  for (const tc of program.baselineTests?.cases ?? []) {
    rows.push([`TC-${idx++}`, tc.name, "N/A (existing/characterization test)", "Behavior unchanged from baseline", tc.status, tc.status === "pass" ? "Pass" : "Fail", tc.humanConfirmed ? "Baseline confirmed by human" : ""]);
  }
  const v = program.validationReport;
  if (v) {
    rows.push([`TC-${idx++}`, "Syntax check", "Fixed source", "No syntax errors", v.syntaxCheckPassed ? "Pass" : "Fail", v.syntaxCheckPassed ? "Pass" : "Fail", ""]);
    rows.push([`TC-${idx++}`, "Activation", "Fixed source", "Object activates cleanly", v.activationPassed ? "Pass" : "Fail", v.activationPassed ? "Pass" : "Fail", ""]);
    rows.push([`TC-${idx++}`, "ATC finding cleared", "Post-fix ATC run", "No regression, original finding cleared", v.atcFindingCleared ? "Pass" : "Fail", v.atcFindingCleared ? "Pass" : "Fail", ""]);
    for (const s of v.sideEffectChecks) {
      rows.push([`TC-${idx++}`, s.name, "Post-fix validation", s.detail, s.passed ? "Pass" : "Fail", s.passed ? "Pass" : "Fail", ""]);
    }
  }

  const startRow = 1; // row 2 (0-indexed 1) is the first data row, under the header
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const addr = XLSX.utils.encode_cell({ r: startRow + r, c });
      testCaseSheet[addr] = { t: "s", v: String(rows[r][c] ?? "") };
    }
  }
  const lastRow = startRow + rows.length;
  testCaseSheet["!ref"] = `A1:G${Math.max(lastRow, 1)}`;

  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return {
    generatedAt: new Date().toISOString(),
    filename: `UnitTest_${program.name}.xlsx`,
    base64: out.toString("base64"),
  };
}
