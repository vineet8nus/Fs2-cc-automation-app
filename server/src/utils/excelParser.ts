import * as XLSX from "xlsx";
import { AbapObjectType, Criticality, ExcelIntakeRow } from "../domain/types";

const CRITICALITY_VALUES: Criticality[] = ["H", "M", "L"];
const OBJECT_TYPE_VALUES: AbapObjectType[] = ["PROGRAM", "CLASS", "FUNCTION_GROUP", "INCLUDE", "INTERFACE", "CDS_VIEW"];

function normalizeCriticality(raw: unknown): Criticality {
  const v = String(raw ?? "M").trim().toUpperCase();
  if (v.startsWith("H")) return "H";
  if (v.startsWith("L")) return "L";
  return "M";
}

function normalizeObjectType(raw: unknown): AbapObjectType {
  const v = String(raw ?? "PROGRAM").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return (OBJECT_TYPE_VALUES as string[]).includes(v) ? (v as AbapObjectType) : "PROGRAM";
}

function firstDefined(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const match = Object.keys(row).find((rk) => rk.trim().toLowerCase() === k.toLowerCase());
    if (match && row[match] !== undefined && row[match] !== "") return row[match];
  }
  return undefined;
}

/**
 * Parses the intake Excel per docs/design/clean-core-migration-design.md
 * §6.1: Program Name | Package | Business Process Area |
 * Business Criticality (H/M/L) | Notes/Owner.
 * Header matching is case-insensitive and tolerant of a few common aliases.
 */
export function parseIntakeExcel(buffer: Buffer): ExcelIntakeRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

  const result: ExcelIntakeRow[] = [];
  for (const row of rows) {
    const programName = String(firstDefined(row, ["Program Name", "Program", "Object Name"]) ?? "").trim();
    if (!programName) continue;
    result.push({
      programName,
      objectType: normalizeObjectType(firstDefined(row, ["Object Type", "Type"])),
      // "UNKNOWN" here is a sentinel, not a real package — Orchestrator.
      // runAutomaticPipeline treats it (like a truly blank value) as "try
      // to auto-detect the real package from SAP," only keeping it as-is
      // if that lookup also fails.
      package: String(firstDefined(row, ["Package", "Development Package"]) ?? "").trim() || "UNKNOWN",
      atcCheckVariant: String(firstDefined(row, ["ATC Check Variant", "Check Variant"]) ?? "").trim() || undefined,
      businessArea: String(firstDefined(row, ["Business Process Area", "Business Area"]) ?? "").trim() || "General",
      criticality: normalizeCriticality(firstDefined(row, ["Business Criticality", "Criticality"])),
      owner: String(firstDefined(row, ["Notes/Owner", "Owner", "Notes"]) ?? "").trim() || "Unassigned",
    });
  }
  return result;
}

export { CRITICALITY_VALUES };
