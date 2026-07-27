import { Finding } from "../domain/types";

/**
 * Credentials + config to call the shared SAP AI Core "foundation-models"
 * deployment (a GPT-4o proxy, confirmed live: `default_aicore` service
 * instance, deployment id discovered via GET .../v2/lm/deployments). The
 * clientid/clientsecret/apiUrl come from the app's own `aicore` service
 * binding (VCAP_SERVICES) — never another app's credentials. deploymentId
 * and resourceGroup aren't part of a service binding (a deployment is a
 * resource created separately inside the AI Core tenant), so they're
 * configured via env vars.
 */
export interface AiCoreConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  deploymentId: string;
  resourceGroup: string;
}

export function loadAiCoreConfigFromEnv(): AiCoreConfig | undefined {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES ?? "{}");
    const creds = vcap.aicore?.[0]?.credentials;
    const deploymentId = process.env.AICORE_DEPLOYMENT_ID;
    if (!creds?.url || !creds?.clientid || !creds?.clientsecret || !creds?.serviceurls?.AI_API_URL || !deploymentId) {
      return undefined;
    }
    return {
      tokenUrl: `${creds.url}/oauth/token`,
      clientId: creds.clientid,
      clientSecret: creds.clientsecret,
      apiUrl: creds.serviceurls.AI_API_URL,
      deploymentId,
      resourceGroup: process.env.AICORE_RESOURCE_GROUP ?? "default",
    };
  } catch {
    return undefined;
  }
}

export interface AiFixResult {
  newSource: string;
  appliedFindingIds: string[];
  changeLog: string[];
}

export interface AiRemediationClient {
  proposeFixes(programName: string, source: string, findings: Finding[]): Promise<AiFixResult | undefined>;
}

interface LlmFixItem {
  findingId: string;
  oldSnippet: string;
  newSnippet: string;
  explanation?: string;
}

interface LlmResponseShape {
  fixes?: LlmFixItem[];
  unresolved?: { findingId: string; reason: string }[];
}

let cachedToken: { token: string; expiresAt: number } | undefined;

async function getAccessToken(config: AiCoreConfig): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`AI Core token request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

function buildPrompt(programName: string, source: string, findings: Finding[]): { system: string; user: string } {
  const numberedFindings = findings
    .map((f) => `- [id=${f.id}] ${f.checkName}${f.line ? ` (near line ${f.line})` : ""}: ${f.message}`)
    .join("\n");

  const system = `You are assisting an SAP ABAP "Clean Core" migration tool. You will be given the full ABAP source of one repository object and a list of real ATC (ABAP Test Cockpit) clean-core findings against it.

For each finding, if you can confidently identify a minimal, mechanical, safe source change that resolves it — e.g. replacing a direct standard-table SELECT/UPDATE/INSERT/DELETE with a released CDS view or BAPI, replacing an obsolete statement with its released equivalent, replacing a non-released function module call with a released API — propose that exact change as an old/new snippet pair. The old snippet MUST be an exact, verbatim substring of the source provided (matching whitespace) so it can be located and replaced mechanically. If you cannot quote it exactly, do not propose a fix for that finding.

Never change business logic, control flow, variable names, or unrelated comments, and never add new functionality. Never guess at authorization objects, business field values, or anything requiring a business decision — leave those findings unresolved. If you are not highly confident a change is both correct and safe, leave that finding unresolved rather than guessing — an honest "unresolved" is far better than a wrong or unsafe edit, since this proposal still goes to a human reviewer before anything is written to SAP, but an incorrect edit could still mislead that review.

Respond with ONLY a JSON object (no markdown fences, no commentary before or after) of exactly this shape:
{"fixes":[{"findingId":"<id>","oldSnippet":"<exact source substring>","newSnippet":"<replacement>","explanation":"<one sentence>"}],"unresolved":[{"findingId":"<id>","reason":"<one sentence>"}]}`;

  const user = `Object: ${programName}\n\nFindings:\n${numberedFindings}\n\nFull source:\n${source}`;

  return { system, user };
}

function parseLlmResponse(content: string): LlmResponseShape | undefined {
  try {
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.fixes)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Real AI Core-backed remediation for findings the mechanical (regex/table-
 * mapping) pass in remediationAgent.ts couldn't resolve — the majority of
 * real ATC findings today, since most only name the violated API/table in
 * free-text message strings, if at all. Applies old/new snippet pairs only
 * when the old snippet is found verbatim and unambiguously (exactly once)
 * in the current source — never guesses at a fuzzy match. On ANY failure
 * (auth, network, timeout, unparseable response) returns undefined rather
 * than throwing, so the caller falls back to the existing honest
 * "no automated fix — needs manual remediation" path; this must never be
 * allowed to break the remediation pipeline just because an external HTTP
 * call had a bad day.
 */
export class AiCoreRemediationClient implements AiRemediationClient {
  constructor(private readonly config: AiCoreConfig) {}

  async proposeFixes(programName: string, source: string, findings: Finding[]): Promise<AiFixResult | undefined> {
    if (findings.length === 0) return undefined;
    try {
      const token = await getAccessToken(this.config);
      const { system, user } = buildPrompt(programName, source, findings);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      let res: Response;
      try {
        res = await fetch(
          `${this.config.apiUrl}/v2/inference/deployments/${this.config.deploymentId}/chat/completions?api-version=2024-08-01-preview`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "AI-Resource-Group": this.config.resourceGroup,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              temperature: 0,
              max_tokens: 4000,
            }),
            signal: controller.signal,
          }
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) throw new Error(`AI Core inference failed: HTTP ${res.status}`);

      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) return undefined;

      const parsed = parseLlmResponse(content);
      if (!parsed?.fixes) return undefined;

      let newSource = source;
      const appliedFindingIds: string[] = [];
      const changeLog: string[] = [];
      for (const fix of parsed.fixes) {
        if (!fix.oldSnippet || !fix.newSnippet) continue;
        const occurrences = newSource.split(fix.oldSnippet).length - 1;
        if (occurrences !== 1) continue; // absent or ambiguous — refuse rather than guess which occurrence
        newSource = newSource.replace(fix.oldSnippet, fix.newSnippet);
        appliedFindingIds.push(fix.findingId);
        changeLog.push(`[AI-fix] ${fix.explanation ?? "AI Core-proposed fix"}`);
      }

      return { newSource, appliedFindingIds, changeLog };
    } catch (err) {
      console.warn(`[aiRemediationAgent] AI Core fix proposal failed for ${programName}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
