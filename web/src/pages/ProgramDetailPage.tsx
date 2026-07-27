import {
  Avatar,
  Bar,
  Breadcrumbs,
  BreadcrumbsItem,
  Button,
  BusyIndicator,
  CheckBox,
  DynamicPage,
  DynamicPageHeader,
  DynamicPageTitle,
  FlexBox,
  Input,
  Label,
  MessageStrip,
  Panel,
  Table,
  TableCell,
  TableColumn,
  TableRow,
  TextArea,
  Text,
  Title,
  Wizard,
  WizardStep,
} from "@ui5/webcomponents-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { LevelBadge, RiskBadge, StateBadge } from "../components/Badges";
import { DiffView, RawDiffView } from "../components/DiffView";
import { objectTypeLabel } from "../components/objectTypes";
import { Finding, ProgramDetail } from "../types";

/**
 * `suggestedFix.origin` alone overstates what remediation can actually do:
 * both "native_quick_fix" and "ai_generated" are meant to imply an
 * automated fix, but runRemediation (server/src/agents/remediationAgent.ts)
 * only has ONE generic branch for real-mode findings, and it requires a
 * concrete `replacementObject` to swap in — an "ai_generated" finding
 * without one (the common case for a real ATC run, where the classifier
 * can categorize the *kind* of issue but has no LLM wired up to actually
 * write a fix) is approved-then-silently-deferred exactly like a "none"
 * finding, despite being labeled "AI-fix" in the UI. This checks the one
 * thing that actually determines whether approving a finding does
 * anything mechanical, so the badge doesn't promise more than the backend
 * delivers.
 */
function isMechanicallyFixable(f: Finding): boolean {
  return !!f.suggestedFix.replacementObject;
}

const STEP_TITLES = ["Object intake", "ATC findings", "Propose & approve fix", "Results & audit log"] as const;
type Step = 1 | 2 | 3 | 4;

// Which wizard step a program's current backend state belongs to. PARKED can
// be reached from either Gate 1 or the fix review, so it's disambiguated by
// whether a fix was ever proposed.
function stepForState(program: ProgramDetail): Step {
  const s = program.state;
  if (s === "VALIDATING" || s === "AWAITING_HUMAN_REVIEW_2" || s === "TRANSPORT_RELEASED" || s === "DOCUMENTED" || s === "DONE" || s === "ESCALATED") {
    return 4;
  }
  if (s === "REMEDIATING" || s === "AWAITING_FIX_REVIEW") return 3;
  if (s === "PARKED") return program.proposedSource ? 3 : 2;
  return 2;
}

