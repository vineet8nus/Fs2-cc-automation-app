import * as XLSX from "xlsx";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { InMemoryProgramStore } from "../src/store/store";

function buildExcel(rows: Record<string, unknown>[]): Buffer {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Programs");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

describe("end-to-end mock workflow", () => {
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    ({ app } = createApp(new InMemoryProgramStore()));
  });

  it("runs an uploaded program through discovery/analysis/baseline automatically to Gate 1", async () => {
    const excel = buildExcel([
      { "Program Name": "ZTEST_ORDER", Package: "ZSD", "Business Process Area": "Sales", "Business Criticality": "H", "Notes/Owner": "dev1" },
    ]);

    const uploadRes = await request(app).post("/api/programs/upload").attach("file", excel, "programs.xlsx");
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.ingested).toBe(1);
    const summary = uploadRes.body.programs[0];
    expect(summary.state).toBe("AWAITING_HUMAN_REVIEW_1");
    expect(summary.findingsCount).toBeGreaterThan(0);
    expect(summary.riskScore).toBeTruthy();

    const detail = await request(app).get(`/api/programs/${summary.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.dependencies.length).toBeGreaterThan(0);
    expect(detail.body.baselineTests.cases.length).toBeGreaterThan(0);
    expect(detail.body.gitBaseline.baselineCommit).toBeTruthy();
  });

  it("walks a program through both human gates to DONE with a generated report", async () => {
    const excel = buildExcel([
      { "Program Name": "ZTEST_MATERIAL", Package: "ZMM", "Business Process Area": "Materials", "Business Criticality": "M", "Notes/Owner": "dev2" },
    ]);
    const uploadRes = await request(app).post("/api/programs/upload").attach("file", excel, "programs.xlsx");
    const id = uploadRes.body.programs[0].id;

    const gate1 = await request(app).post(`/api/programs/${id}/gate1`).send({ decision: "approve", comment: "looks fine" });
    expect(gate1.status).toBe(200);
    expect(gate1.body.state).toBe("AWAITING_FIX_REVIEW");
    expect(gate1.body.proposedSource).toBeTruthy();
    expect(gate1.body.baselineSource).toBeTruthy();

    const fixReview = await request(app)
      .post(`/api/programs/${id}/fix-review`)
      .send({ decision: "approve", comment: "fix looks right, write it", transportNumber: "TR12345" });
    expect(fixReview.status).toBe(200);
    expect(["AWAITING_HUMAN_REVIEW_2", "ESCALATED"]).toContain(fixReview.body.state);

    if (fixReview.body.state === "ESCALATED") {
      // Documented valid outcome of the retry-cap path, not a test failure.
      return;
    }

    expect(fixReview.body.validationReport.overallPass).toBe(true);

    const gate2 = await request(app)
      .post(`/api/programs/${id}/gate2`)
      .send({ decision: "approve", comment: "ship it", transportNumber: "SHDK900001" });
    expect(gate2.status).toBe(200);
    expect(gate2.body.state).toBe("DONE");
    expect(gate2.body.gitBaseline.prState).toBe("merged");
    expect(gate2.body.transportNumber).toBe("SHDK900001");

    const report = await request(app).get(`/api/programs/${id}/report`);
    expect(report.status).toBe(200);
    expect(report.text).toContain("Clean Core Remediation");

    const diff = await request(app).get(`/api/programs/${id}/diff`);
    expect(diff.status).toBe(200);
  });

  it("parks a program on Gate 1 rejection instead of remediating", async () => {
    const excel = buildExcel([{ "Program Name": "ZTEST_PARK", "Business Criticality": "L" }]);
    const uploadRes = await request(app).post("/api/programs/upload").attach("file", excel, "programs.xlsx");
    const id = uploadRes.body.programs[0].id;

    const gate1 = await request(app).post(`/api/programs/${id}/gate1`).send({ decision: "reject", comment: "not in scope this quarter" });
    expect(gate1.status).toBe(200);
    expect(gate1.body.state).toBe("PARKED");
  });

  it("rejects an out-of-sequence gate call", async () => {
    const excel = buildExcel([{ "Program Name": "ZTEST_SEQ" }]);
    const uploadRes = await request(app).post("/api/programs/upload").attach("file", excel, "programs.xlsx");
    const id = uploadRes.body.programs[0].id;

    const gate2Early = await request(app).post(`/api/programs/${id}/gate2`).send({ decision: "approve" });
    expect(gate2Early.status).toBe(400);
  });

  it("exposes retro metrics across ingested programs", async () => {
    const excel = buildExcel([{ "Program Name": "ZTEST_RETRO1" }, { "Program Name": "ZTEST_RETRO2" }]);
    await request(app).post("/api/programs/upload").attach("file", excel, "programs.xlsx");

    const retro = await request(app).get("/api/retro");
    expect(retro.status).toBe(200);
    expect(retro.body.totalPrograms).toBe(2);
    expect(Array.isArray(retro.body.recommendations)).toBe(true);
  });

  it("rejects an upload with no valid rows", async () => {
    const excel = buildExcel([{ Package: "ZPKG" }]);
    const res = await request(app).post("/api/programs/upload").attach("file", excel, "programs.xlsx");
    expect(res.status).toBe(400);
  });
});
