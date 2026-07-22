# Multi-Object Dependency-Aware Remediation — Design Document (v0.1, Draft for Review)

Companion to `clean-core-migration-design.md`. That document assumes a "unit of
work" is one ABAP object (a Program/Include). This document addresses what
happens once that assumption breaks — which, in practice, is most real
programs of any size: fixing one Clean Core violation often requires touching
an Include, a local or global Class, a Function Group, and occasionally a DDIC
structure, all of which have to activate together as one consistent set
before the *originally requested* object will even syntax-check, let alone
run correctly.

## 1. Why the current single-object model breaks down

The app today: reads one object's source → runs findings against that one
source → proposes a fix to that one source → writes/activates that one
object. This is correct only when the fix is fully self-contained inside the
object being fixed. That is the easy 20% of real migrations. The other 80%:

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
  object the user asked to migrate.
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
- **Replacement APIs are not behaviorally identical to what they replace,**
  independent of the multi-object question, but it compounds it:
  - A CDS view replacing a direct `SELECT` from a DB table may not expose
    every field the original selected (conversion routines, unit/currency
    conversion baked into annotations, different key structure, different
    buffering, and its own authorization checks via DCL that the raw table
    read never had).
  - A BAPI replacing a direct `UPDATE`/`MODIFY`/`INSERT`/`DELETE` is not a
    mechanical swap: BAPIs run their own authorization and business-rule
    validation, return `BAPIRET2` messages instead of raising exceptions,
    typically require an explicit `BAPI_TRANSACTION_COMMIT`, and may trigger
    side effects the direct table write never did (output determination,
    change documents, workflow events).
  - A released function module/class method replacing a call to a
    non-released FM has its own parameter interface — importing/exporting/
    tables parameters rarely map 1:1 to a BAPI's structured signature.
  - Some constructs have **no released replacement at all** today: dynamic
    ABAP, `EXEC SQL`, kernel calls, and a handful of SAP-GUI-only statements.
    These need re-architecture (or a side-by-side extension), not a fix —
    the tool must recognize and label this category explicitly rather than
    attempt (and silently fail) a mechanical substitution.
- **Activation is not naturally atomic across multiple objects.** Writing
  object A, activating it, then writing object B, activating it, is exactly
  how you get an intermediate state where A references a signature B hasn't
  been updated to match yet — a real syntax error window that doesn't exist
  in SE80/ADT's normal workflow, because that workflow keeps a whole batch
  *inactive* and mass-activates it together.
- **Transports need to move together.** Every object in one migration unit
  has to land in the same transport request (or a correlated set) so QA and
  Production always see a consistent, activatable state — never "half" of a
  cross-object fix.

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
- **SE80 / ADT's own activation model is "collect inactive, then mass
  activate."** ADT's `/sap/bc/adt/activation?method=activate` endpoint
  already accepts multiple object references in one POST body — this is
  the exact mechanism to reuse for atomic multi-object activation rather
  than inventing a new one.
- **ADT exposes a repository information system with real "used by" / "uses"
  relations** (`/sap/bc/adt/repository/informationsystem/...`), which is a
  sound dependency source — a graph built from that is trustworthy in a way
  a regex pass over source text never can be. This should replace
  `extractDependencies`'s text heuristic once real-mode dependency
  resolution matters for anything beyond discovery/display.
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

## 3. Proposed design

### 3.1 New concept: Migration Unit

Replace the implicit assumption of "one Program = one workflow instance"
with an explicit **Migration Unit**: the primary object plus its *resolved
dependency closure*, computed once at discovery time and re-validated at
every gate.

```
MigrationUnit
├── primaryObject: { name, type, source }
├── closure: DependencyNode[]        // BFS from primaryObject
│     each node: { name, type, source?, role, externalUsageCount }
├── scopeBoundary: { packages: string[], maxDepth: number }
└── ddicReferences: DdicRef[]        // read-only, never auto-edited
```

- **`role`** marks why a node is in the closure: `INCLUDE` (compiled
  together, must move with the primary object), `LOCAL_DEPENDENCY` (a
  Z/Y-namespace Class/Function Group actually called, in scope for fixes),
  or `EXTERNAL_REFERENCE` (a released or SAP-standard object the closure
  calls but never modifies — resolution stops there).
- **`externalUsageCount`**: how many objects *outside* this migration unit
  also depend on this node. A `LOCAL_DEPENDENCY` with a non-zero count is a
  shared object — flagged as elevated risk (§3.4), not auto-excluded.
- **Scope boundary is mandatory, not optional.** Closure resolution BFS-walks
  real dependencies (via ADT's information-system "uses" relation, not
  regex) but only traverses into objects inside the configured package
  allowlist and up to `maxDepth` hops. Anything outside the boundary is
  recorded as an `EXTERNAL_REFERENCE` leaf and never read for editing
  purposes — this bounds both blast radius and the size of a single review.
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
  role the static rule engine plays for ATC today).
- Findings are collected **per node in the closure**, not just on the
  primary object — the Findings table becomes grouped by object, and a
  finding whose real location is an Include is now visible and attributable
  to that Include specifically.

### 3.3 Batch write / syntax-check / activate

