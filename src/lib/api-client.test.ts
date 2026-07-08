import { describe, expect, it } from "vitest";
import { DEFAULT_FILE_TREE_MAX_FILES, LlmWikiApiClient, normalizeBaseUrl } from "./api-client";

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

  it("requests the LLM Wiki 0.6 file tree hard limit by default", async () => {
    const calls: string[] = [];
    const client = new LlmWikiApiClient({
      fetchImpl: async (url) => {
        calls.push(String(url));
        return response({ ok: true, files: [] });
      },
    });

    await client.files("p1", { root: "wiki", recursive: true });

    expect(DEFAULT_FILE_TREE_MAX_FILES).toBe(10_000);
    expect(calls[0]).toContain("maxFiles=10000");
  });

  it("loads the WebUI aggregated full graph endpoint", async () => {
    const calls: string[] = [];
    const client = new LlmWikiApiClient({
      baseUrl: "/api/llm-wiki",
      fetchImpl: async (url) => {
        calls.push(String(url));
        return response({
          ok: true,
          nodes: [{ id: "a", label: "A", type: "concept", path: "wiki/a.md", linkCount: 1 }],
          edges: [{ source: "a", target: "b", weight: 1 }],
        });
      },
    });

    const graph = await client.fullGraph("p1");

    expect(calls[0]).toBe("/api/llm-wiki/projects/p1/graph/full");
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
  });
});
