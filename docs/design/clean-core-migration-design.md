# SAP Clean Core Migration Automation — Design Document (v0.1, Design Phase)

Status: **DESIGN ONLY — not yet implemented.** This document is the output of the
"design first, implement second" phase requested for this app. It grounds the
design in SAP's published Clean Core guidance and Custom Code Analysis/ATC
tooling, validates the original requirements, and proposes an architecture,
agent set, workflow, UI, and roadmap.

---

## 0. Note on the referenced video

`https://youtu.be/W5oeaEXcwS0` could not be retrieved — YouTube served an
automated bot-check page instead of the video/transcript, and no transcript
mirror was found. Its content is **not** reflected below. If it contains a
specific product demo or architecture you want incorporated, the fastest path
is to paste the transcript, or the specific claims/screens from it, into the
chat — happy to fold that in.

---

## 1. Validation of your requirements

Overall the requirement set is well-formed and shows real understanding of
where clean core remediation projects usually fail (skipping baseline tests,
skipping human review, not verifying replacement objects exist). Corrections
and gaps below, organized by severity.

### Things to correct

1. **"Run it in Eclipse IDE"** — Eclipse itself has no server-side role. ADT
   (ABAP Development Tools) in Eclipse is a *thin client* over the same
   ADT REST API that's exposed by the ABAP backend (`/sap/bc/adt/...`). That
   REST layer is what actually reads sources, runs ATC, runs ABAP Unit, and
   applies quick fixes. This means: **you don't need to run or automate
   Eclipse** — your app's backend should talk to ADT REST endpoints directly
   (the same way abapGit, `abap-adt-api`, and MCP-for-ABAP projects already
   do). Eclipse only matters as the tool a human developer opens to eyeball a
   finding manually; it is not part of the automation path.

2. **"Same test results after fix = program still works the same"** — mostly
   right, but incomplete for a class of clean-core fixes that are *not*
   pure refactors. Replacing a direct table UPDATE with a released BAPI/RAP
   action, for example, can additionally trigger number-range assignment,
   change documents, or workflow events that a same-output unit test won't
   catch. Regression validation needs to check **side effects**, not just
   return values — see §8.

3. **"Prepare unit tests before changes to ensure post-change results are the
   same"** — correct instinct (this is "characterization testing" /
   golden-master testing), but there's a chicken-and-egg problem: most old
   custom ABAP has **no existing ABAP Unit tests**. If the app auto-generates
   the baseline tests from current behavior, those tests will faithfully lock
   in whatever the code does today — including existing bugs. A human must
   confirm the generated baseline actually reflects *intended* behavior before
   it's trusted as the regression oracle. This is exactly why your human-in-
   loop gate needs to sit **before** baseline test generation is trusted, not
   only before the fix.

4. **"ATC or a set of rules, preferably ATC"** — good default, but frame it as
   "ATC first, custom rules as a gap-filler," not either/or. ATC's clean-core
   check variant is release- and system-type dependent (see §3) — a system
   below a certain support package, or without central ATC configured, may not
   have all clean-core checks available yet. A small custom rule set (e.g.
   flagging deprecated statements, forbidden direct DB writes to SAP tables,
   naming-convention/governance rules specific to your org) is a sensible
   fallback/supplement, not a replacement.

### Things missing that should be added

- **Transport strategy.** Every fix eventually needs a transport request.
  Decide per-program or per-batch transports, who releases them, and how they
  flow through the landscape. Not mentioned in the original ask but mandatory
  for a real SAP change.
- **A non-production target system for the automated fix+validate loop.**
  The app should never write code changes directly against a system a
  developer is watching without a sandbox/dev step first — activate, test,
  and only then present the diff for human sign-off.
- **Service-user authorization scoping.** Discovery/analysis should run under
  a read-only technical user; write access (applying a fix, releasing a
  transport) should be a separate, narrower-scoped credential gated by the
  human approval step.
- **Idempotent, stateful tracking per object**, not a one-shot batch. The
  Excel upload will be re-run over time (new findings, partially-fixed
  programs, re-checks after an SAP release upgrade) — the app needs a
  persistent object-level status, not just a run log.
