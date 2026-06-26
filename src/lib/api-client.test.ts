import { describe, expect, it } from "vitest";
import { LlmWikiApiClient, normalizeBaseUrl } from "./api-client";

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("LlmWikiApiClient", () => {
  it("normalizes base URLs", () => {
    expect(normalizeBaseUrl("/api/llm-wiki///")).toBe("/api/llm-wiki");
    expect(normalizeBaseUrl("")).toBe("/api/llm-wiki");
  });

  it("parses projects and sends bearer token", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const client = new LlmWikiApiClient({
      baseUrl: "/api/llm-wiki",
      token: "secret",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization });
        return response({
          ok: true,
          projects: [{ id: "p1", name: "Demo", path: "/tmp/demo", current: true }],
          currentProject: { id: "p1", name: "Demo", path: "/tmp/demo", current: true },
        });
      },
    });

    const result = await client.projects();

    expect(calls[0]).toEqual({ url: "/api/llm-wiki/projects", auth: "Bearer secret" });
    expect(result.currentProject?.name).toBe("Demo");
  });

  it("surfaces upstream errors", async () => {
    const client = new LlmWikiApiClient({
      fetchImpl: async () => response({ ok: false, error: "Unauthorized" }, { status: 401 }),
    });

    await expect(client.projects()).rejects.toThrow("LLM Wiki API 401: Unauthorized");
  });
});
