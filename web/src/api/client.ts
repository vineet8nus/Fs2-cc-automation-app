import { ProgramDetail, ProgramSummary, RetroMetrics } from "../types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed with ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  async health() {
    return json<{ status: string; sapIntegrationMode: string }>(await fetch("/api/health"));
  },
  async listPrograms() {
    return json<ProgramSummary[]>(await fetch("/api/programs"));
  },
  async getProgram(id: string) {
    return json<ProgramDetail>(await fetch(`/api/programs/${id}`));
  },
  async uploadExcel(file: File) {
    const form = new FormData();
    form.append("file", file);
    return json<{ ingested: number; programs: ProgramSummary[] }>(
      await fetch("/api/programs/upload", { method: "POST", body: form })
    );
  },
  async createProgram(row: {
    programName: string;
    objectType?: string;
    package?: string;
    businessArea?: string;
    criticality?: "H" | "M" | "L";
    owner?: string;
  }) {
    return json<ProgramDetail>(
      await fetch("/api/programs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      })
    );
  },
  async gate1(id: string, decision: "approve" | "reject" | "defer", approvedFindingIds?: string[], comment?: string) {
    return json<ProgramDetail>(
      await fetch(`/api/programs/${id}/gate1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, approvedFindingIds, comment }),
      })
    );
  },
  async fixReview(id: string, decision: "approve" | "request_changes" | "reject", editedSource?: string, comment?: string) {
    return json<ProgramDetail>(
      await fetch(`/api/programs/${id}/fix-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, editedSource, comment }),
      })
    );
  },
  async gate2(id: string, decision: "approve" | "request_changes", comment?: string, transportNumber?: string) {
    return json<ProgramDetail>(
      await fetch(`/api/programs/${id}/gate2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, comment, transportNumber }),
      })
    );
  },
  async getReport(id: string) {
    const res = await fetch(`/api/programs/${id}/report`);
    if (!res.ok) throw new Error("Report not available yet");
    return res.text();
  },
  async getDiff(id: string) {
    const res = await fetch(`/api/programs/${id}/diff`);
    return res.text();
  },
  async getDependencySource(id: string, depName: string) {
    return json<{ name: string; type: string; source: string }>(
      await fetch(`/api/programs/${id}/dependency-source/${encodeURIComponent(depName)}`)
    );
  },
  async retro() {
    return json<RetroMetrics>(await fetch("/api/retro"));
  },
  /** Re-runs discovery/analysis against this same program (in place — no new row), picking up newly-added dependencies or a real ATC result if the RFC destination is back online. */
  async rerunAnalysis(id: string) {
    return json<ProgramDetail>(await fetch(`/api/programs/${id}/rerun`, { method: "POST" }));
  },
  async deleteProgram(id: string) {
    const res = await fetch(`/api/programs/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `Request failed with ${res.status}`);
    }
  },
};
