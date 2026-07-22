# Multi-Object Dependency-Aware Remediation — Design Document (v0.3, Finalized)

Companion to `clean-core-migration-design.md`. That document assumes a "unit of
work" is one ABAP object (a Program/Include). This document addresses what
happens once that assumption breaks — which, in practice, is most real
programs of any size: fixing one Clean Core violation often requires touching
an Include, a local or global Class, a Function Group, and occasionally a DDIC
structure, all of which have to activate together as one consistent set
before the *originally requested* object will even syntax-check, let alone
run correctly.

**v0.2 changelog:** this revision incorporated a full technical review by an
ABAP/Clean-Core expert reviewer. The review's verdict was **PASS WITH
CHANGES** — one claim in v0.1 was flagged as a load-bearing technical error
(mass-activation is not atomic), one scoping question was flagged as
undeclared (which Clean Core target — see §0), and the shared-dependency
write policy was flagged as too permissive for this specific landscape (a
shared dev/test client). All three were corrected, along with several
missing failure modes and a tighter v1 scope recommendation. See §5 for the
full list of what changed and why.

**v0.3 changelog:** the user reviewed §6's open questions and answered all
of them — this revision replaces those open questions with the confirmed
decisions (§6 is now "Decisions," not "Open questions"), adds an explicit
**top-priority constraint** (§0a: existing program functionality must never
change as a side effect of any fix), and adds a phased implementation plan
(§7) reflecting what actually gets built first.

## 0. Scope declaration (new in v0.2 — was previously undeclared)

"Clean Core" and "**ABAP for Cloud Development**" (the strict ABAP Cloud
language version) are **not the same target**, and this design must commit to
one before anything else in it is meaningful:

- **Clean Core on Standard ABAP** (what this app currently targets, per the
  companion doc's confirmed landscape — S/4HANA 2023 private cloud): the
  rule is *use only released APIs*; the code can otherwise remain in the
  classic (Standard ABAP) language version. `WRITE`, classic dynpro,
  `CALL TRANSACTION`, and most "old" statement forms remain legal — the
  violations are about *which tables/FMs/interfaces* are touched, not the
  statement vocabulary itself.
- **ABAP for Cloud Development** (the strict language version, required for
  BTP ABAP Environment / "Steampunk"): a materially stricter syntax subset —
  no classic dynpro/BDC/`CALL TRANSACTION`, no `SUBMIT` to classic reports,
  restricted internal-table and statement forms, and transactional data
  changes are expected to go through RAP, not ad hoc BAPI calls.

**Confirmed (§6.1): Clean Core on Standard ABAP.** The user additionally
confirmed a second scope rule that applies regardless of language-version
target: **only custom (Y/Z-namespace) objects are ever fixed/written by
this tool.** Standard/SAP objects are referenced as replacement targets
(a released CDS view, a released API) but are never themselves read for
editing, proposed a fix, or written to — this was already true of the
single-object flow by construction (the object a user submits for
migration is always their own custom object), and the multi-object design
makes it an explicit, enforced rule for closure resolution too: any
dependency node whose name doesn't match the Y/Z custom namespace is
always `EXTERNAL_REFERENCE` (§3.1), never `LOCAL_DEPENDENCY`, regardless of
its actual SAP object-release status.

## 0a. Top priority: functional equivalence — non-negotiable

Stated by the user as the top-priority rule for all of this work: **a
program's functionality must not change** as a result of any fix this tool
applies — automated or human-approved. Substituting a released API for a
direct table/FM access is only an acceptable fix if the *observable
behavior* of the program is unchanged; anything else is a regression, not a
migration, regardless of whether it activates cleanly.

This is not a new requirement invented for the multi-object case, but the
multi-object failure modes in §1 are exactly where it is most at risk of
being violated silently — a clean activation is not proof of behavioral
equivalence. The specific risks below are called out explicitly because
each one can pass syntax check and activation while still changing what the
program actually does:

- **CDS-view authorization filtering returning fewer rows than the original
  table read** (§1) — the highest-risk item on this list. No error, no
  dump, just quietly different output. This must be a named, explicit
  validation check (§4, item 4) before any CDS-view substitution is
  considered safe to write, not left to "activation passed."
- **Currency/quantity reference-field loss** (§1) turning correct amounts
  into unitless or wrongly-unit'd numbers.
- **BAPI/RAP side effects the original direct write never had** (§1) —
  output determination, change documents, workflow triggers — which are
  functional changes even when the primary business data ends up identical.
- **Append/enhancement fields silently dropped** because the released
  successor never exposed them (§1).
- **BAdI/implicit-enhancement detachment** when an edited include or
  replaced FM was wrapped by custom logic that assumed the old code path
  (§1).

Every gate in this app's existing workflow (Gate 1 scope approval, fix
review, validation, Gate 2 final approval) exists to catch exactly this
class of problem before a real write happens — the multi-object design does
not relax any of them; §4's checklist is the concrete, per-fix version of
this principle.

