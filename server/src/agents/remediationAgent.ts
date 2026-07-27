import { Finding } from "../domain/types";
import { RELEASED_CDS_SUCCESSOR } from "../sap/staticCleanCoreRules";

export interface RemediationResult {
  newSource: string;
  appliedFindingIds: string[];
  skippedFindingIds: string[];
  changeLog: string[];
}

// Inverts RELEASED_CDS_SUCCESSOR (standard table -> released CDS view) back
// to (released CDS view -> standard table), so the generic real-mode swap
// below can recover the actual violated table name from a finding's
// replacementObject. Needed because real ATC's own findings never carry the
// violated table/API name anywhere queryable except buried in free-text
// message strings — the classifier already extracts it once (to look up
// replacementObject in the forward direction), but doesn't expose it
// on the Finding itself. All values are already distinct table->view pairs, so
// inverting is lossless.
const ORIGINAL_TABLE_FOR: Record<string, string> = Object.fromEntries(
  Object.entries(RELEASED_CDS_SUCCESSOR).map(([table, view]) => [view, table])
);

/**
 * Applies a fix per finding: the native ADT quick-fix path first where a
 * stable mapping exists, falling back to an AI-authored substitution
 * otherwise — both constrained to released-API substitution only, never
 * touching control flow or business rules (design doc §6.4).
 *
 * The first four transforms below are mock-mode stand-ins for what a real
 * quick-fix / LLM-constrained fix would produce against MockSapClient's
 * fixed source template; they exist so the full pipeline (fix -> PR ->
 * validate -> re-run ATC) is exercised end-to-end without live SAP access.
 * Each is gated by a loose `.test()` (does this finding look like it's
 * about this pattern?) but performs its actual edit with a much more
 * specific regex requiring the exact mock-template phrasing — real source
 * text that merely resembles the pattern (e.g. "SELECT * from mara..."
 * without MockSapClient's "UP TO 100 ROWS." suffix) can pass the loose
 * gate but never match the specific replace. Confirmed live against a real
 * program (ztest_vk2): this silently reported findings "fixed" whose
 * source hadn't changed at all — worse than an honest "no automated fix",
 * since it looks to a human reviewer like a real code change is being
 * written when none was. Two corrections vs. the original version:
 * (1) every branch now checks the source actually changed before claiming
 * success, and (2) a branch whose loose gate matched but whose edit didn't
 * (or any branch that doesn't apply at all) now falls through to try the
 * next one — including the generic real-mode fallback — instead of a
 * matched-but-failed mock branch permanently blocking it.
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
    const before = newSource;

    if (/SELECT \* FROM mara/i.test(newSource) && /MARA/i.test(finding.message)) {
      newSource = newSource.replace(
        /SELECT \* FROM mara INTO TABLE @DATA\(lt_mara\) UP TO 100 ROWS\./i,
        "SELECT * FROM I_Product INTO TABLE @DATA(lt_mara) UP TO 100 ROWS."
      );
      applied = newSource !== before;
    }
    if (!applied && /UPDATE vbak/i.test(newSource) && /VBAK/i.test(finding.message)) {
      newSource = newSource.replace(
        /UPDATE vbak SET netwr = 0 WHERE vbeln = '0000000001'\./i,
        "CALL FUNCTION 'BAPI_SALESORDER_CHANGE'\n  EXPORTING\n    salesdocument = '0000000001'\n  * released API replacing the direct table UPDATE"
      );
      applied = newSource !== before;
    }
    if (!applied && /CALL FUNCTION 'MATERIAL_READ'/i.test(newSource) && /MATERIAL_READ/i.test(finding.message)) {
      newSource = newSource.replace(
        /CALL FUNCTION 'MATERIAL_READ'\./i,
        "CALL FUNCTION 'BAPI_MATERIAL_GET_DETAIL'.\n  \" released API replacing the internal function module call"
      );
      applied = newSource !== before;
    }
    if (!applied && /REFRESH lt_mara\./i.test(newSource) && /REFRESH|obsolete/i.test(finding.message)) {
      newSource = newSource.replace(/REFRESH lt_mara\./i, "CLEAR lt_mara.");
      applied = newSource !== before;
    }
    if (!applied && finding.suggestedFix.replacementObject) {
      // Generic fallback for real-mode findings. `finding.objectName` is
      // NOT reliable here — for real ATC findings (atcFindingClassifier.ts)
      // it's the containing object's own name (e.g. "ZTEST_VK2"), not the
      // actual table/API violated, since ATC's worklist XML doesn't expose
      // that directly. The static fallback engine's own findings
      // (staticCleanCoreRules.ts) DO set objectName to the real violated
      // table, so ORIGINAL_TABLE_FOR is only a fallback correction for the
      // real-ATC case — it recovers the actual table name from the same
      // known table->CDS-view mapping the classifier used to derive
      // replacementObject in the first place.
      const target = ORIGINAL_TABLE_FOR[finding.suggestedFix.replacementObject] ?? finding.objectName;
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const swapped = newSource.replace(
        new RegExp(`\\b(FROM|JOIN)\\s+${escaped}\\b`, "gi"),
        (_match, keyword: string) => `${keyword} ${finding.suggestedFix.replacementObject}`
      );
      applied = swapped !== newSource;
      if (applied) newSource = swapped;
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