- **An explicit risk-scoring model** (the ask says "advise on risk score" but
  doesn't define inputs) — proposed in §7.

---

## 2. Grounding: SAP Clean Core (what SAP actually says)

Five pillars per SAP's clean core guidance: **Processes, Extensibility, Data,
Integration, Operations**. The part relevant to this app is Extensibility:
custom code must consume only **released, upgrade-stable APIs** (interfaces,
classes, function modules, CDS views, RAP behavior definitions) — never
SAP-internal objects, direct writes to SAP DDIC tables, or implicit
enhancements.

SAP has moved from a binary "clean vs. not clean" view to a **four-level
extensibility model (A–D)**:

| Level | Meaning |
|---|---|
| A | Only released, upgrade-stable APIs with a formal SAP stability contract |
| B | Mostly compliant, minor/tolerated deviations |
| C | Uses non-released-but-tolerated constructs, needs remediation |
| D | Not clean core — modifications, internal-object access, implicit enhancements, unsupported techniques |

This A–D scale (not a single risk number) is the right primary classification
axis for each finding; your numeric "risk score" should be a derived,
secondary metric layered on top (§7), not a replacement for it — developers
and governance reporting expect the A–D vocabulary.

Sources: [SAVIC Clean Core 2026 guide](https://www.savictech.com/insights/sap-clean-core-strategy-2026/), [SAP Community — Clean Core extensibility levels A–D](https://community.sap.com/t5/technology-blog-posts-by-members/clean-core-levels-a-d-how-to-classify-your-custom-abap-and-what-to-do-with/ba-p/14437956), [SAP Community — Business Excellence with clean core extensibility levels](https://community.sap.com/t5/technology-blog-posts-by-sap/business-excellence-with-sap-s-new-clean-core-extensibility-levels-why-what/ba-p/14191481)

---

## 3. Grounding: ATC / Custom Code Analysis tooling (what actually exists today)

- **ABAP Test Cockpit (ATC)** now ships dedicated **clean-core check
  variants**, available in ATC on SAP BTP ABAP Environment and in SAP
  S/4HANA 2025 (private cloud/on-premise). The flagship check is
  **"Usage of APIs"**: it flags any custom code touching non-released
  classes, interfaces, function modules, CDS views, DDIC tables/views,
  or programs — exactly the "clean or not" question this app needs to answer.
  For known patterns (e.g. direct `SELECT`/table access to a standard table
  that has a released successor CDS view), ATC can propose a **quick fix
  automatically**, but only when the field mapping between old table and new
  CDS view is unambiguous.
- **Recommended architecture (SAP's own guidance):** a **central ATC check
  system**, either "ATC on SAP BTP" (SAP's recommended default) or a central
  ATC role in an S/4HANA 2023/2025 system, checking custom code across the
  whole landscape remotely. This is the system your app's Analysis Agent
  should call, not each satellite system individually.
- **Custom Code Migration vs. Analyze Custom Code**: as of BTP ABAP
  Environment 2508 these were split into two Fiori apps — **Analyze Custom
  Code** (ongoing custom-code-quality/clean-core analysis) and **Custom Code
  Migration** (one-time S/4HANA conversion-specific analysis). Your app's use
  case (ongoing clean-core compliance of existing custom programs) maps to
  the **Analyze Custom Code** capability, not the migration-project one — good
  to know so you don't build against the wrong SAP app's data model.
- **Quick Fixes in Eclipse ADT**: resolve common patterns (ORDER_BY additions,
  MATNR-type issues, KONV/BSEG-related data model changes, released-API
  replacements) with one click, and can be **mass-applied** across a whole
  package/finding-set. Quick fixes are implemented as ADT/Eclipse-side logic
  invoked over the ADT protocol — not a documented, stable public REST
  contract. Community/open-source clients (`abap-adt-api`,
  `erpl-adt`, several ABAP MCP servers) already reverse-engineer enough of the
  ADT REST surface to read/write source, run ATC (`POST /atc/runs` style
  endpoints), run ABAP Unit, and in some cases trigger fix proposals — this is
  the same surface Eclipse itself uses, so it's the right integration point,
  with the caveat that it's not an officially published/stable API contract
  the way OData APIs are. Treat it as: **use it, but design a fallback** (see
  §6.4).
- **ABAP Unit + AI test generation**: SAP's newer AI capability inside ADT can
  generate ABAP Unit tests for public/protected/private methods of global
  classes and public methods of local classes, plus test-double support and
  refactoring of generated tests. This directly supports the
  "generate baseline tests" requirement in §6.2.

Sources: [ATC recommendations for clean-core governance](https://community.sap.com/t5/technology-blog-posts-by-sap/abap-test-cockpit-atc-recommendations-for-governance-of-clean-core-abap/ba-p/14186130), [SAP Help — Custom Code Analysis in ABAP Environment](https://help.sap.com/docs/sap-btp-abap-environment/abap-environment/getting-started-with-custom-code-analysis-in-abap-environment), [SAP Help — Applying recommended quick fixes for multiple ATC findings](https://help.sap.com/docs/abap-cloud/abap-development-tools-user-guide/applying-recommended-quick-fixes-for-multiple-atc-findings), [SAP Community — ATC for Developers in Eclipse](https://community.sap.com/t5/application-development-and-automation-blog-posts/abap-test-cockpit-atc-for-developers-in-eclipse/ba-p/13113248), [Custom Code Migration Guide PDF](https://help.sap.com/doc/9dcbc5e47ba54a5cbb509afaa49dd5a1/2025.000/en-US/CustomCodeMigration_EndToEnd.pdf), [abap-adt-api (GitHub)](https://github.com/marcellourbani/abap-adt-api), [erpl-adt — CLI/MCP over ADT REST API](https://github.com/DataZooDE/erpl-adt), [Project Piper — abapEnvironmentRunATCCheck](https://www.project-piper.io/steps/abapEnvironmentRunATCCheck/), [Generating ABAP Unit Tests with SAP Joule](https://learning.sap.com/courses/deepening-your-abap-programming-knowledge/generating-abap-unit-tests-with-sap-joule), [SAP Help — ABAP Unit Test Generation (Generative AI in ABAP Cloud)](https://help.sap.com/docs/abap-ai/generative-ai-in-abap-cloud/abap-unit-test-generation)

---

## 3a. Confirmed landscape details (as of 2026-07-18)

| Item | Confirmed value | Design implication |
|---|---|---|
| Release | RISE with SAP, S/4HANA 2023 (private cloud) | Central ATC on S/4HANA (not "ATC on BTP") is the check system; confirm the 2023 release's clean-core check variant coverage matches what's needed — some clean-core checks only shipped from later support packages, worth a quick confirm with Basis. |
| Connectivity | BTP destination `SHD200SYSTEM` (client 200), reached from BTP | This app calls the SAP system's ADT REST API **through this destination**, not via a direct network path — the destination's auth method (principal propagation, OAuth2SAMLBearerAssertion, or basic) determines what technical-user setup is needed. Confirm the destination's auth type before building the ADT client. |
| ATC | Already configured centrally, in the dev client (client 200) | Analysis Agent can start against this immediately — no prerequisite setup blocking Phase 1. |
| Test/sandbox | Dev system doubles as the test system (no separate sandbox) | Workable, but not isolated: automation runs will activate objects in a client other developers may be actively using. Mitigate with a **dedicated package/naming range reserved for automation-driven changes**, and treat "activate + test in dev" as a scoped, transport-tracked change — never a silent background activation. On RISE, provisioning/authorizing any new technical communication user for this typically goes through an SAP AMS ticket — plan lead time. |
| Version control | Must snapshot code to Git **before** any change is made | Becomes the baseline/rollback point and the mechanism for human review (§6.6) — see the new Git Sync Agent below. |

---

## 4. Proposed system architecture

```mermaid
flowchart TB
    subgraph Client["Web UI (developer-facing)"]
        U1[Excel Upload]
        U2[Program Dashboard]
        U3[Finding / Risk Detail + Diff Viewer]
        U4[Approval Gates]
        U5[Tech Spec & Test Report Viewer]
    end

    subgraph App["Automation Backend (this app)"]
        ORCH[Orchestrator / Workflow Engine]
        GITSYNC[Git Sync Agent]
        DISC[Discovery Agent]
        ANLZ[Clean Core Analysis Agent]
        BASE[Baseline Test Agent]
        REM[Remediation Agent]
        VAL[Validation Agent]
        DOC[Reporting Agent]
        RETRO[Process Retro Agent]
        DB[(App DB: objects, findings,\nrisk scores, test results, audit log)]
    end

    subgraph GIT["ABAP Mirror Git Repo"]
        BASELINE[baseline branch\n(pre-change snapshot)]
        PR[Fix branch + PR\n(proposed change + validation report)]
    end

    subgraph SAP["Target SAP Landscape (via BTP destination SHD200SYSTEM, client 200)"]
        ADT["ADT REST API\n(source read/write, syntax check,\nABAP Unit run, ATC run)"]
        ATCSYS["Central ATC check system\n(configured in dev client 200)"]
        DEVSYS[(Dev client = test client)]
        TR[Transport Management]
    end

    U1 --> ORCH
    ORCH --> GITSYNC --> ADT
    GITSYNC --> BASELINE
    ORCH --> DISC --> ADT
    DISC --> DB
    ORCH --> ANLZ --> ATCSYS
    ANLZ --> DB
    ORCH --> BASE --> ADT
    BASE --> U4
    U4 -->|approve scope| ORCH
    ORCH --> REM
    REM --> PR
    PR -->|apply for validation| DEVSYS
    ORCH --> VAL --> ATCSYS
    VAL --> ADT
    VAL -->|post checks/results| PR
    PR --> U4
    U4 -->|approve PR merge| TR
    ORCH --> DOC --> U5
    DOC -->|attach to PR| PR
    ORCH --> RETRO --> DB
    DB --> U2
    DB --> U3
```

### Agent roster and responsibilities

| Agent | Input | Action | Output |
|---|---|---|---|
| **Git Sync Agent** | Program name from Excel | Runs **first, before any other agent touches the object**: pulls current source of the program + every dependent object (includes, classes, function groups, DDIC/CDS DDL) via ADT REST and commits it to a `baseline/<program>` branch in a dedicated ABAP mirror Git repo | Immutable pre-change snapshot = rollback point + diff basis |
| **Discovery Agent** | Program name from Excel | Pulls object structure, includes, called function modules/classes, DDIC tables/CDS views used, where-used list, via ADT REST | Dependency graph per program |
| **Clean Core Analysis Agent** | Dependency graph | Triggers central ATC run with clean-core check variant on the full object set; supplements with custom rule engine for org-specific rules | List of findings, each mapped to an extensibility level (A–D) and ATC priority |
| **Baseline Test Agent** | Program + existing tests | Runs existing ABAP Unit tests if present; where missing/low-coverage, generates characterization tests (AI-assisted) capturing current behavior; **flags to human for confirmation these reflect intended behavior** | Baseline test suite + pass/fail snapshot ("golden master") |
| **Human Gate 1 — Review** | Findings + risk scores + baseline tests | Developer reviews and approves/rejects/defers each finding or whole program | Approved remediation scope |
| **Remediation Agent** | Approved findings | Applies fix: (a) native ADT quick fix where a stable, unambiguous mapping exists (e.g. released CDS-view successor), else (b) AI-generated fix constrained to released-API replacement only, never altering business logic; commits the result to a `fix/<program>-<finding>` branch and opens a **PR** against the baseline branch | PR with proposed diff + fix rationale in the description |
| **Validation Agent** | PR branch | Applies the branch content to the dev client via ADT write → syntax check → activate → confirm referenced objects (CDS fields, API signatures) actually exist and type-match → re-run ATC (finding cleared, no new findings) → re-run baseline + new tests → diff before/after behavior, including **side-effect checks** (change docs, number ranges, BAPI return messages) → posts results as **PR checks/comments** | Pass/fail validation report attached to the PR |
| **Human Gate 2 — Final Approval** | The PR itself (diff + validation report as checks/comments) | Developer reviews and approves/merges the PR, or requests changes (sends back for another remediation pass) | Merged PR = approved change, ready for transport |
| **Reporting Agent** | All of the above | Generates tech spec doc (what/why/ATC rule/impact) + unit test report + risk register per program; attaches to the merged PR | PDF/Excel/Markdown deliverables, linked from the PR |
| **Process Retro Agent** | Run metrics across programs (time per stage, quick-fix vs AI-fix ratio, rejection rate, rollback rate, false-positive rate) | Aggregates and surfaces process-improvement recommendations | Dashboard + periodic advisory report (this directly answers your "validate this process and advise on improvements" requirement — build it as a standing agent, not a one-time exercise) |

---

## 5. Per-program workflow / state machine

```
UPLOADED → GIT_BASELINED (Git Sync Agent snapshots pre-change source)
   → DISCOVERING → DISCOVERED → ANALYZING (ATC) → ANALYZED
   → BASELINING_TESTS → AWAITING_HUMAN_REVIEW_1
      → (rejected/deferred) → PARKED
      → (approved) → REMEDIATING (PR opened) → VALIDATING (in dev/test client)
         → (validation failed) → REMEDIATING (retry, capped attempts) or ESCALATE_TO_HUMAN
         → (validation passed) → AWAITING_HUMAN_REVIEW_2 (PR review)
            → (changes requested) → REMEDIATING (revise) or PARKED
            → (PR approved+merged) → TRANSPORT_RELEASED → DOCUMENTED → DONE
```

Every state transition is logged (who/when/why) — this audit trail *is* the
governance evidence auditors ask for in clean-core programs, so treat the
audit log as a first-class deliverable, not incidental logging.

---

## 6. Key design decisions & rationale

### 6.1 Excel input schema (minimum viable columns)
`Program Name | Package | Business Process Area | Business Criticality (H/M/L) | Notes/Owner`.
Criticality and owner feed the risk score and the approval routing.

### 6.2 Baseline testing approach
Characterization/golden-master testing: capture current input/output pairs
(and, where relevant, DB state before/after) as the regression oracle. Human
sign-off required before a baseline is trusted (see §1, correction 3).

### 6.3 Risk scoring model (proposed)
A weighted score, separate from but informed by the A–D extensibility level:

```
risk_score = w1*ATC_priority + w2*extensibility_level(A=0..D=3)
           + w3*usage_frequency (callers/transports in last N months)
           + w4*business_criticality (from Excel)
           + w5*fix_confidence_penalty (native quick fix=low penalty,
                                          AI-authored fix=higher penalty)
           + w6*dependency_fan_out (# of dependent objects touched)
```
Default weights should be configurable per customer/governance policy, not
hardcoded — different orgs weight business criticality vs. technical severity
differently.

### 6.4 Fix application strategy — hybrid, with explicit fallback
1. Try SAP's native ADT quick fix path first for checks with a known, stable
   mapping (released CDS-view successor, ORDER_BY, MATNR/KONV/BSEG patterns).
2. Where no native quick fix exists (bespoke internal-table access, custom
   forbidden patterns), fall back to an **LLM-assisted fix** that is
   explicitly constrained: only substitute released-API equivalents, never
   change control flow or business rules, and always run through the full
   Validation Agent gate before a human ever sees it as "ready."
3. Because the native quick-fix REST contract isn't officially published,
   budget engineering time to validate it empirically against your actual
   target release, and design the AI-fallback path as the primary path if it
   proves unstable — don't make the whole app depend on an undocumented API.

### 6.5 Where the app runs / connects
This app is a **side-by-side automation tool**, not something installed
inside the SAP system. For this landscape specifically, it connects outward
to:
- The **central ATC check system already configured in dev client 200** for
  clean-core analysis — no separate BTP ATC setup needed.
- The **ADT REST API**, reached through the BTP destination `SHD200SYSTEM`,
  for source read, dependency discovery, syntax check, ABAP Unit run, and
  (where viable) quick-fix application.
- The **dev client itself**, since no separate sandbox exists — code changes
  are activated and tested there before a human ever approves a transport,
  scoped to a dedicated package/naming range to limit collision with other
  developers actively working in the same client.

Credentials should be split: a read-only technical communication user for
Discovery/Analysis, and a separate, narrowly-scoped read-write user (used
only after Human Gate 1 approval) for Remediation/Validation. On RISE, both
likely require an SAP AMS ticket to provision/authorize against the BTP
destination — raise this early, it can otherwise block Phase 1.

### 6.6 Git-first change flow (why this replaces the custom diff viewer)
Because every change must be captured in Git *before* anything is touched,
the Git Sync Agent's baseline commit becomes the single source of truth for
"what did this program look like before," and the Remediation Agent's output
becomes an ordinary pull request against it:

- **Rollback is trivial**: reverting a bad fix in SAP means re-applying the
  baseline commit via ADT write, not reconstructing state from memory.
- **Human Gate 2 is a standard PR review**, not a bespoke UI — the app's
  "diff viewer" from §4 is realized as the PR's file diff, with the
  Validation Agent's ATC/test results posted as PR checks/comments rather
  than a separate report screen. This also means existing PR tooling
  (review, comment threads, approval requirements) can be reused instead of
  built from scratch.
- **Open decision**: should the ABAP mirror live in its own dedicated repo
  (recommended — one Git history per SAP system/client, independent of this
  app's own release cycle) or as a folder inside this `Fs2-cc-automation-app`
  repo? Recommend a dedicated repo per target client (e.g.
  `sap-shd200-abap-mirror`), created and owned by you, with this app reading/
  writing to it via a scoped token — keeps the automation app's own codebase
  separate from the customer ABAP snapshot it manages.

---

## 7. Tech stack recommendation (subject to your preference)

- **Backend**: Node.js/TypeScript or Python service hosting the Orchestrator
  and Agents; talks to ADT REST via an ADT client (build on patterns from
  `abap-adt-api`/`erpl-adt` rather than reinventing the protocol).
- **LLM for fix generation / test generation**: Claude via the Anthropic API,
  constrained with the target ABAP release's released-API catalog as
  grounding context (retrieved from ATC's "Usage of APIs" reference data)
  to avoid hallucinated replacement objects.
- **Frontend**: React/TypeScript SPA — dashboard, diff viewer (before/after
  ABAP source + test results side by side), approval workflow.
- **Persistence**: relational DB for object/finding/state/audit tracking.
- **Deployment target**: SAP BTP (Cloud Foundry/Kyma) if this should live
  alongside other BTP-hosted extensions, or any standard cloud host if it
  only needs outbound connectivity to the SAP landscape.

---

## 8. Testing & regression validation — the non-negotiable checklist

Before a fix can reach Human Gate 2, the Validation Agent must confirm **all**
of:
1. Syntax check passes, object activates cleanly in sandbox.
2. Every replaced object reference (CDS view, class, interface, BAPI) exists,
   is released, and field/parameter types match what the old code assumed.
3. Re-run of the same ATC clean-core variant shows the finding cleared and
   **no new findings introduced**.
4. Baseline (pre-change) ABAP Unit tests still pass against the new code.
5. Any newly-added tests for the changed logic pass.
6. Side-effect parity check for non-trivial replacements (e.g., BAPI
   replacing direct table write): change documents, number range behavior,
   return/message structures, and any downstream trigger (workflow, output
   determination) are compared, not just the primary return value.
7. Performance sanity check where the replacement is a CDS view over a direct
   table read (view joins can be materially slower/faster).

---

## 9. Open questions before implementation starts

Resolved: target landscape (RISE S/4HANA 2023, dev client 200, BTP
destination `SHD200SYSTEM`), ATC readiness (already configured centrally in
that client), and the requirement to Git-snapshot code before any change —
see §3a and §6.6. Still outstanding:

1. **BTP destination auth type for `SHD200SYSTEM`** — basic auth, principal
   propagation, or OAuth2SAMLBearerAssertion? Determines the technical-user
   provisioning request to raise with SAP AMS, and whether this app can use
   one shared technical user or needs per-developer identity flow-through.
2. **Fix-authoring source**: are you comfortable with Claude/an LLM
   authoring the non-canned fixes (constrained + fully validated + human-
   gated via PR review), or do you want v1 scoped to *only* the native ADT
   quick-fix patterns (safer, narrower coverage) with AI-authored fixes as a
   v2? (Recommended: include AI-authored fixes in v1, since every fix — native
   or AI — goes through the same Validation Agent + PR gate before merge, so
   the extra coverage doesn't cost safety.)
3. **ABAP mirror Git repo**: new dedicated repo (e.g.
   `sap-shd200-abap-mirror`) as recommended in §6.6, or a folder inside this
   repo? Who should own/host it — same GitHub org as this app?
4. **Dedicated package/naming range** in client 200 to scope automation-driven
   changes, so they're clearly distinguishable from manual developer work in
   the same client — what naming convention does your team already use for
   custom packages, so this can follow it rather than invent a new one?
5. Any existing governance/risk-scoring policy at your org this should match,
   or is the weighting model in §6.3 a fine starting default?

---

## 10. Phased roadmap (once the above is answered)

- **Phase 1**: Excel upload → Discovery Agent → Analysis Agent (ATC
  integration) → dashboard with findings/risk score. Read-only, no fixes yet.
- **Phase 2**: Baseline Test Agent + Human Gate 1 UI.
- **Phase 3**: Remediation Agent (native quick fixes only) + Validation Agent
  + Human Gate 2 + transport handoff.
- **Phase 4**: AI-authored fix fallback for non-canned findings.
- **Phase 5**: Reporting Agent (tech spec + test report generation) +
  Process Retro Agent / continuous improvement dashboard.