**This design targets Clean Core on Standard ABAP** — consistent with the
confirmed landscape in the companion doc. Every finding category, every
"needs re-architecture" label, and every DDIC/dynamic-ABAP judgment below
assumes that target. If the org's actual direction is the stricter ABAP
Cloud language version, a materially larger set of findings applies (no
classic dynpro, no ad hoc `CALL TRANSACTION`, RAP-only writes) and this
document would need a second pass — flagged as an open question in §6.

## 1. Why the current single-object model breaks down

The app today: reads one object's source → runs findings against that one
source → proposes a fix to that one source → writes/activates that one
object. This is correct only when the fix is fully self-contained inside the
object being fixed. That is the easy fraction of real migrations. The rest:

- **INCLUDEs are not separate compilation units.** An ABAP main program and
  every `INCLUDE` it pulls in compile as one physical unit. You cannot
  syntax-check, activate, or meaningfully diff "the program" without also
  loading (and, if the fix touches shared logic, writing) every INCLUDE in
  its chain. Today's tool reads only the main program's source — a finding
  whose real occurrence is inside an INCLUDE is invisible to it entirely,
  and a "fix" applied only at the main-program level while the actual
  offending code lives in an INCLUDE is a no-op that reports success falsely.
- **Fixes to a shared Include or global Class ripple outward.** If
  `ZCL_COMMON_UTILS` is fixed because *this* program's migration needs it,
  every *other* program, class, or report that also calls
  `ZCL_COMMON_UTILS` is affected the moment that object activates — whether
  or not those callers are part of the current migration batch, have been
  reviewed, or even have baseline tests. Blast radius extends past the
  object the user asked to migrate. **In this specific landscape the risk is
  sharper than usual**: the dev client doubles as the test client, with
  other developers potentially live in it (companion doc §3a) — an
  unreviewed activation of a shared object is not just a code-review gap,
  it changes runtime behavior underneath other people's active work with no
  consent from them.
- **DDIC objects (data elements, domains, table types, structures) are the
  highest-blast-radius case.** They have no "local" scope at all — a domain
  used by one field of one structure is, transitively, used everywhere that
  structure appears, including places with zero relationship to Clean Core.
  Auto-editing DDIC objects is a different risk class entirely from editing
  ABAP source and should not be treated the same way.
