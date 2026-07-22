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
import { ProgramDetail } from "../types";

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
            <Breadcrumbs>
              <BreadcrumbsItem onClick={() => navigate("/")}>Programs</BreadcrumbsItem>
              <BreadcrumbsItem>{program.name}</BreadcrumbsItem>
            </Breadcrumbs>
          }
          header={<Title level="H2">{program.name}</Title>}
          subHeader={<Label>{objectTypeLabel(program.objectType)}</Label>}
          actions={
            <FlexBox style={{ gap: "0.5rem" }}>
              <StateBadge state={program.state} />
              <LevelBadge level={program.worstExtensibilityLevel} />
              <RiskBadge riskScore={program.riskScore} />
            </FlexBox>
          }
        />
      }
      headerContent={
        <DynamicPageHeader>
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
                                [{f.suggestedFix.origin === "native_quick_fix" ? "quick-fix" : f.suggestedFix.origin === "ai_generated" ? "AI-fix" : "manual"}]{" "}
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
                              {program.findings.filter((f) => f.status === "deferred").length} approved finding(s) have
                              no automated fix behind them and are unchanged in the proposed source below — they need
                              manual remediation, separately from this write:{" "}
                              {program.findings
                                .filter((f) => f.status === "deferred")
                                .map((f) => `${f.checkName} (${f.objectName})`)
                                .join("; ")}
                              .
                            </MessageStrip>
                          )}
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
                                  disabled={busy || !editedSource}
                                  onClick={() => runAction(() => api.fixReview(program.id, "approve", editedSource, comment))}
                                >
                                  Approve &amp; write to SAP
                                </Button>
                              </FlexBox>
                            }
                          />
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
                                <Button design="Emphasized" disabled={busy} onClick={() => runAction(() => api.gate2(program.id, "approve", comment))}>
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

function downloadMarkdown(programName: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${programName}-clean-core-report.md`;
  a.click();
  URL.revokeObjectURL(url);
}
