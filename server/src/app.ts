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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function createApp(store: ProgramStore = new InMemoryProgramStore()) {
  const sap = createSapClient();
  const orchestrator = new Orchestrator(store, sap);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", sapIntegrationMode: process.env.SAP_INTEGRATION_MODE ?? "mock" });
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

  app.get("/api/programs", (_req, res) => {
    res.json(store.list().map(summarize));
  });

  app.get("/api/programs/:id", (req, res) => {
    const program = store.get(req.params.id);
    if (!program) return res.status(404).json({ error: "Program not found" });
    res.json(program);
  });

  app.get("/api/programs/:id/diff", (req, res) => {
    const program = store.get(req.params.id);
    if (!program) return res.status(404).json({ error: "Program not found" });
    res.type("text/plain").send(orchestrator.diff(req.params.id) || "No diff available yet.");
  });

  app.get("/api/programs/:id/report", (req, res) => {
    const program = store.get(req.params.id);
    if (!program) return res.status(404).json({ error: "Program not found" });
    if (!program.report) return res.status(409).json({ error: "Report not generated yet — program must reach DONE." });
    res.type("text/markdown").send(program.report.markdown);
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
      const { decision, comment } = req.body ?? {};
      if (!["approve", "request_changes"].includes(decision)) {
        return res.status(400).json({ error: "decision must be approve | request_changes" });
      }
      const program = await orchestrator.gate2Decision(req.params.id, decision, comment);
      res.json(program);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/retro", (_req, res) => {
    res.json(computeRetroMetrics(store.list()));
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
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
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

  // Experimental real-ATC trigger, isolated from the main pipeline while
  // the request/response shape gets proven against SHD200SYSTEM. Doesn't
  // modify any ABAP object — creates a worklist, runs the check, polls the
  // result. See RealAdtClient.triggerAtcRun.
  app.get("/api/diagnostics/atc-trigger/:programName", async (req, res) => {
    const destinationName = process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM";
    const checkVariant = String(req.query.checkVariant ?? "ZNUS_SCI_DEF_CENTRAL");
    const objectUri = `/sap/bc/adt/programs/programs/${encodeURIComponent(req.params.programName.toLowerCase())}`;
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
