import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DependencyObject, GitBaseline } from "../domain/types";
import { ObjectSource } from "../sap/SapClient";

// Local ABAP mirror repo used as the pre-change snapshot / rollback point,
// per docs/design/clean-core-migration-design.md §6.6. In production this
// mirrors to a dedicated hosted repo (e.g. sap-shd200-abap-mirror) — the
// mirror location is swappable via ABAP_MIRROR_REPO_PATH; the git plumbing
// itself doesn't change.
const MIRROR_ROOT = process.env.ABAP_MIRROR_REPO_PATH ?? path.join(__dirname, "..", "..", "data", "abap-mirror");

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function ensureMirrorRepo() {
  if (!fs.existsSync(MIRROR_ROOT)) fs.mkdirSync(MIRROR_ROOT, { recursive: true });
  if (!fs.existsSync(path.join(MIRROR_ROOT, ".git"))) {
    git(["init", "-q"], MIRROR_ROOT);
    git(["config", "user.email", "cc-automation@fs2ready.local"], MIRROR_ROOT);
    git(["config", "user.name", "Clean Core Automation"], MIRROR_ROOT);
    fs.writeFileSync(path.join(MIRROR_ROOT, "README.md"), "# ABAP mirror\nBaseline snapshots + remediation branches for clean core automation.\n");
    git(["add", "-A"], MIRROR_ROOT);
    git(["commit", "-q", "-m", "chore: init ABAP mirror repo"], MIRROR_ROOT);
  }
}

function objectFileName(name: string, kind: string) {
  return `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.${kind}.abap`;
}

/**
 * Runs first, before Discovery/Analysis ever touch the object: snapshots
 * the program's current source and every dependent object into a
 * `baseline/<program>` branch, giving a rollback point and a diff basis for
 * every later change.
 */
export function runGitSync(
  programName: string,
  programSource: ObjectSource,
  dependencies: DependencyObject[],
  dependencySources: ObjectSource[]
): GitBaseline {
  ensureMirrorRepo();
  const branch = `baseline/${programName}`;
  git(["checkout", "-q", "-B", "main"], MIRROR_ROOT);

  // Recreate the branch fresh each run so re-uploads produce a clean baseline.
  try {
    git(["branch", "-D", branch], MIRROR_ROOT);
  } catch {
    /* branch didn't exist yet */
  }
  git(["checkout", "-q", "-b", branch], MIRROR_ROOT);

  const dir = path.join(MIRROR_ROOT, programName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, objectFileName(programName, "PROG")), programSource.source);
  for (const dep of dependencySources) {
    fs.writeFileSync(path.join(dir, objectFileName(dep.name, dep.type)), dep.source);
  }
  fs.writeFileSync(
    path.join(dir, "dependencies.json"),
    JSON.stringify(dependencies, null, 2)
  );

  git(["add", "-A"], MIRROR_ROOT);
  git(["commit", "-q", "--allow-empty", "-m", `baseline: pre-change snapshot of ${programName}`], MIRROR_ROOT);
  const commit = git(["rev-parse", "HEAD"], MIRROR_ROOT);
  git(["checkout", "-q", "main"], MIRROR_ROOT);

  return {
    repo: MIRROR_ROOT,
    baselineBranch: branch,
    baselineCommit: commit,
  };
}

/** Commits the remediated source to a fix branch and records it as an open PR. */
export function commitRemediation(
  programName: string,
  baseline: GitBaseline,
  newSource: string,
  findingSummary: string
): GitBaseline {
  ensureMirrorRepo();
  const fixBranch = `fix/${programName}-${Date.now()}`;
  git(["checkout", "-q", baseline.baselineBranch], MIRROR_ROOT);
  git(["checkout", "-q", "-b", fixBranch], MIRROR_ROOT);

  const dir = path.join(MIRROR_ROOT, programName);
  fs.writeFileSync(path.join(dir, objectFileName(programName, "PROG")), newSource);
  git(["add", "-A"], MIRROR_ROOT);
  git(["commit", "-q", "--allow-empty", "-m", `fix: ${findingSummary}`], MIRROR_ROOT);
  git(["checkout", "-q", "main"], MIRROR_ROOT);

  return {
    ...baseline,
    fixBranch,
    prNumber: Math.floor(Date.now() / 1000) % 100000,
    prUrl: `local-mirror://${MIRROR_ROOT}/compare/${baseline.baselineBranch}...${fixBranch}`,
    prState: "open",
  };
}

export function diffAgainstBaseline(programName: string, baseline: GitBaseline): string {
  if (!baseline.fixBranch) return "";
  try {
    return git(["diff", baseline.baselineBranch, baseline.fixBranch, "--", programName], MIRROR_ROOT);
  } catch {
    return "";
  }
}
