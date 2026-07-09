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

  it("sends LLM Wiki 0.6 chat requests with tools, images, and history", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = new LlmWikiApiClient({
      baseUrl: "/api/llm-wiki",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return response({
          ok: true,
          projectId: "p1",
          sessionId: "s1",
          mode: "deep",
          message: { role: "assistant", content: "Answer" },
          references: [{ title: "Topic", path: "wiki/topic.md", kind: "wiki", score: 0.8 }],
          toolEvents: [{ tool: "wiki_search", status: "success", detail: "1 hit" }],
          events: [{ type: "done", sessionId: "s1" }],
          usage: { promptChars: 10, completionChars: 6, referenceCount: 1 },
        });
      },
    });

    const result = await client.chat("p1", "Hello", {
      sessionId: "s1",
      mode: "deep",
      wiki: true,
      web: true,
      anytxt: true,
      images: [{ mediaType: "image/png", dataBase64: "abc" }],
      history: [{ role: "user", content: "Earlier" }],
      historyExplicit: true,
    });

    expect(calls[0]).toMatchObject({
      url: "/api/llm-wiki/projects/p1/chat",
      method: "POST",
    });
    expect(calls[0].body).toMatchObject({
      message: "Hello",
      sessionId: "s1",
      mode: "deep",
      tools: { wiki: true, web: true, anytxt: true },
      images: [{ mediaType: "image/png", dataBase64: "abc" }],
      historyExplicit: true,
    });
    expect(result.message.content).toBe("Answer");
    expect(result.references[0].path).toBe("wiki/topic.md");
    expect(result.toolEvents[0].tool).toBe("wiki_search");
  });

  it("calls chat cancel and review state endpoints", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = new LlmWikiApiClient({
      baseUrl: "/api/llm-wiki",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(url).endsWith("/cancel")) return response({ ok: true, sessionId: "s1", cancelled: true });
        if (String(url).endsWith("/resolve")) return response({ ok: true, resolved: ["r1"], notFound: [], count: 1 });
        return response({ ok: true, reviewId: "r1", resolved: true });
      },
    });

    await expect(client.cancelChat("p1", "s1")).resolves.toEqual({ sessionId: "s1", cancelled: true });
    await client.patchReview("p1", "r1", { resolved: true, action: "Skip" });
    await expect(client.bulkResolveReviews("p1", ["r1"], "Bulk")).resolves.toEqual({
      resolved: ["r1"],
      notFound: [],
      count: 1,
    });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "/api/llm-wiki/projects/p1/chat/s1/cancel"],
      ["PATCH", "/api/llm-wiki/projects/p1/reviews/r1"],
      ["POST", "/api/llm-wiki/projects/p1/reviews/resolve"],
    ]);
    expect(calls[1].body).toEqual({ resolved: true, action: "Skip" });
    expect(calls[2].body).toEqual({ ids: ["r1"], action: "Bulk" });
  });
});
