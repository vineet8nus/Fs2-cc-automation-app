import {
  Bar,
  Button,
  BusyIndicator,
  CheckBox,
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
} from "@ui5/webcomponents-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { LevelBadge, RiskBadge, StateBadge } from "../components/Badges";
import { ProgramDetail } from "../types";

export function ProgramDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [program, setProgram] = useState<ProgramDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");

  const load = useCallback(async () => {
    if (!id) return;
    const p = await api.getProgram(id);
    setProgram(p);
    setSelected(new Set(p.findings.filter((f) => f.status === "open").map((f) => f.id)));
    if (p.gitBaseline?.fixBranch) {
      api.getDiff(id).then(setDiff).catch(() => undefined);
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

  return (
    <div style={{ maxWidth: 1100, margin: "2rem auto", padding: "0 1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <FlexBox justifyContent="SpaceBetween" alignItems="Center">
        <Title level="H2">{program.name}</Title>
        <FlexBox style={{ gap: "0.5rem" }}>
          <StateBadge state={program.state} />
          <LevelBadge level={program.worstExtensibilityLevel} />
          <RiskBadge riskScore={program.riskScore} />
        </FlexBox>
      </FlexBox>
      <Text>
        Package {program.package} · {program.businessArea} · Criticality {program.criticality} · Owner {program.owner}
      </Text>

      {error && <MessageStrip design="Negative">{error}</MessageStrip>}
      {program.state === "ESCALATED" && (
        <MessageStrip design="Negative">
          Remediation was escalated after {program.remediationAttempts} attempt(s) — validation kept failing. A human
          needs to look at this one directly rather than retry automatically.
        </MessageStrip>
      )}

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
                One or more baseline tests were auto-generated from current behavior. Confirm they reflect intended
                behavior before approving — see design doc §1.
              </MessageStrip>
            )}
            <Label>Comment</Label>
            <TextArea value={comment} onInput={(e) => setComment(e.target.value)} rows={2} />
            <Bar
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
                    Approve {selected.size} finding(s) &amp; remediate
                  </Button>
                </FlexBox>
              }
            />
          </div>
        </Panel>
      )}

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
          <pre style={{ padding: "1rem", overflowX: "auto", fontSize: "0.8rem" }}>{diff || "No diff produced."}</pre>
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
                  <Button design="Negative" disabled={busy} onClick={() => runAction(() => api.gate2(program.id, "request_changes", comment))}>
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

      <Panel headerText="Audit trail" collapsed>
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
      <BusyIndicator active={busy} style={{ display: busy ? "block" : "none" }} />
    </div>
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