Sequence for approved fixes across a Migration Unit:

1. **Lock every node in the closure that has a proposed change** (not just
   the primary object) — same lock-then-write pattern already proven for
   the single-object case, extended to N objects.
2. **Write all proposed sources**, but do **not** activate yet.
3. **Syntax-check the whole inactive set together** before activating
   anything — this is what catches a cross-object signature mismatch while
   everything is still reversible.
4. **Mass-activate** the whole set in one ADT activation call (the endpoint
   already supports multiple object references — see §2). This is what
   makes the operation atomic in practice: either the whole consistent set
   activates, or none of it does.
5. **On any failure at steps 3 or 4, unlock and discard the whole batch** —
   never leave a partially-activated migration unit. This mirrors the
   existing single-object `ESCALATED` path, just scoped to the unit instead
   of one object.
6. **Re-run findings across the whole closure**, not just the primary
   object, before moving to Gate 2 — the validation report needs a per-node
   breakdown, since "fixed the primary object but broke Include X" must be
   visible, not swallowed into a single pass/fail bit.

### 3.4 Shared-dependency risk handling

A `LOCAL_DEPENDENCY` node with `externalUsageCount > 0` means fixing it
affects objects outside this migration unit's own review. Proposed handling:
surface it as a distinct, elevated-severity warning at Gate 1 ("this fix
also touches `ZCL_COMMON_UTILS`, used by 6 other objects not in this
migration"), requiring an explicit acknowledgement checkbox before it can be
approved — not an automatic block, since sometimes fixing the shared object
correctly *is* the right call, but it must never be silently rolled into an
otherwise-routine single-program approval.

### 3.5 DDIC and no-fix categories stay manual

Two categories are deliberately **out of automated scope**, surfaced as
tracked action items rather than attempted fixes:

- Any finding whose remediation would require changing a DDIC object
  (structure, table type, domain, data element).
- Any finding in the "no released replacement exists" category (dynamic
  ABAP, `EXEC SQL`, kernel calls, and similar) — these need re-architecture
  or side-by-side extensibility, which is a design decision for a human,
  not a mechanical fix this tool should ever attempt.

Both get a permanent `deferred` status with a reason code distinguishing
"needs DDIC change (manual)" from "needs re-architecture (manual)" from
"no automated fix available" (the existing bucket, tightened by the fix
shipped alongside this doc — see the recent `no-automated-fix` audit
entry). This keeps the audit trail honest about what will and won't ever be
touched by automation, which matters for whoever plans the manual follow-up
work.

### 3.6 UI implications (not yet built — depends on design approval)

- Findings table gains an **Object** column (which closure node the finding
  is actually in).
- Fix Review (step 3) becomes **per-object tabs**, each with the same
  side-by-side colored diff already built, plus a **dependency graph
  panel** showing the resolved closure (primary object, Includes, local
  dependencies with their external-usage counts, external references as
  read-only leaves).
- Gate 1 approval is per Migration Unit (all findings across the closure),
  not per single object.
- Results (step 4) shows a **per-object validation breakdown** in addition
  to the existing overall pass/fail, and **one transport** covering every
  object actually changed.

### 3.7 Rollout strategy — avoid a big-bang rewrite

Most real objects, even in a Clean Core migration backlog, turn out to have
zero or very few local (Y/Z) dependencies once the closure is resolved. Two
practical options once this design is approved:

- **Option A (recommended):** Keep today's single-object flow as the
  default execution path. Resolve the closure at discovery time regardless;
  if it comes back with only `EXTERNAL_REFERENCE` / `INCLUDE` nodes (no
  in-scope local dependencies with findings of their own), run exactly the
  flow that exists today — this is the common case and needs no UI change.
  Only switch to the full Migration Unit flow (multi-object tabs, grouped
  Gate 1, batch write/activate) when the closure actually contains
  in-scope local dependencies that need a fix. This means most of today's
  UI and orchestrator logic is additive, not replaced.
- **Option B:** Always run the full Migration Unit flow, even for the
  single-object case (a unit of size 1 is just a degenerate case of the
  general model). Simpler mental model long-term, but touches every
  existing code path immediately and is a bigger first step.

This document recommends **Option A** — narrower blast radius on the
existing, already-proven single-object flow, and the multi-object
machinery only activates when a real migration actually needs it.

## 4. Open questions for the user (mirrors §9 of the companion doc)

1. Package/scope boundary: should the allowed package list default to "same
   package as the primary object" or does the org want an explicit
   allowlist configured per landscape?
2. `maxDepth` default — is 2-3 hops a reasonable ceiling, or should it be
   uncapped within the package boundary?
3. Should a `LOCAL_DEPENDENCY` with a large `externalUsageCount` (say, >10)
   ever be hard-blocked rather than just flagged for acknowledgement?
4. Confirm DDIC objects should never be auto-edited under any circumstance
   (this document assumes yes, treating it as a hard rule, not a
   configurable option).
5. Is Option A (additive, default to today's flow when no local
   dependencies exist) acceptable, or is the multi-object flow wanted
   uniformly from day one (Option B)?

## 5. Status

Draft — pending ABAP-expert review before any implementation begins.