- **Regex-based dependency extraction (today's `extractDependencies`) misses
  real dependencies.** It catches `FROM`, `CALL FUNCTION '...'`, `=>`, and
  `TYPE REF TO` as literal text patterns. It does not (and structurally
  cannot) catch: dynamic calls (`CALL METHOD (lv_method)`,
  `PERFORM (lv_form) IN PROGRAM (lv_prog)`), inheritance (a subclass
  depending on a superclass's protected members), append structures, macros,
  or table types/structures referenced only via a `TYPES` statement. A
  text-heuristic dependency graph is a reasonable stand-in for *discovery
  signal* but is not sound enough to drive an automated multi-object write.
  A real ADT where-used query is materially better (§2), but is still not a
  complete oracle (§2 caveats) — it misses dynamic dispatch too, and depends
  on a where-used index that can be stale.
- **Replacement APIs are not behaviorally identical to what they replace,**
  independent of the multi-object question, but it compounds it:
  - A CDS view replacing a direct `SELECT` from a DB table may not expose
    every field the original selected (conversion routines, unit/currency
    conversion baked into annotations, different key structure, different
    buffering). Its DCL-driven authorization is the sharpest hazard here —
    not just "a difference," but a **silent correctness regression**: a raw
    table read returning 1,000 rows can come back as 200 through the CDS
    view once org-level access controls filter the result, with **no error,
    no dump — just missing rows**. A characterization test run by the same
    broad-authorization technical user this app already uses (§8 of the
    companion doc) will not catch this, because that user's own authorization
    doesn't hit the same filter. This needs its own explicit validation
    check, not just a pass/fail activation check.
  - **Currency and quantity reference fields.** A `CURR` field's `CUKY`
    reference and a `QUAN` field's `UNIT` reference must travel with the
    field through any CDS/API swap. A field-by-field mapping that drops or
    remaps the reference field silently produces amounts with the wrong (or
    no) currency — a common, financially material failure mode in table→CDS
    migrations.
  - **Append structures and enhancement fields.** A customer append on a
    standard table, or a field added via the classic enhancement framework,
    frequently has **no path through the released CDS successor** — the
    released view was never built to expose it. This is a hard stop the
    dependency closure won't surface on its own, because the missing field
    is a data-model gap, not a code dependency the graph walk would catch.
  - Direct table writes (`UPDATE`/`MODIFY`/`INSERT`/`DELETE`) are not fixed
    by "swap in a BAPI" as a general rule. In a Clean Core context the
    sanctioned write path is a **released API** — which in practice usually
    means **RAP (EML — Entity Manipulation Language)** for transactional
    data, or a BAPI *that is itself released* for Clean Core use. Many
    classic BAPIs are **not** released — swapping a direct table write for
    an unreleased BAPI just moves a Level-D finding to a Level-C one and
    reports false success. **"Is the replacement itself released?" must be
    a mandatory, automated check before any such fix is proposed**, not an
    assumption. Whichever released path is used, it is not a mechanical
    swap: it runs its own authorization/business-rule validation, returns
    `BAPIRET2`-style messages instead of raising exceptions, typically
    needs an explicit commit, and may trigger side effects the direct
    write never did (output determination, change documents, workflow).
  - A released function module/class method replacing a call to a
    non-released FM has its own parameter interface — importing/exporting/
    tables parameters rarely map 1:1 onto a structured BAPI/RAP signature.
  - **BAdI and implicit-enhancement interactions.** Custom enhancements
    (implicit enhancement points inside includes, BAdI implementations,
    explicit enhancement sections) are themselves Level-C/D constructs and
    often sit *inside the very includes being edited*, or wrap the very FM
    being replaced. Editing an include that carries an implicit
    enhancement, or replacing an FM a customer BAdI wraps, is a common way
    to silently detach or break an enhancement — not caught by a syntax
    check, since the enhancement is often syntactically independent.
  - **Test-double coupling.** Existing ABAP Unit tests — or the
    characterization tests this app auto-generates — that mock the old
    table or FM (via `CL_OSQL_TEST_ENVIRONMENT` for table doubles,
    `CL_CDS_TEST_ENVIRONMENT` for CDS) will either break or silently keep
    passing against a now-stale double once the real data source changes.
    The baseline oracle can be invalidated by the very fix it exists to
    guard against regressions in.
  - Some constructs have **no mechanical replacement** (reframed from v0.1's
    "no released replacement at all," which overstated it): dynamic ABAP is
    *restricted*, not abolished — RTTS/RTTI, dynamic `WHERE` clauses, and
    dynamic `SELECT` lists remain legal even under the stricter ABAP Cloud
    language version; what's actually gone is *program generation*
    (`INSERT REPORT`, `GENERATE SUBROUTINE POOL`, dynamic
    `PERFORM ... IN PROGRAM`). `EXEC SQL` frequently *does* have a target —
    AMDP, a CDS view, or plain Open SQL — it is not automatically a dead
    end. The genuinely hard-stop category is narrower: program generation,
    kernel calls (`CALL 'C'`-style), and a handful of SAP-GUI-only
    statements. These need re-architecture (or side-by-side extensibility),
    not a mechanical fix — the tool must recognize and label this category
    explicitly, distinct from "dynamic ABAP in general," rather than
    over-flag legal code as unmigratable.
- **Activation is not naturally atomic across multiple objects, and (see §3.3)
  neither is ADT's mass-activation endpoint.** Writing object A, activating
  it, then writing object B, activating it, one at a time, is exactly how
  you get an intermediate state where A references a signature B hasn't
  been updated to match yet. ADT's mass-activation is a real improvement
  over that — but it is dependency-ordered *best-effort*, not transactional
  (§3.3 corrects v0.1's claim that it is).
- **DDIC objects must activate before the ABAP that references them** —
  within a batch, and across a transport landscape. "Same transport" is
  necessary but not sufficient; activation and transport *ordering* both
  matter, not just co-location.
- **Cross-client considerations.** In a shared dev/test client, activations
  land in a client other developers may be actively working in, and any
  client-specific logic (`SY-MANDT` branches) can behave differently across
  clients than assumed by a single-client characterization test.
- **Package vs. software-component/use-access boundaries.** Scoping by
  ABAP package (as §3.1 does) is necessary but not sufficient — released-ness
  and use-access are also enforced at the software-component /
  package-interface level. A dependency can sit inside the package allowlist
  and still cross a use-access boundary that matters and that a
  package-only scope check would miss.
- **Where-used index freshness.** A real ADT where-used query (§2) is the
  closure resolver's intended dependency source, but it depends on a
  maintained cross-reference index. In a freshly loaded or under-indexed
  system, the "real" dependency graph can be as stale as the regex
  heuristic it's meant to replace — this is a prerequisite to state
  explicitly, not assume away.

## 2. What SAP itself already does here (grounding, per the existing doc's
philosophy of "ATC first, don't reinvent it")

- **ATC's check variants are already object-graph-aware at the tool level**:
  a real ATC run is normally scoped to a **package** or a **transport
  request**, not a single object, precisely because custom-code findings are
  meaningful at that granularity. Our static stand-in engine, by contrast,
  is scoped to whatever single source string it's handed — a real
  reintegration with ATC should run at package/transport scope once the
  blocked `SHD200ATC` RFC destination is fixed (see the other design doc,
  §3a), which would hand us multi-object findings for free instead of us
  reinventing graph discovery.
- **SAP's Custom Code Migration tooling and ADT's mass quick-fix likely
  already solve the hardest part of this — reuse before rebuilding.** ATC's
  Custom Code Migration worklist is itself dependency-aware across an
  object set, and ADT already supports **mass-applying released-API quick
  fixes across a whole finding set**, which necessarily handles activation
  ordering across that set. Before building a bespoke closure
  resolver + batch activator, the default should be: **where a canned,
  released-API mapping exists, drive ATC's own worklist and ADT's mass
  quick-fix directly**, and reserve the bespoke Migration Unit machinery in
  §3 for AI-authored or non-canned fixes that ATC's quick-fix mechanism
  doesn't cover. This is a scoping question for §6, not yet settled here.
- **ADT's activation endpoint (`/sap/bc/adt/activation?method=activate`)
  does accept multiple object references in one POST body** — that part of
  v0.1's grounding was correct, and it's still the right mechanism to reuse.
  What changed in this revision is *what activating multiple objects in one
  call actually guarantees* — see §3.3.
- **ADT exposes a repository information system with real "used by" / "uses"
  relations**, which is a sounder dependency source than regex — but not a
  complete oracle (§1's index-freshness and dynamic-dispatch caveats apply).
  This should replace `extractDependencies`'s text heuristic wherever
  real-mode connectivity is available; keep the regex heuristic only as the
  mock-mode stand-in.
- **SAP's own tooling treats extensibility as a spectrum, not a single
  "fix it" button**: the Custom Code Migration guidance (part of the
  broader ABAP Cloud / Clean Core toolchain, alongside SAP Readiness Check's
  simplification-item and custom-code compatibility checks) explicitly
  expects a mix of (a) mechanical released-API substitutions, (b) manual
  rework, and (c) side-by-side extensibility for what can't be brought
  inside the Clean Core boundary at all. This app's finding taxonomy
  (`native_quick_fix` / `ai_generated` / `none`) already mirrors that
  three-way split; the multi-object design should preserve it rather than
  assume everything is mechanically fixable once dependencies are resolved.
- SAP has also been previewing AI-assisted ABAP code adaptation (Joule for
  Developers / SAP Build Code's pair-programming features) as a *direction*
  for the harder rewrite cases — directionally relevant to the "no
  automated fix" bucket this app already has, but there is no public,
  automatable API for it today, so it's noted here as context, not a
  dependency for this design.
- **SPDD/SPAU are deliberately out of scope**, noted explicitly so this
  reads as a considered exclusion rather than an oversight: they are
  upgrade-time modification-adjustment tooling for changes to *SAP-delivered*
  objects, and are largely orthogonal to custom-code Clean Core remediation.

## 3. Proposed design

### 3.1 New concept: Migration Unit

Replace the implicit assumption of "one Program = one workflow instance"
with an explicit **Migration Unit**: the primary object plus its *resolved
dependency closure*, computed once at discovery time and re-validated at
every gate (including immediately before write — see §3.4, since a closure
computed at discovery time can go stale by the time of approval in a
multi-developer client).

```
MigrationUnit
├── primaryObject: { name, type, source }
├── languageVersionTarget: "standard_abap"   // see §0 — not a per-unit choice, fixed for this app
├── closure: DependencyNode[]        // BFS from primaryObject
│     each node: { name, type, source?, role, activationUnit, externalUsageCount }
├── scopeBoundary: { packages: string[], maxDepth: number }
└── ddicReferences: DdicRef[]        // read-only, never auto-edited
```

- **`role`** marks why a node is in the closure: `INCLUDE` (compiled
  together, must move with the primary object), `LOCAL_DEPENDENCY` (a
  Z/Y-namespace Class/Function Group actually called), or
  `EXTERNAL_REFERENCE` (a released or SAP-standard object the closure calls
  but never modifies — resolution stops there).
- **`activationUnit` (new in v0.2 — corrects a real error in v0.1).** A
  closure node's *finding location* and its *activation unit* are not
  always the same thing. A function-group include (`LZ…U01` etc.) or a
  class's internal method-include is not independently activatable — the
  activation unit is the **containing Function Group** or the **containing
  global Class as a whole**. `activationUnit` records that container
  explicitly, so the batch-write/activate sequence in §3.3 operates on
  activation units, while the Findings table (§3.6) can still attribute a
  finding to the specific include it actually occurs in.
- **`externalUsageCount`**: how many objects *outside* this migration unit
  also depend on this node, from the same where-used source as closure
  resolution (with the same staleness caveat — §1). Per §3.4, in v1 this is
  used to gate whether the node is even eligible for automated writing, not
  merely to flag it for acknowledgement.
- **Scope boundary is mandatory, not optional**, and now explicitly
  package **and** software-component/use-access aware (§1) — not
  package-name matching alone. Closure resolution BFS-walks real
  dependencies (via ADT's information-system "uses" relation, not regex)
  but only traverses into objects inside the configured allowlist and up to
  `maxDepth` hops. Anything outside the boundary is recorded as an
  `EXTERNAL_REFERENCE` leaf and never read for editing purposes.
  **Confirmed default (§6.2): the package allowlist is the primary object's
  own package.** For a brand-new object entered through the Create screen,
  the package is a required field the user supplies at intake (§7,
  task: make Package mandatory rather than defaulting to `UNKNOWN`) —
  there is no discovery step needed to "find" the package for a new object
  since it's asked for directly. **Confirmed `maxDepth` (§6.3): 2-3 hops**,
  matching the range originally proposed in v0.1, not uncapped.
- **DDIC objects are always `ddicReferences`, never part of the editable
  closure.** If a proposed fix would require a structure/table-type/domain
  change, the unit surfaces it as a manual, separately tracked action item
  (§3.5) — the automated write path never touches DDIC.

### 3.2 Discovery changes

- Keep the existing single-object discovery agent as the entry point, but
  have it resolve the full closure before analysis runs, not after.
- Prefer ADT's information-system "uses" relation over
  `extractDependencies`'s regex heuristic wherever real-mode connectivity is
  available; keep the regex heuristic only as the mock-mode stand-in (same
  role the static rule engine plays for ATC today). Treat the real
  where-used result as *more complete, not complete* (§1, §2).
- Findings are collected **per node in the closure**, not just on the
  primary object — the Findings table becomes grouped by object (attributed
  to the specific include/class where the finding actually occurs, per the
  `activationUnit` distinction in §3.1), and a finding whose real location
  is an Include is now visible instead of invisible.

### 3.3 Batch write / syntax-check / activate — revised: not atomic, and the
rollback story is the existing Git baseline, not "discard the batch"

**v0.1 claimed mass-activation makes the whole operation atomic. That claim
was wrong and is retracted.** ADT's multi-object activation processes the
set in dependency order, but objects that generate cleanly **are** activated
while objects that hit a generation/activation-time error are **not** — the
result is a per-object message list and a **possible partially-activated
landscape**, not an all-or-nothing transaction. A pre-activation syntax
check (step 3 below) reduces the odds of this but cannot eliminate it, since
some errors only surface at generation/activation time, not at syntax-check
time. Any design for this has to assume partial success is a real, expected
outcome — not an edge case to wave away.

Revised sequence for approved fixes across a Migration Unit:

1. **Pre-flight: acquire locks on every activation unit with a proposed
   change, for the whole set, before writing anything.** If any node is
   already locked by another developer (realistic in a shared dev/test
   client), fail fast for the whole unit rather than partially lock and
   stall. Keep the ADT session alive for the duration (§3.3 lock-longevity
   note below) and have an explicit orphan-lock cleanup path if the session
   drops mid-operation.
2. **Write all proposed sources**, but do **not** activate yet.
3. **Syntax-check the whole inactive set together** before activating
   anything, supplying the correct main-program context for any standalone
   include being checked (an include has no independent syntax check —
   it's checked *in the context of* a specified main program). This is what
   catches a cross-object signature mismatch while everything is still
   reversible, but see the opening note: it does not catch every
   activation-time failure.
4. **Mass-activate** the whole set in one ADT activation call. **Confirmed
   scope rule (§6.6): the activation call's object-reference list contains
   only the activation units that were actually changed and approved in
   this run** — never the whole discovered closure, never anything merely
   read for advisory/discovery purposes, and never an unrelated object that
   happens to share the package. `EXTERNAL_REFERENCE` nodes and
   advisory-only shared dependencies (§3.4) are never candidates for this
   call under any circumstance, since they were never written in the first
   place. Treat the result as a **per-object outcome list**, not a single
   pass/fail bit — some activation units may succeed while others fail in
   the same call.
5. **Recovery, corrected:** for any activation unit that did **not**
   activate, discarding its inactive version is clean (nothing changed).
   For any activation unit that **did** activate, there is no "discard" —
   its live version has already changed. **Recovery for an already-activated
   unit is a forward operation, not a rollback**: re-apply the Git baseline
   commit (already tracked per the companion doc's git-first flow, §6.6) by
   writing the baseline source back and re-activating it. The Migration
   Unit's status after a partial activation failure must show, per
   activation unit: activated-with-new-fix / reverted-to-baseline /
   never-touched — not a single unit-level pass/fail.
6. **Re-run findings across the whole closure**, not just the primary
   object, before moving to Gate 2 — the validation report needs a per-node
   breakdown, since "fixed the primary object but broke Include X" must be
   visible, not swallowed into a single pass/fail bit. This must include a
   result-set/authorization spot-check for any CDS-view substitution (§1) —
   a clean activation does not guarantee the same rows come back.

### 3.4 Shared-dependency policy — tightened: advisory-only in v1, not
"flag but allow"

v0.1 proposed flagging a shared `LOCAL_DEPENDENCY` (`externalUsageCount > 0`)
with an acknowledgement checkbox, then allowing the write. **Revised for
this landscape specifically**: given the dev client doubles as the test
client with other developers potentially live in it, a checkbox in this
tool is not informed consent from those other objects' owners. **For v1,
any `LOCAL_DEPENDENCY` with `externalUsageCount > 0` is advisory-only** — the
tool surfaces the finding, the resolved impact list, and a suggested fix,
but does **not** write it. Only nodes with zero external usage (in addition
to the primary object's own includes, which by definition have no
independent external usage) are eligible for automated write.
`externalUsageCount` must be **re-checked immediately before write, not just
at discovery**, since a new caller can appear between discovery and
approval in a shared, multi-developer client.

This is a stricter default than v0.1's; revisiting it (moving shared
dependencies from advisory-only to write-eligible-with-approval) is a
reasonable v2 once there's an isolated sandbox system to run this against
instead of a shared dev/test client — tracked as an open question in §6,
not decided here.

### 3.5 DDIC and no-mechanical-fix categories stay manual

Two categories are deliberately **out of automated scope**, surfaced as
tracked action items rather than attempted fixes:

- Any finding whose remediation would require changing a DDIC object
  (structure, table type, domain, data element).
- Any finding in the "no mechanical fix" category — reframed per §1 to
  cover specifically program generation, kernel calls, and SAP-GUI-only
  statements, **not** dynamic ABAP as a whole (RTTS/RTTI and dynamic
  WHERE/SELECT remain legal and are not automatically in this bucket).

Reason codes are split three ways (tightened from v0.1's collapsed
"no-automated-fix" bucket) so the audit trail distinguishes:
`needs-ddic-change` (manual) / `needs-rearchitecture` (manual, no mechanical
path exists) / `no-automated-fix-yet` (a mechanical path may exist in
principle — e.g. a generic SELECT * with no known CDS mapping identified —
but this tool doesn't have one). This third code is what the recently
shipped orchestrator fix already tags as `no-automated-fix`; the other two
reason codes are new and specific to the multi-object design.

### 3.6 UI implications (not yet built — depends on design approval)

- Findings table gains an **Object** column (which closure node/activation
  unit the finding is actually in).
- Fix Review (step 3) becomes **per-object tabs** for objects eligible for
  automated write (primary object + its own includes, per §3.4's tightened
  policy), each with the same side-by-side colored diff already built, plus
  a **dependency graph panel** showing the full resolved closure — including
  advisory-only shared dependencies and external references as read-only
  informational nodes, clearly distinguished from the write-eligible set.
- Gate 1 approval is per Migration Unit for the write-eligible set; advisory
  findings on shared dependencies are shown but do not require (or accept)
  an approval action in v1 — they're informational output for separate,
  manual follow-up.
- Results (step 4) shows a **per-activation-unit validation breakdown** (see
  §3.3 step 5's three-way status), not a single overall pass/fail, and
  **one transport** covering every activation unit actually changed.

### 3.7 Rollout strategy — bounded v1, not a big-bang rewrite

Given §3.4's tightened policy, the practical v1 scope is narrower and safer
than v0.1's Option A:

**v1 (recommended): bound automated writing to the primary object and its
own includes only.** Every other cross-object dependency — global classes,
function groups, other programs, and anything with `externalUsageCount > 0`
— is discovered, analyzed, diffed, and handed to a human as advisory output,
never written by automation. This:

- keeps activation to a single container (a program + its includes, or one
  function group, or one class) — eliminating the multi-activation-unit
  atomicity problem in §3.3 for the write path entirely (it only remains a
  concern for the advisory/discovery side, which never writes),
- eliminates the multi-lock-across-a-long-operation contention problem for
  the write path,
- eliminates un-consented blast radius into the shared dev/test client,
- and still captures the dominant real-world case: most objects, once their
  closure is resolved, turn out to have zero or very few in-scope local
  dependencies with findings of their own.

The full closure resolver and the dependency-graph panel are still worth
building in v1 — as **discovery/advisory** output, the same role the regex
heuristic and static rule engine already play as ATC stand-ins elsewhere in
this app: a signal, not an automated write driver.

**v2 (later, gated on two preconditions):** widen automated writing to
shared local dependencies, but only once (a) an isolated sandbox system
exists instead of the current shared dev/test client, and (b) the batch
write/activate machinery in §3.3 has been proven, in production use, against
the bounded v1 case first.

This replaces v0.1's "Option A vs. Option B" framing — the tightened §3.4
policy makes "Option B" (always full Migration Unit flow, including shared
dependencies, from day one) inappropriate for this landscape regardless of
UI convenience, so it's dropped rather than offered as a live choice.

## 4. Failure-mode checklist (consolidated from §1, for implementation
reference)

A finding's proposed fix must be checked against all of these before it is
eligible for **any** automated write (single-object or multi-object):

1. Is the replacement API/CDS view/RAP action itself released for Clean
   Core use? (Not just "does a mapping exist" — is the mapping target
   actually on the released list.)
2. Does the replacement expose every field the original access used,
   including any customer append/enhancement fields? If not: manual,
   `needs-rearchitecture`.
3. For CURR/QUAN fields: does the replacement carry the correct
   CUKY/UNIT reference field through?
4. For a CDS-view read replacing a direct table read: does DCL-driven
   authorization filtering change the result set for the technical user
   this app runs as, vs. the original unfiltered table read? (Needs an
   explicit row-count/spot-check validation, not just "activation passed.")
5. Does the object being edited carry an implicit enhancement point, or is
   the FM being replaced wrapped by a customer BAdI implementation?
6. Do existing ABAP Unit tests (or this app's generated characterization
   tests) use a table/CDS test double that assumes the old data source?
7. Is the change confined to DDIC? → always manual, never auto-write.
8. Is the change in the "no mechanical fix" bucket (program generation,
   kernel calls, SAP-GUI-only statements)? → always manual, never auto-write.
9. Is the node's `externalUsageCount` zero? If not → advisory-only in v1
   (§3.4), re-checked immediately before write, not just at discovery.

## 5. What changed from v0.1 (summary for reviewers who read the first
draft)

- §0 added: explicit scope declaration (Clean Core on Standard ABAP, not the
  stricter ABAP Cloud language version) — was previously undeclared.
- §1: reframed "no released replacement" → "no mechanical replacement,"
  narrowed to program generation/kernel calls/GUI-only statements; replaced
  "BAPI" as the write-replacement target with "released API (RAP/BAPI, with
  an explicit released-check)"; added CDS-DCL silent result-set reduction,
  currency/unit reference-field integrity, append/enhancement field gaps,
  BAdI/implicit-enhancement interactions, test-double coupling, DDIC-before-
  code ordering, cross-client considerations, package vs. software-component/
  use-access boundaries, and where-used index staleness.
- §2: added the recommendation to drive ATC's own worklist and ADT's mass
  quick-fix for canned/released mappings before building bespoke machinery;
  added the SPDD/SPAU exclusion note.
- §3.1: added `activationUnit`, distinct from finding location, to fix the
  function-group-include/class-include activation-granularity error.
- §3.3: retracted the "mass-activation is atomic" claim; replaced "discard
  the batch" with a three-way per-activation-unit outcome model where
  recovery from an already-activated unit is a forward re-apply of the Git
  baseline, not a discard; added pre-flight whole-set lock acquisition and
  orphan-lock handling.
- §3.4: tightened shared-dependency handling from "flag with
  acknowledgement, then allow" to **advisory-only, no automated write**, for
  this landscape; added re-checking `externalUsageCount` immediately before
  write.
- §3.5: split the manual-fix reason codes three ways
  (`needs-ddic-change` / `needs-rearchitecture` / `no-automated-fix-yet`).
  instead of one collapsed bucket.
- §3.7: replaced the "Option A vs. Option B" choice with a single
  recommended bounded v1 (primary object + its own includes only,
  everything else advisory) and an explicit, precondition-gated v2.
- §4 added: a consolidated pre-write failure-mode checklist for
  implementation reference.

## 6. Decisions (confirmed by the user — v0.1's open questions, resolved)

1. **Scope target: Clean Core on Standard ABAP — confirmed**, with an
   additional standing rule: **only custom (Y/Z) objects are ever fixed;
   standard objects are used only as replacement targets, never edited**
   (folded into §0 as a hard rule, not a configurable option).
2. **Package/software-component scope boundary: same package as the primary
   object, by default.** For a new object entered via the Create screen,
   the package is asked for directly at intake (now a required field, not
   defaulted — see §7, Phase 1b) rather than inferred.
3. **`maxDepth`: 2-3 hops** (not uncapped).
4. **v1 bounded scope confirmed**: automated writing stays limited to the
   primary object and its own includes; every shared local dependency is
   advisory-only, never auto-written, for the reasons in §3.4. No
   pushback was raised on this being the safer default for the current
   shared dev/test client.
5. **Sandbox timeline: none set yet.** The v2 widening in §3.7 (writing
   shared local dependencies) stays gated on an isolated sandbox existing —
   revisit when/if one is planned; no further action now.
6. **Lean on ATC's own worklist + ADT mass quick-fix for canned/released
   mappings — confirmed**, reserving the bespoke Migration Unit machinery
   for AI-authored/non-canned fixes, **with an explicit scoping
   clarification from the user**: whichever mechanism performs the
   activation, **the mass-activation call only ever targets the objects
   actually changed in that run** — never the full discovered closure,
   never anything read for advisory/discovery purposes only. This is now
   stated as a hard rule in §3.3, not left implicit.

*(v0.2's changelog, §5 above, still lists the full set of changes from the
original v0.1 draft. v0.3 additionally added §0a, converted §6 from
questions to confirmed decisions, and added §7 below.)*

## 7. Phased implementation plan

Given §0a's top-priority constraint — existing functionality must not
change — this is being built in phases that each leave the previously
working single-object flow untouched, rather than as one large change to
the write path at once.

- **Phase 1 (this pass): read-only visibility, zero change to the write
  path.** Extend discovery to actually fetch real Include and Class source
  (via the correct ADT endpoints — `programs/includes` and `oo/classes`,
  distinct from the `programs/programs` endpoint the primary object uses),
  run the existing static clean-core rules against each of them, and
  attribute each finding to the object it was actually found in (a new
  `containerObject` field, distinct from the existing `objectName` field
  which names the violation's *target*, e.g. the table being misread — not
  its container). This directly fixes the "a finding exists but I don't see
  it or any change for it" gap for findings that live in an Include/Class
  rather than the primary object. **Remediation and the write/activate path
  are completely untouched in this phase** — they continue to operate only
  on the primary object's source, exactly as before. A finding attributed
  to a different container object naturally falls into the existing
  `deferred` / `no-automated-fix` handling (already shipped), with a
  clearer reason message explaining *why*: it lives in a different object
  that multi-object writes don't cover yet, not that no fix could be
  identified.
- **Phase 1b (this pass): Package becomes a required intake field** on the
  single-object Create screen, replacing the current silent default to
  `UNKNOWN` — directly implementing decision §6.2's "ask for the package
  name" for new objects.
- **Phase 2 (not yet started, higher risk, needs its own review pass before
  it ships): write-capable multi-object remediation** for the primary
  object's own includes only (per the bounded v1 scope in §3.7) — batch
  lock/write/syntax-check/mass-activate (§3.3) restricted to exactly the
  changed activation units (§6.6), the full failure-mode checklist (§4)
  enforced before any such fix is proposed, and the per-object Fix Review
  UI (§3.6). This phase touches the real write path and will get the same
  kind of scrutiny (and, if warranted, another expert review pass) as
  Phase 1 got before it starts.

## 8. Status

Reviewed by an ABAP/Clean-Core expert agent — verdict **PASS WITH CHANGES**,
all items incorporated (v0.2). All open questions answered by the user and
recorded as decisions above (v0.3, §6). Phase 1/1b (read-only visibility +
required package field) is being implemented now; Phase 2 (write-capable
multi-object remediation) is deliberately deferred to its own pass.