export function ProgramDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [program, setProgram] = useState<ProgramDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [comment, setComment] = useState("");
  const [transportNumber, setTransportNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [editedSource, setEditedSource] = useState("");
  const [viewStep, setViewStep] = useState<Step>(1);
  const maxStepReachedRef = useRef<Step>(1);

  const load = useCallback(async () => {
    if (!id) return;
    const p = await api.getProgram(id);
    setProgram(p);
    setSelected(new Set(p.findings.filter((f) => f.status === "open").map((f) => f.id)));
    if (p.state === "AWAITING_FIX_REVIEW") setEditedSource(p.proposedSource ?? "");
    if (p.gitBaseline?.fixBranch) {
      api.getDiff(id).then(setDiff).catch(() => undefined);
    }
    const backendStep = stepForState(p);
    if (backendStep > maxStepReachedRef.current) {
      maxStepReachedRef.current = backendStep;
      setViewStep(backendStep);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!program) return <div style={{ padding: "2rem" }}>Loading…</div>;

  async function runAction(fn: () => Promise<ProgramDetail>) {
    setBusy(true);
    setError(null);
    try {
      const updated = await fn();
      setProgram(updated);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Even on error, re-fetch so the displayed state reflects whatever
      // the backend actually persisted rather than a stale pre-action
      // snapshot — some failures happen after a state transition was
      // already saved.
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleRerun() {
    if (!program) return;
    if (
      !window.confirm(
        `Re-run analysis for ${program.name}? This discards the current findings and any proposed fix, and re-analyzes from the live source — the same program record is updated in place, no duplicate row is created.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.rerunAnalysis(program.id);
      setProgram(updated);
      setSelected(new Set(updated.findings.filter((f) => f.status === "open").map((f) => f.id)));
      setEditedSource(updated.state === "AWAITING_FIX_REVIEW" ? updated.proposedSource ?? "" : "");
      setDiff("");
      // A rerun can move the program BACKWARDS in the wizard (e.g. from
      // AWAITING_FIX_REVIEW back to AWAITING_HUMAN_REVIEW_1) — unlike load()
      // on a normal mount, maxStepReachedRef must be force-reset here rather
      // than only ratcheted forward, or stale later steps would stay
      // reachable even though the backend state no longer supports them.
      const step = stepForState(updated);
      maxStepReachedRef.current = step;
      setViewStep(step);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!program) return;
    if (!window.confirm(`Delete ${program.name}? This permanently removes it from the backlog and cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteProgram(program.id);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const openFindings = program.findings.filter((f) => f.status === "open");
  const otherFindings = program.findings.filter((f) => f.status !== "open");
  const maxStep = maxStepReachedRef.current;

  function goToStep(step: Step) {
    if (step >= 1 && step <= maxStep) setViewStep(step);
  }

  return (
    <DynamicPage
      headerTitle={
        <DynamicPageTitle
          breadcrumbs={
            // Click handling for a breadcrumb hop lives on <Breadcrumbs>'s
            // onItemClick (the web component's real "item-click" event) —
            // an onClick prop on an individual <BreadcrumbsItem> is never
            // fired by the underlying UI5 web component, so it silently did
            // nothing. Only "Programs" (not the current-page item) is ever
            // clickable here.
            <Breadcrumbs onItemClick={() => navigate("/")}>
              <BreadcrumbsItem>Programs</BreadcrumbsItem>
              <BreadcrumbsItem>{program.name}</BreadcrumbsItem>
            </Breadcrumbs>
          }
          header={<Title level="H2">{program.name}</Title>}
          subHeader={<Label>{objectTypeLabel(program.objectType)}</Label>}
          actions={
            <FlexBox style={{ gap: "0.5rem", alignItems: "center" }}>
              <StateBadge state={program.state} />
              <LevelBadge level={program.worstExtensibilityLevel} />
              <RiskBadge riskScore={program.riskScore} />
            </FlexBox>
          }
        />
      }
      headerContent={
        <DynamicPageHeader>
          <FlexBox style={{ gap: "1.5rem", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
            <FlexBox style={{ gap: "1.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <Avatar size="M" initials={program.name.slice(0, 2).toUpperCase()} colorScheme="Accent6" />
              <div>
                <Label>Package</Label>
                <Text style={{ display: "block" }}>{program.package}</Text>
              </div>
              <div>
                <Label>Business process area</Label>
                <Text style={{ display: "block" }}>{program.businessArea}</Text>
              </div>
              <div>
                <Label>Criticality</Label>
                <Text style={{ display: "block" }}>{program.criticality}</Text>
              </div>
              <div>
                <Label>Owner</Label>
                <Text style={{ display: "block" }}>{program.owner}</Text>
              </div>
            </FlexBox>
            {/* Deliberately NOT in DynamicPageTitle's `actions` slot: that
                slot has its own responsive overflow-popover behavior, and
                adding more buttons there pushed it right to the width
                threshold where it endlessly toggled buttons in/out of the
                overflow menu (observed as a runaway ResizeObserver
                measure/collapse/expand loop). This plain FlexBox has no
                such responsive logic. */}
            <FlexBox style={{ gap: "0.5rem", alignItems: "center" }}>
              <Button icon="refresh" disabled={busy} onClick={handleRerun}>
                Re-run analysis
              </Button>
              <Button icon="delete" design="Negative" disabled={busy} onClick={handleDelete}>
                Delete
              </Button>
            </FlexBox>
          </FlexBox>
        </DynamicPageHeader>
      }
      footer={
        <Bar
          design="FloatingFooter"
          startContent={
            <Button disabled={viewStep <= 1} onClick={() => goToStep((viewStep - 1) as Step)}>
              ← Back
            </Button>
          }
          endContent={
            <Button disabled={viewStep >= maxStep} onClick={() => goToStep((viewStep + 1) as Step)}>
              Next →
            </Button>
          }
        />
      }
    >
      {error && <MessageStrip design="Negative">{error}</MessageStrip>}
      {program.state === "ESCALATED" && (
        <MessageStrip design="Negative">
          Remediation was escalated after {program.remediationAttempts} attempt(s) — validation kept failing. A human
          needs to look at this one directly rather than retry automatically.
        </MessageStrip>
      )}

      <Wizard
        contentLayout="SingleStep"
        onStepChange={(e) => {
          const idx = STEP_TITLES.indexOf(e.detail.step.titleText as (typeof STEP_TITLES)[number]) + 1;
          if (idx >= 1) goToStep(idx as Step);
        }}
      >
        {STEP_TITLES.map((title, i) => {
          const step = (i + 1) as Step;
          return (
            <WizardStep key={title} titleText={title} selected={viewStep === step} disabled={step > maxStep}>
              <div style={{ padding: "0.5rem 0" }}>
                {step === 1 && (
                  <Panel headerText="Object details">
                    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                      <Text>Name: {program.name}</Text>
                      <Text>Object type: {objectTypeLabel(program.objectType)}</Text>
                      <Text>Package: {program.package}</Text>
                      <Text>Business process area: {program.businessArea}</Text>
                      <Text>Criticality: {program.criticality}</Text>
                      <Text>Owner: {program.owner}</Text>
                      <Text style={{ marginTop: "0.5rem", color: "var(--sapContent_LabelColor)" }}>
                        This object has already been ingested. Discovery and analysis run automatically — move to the
                        next step to review the ATC findings.
                      </Text>
                      <Bar endContent={<Button onClick={() => navigate("/")}>Cancel</Button>} />
                    </div>
                  </Panel>
                )}

                {step === 2 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                    <Panel headerText={`Dependencies (${program.dependencies.length})`} collapsed>
                      <div style={{ padding: "0.5rem 1rem" }}>
                        {program.dependencies.map((d) => (
                          <Text key={d.name} style={{ display: "block" }}>
                            {d.type}: {d.name}
                          </Text>
                        ))}
                      </div>
                    </Panel>

                    <Panel headerText={`Findings (${program.findings.length})`}>
                      {program.state === "AWAITING_HUMAN_REVIEW_1" && openFindings.length > 0 && (
                        <FlexBox style={{ gap: "0.5rem", padding: "0 1rem 0.5rem" }}>
                          <Button design="Transparent" onClick={() => setSelected(new Set(openFindings.map((f) => f.id)))}>
                            Select all
                          </Button>
                          <Button design="Transparent" onClick={() => setSelected(new Set())}>
                            Deselect all
                          </Button>
                          <Button
                            design="Transparent"
                            onClick={() => setSelected(new Set(openFindings.filter(isMechanicallyFixable).map((f) => f.id)))}
                          >
                            Select only auto-fixable
                          </Button>
                          <Text style={{ alignSelf: "center", color: "var(--sapContent_LabelColor)" }}>
                            {selected.size} of {openFindings.length} selected
                          </Text>
                        </FlexBox>
                      )}
                      <Table
                        columns={
                          <>
                            {program.state === "AWAITING_HUMAN_REVIEW_1" && <TableColumn>Include</TableColumn>}
                            <TableColumn>Check</TableColumn>
                            <TableColumn>Found in</TableColumn>
                            <TableColumn>Message</TableColumn>
                            <TableColumn>Priority</TableColumn>
                            <TableColumn>Level</TableColumn>
                            <TableColumn>Suggested fix</TableColumn>
                            <TableColumn>Status</TableColumn>
                          </>
                        }
                      >
                        {[...openFindings, ...otherFindings].map((f) => (
                          <TableRow key={f.id}>
                            {program.state === "AWAITING_HUMAN_REVIEW_1" && (
                              <TableCell>
                                {f.status === "open" ? (
                                  <CheckBox
                                    checked={selected.has(f.id)}
                                    onChange={(e) =>
                                      setSelected((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(f.id);
                                        else next.delete(f.id);
                                        return next;
                                      })
                                    }
                                  />
                                ) : (
                                  <Text>—</Text>
                                )}
                              </TableCell>
                            )}
                            <TableCell>
                              <Text>
                                {f.checkName} ({f.atcCheckId})
                              </Text>
                            </TableCell>
                            <TableCell>
                              <Text>{f.containerObject === program.name ? f.containerObject : `${f.containerObject} (Include/Class)`}</Text>
                            </TableCell>
                            <TableCell>
                              <Text>{f.message}</Text>
                            </TableCell>
                            <TableCell>
                              <Text>P{f.priority}</Text>
                            </TableCell>
                            <TableCell>
                              <LevelBadge level={f.extensibilityLevel} />
                            </TableCell>
                            <TableCell>
                              <Text>
                                [
                                {isMechanicallyFixable(f)
                                  ? f.suggestedFix.origin === "native_quick_fix"
                                    ? "quick-fix"
                                    : "AI-fix"
                                  : "manual"}
                                ]{" "}
                                {f.suggestedFix.description}
                              </Text>
                            </TableCell>
                            <TableCell>
                              <Text>{f.status}</Text>
                            </TableCell>
                          </TableRow>
                        ))}
                      </Table>
                    </Panel>

                    {program.baselineTests && (
                      <Panel headerText={`Baseline tests (${program.baselineTests.cases.length})`} collapsed>
                        <Table
                          columns={
                            <>
                              <TableColumn>Test</TableColumn>
                              <TableColumn>Kind</TableColumn>
                              <TableColumn>Status</TableColumn>
                              <TableColumn>Human-confirmed</TableColumn>
                            </>
                          }
                        >
                          {program.baselineTests.cases.map((t) => (
                            <TableRow key={t.id}>
                              <TableCell>
                                <Text>{t.name}</Text>
                              </TableCell>
                              <TableCell>
                                <Text>{t.kind === "generated_characterization" ? "generated (characterization)" : "existing"}</Text>
                              </TableCell>
                              <TableCell>
                                <Text>{t.status}</Text>
                              </TableCell>
                              <TableCell>
                                <Text>{t.humanConfirmed ? "yes" : "pending Gate 1"}</Text>
                              </TableCell>
                            </TableRow>
                          ))}
                        </Table>
                      </Panel>
                    )}

                    {program.state === "AWAITING_HUMAN_REVIEW_1" && (
                      <Panel headerText="Human Gate 1 — approve remediation scope">
                        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                          {program.baselineTests?.cases.some((c) => c.kind === "generated_characterization") && (
                            <MessageStrip design="Warning">
                              One or more baseline tests were auto-generated from current behavior. Confirm they
                              reflect intended behavior before approving — see design doc §1.
                            </MessageStrip>
                          )}
                          <Label>Comment</Label>
                          <TextArea value={comment} onInput={(e) => setComment(e.target.value)} rows={2} />
                          <Bar
                            startContent={<Button onClick={() => navigate("/")}>Cancel</Button>}
                            endContent={
                              <FlexBox style={{ gap: "0.5rem" }}>
                                <Button
                                  design="Negative"
                                  disabled={busy}
                                  onClick={() => runAction(() => api.gate1(program.id, "reject", undefined, comment))}
                                >
                                  Reject / Park
                                </Button>
                                <Button
                                  design="Emphasized"
                                  disabled={busy || selected.size === 0}
                                  onClick={() => runAction(() => api.gate1(program.id, "approve", Array.from(selected), comment))}
                                >
                                  Review Fixed Code and Remediate
                                </Button>
                              </FlexBox>
                            }
                          />
                        </div>
                      </Panel>
                    )}
                  </div>
                )}

                {step === 3 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                    {program.state === "AWAITING_FIX_REVIEW" ? (
                      <Panel headerText="Fix review — approve to write &amp; activate on SHD200SYSTEM">
                        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                          <MessageStrip design="Warning">
                            Approving writes this exact code to the real SAP system and activates it (attributed to
                            the destination's configured user). Review the proposed fix below — it's editable —
                            before approving.
                          </MessageStrip>
                          {program.findings.some((f) => f.status === "deferred") && (
                            <MessageStrip design="Information">
                              <div>
                                {program.findings.filter((f) => f.status === "deferred").length} approved finding(s)
                                have no automated fix behind them and are unchanged in the proposed source below —
                                they need manual remediation, separately from this write:
                              </div>
                              <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem" }}>
                                {deferredFindingSummary(program).map((g) => (
                                  <li key={g.checkName}>
                                    {g.checkName} × {g.count}
                                  </li>
                                ))}
                              </ul>
                            </MessageStrip>
                          )}
                          {crossObjectContainers(program).map((depName) => (
                            <DependencySourcePanel key={depName} programId={program.id} depName={depName} />
                          ))}
                          <FlexBox style={{ gap: "1rem" }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Label>Diff (baseline → proposed) — red removed, green added</Label>
                              <DiffView oldText={program.baselineSource ?? ""} newText={editedSource} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Label>Proposed fix (editable)</Label>
                              <TextArea
                                value={editedSource}
                                onInput={(e) => setEditedSource(e.target.value)}
                                rows={22}
                                style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }}
                              />
                            </div>
                          </FlexBox>
                          <Label>Comment</Label>
                          <TextArea value={comment} onInput={(e) => setComment(e.target.value)} rows={2} />
                          <Bar
                            endContent={
                              <FlexBox style={{ gap: "0.5rem" }}>
                                <Button
                                  design="Negative"
                                  disabled={busy}
                                  onClick={() => runAction(() => api.fixReview(program.id, "reject", undefined, comment))}
                                >
                                  Reject / Park
                                </Button>
                                <Button
                                  disabled={busy}
                                  onClick={() => runAction(() => api.fixReview(program.id, "request_changes", undefined, comment))}
                                >
                                  Request changes (regenerate)
                                </Button>
                                <Button
                                  design="Emphasized"
                                  disabled={busy || !editedSource || editedSource === (program.baselineSource ?? "")}
                                  onClick={() => runAction(() => api.fixReview(program.id, "approve", editedSource, comment))}
                                >
                                  Approve &amp; write to SAP
                                </Button>
                              </FlexBox>
                            }
                          />
                          {editedSource === (program.baselineSource ?? "") && (
                            <Text style={{ color: "var(--sapContent_LabelColor)" }}>
                              The proposed source is identical to the original — none of the approved findings had a
                              mechanical fix to apply, so there's nothing to write to SAP. Edit the source directly
                              above if you want to fix something by hand, or reject/park this program.
                            </Text>
                          )}
                        </div>
                      </Panel>
                    ) : (
                      <MessageStrip design="Information">
                        {program.state === "REMEDIATING"
                          ? "Remediation is being proposed — the fix will appear here for review shortly."
                          : "No fix has been proposed yet for this object."}
                      </MessageStrip>
                    )}
                  </div>
                )}

                {step === 4 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                    {program.validationReport && (
                      <Panel headerText="Validation report" collapsed={program.state !== "AWAITING_HUMAN_REVIEW_2"}>
                        <div style={{ padding: "1rem" }}>
                          <ValidationRow label="Syntax check" pass={program.validationReport.syntaxCheckPassed} />
                          <ValidationRow label="Activation" pass={program.validationReport.activationPassed} />
                          <ValidationRow label="Replaced objects exist & released" pass={program.validationReport.replacedObjectsExist} />
                          <ValidationRow label="ATC finding cleared, no regressions" pass={program.validationReport.atcFindingCleared} />
                          <ValidationRow label="Baseline tests still pass" pass={program.validationReport.baselineTestsStillPass} />
                          <ValidationRow label="New tests pass" pass={program.validationReport.newTestsPass} />
                          {program.validationReport.sideEffectChecks.map((s) => (
                            <ValidationRow key={s.name} label={`${s.name} — ${s.detail}`} pass={s.passed} />
                          ))}
                          <Text style={{ display: "block", marginTop: "0.5rem", fontWeight: "bold" }}>
                            Overall: {program.validationReport.overallPass ? "PASS" : "FAIL"}
                          </Text>
                        </div>
                      </Panel>
                    )}

                    {program.gitBaseline?.fixBranch && (
                      <Panel headerText={`Change diff (${program.gitBaseline.baselineBranch} → ${program.gitBaseline.fixBranch})`} collapsed>
                        <div style={{ padding: "1rem" }}>{diff ? <RawDiffView text={diff} /> : <Text>No diff produced.</Text>}</div>
                      </Panel>
                    )}

                    {program.state === "AWAITING_HUMAN_REVIEW_2" && (
                      <Panel headerText="Human Gate 2 — final approval (PR review)">
                        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                          <Label>Comment</Label>
                          <TextArea value={comment} onInput={(e) => setComment(e.target.value)} rows={2} />
                          <Label required>Transport request</Label>
                          <Input value={transportNumber} onInput={(e) => setTransportNumber(e.target.value)} placeholder="e.g. SHDK900123" />
                          <Bar
                            endContent={
                              <FlexBox style={{ gap: "0.5rem" }}>
                                <Button
                                  design="Negative"
                                  disabled={busy}
                                  onClick={() => runAction(() => api.gate2(program.id, "request_changes", comment))}
                                >
                                  Request changes
                                </Button>
                                <Button
                                  design="Emphasized"
                                  disabled={busy || !transportNumber.trim()}
                                  onClick={() => runAction(() => api.gate2(program.id, "approve", comment, transportNumber.trim()))}
                                >
                                  Approve &amp; merge → transport
                                </Button>
                              </FlexBox>
                            }
                          />
                        </div>
                      </Panel>
                    )}

                    {program.report && (
                      <Panel headerText="Tech spec & test report">
                        <div style={{ padding: "1rem" }}>
                          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{program.report.markdown}</pre>
                          <Bar
                            endContent={
                              <Button onClick={() => downloadMarkdown(program.name, program.report!.markdown)}>Download report (.md)</Button>
                            }
                          />
                        </div>
                      </Panel>
                    )}

                    <Panel headerText="Audit trail" collapsed={program.state !== "DONE"}>
                      <div style={{ padding: "0.5rem 1rem" }}>
                        {program.auditLog.map((a, i) => (
                          <Text key={i} style={{ display: "block", fontSize: "0.85rem" }}>
                            {a.timestamp} — {a.actor} — {a.action}
                            {a.fromState ? ` (${a.fromState} → ${a.toState})` : ""}
                            {a.details ? `: ${a.details}` : ""}
                          </Text>
                        ))}
                      </div>
                    </Panel>
                  </div>
                )}
              </div>
            </WizardStep>
          );
        })}
      </Wizard>

      <BusyIndicator active={busy} style={{ display: busy ? "block" : "none" }} />
    </DynamicPage>
  );
}

function ValidationRow({ label, pass }: { label: string; pass: boolean }) {
  return (
    <Text style={{ display: "block" }}>
      {pass ? "✅" : "❌"} {label}
    </Text>
  );
}

// Distinct Include/Class objects that carry an approved finding but aren't
// the primary object being migrated — the source panel lets a reviewer
// actually see the code a deferred, cross-object finding refers to,
// instead of only ever seeing the primary object's (unaffected) diff.
function crossObjectContainers(program: ProgramDetail): string[] {
  return Array.from(new Set(program.findings.filter((f) => f.containerObject !== program.name).map((f) => f.containerObject)));
}

/**
 * Grouped by checkName with a count, not one line per finding — a real ATC
 * run against a full-size program can have hundreds of deferred findings of
 * only a handful of distinct check types, and listing each individually
 * (as this used to) produced an unreadable wall of repeated text.
 */
function deferredFindingSummary(program: ProgramDetail): { checkName: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of program.findings) {
    if (f.status !== "deferred") continue;
    counts.set(f.checkName, (counts.get(f.checkName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([checkName, count]) => ({ checkName, count }))
    .sort((a, b) => b.count - a.count);
}

function DependencySourcePanel({ programId, depName }: { programId: string; depName: string }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getDependencySource(programId, depName)
      .then((r) => {
        if (!cancelled) setSource(r.source);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [programId, depName]);

  return (
    <Panel headerText={`Source of ${depName} (read-only — not the primary object; not written by this app yet)`} collapsed>
      <div style={{ padding: "1rem" }}>
        {error && <MessageStrip design="Negative">{error}</MessageStrip>}
        {!error && source === null && <Text>Loading…</Text>}
        {source !== null && (
          <TextArea readonly value={source} rows={18} style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }} />
        )}
      </div>
    </Panel>
  );
}

function downloadMarkdown(programName: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${programName}-clean-core-report.md`;
  a.click();
  URL.revokeObjectURL(url);
}
