# Clean Core Migration Automation App

Excel intake → Git baseline → SAP discovery → ATC clean-core analysis → risk
scoring → baseline tests → human approval (Gate 1) → remediation → validation
→ human approval (Gate 2, PR review) → transport → tech spec report. Full
design rationale: [`docs/design/clean-core-migration-design.md`](docs/design/clean-core-migration-design.md).

## Status

Phase 1-5 of the roadmap are implemented and running end-to-end **in mock
mode** (`SAP_INTEGRATION_MODE=mock`, the default). Real connectivity to
`SHD200SYSTEM` (RISE S/4HANA 2023, client 200) is a deliberately unimplemented
extension point — see `server/src/sap/RealAdtClient.ts` — pending the OAuth
grant type and destination binding described in the design doc §9.

## Structure

- `server/` — Node/TypeScript/Express backend: domain model, agents,
  orchestrator/state machine, REST API, and the SAP client abstraction
  (mock + real).
- `web/` — React/TypeScript frontend using SAP's official UI5 Web Components
  (`@ui5/webcomponents-react`) for a Fiori/Horizon-consistent look. (True
  Fiori Elements is metadata-generated from a RAP/CAP backend; since this app
  lives outside ABAP as a side-by-side tool, this is the supported way to
  get the same design language without one.)
- `docs/design/` — the design document.
- `mta.yaml`, `manifest.yml` — Cloud Foundry deployment (see below).

## Run locally

```
npm install          # installs both workspaces
npm run dev:server    # backend on :4000 (tsx watch)
npm run dev:web        # frontend on :5173 (Vite, proxies /api to :4000)
```

Or run the combined production build (single process serving API + static
frontend, same shape as the CF deployment):

```
npm run build
npm start              # serves on :4000 (or $PORT)
```

## Tests

```
cd server && npm test   # vitest: risk scoring, excel parsing, state machine,
                         # and a full API-level e2e run through every
                         # workflow state to DONE
```

## Deploy to Cloud Foundry

```
cf login -a <api endpoint> -o <org> -s <space>   # or --login --sso-passcode <code>
npm run build            # compiles server + frontend into server/dist
npm run prepare:deploy   # assembles deploy/ — compiled app + runtime-only package.json, no build hooks
cf push
```

`manifest.yml` points at `deploy/`, not the repo root. The CF `nodejs_buildpack`
runs its own `npm install` + optional `npm run build` during staging, and in
practice its node_modules cache can short-circuit that install before
devDependencies (tsc/vite) land — so rather than fight it, the app is built
locally first and only the compiled output + a minimal runtime-only
`package.json` (no `build`/`postinstall` scripts) is pushed. `deploy/` is
generated, gitignored, and safe to delete/regenerate any time.

This is deployed as a single combined Node app (no XSUAA/approuter/
destination-service wiring yet) — see the design doc §6.5/§9 for what
production hardening (auth, destination binding to `SHD200SYSTEM`, a
persistent DB instead of the in-memory store) adds once the SAP connectivity
details are final. The in-memory program store and local Git mirror both
live on the container's ephemeral filesystem, so app restarts currently lose
state — acceptable for this mock-mode milestone, not for production.
