import { Finding } from "../domain/types";

export interface RemediationResult {
  newSource: string;
  appliedFindingIds: string[];
  skippedFindingIds: string[];
  changeLog: string[];
}

/**
 * Applies a fix per finding: the native ADT quick-fix path first where a
 * stable mapping exists, falling back to an AI-authored substitution
 * otherwise — both constrained to released-API substitution only, never
 * touching control flow or business rules (design doc §6.4).
 *
 * The transforms below are the mock-mode stand-ins for what a real
 * quick-fix / LLM-constrained fix would produce against the MockSapClient's
 * fixed source template; they exist so the full pipeline (fix -> PR ->
 * validate -> re-run ATC) is exercised end-to-end without live SAP access.
 */
export function runRemediation(source: string, findings: Finding[]): RemediationResult {
  let newSource = source;
  const appliedFindingIds: string[] = [];
  const skippedFindingIds: string[] = [];
  const changeLog: string[] = [];

  for (const finding of findings) {
    if (finding.suggestedFix.origin === "none") {
      skippedFindingIds.push(finding.id);
      continue;
    }

    let applied = false;
    if (/SELECT \* FROM mara/i.test(newSource) && /MARA/i.test(finding.message)) {
      newSource = newSource.replace(
        /SELECT \* FROM mara INTO TABLE @DATA\(lt_mara\) UP TO 100 ROWS\./i,
        "SELECT * FROM I_Product INTO TABLE @DATA(lt_mara) UP TO 100 ROWS."
      );
      applied = true;
    } else if (/UPDATE vbak/i.test(newSource) && /VBAK/i.test(finding.message)) {
      newSource = newSource.replace(
        /UPDATE vbak SET netwr = 0 WHERE vbeln = '0000000001'\./i,
        "CALL FUNCTION 'BAPI_SALESORDER_CHANGE'\n  EXPORTING\n    salesdocument = '0000000001'\n  * released API replacing the direct table UPDATE"
      );
      applied = true;
    } else if (/CALL FUNCTION 'MATERIAL_READ'/i.test(newSource) && /MATERIAL_READ/i.test(finding.message)) {
      newSource = newSource.replace(
        /CALL FUNCTION 'MATERIAL_READ'\./i,
        "CALL FUNCTION 'BAPI_MATERIAL_GET_DETAIL'.\n  \" released API replacing the internal function module call"
      );
      applied = true;
    } else if (/REFRESH lt_mara\./i.test(newSource) && /REFRESH|obsolete/i.test(finding.message)) {
      newSource = newSource.replace(/REFRESH lt_mara\./i, "CLEAR lt_mara.");
      applied = true;
    }

    if (applied) {
      appliedFindingIds.push(finding.id);
      changeLog.push(
        `[${finding.suggestedFix.origin === "native_quick_fix" ? "quick-fix" : "AI-fix"}] ${finding.checkName}: ${finding.suggestedFix.description}`
      );
    } else {
      skippedFindingIds.push(finding.id);
    }
  }

  return { newSource, appliedFindingIds, skippedFindingIds, changeLog };
}
