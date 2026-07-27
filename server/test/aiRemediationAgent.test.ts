import { afterEach, describe, expect, it, vi } from "vitest";
import { AiCoreConfig, AiCoreRemediationClient } from "../src/agents/aiRemediationAgent";
import { Finding } from "../src/domain/types";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f1",
    atcCheckId: "CHK",
    checkName: "Usage of Released APIs",
    message: "Usage of not released application API.",
    objectName: "ZTEST",
    containerObject: "ZTEST",
    priority: 2,
    extensibilityLevel: "C",
    suggestedFix: { origin: "ai_generated", description: "n/a", confidence: "low" },
    status: "approved",
    ...overrides,
  };
}

const config: AiCoreConfig = {
  tokenUrl: "https://fake-idp.example/oauth/token",
  clientId: "id",
  clientSecret: "secret",
  apiUrl: "https://fake-aicore.example",
  deploymentId: "dep123",
  resourceGroup: "default",
};

function mockFetchSequence(responses: { status: number; body: unknown }[]) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  });
}

// expires_in: 0 so the module-level token cache in aiRemediationAgent.ts
// never short-circuits a later test's expected fetch call — each test gets
// its own fresh mockFetchSequence, but the token cache is shared module
// state across the whole test file, so a "cached" token from an earlier
// test must never look valid to a later one.
const tokenResponse = { status: 200, body: { access_token: "tok", expires_in: 0 } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AiCoreRemediationClient.proposeFixes", () => {
  it("applies a proposed fix only when the old snippet is present exactly once", async () => {
    const chatResponse = {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                fixes: [{ findingId: "f1", oldSnippet: "SELECT * FROM mara.", newSnippet: "SELECT * FROM I_Product.", explanation: "released view" }],
              }),
            },
          },
        ],
      },
    };
    vi.stubGlobal("fetch", mockFetchSequence([tokenResponse, chatResponse]));

    const client = new AiCoreRemediationClient(config);
    const result = await client.proposeFixes("ZTEST", "REPORT ztest.\nSELECT * FROM mara.\nWRITE 'x'.", [finding({})]);

    expect(result?.appliedFindingIds).toEqual(["f1"]);
    expect(result?.newSource).toContain("SELECT * FROM I_Product.");
    expect(result?.newSource).not.toContain("SELECT * FROM mara.");
  });

  it("refuses to apply a fix whose old snippet doesn't appear verbatim in the source", async () => {
    const chatResponse = {
      status: 200,
      body: {
        choices: [{ message: { content: JSON.stringify({ fixes: [{ findingId: "f1", oldSnippet: "SELECT * FROM totallydifferent.", newSnippet: "x" }] }) } }],
      },
    };
    vi.stubGlobal("fetch", mockFetchSequence([tokenResponse, chatResponse]));

    const client = new AiCoreRemediationClient(config);
    const source = "REPORT ztest.\nSELECT * FROM mara.\n";
    const result = await client.proposeFixes("ZTEST", source, [finding({})]);

    expect(result?.appliedFindingIds).toEqual([]);
    expect(result?.newSource).toBe(source);
  });

  it("refuses to apply a fix whose old snippet is ambiguous (appears more than once)", async () => {
    const chatResponse = {
      status: 200,
      body: {
        choices: [{ message: { content: JSON.stringify({ fixes: [{ findingId: "f1", oldSnippet: "SELECT * FROM mara.", newSnippet: "SELECT * FROM I_Product." }] }) } }],
      },
    };
    vi.stubGlobal("fetch", mockFetchSequence([tokenResponse, chatResponse]));

    const client = new AiCoreRemediationClient(config);
    const source = "SELECT * FROM mara.\nSELECT * FROM mara.\n"; // same snippet twice — which one?
    const result = await client.proposeFixes("ZTEST", source, [finding({})]);

    expect(result?.appliedFindingIds).toEqual([]);
    expect(result?.newSource).toBe(source);
  });

  it("strips a markdown code fence around the JSON response before parsing", async () => {
    const chatResponse = {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: "```json\n" + JSON.stringify({ fixes: [{ findingId: "f1", oldSnippet: "CLEAR lv_x.", newSnippet: "FREE lv_x." }] }) + "\n```",
            },
          },
        ],
      },
    };
    vi.stubGlobal("fetch", mockFetchSequence([tokenResponse, chatResponse]));

    const client = new AiCoreRemediationClient(config);
    const result = await client.proposeFixes("ZTEST", "CLEAR lv_x.", [finding({})]);

    expect(result?.appliedFindingIds).toEqual(["f1"]);
    expect(result?.newSource).toBe("FREE lv_x.");
  });

  it("returns undefined (graceful degradation) on a token request failure, never throwing", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([{ status: 401, body: { error: "invalid_client" } }]));

    const client = new AiCoreRemediationClient(config);
    await expect(client.proposeFixes("ZTEST", "REPORT ztest.", [finding({})])).resolves.toBeUndefined();
  });

  it("returns undefined on an inference call failure, never throwing", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([tokenResponse, { status: 500, body: { error: "internal" } }]));

    const client = new AiCoreRemediationClient(config);
    await expect(client.proposeFixes("ZTEST", "REPORT ztest.", [finding({})])).resolves.toBeUndefined();
  });

  it("returns undefined on an unparseable (non-JSON) model response, never throwing", async () => {
    const chatResponse = { status: 200, body: { choices: [{ message: { content: "Sorry, I can't help with that." } }] } };
    vi.stubGlobal("fetch", mockFetchSequence([tokenResponse, chatResponse]));

    const client = new AiCoreRemediationClient(config);
    await expect(client.proposeFixes("ZTEST", "REPORT ztest.", [finding({})])).resolves.toBeUndefined();
  });

  it("does not call fetch at all when there are no findings to fix", async () => {
    const fetchSpy = mockFetchSequence([tokenResponse]);
    vi.stubGlobal("fetch", fetchSpy);

    const client = new AiCoreRemediationClient(config);
    const result = await client.proposeFixes("ZTEST", "REPORT ztest.", []);

    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
