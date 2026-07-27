import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { Program } from "./domain/types";
import { InMemoryProgramStore, ProgramStore } from "./store/store";
import { createSapClient } from "./sap";
import { RealAdtClient } from "./sap/RealAdtClient";
import { Orchestrator } from "./orchestrator/orchestrator";
import { parseIntakeExcel } from "./utils/excelParser";
import { computeRetroMetrics } from "./agents/processRetroAgent";
import { AiCoreRemediationClient, loadAiCoreConfigFromEnv } from "./agents/aiRemediationAgent";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function createApp(store: ProgramStore = new InMemoryProgramStore()) {
  const sap = createSapClient();
  // Only wired up in real mode — mock/demo runs never make a real (paid)
  // AI Core call, keeping the mock-mode pipeline exactly as deterministic
  // as it always was. Absent config (AI Core not bound, or
  // AICORE_DEPLOYMENT_ID not set) leaves this undefined, which
  // Orchestrator treats as "no AI remediation available" — the same
  // honest "no automated fix" outcome as before this existed.
  const aiCoreConfig = process.env.SAP_INTEGRATION_MODE === "real" ? loadAiCoreConfigFromEnv() : undefined;
  const aiRemediation = aiCoreConfig ? new AiCoreRemediationClient(aiCoreConfig) : undefined;
  if (process.env.SAP_INTEGRATION_MODE === "real" && !aiRemediation) {
    console.warn("[app] Real mode without AI Core configured (missing aicore binding or AICORE_DEPLOYMENT_ID) — findings with no mechanical fix will be deferred for manual remediation only.");
  }
  const orchestrator = new Orchestrator(store, sap, aiRemediation);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", async (_req, res, next) => {
    try {
      const programCount = (await store.list()).length;
      res.json({
        status: "ok",
        sapIntegrationMode: process.env.SAP_INTEGRATION_MODE ?? "mock",
        storeType: store.constructor.name,
        aiRemediationEnabled: !!aiRemediation,
        programCount,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/programs/upload", upload.single("file"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded (expected multipart field 'file')." });
      const rows = parseIntakeExcel(req.file.buffer);
      if (rows.length === 0) {
        return res.status(400).json({ error: "No valid rows found. Expected a 'Program Name' column." });
      }
      const programs = await orchestrator.ingest(rows);
      res.status(201).json({ ingested: programs.length, programs: programs.map(summarize) });
    } catch (err) {
      next(err);
    }
  });

  // Single-object entry, for the one-at-a-time wizard flow — same intake
  // shape as an Excel row, without needing to build a spreadsheet for one
  // program. Excel upload remains the bulk path.
  const OBJECT_TYPES = ["PROGRAM", "CLASS", "FUNCTION_GROUP", "INCLUDE", "INTERFACE", "CDS_VIEW"];

  app.post("/api/programs", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { programName, objectType, package: pkg, businessArea, criticality, owner } = req.body ?? {};
      if (!programName || typeof programName !== "string") {
        return res.status(400).json({ error: "programName is required" });
      }
      if (!pkg || typeof pkg !== "string") {
        // Per docs/design/multi-object-dependency-remediation.md §6.2: the
        // package scope for dependency-closure resolution defaults to the
        // primary object's own package, so a new object must state it
        // explicitly at intake rather than silently defaulting.
        return res.status(400).json({ error: "package is required" });
      }
      const row = {
        programName,
        objectType: OBJECT_TYPES.includes(objectType) ? objectType : "PROGRAM",
        package: pkg,
        businessArea: businessArea || "General",
        criticality: ["H", "M", "L"].includes(criticality) ? criticality : "M",
        owner: owner || "Unassigned",
      };
      const [program] = await orchestrator.ingest([row]);
      res.status(201).json(program);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/programs", async (_req, res, next) => {
    try {
      res.json((await store.list()).map(summarize));
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/programs/:id", async (req, res, next) => {
    try {
      const program = await store.get(req.params.id);
      if (!program) return res.status(404).json({ error: "Program not found" });
      await store.delete(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/programs/:id", async (req, res, next) => {
    try {
      const program = await store.get(req.params.id);
      if (!program) return res.status(404).json({ error: "Program not found" });
      res.json(program);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/programs/:id/diff", async (req, res, next) => {
    try {
      const program = await store.get(req.params.id);
      if (!program) return res.status(404).json({ error: "Program not found" });
      const diff = await orchestrator.diff(req.params.id);
      res.type("text/plain").send(diff || "No diff available yet.");
    } catch (err) {
      next(err);
    }
  });

  // Read-only, on-demand source view for one of the program's own
  // dependencies (an Include/Class) — this is what lets a reviewer see
  // *why* a cross-object finding exists (docs/design/
  // multi-object-dependency-remediation.md §3.2) when the Fix Review
  // screen only shows the primary object's own (unfixable-for-that-
  // finding) diff. Never used to write — read-only, real mode only, same
  // as Phase 1's discovery-time closure resolution.
  app.get("/api/programs/:id/dependency-source/:depName", async (req, res, next) => {
    try {
      const program = await store.get(req.params.id);
      if (!program) return res.status(404).json({ error: "Program not found" });
      const dep = program.dependencies.find((d) => d.name === req.params.depName);
      if (!dep) return res.status(404).json({ error: `${req.params.depName} is not a known dependency of ${program.name}` });
      const result = await sap.readObjectSource(dep.name, dep.type);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/programs/:id/report", async (req, res, next) => {
    try {
      const program = await store.get(req.params.id);
      if (!program) return res.status(404).json({ error: "Program not found" });
      if (!program.report) return res.status(409).json({ error: "Report not generated yet — program must reach DONE." });
      res.type("text/markdown").send(program.report.markdown);
    } catch (err) {
      next(err);
    }
  });

  // Re-runs discovery/analysis against the same existing Program record —
  // the fix for "re-checking a program just piles up duplicate rows and
  // never shows fresh findings": this discards the prior pipeline results
  // and re-derives them from whatever the SapClient returns right now,
  // in place, instead of requiring a brand new intake row per re-check.
  app.post("/api/programs/:id/rerun", async (req, res, next) => {
    try {
      const program = await orchestrator.rerunAnalysis(req.params.id);
      res.json(program);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/programs/:id/gate1", async (req, res, next) => {
    try {
      const { decision, approvedFindingIds, comment } = req.body ?? {};
      if (!["approve", "reject", "defer"].includes(decision)) {
        return res.status(400).json({ error: "decision must be approve | reject | defer" });
      }
      const program = await orchestrator.gate1Decision(req.params.id, decision, approvedFindingIds, comment);
      res.json(program);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/programs/:id/fix-review", async (req, res, next) => {
    try {
      const { decision, editedSource, comment } = req.body ?? {};
      if (!["approve", "request_changes", "reject"].includes(decision)) {
        return res.status(400).json({ error: "decision must be approve | request_changes | reject" });
      }
      const program = await orchestrator.fixReviewDecision(req.params.id, decision, editedSource, comment);
      res.json(program);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/programs/:id/gate2", async (req, res, next) => {
    try {
      const { decision, comment, transportNumber } = req.body ?? {};
      if (!["approve", "request_changes"].includes(decision)) {
        return res.status(400).json({ error: "decision must be approve | request_changes" });
      }
      const program = await orchestrator.gate2Decision(req.params.id, decision, comment, transportNumber);
      res.json(program);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/retro", async (_req, res, next) => {
    try {
      res.json(computeRetroMetrics(await store.list()));
    } catch (err) {
      next(err);
    }
  });

  // Isolated proof-of-connectivity route: always uses RealAdtClient against
  // the real destination, independent of SAP_INTEGRATION_MODE — so it can
  // be exercised without switching the main upload/analysis pipeline (still
  // mock-only until far more of RealAdtClient is built out and a dedicated
  // technical user replaces the current personal-user credential) into real
  // mode. Read-only: calls readObjectSource only, nothing else.
  app.get("/api/diagnostics/sap-source/:programName", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    try {
      const result = await new RealAdtClient(destinationName).readObjectSource(req.params.programName);
      res.json({ destinationName, ...result });
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; cause?: { message?: string } };
      res.status(502).json({
        destinationName,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        cause: e.cause?.message,
      });
    }
  });

  // Generic, GET-only ADT REST explorer — deliberately read-only (no
  // method param, always GET) so it can be used to discover real endpoint
  // shapes (e.g. the ADT discovery document, ATC check variants) against
  // SHD200SYSTEM without risking a write. Not a general-purpose proxy.
  app.get("/api/diagnostics/adt-raw", async (req, res) => {
    const destinationName = String(req.query.destinationName ?? process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM");
    const path = String(req.query.path ?? "");
    if (!path.startsWith("/sap/bc/adt")) {
      return res.status(400).json({ error: "path must start with /sap/bc/adt" });
    }
    try {
      const response = await executeHttpRequest(
        { destinationName },
        { method: "get", url: path, headers: { Accept: "application/xml, text/plain, */*" } },
        { fetchCsrfToken: false }
      );
      res.type("text/plain").send(typeof response.data === "string" ? response.data : JSON.stringify(response.data));
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; cause?: { message?: string } };
      res.status(502).json({
        destinationName,
        path,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        cause: e.cause?.message,
      });
    }
  });

  // GET-only runtime OData V4 explorer — same read-only-proxy pattern as
  // adt-raw, just scoped to /sap/opu/odata4 instead of /sap/bc/adt, to
  // confirm a just-published service binding's actual runtime endpoint
  // (metadata, entity sets) rather than only its ADT repository status.
  app.get("/api/diagnostics/odata-raw", async (req, res) => {
    const destinationName = String(req.query.destinationName ?? process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM");
    const path = String(req.query.path ?? "");
    if (!path.startsWith("/sap/opu/odata4")) {
      return res.status(400).json({ error: "path must start with /sap/opu/odata4" });
    }
    try {
      const response = await executeHttpRequest(
        { destinationName },
        { method: "get", url: path, headers: { Accept: "application/xml, application/json, */*" } },
        { fetchCsrfToken: false }
      );
      res.type("text/plain").send(typeof response.data === "string" ? response.data : JSON.stringify(response.data));
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; cause?: { message?: string } };
      res.status(502).json({
        destinationName,
        path,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        cause: e.cause?.message,
      });
    }
  });

  // Experimental real-ATC trigger, isolated from the main pipeline while
  // the request/response shape gets proven against SHD200SYSTEM. Doesn't
  // modify any ABAP object — creates a worklist, runs the check, polls the
  // result. See RealAdtClient.triggerAtcRun.
  app.get("/api/diagnostics/atc-trigger/:programName", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const checkVariant = String(req.query.checkVariant ?? "ZNUS_SCI_CC_CENTRAL");
    // objtype lets this diagnostic target CLAS/INTF objects too, not just
    // PROG — the collection each lives under differs (oo/classes,
    // oo/interfaces, programs/programs).
    const objtype = String(req.query.objtype ?? "PROG");
    const collection = objtype === "CLAS" ? "oo/classes" : objtype === "INTF" ? "oo/interfaces" : "programs/programs";
    const objectUri = `/sap/bc/adt/${collection}/${encodeURIComponent(req.params.programName.toLowerCase())}`;
    try {
      const result = await new RealAdtClient(destinationName).triggerAtcRun(objectUri, checkVariant);
      res.json({ destinationName, checkVariant, objectUri, ...result });
    } catch (err) {
      const e = err as {
        message?: string;
        response?: { status?: number; data?: unknown; config?: { url?: string; method?: string } };
        cause?: { message?: string };
      };
      res.status(502).json({
        destinationName,
        checkVariant,
        objectUri,
        failedStep: e.response?.config ? `${e.response.config.method ?? "?"} ${e.response.config.url ?? "?"}` : undefined,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        cause: e.cause?.message,
      });
    }
  });

  // Experimental object-creation route for the Clean Core Governance app
  // (ZIF_ZCC_*/ZCL_ZCC_*/ZCC_*/ZI_CC_*/ZC_CC_* in ZTEST_VK) — see
  // RealAdtClient.createObject. Restricted to ZTEST_VK and the types
  // RealAdtClient knows how to build a creation body for, so this can't
  // become a general write-anywhere proxy; the transport number must be
  // supplied explicitly by the caller (no default) since it's tied to a
  // specific TR the human approved out-of-band.
  app.post("/api/diagnostics/create-object", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const { objtype, name, packageName, description, transportNumber, responsible } = req.body ?? {};
    if (packageName !== "ZTEST_VK") return res.status(400).json({ error: "packageName must be ZTEST_VK" });
    if (!Object.prototype.hasOwnProperty.call(RealAdtClient.CREATABLE_TYPES, objtype ?? ""))
      return res.status(400).json({ error: `objtype must be one of ${Object.keys(RealAdtClient.CREATABLE_TYPES).join(", ")}` });
    if (!name || !description || !transportNumber) return res.status(400).json({ error: "name, description, transportNumber are required" });
    try {
      const result = await new RealAdtClient(destinationName).createObject({
        objtype,
        name,
        packageName,
        description,
        transportNumber,
        responsible: responsible ?? "VINEET",
      });
      res.json({ destinationName, ...result });
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; debugMessages?: string[] };
      res.status(502).json({
        destinationName,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        debugMessages: e.debugMessages,
      });
    }
  });

  // Publishes an OData V4 service binding's runtime endpoint — a separate
  // step from binding activation. See RealAdtClient.publishODataV4Service.
  app.post("/api/diagnostics/publish-odata-v4", async (req, res) => {
    // Allows an explicit override — service publish/registration lives in a
    // different client (SHD250SYSTEM) than object creation/activation
    // (SHD200SYSTEM) on this landscape; repository objects are client-
    // independent, so the same SRVB created via SHD200SYSTEM's session is
    // visible and publishable through a SHD250SYSTEM session too.
    const destinationName = req.body?.destinationName ?? process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const { serviceName } = req.body ?? {};
    if (!serviceName) return res.status(400).json({ error: "serviceName is required" });
    try {
      const result = await new RealAdtClient(destinationName).publishODataV4Service(serviceName);
      res.json({ destinationName, ...result });
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; debugMessages?: string[] };
      res.status(502).json({
        destinationName,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        debugMessages: e.debugMessages,
      });
    }
  });

  // Companion to create-object: writes real source into a just-created (or
  // pre-existing empty) CLAS/INTF shell and activates it. See
  // RealAdtClient.writeAndActivateObjectSource.
  app.post("/api/diagnostics/write-object-source", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const { objectName, objectType, source, transportNumber } = req.body ?? {};
    if (!["CLAS", "INTF", "TABL", "DDLS", "BDEF", "SRVD"].includes(objectType))
      return res.status(400).json({ error: "objectType must be CLAS, INTF, TABL, or DDLS" });
    if (!objectName || !source) return res.status(400).json({ error: "objectName and source are required" });
    try {
      const result = await new RealAdtClient(destinationName).writeAndActivateObjectSource(objectName, objectType, source, transportNumber);
      res.json({ destinationName, ...result });
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; debugMessages?: string[] };
      res.status(502).json({
        destinationName,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        debugMessages: e.debugMessages,
      });
    }
  });

  // Service bindings are a distinct protocol from createObject — see
  // RealAdtClient.createServiceBinding.
  app.post("/api/diagnostics/create-service-binding", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const { name, packageName, description, serviceDefinitionName, transportNumber, responsible } = req.body ?? {};
    if (packageName !== "ZTEST_VK") return res.status(400).json({ error: "packageName must be ZTEST_VK" });
    if (!name || !description || !serviceDefinitionName || !transportNumber)
      return res.status(400).json({ error: "name, description, serviceDefinitionName, transportNumber are required" });
    try {
      const result = await new RealAdtClient(destinationName).createServiceBinding({
        name,
        packageName,
        description,
        serviceDefinitionName,
        transportNumber,
        responsible: responsible ?? "VINEET",
      });
      res.json({ destinationName, ...result });
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; debugMessages?: string[] };
      res.status(502).json({
        destinationName,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        debugMessages: e.debugMessages,
      });
    }
  });

  // Write-only variant (no activation) for objects that need a combined
  // multi-object activate — see RealAdtClient.writeObjectSourceOnly.
  app.post("/api/diagnostics/write-object-source-only", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const { objectName, objectType, source, transportNumber } = req.body ?? {};
    if (!["CLAS", "INTF", "TABL", "DDLS", "BDEF", "SRVD"].includes(objectType))
      return res.status(400).json({ error: "objectType must be CLAS, INTF, TABL, or DDLS" });
    if (!objectName || !source) return res.status(400).json({ error: "objectName and source are required" });
    try {
      const result = await new RealAdtClient(destinationName).writeObjectSourceOnly(objectName, objectType, source, transportNumber);
      res.json({ destinationName, ...result });
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; debugMessages?: string[] };
      res.status(502).json({
        destinationName,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        debugMessages: e.debugMessages,
      });
    }
  });

  // Combined activation for objects that reference each other (RAP root
  // composition <-> child to-parent association) — see
  // RealAdtClient.activateObjects.
  app.post("/api/diagnostics/activate-objects", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const { refs } = req.body ?? {};
    if (!Array.isArray(refs) || refs.length === 0) return res.status(400).json({ error: "refs must be a non-empty array of {objectName, objectType}" });
    try {
      const objectRefs = refs.map((r: { objectName: string; objectType: "CLAS" | "INTF" | "TABL" | "DDLS" }) => ({
        uri: `/sap/bc/adt/${RealAdtClient.collectionFor(r.objectType)}/${encodeURIComponent(r.objectName.toLowerCase())}`,
        name: r.objectName,
      }));
      const result = await new RealAdtClient(destinationName).activateObjects(objectRefs);
      res.json({ destinationName, ...result });
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown }; debugMessages?: string[] };
      res.status(502).json({
        destinationName,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
        debugMessages: e.debugMessages,
      });
    }
  });

  // Experimental real ABAP Unit trigger, isolated from the main pipeline
  // while the response shape gets proven against SHD200SYSTEM — unlike
  // RealAdtClient.runAbapUnit (which swallows failures to [] by design),
  // this surfaces the raw response/error so a parsing mismatch is visible
  // instead of silently looking like "no tests exist". Doesn't modify any
  // ABAP object.
  app.get("/api/diagnostics/abapunit-trigger/:programName", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const objectUri = `/sap/bc/adt/programs/programs/${encodeURIComponent(req.params.programName.toLowerCase())}`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">
  <external>
    <coverage active="false"/>
  </external>
  <options>
    <uriType value="semantic"/>
    <testDeterminationStrategy sameProgram="true" assignedTests="false"/>
    <testRiskLevels harmless="true" dangerous="false" critical="false"/>
    <testDurations short="true" medium="false" long="false"/>
    <withNavigationUri enabled="true"/>
  </options>
  <adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core">
    <objectSet kind="inclusive">
      <adtcore:objectReferences>
        <adtcore:objectReference adtcore:uri="${objectUri}"/>
      </adtcore:objectReferences>
    </objectSet>
  </adtcore:objectSets>
</aunit:runConfiguration>`;
    try {
      const tokenFetch = await executeHttpRequest(
        { destinationName },
        { method: "get", url: "/sap/bc/adt/discovery", headers: { "X-CSRF-Token": "Fetch" } },
        { fetchCsrfToken: false }
      );
      const csrfToken = tokenFetch.headers?.["x-csrf-token"];
      const setCookie = (tokenFetch.headers?.["set-cookie"] as string[] | undefined) ?? [];
      const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
      const response = await executeHttpRequest(
        { destinationName },
        {
          method: "post",
          url: "/sap/bc/adt/abapunit/testruns",
          data: body,
          headers: {
            "Content-Type": "application/*",
            Accept: "application/*",
            ...(csrfToken ? { "X-CSRF-Token": String(csrfToken) } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        { fetchCsrfToken: false }
      );
      res.type("text/plain").send(String(response.data));
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown } };
      res.status(502).json({
        destinationName,
        objectUri,
        error: e.message ?? String(err),
        httpStatus: e.response?.status,
        responseBody: e.response?.data,
      });
    }
  });

  // Serve the built frontend (see scripts/copy-frontend.js) if present —
  // absent in plain `npm run dev` where the Vite dev server handles the UI.
  const publicDir = path.join(__dirname, "public");
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: err.message });
  });

  return { app, orchestrator, store };
}

function summarize(program: Program) {
  return {
    id: program.id,
    name: program.name,
    objectType: program.objectType,
    package: program.package,
    businessArea: program.businessArea,
    criticality: program.criticality,
    owner: program.owner,
    state: program.state,
    findingsCount: program.findings.length,
    worstExtensibilityLevel: program.worstExtensibilityLevel,
    riskScore: program.riskScore,
    updatedAt: program.updatedAt,
  };
}
