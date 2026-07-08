import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.WEBUI_ACCESS_TOKEN = "webui-test-token";
process.env.LLM_WIKI_API_TOKEN = "native-api-token";
process.env.LLM_WIKI_API_BASE_URL = "http://native.example:19828";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(__dirname, "../dist");
await mkdir(distRoot, { recursive: true });
await writeFile(resolve(distRoot, "index.html"), "<!doctype html><title>Test Shell</title>", "utf8");

const {
  DEFAULT_PROXY_TIMEOUT_MS,
  isAllowedProxyRequest,
  isAuthenticated,
  rewriteProxyUrl,
  server,
  validateRuntimeConfig,
} = await import("./index.mjs");

let baseUrl;
let originalFetch;

function localRequest(path, options = {}) {
  return new Promise((resolveRequest, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpRequest(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolveRequest({
            status: res.statusCode,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise((resolveClose) => server.close(resolveClose));
});

describe("runtime config", () => {
  it("requires WEBUI_ACCESS_TOKEN unless auth is explicitly disabled", () => {
    expect(() => validateRuntimeConfig({})).toThrow("WEBUI_ACCESS_TOKEN is required");
    expect(() => validateRuntimeConfig({ WEBUI_AUTH_DISABLED: "true" })).not.toThrow();
    expect(() => validateRuntimeConfig({ WEBUI_ACCESS_TOKEN: "strong-token" })).not.toThrow();
  });

  it("uses a 90 second default upstream proxy timeout for large LLM Wiki projects", () => {
    expect(DEFAULT_PROXY_TIMEOUT_MS).toBe(90_000);
  });
});

describe("rewriteProxyUrl", () => {
  it("rewrites WebUI proxy paths to upstream API v1", () => {
    expect(rewriteProxyUrl("/api/llm-wiki/projects?x=1", "http://host:19828")).toBe(
      "http://host:19828/api/v1/projects?x=1",
    );
  });

  it("keeps already-versioned paths stable", () => {
    expect(rewriteProxyUrl("/api/llm-wiki/api/v1/health", "http://host:19828/")).toBe(
      "http://host:19828/api/v1/health",
    );
  });
});

describe("proxy allowlist", () => {
  it("allows the API-backed 0.1 surface", () => {
    expect(isAllowedProxyRequest("GET", "/api/llm-wiki/health")).toBe(true);
    expect(isAllowedProxyRequest("GET", "/api/llm-wiki/projects")).toBe(true);
    expect(isAllowedProxyRequest("GET", "/api/llm-wiki/projects/p1/files")).toBe(true);
    expect(isAllowedProxyRequest("GET", "/api/llm-wiki/projects/p1/files/content?path=a.md")).toBe(true);
    expect(isAllowedProxyRequest("POST", "/api/llm-wiki/projects/p1/search")).toBe(true);
    expect(isAllowedProxyRequest("GET", "/api/llm-wiki/projects/p1/graph")).toBe(true);
    expect(isAllowedProxyRequest("GET", "/api/llm-wiki/projects/p1/reviews")).toBe(true);
    expect(isAllowedProxyRequest("POST", "/api/llm-wiki/projects/p1/sources/rescan")).toBe(true);
    expect(isAllowedProxyRequest("POST", "/api/llm-wiki/projects/p1/chat")).toBe(true);
  });

  it("rejects unsupported methods and paths", () => {
    expect(isAllowedProxyRequest("DELETE", "/api/llm-wiki/projects/p1/files")).toBe(false);
    expect(isAllowedProxyRequest("POST", "/api/llm-wiki/projects/p1/files/content")).toBe(false);
    expect(isAllowedProxyRequest("GET", "/api/llm-wiki/projects/p1/settings")).toBe(false);
    expect(isAllowedProxyRequest("POST", "/api/llm-wiki/projects/p1/chat/s1/cancel")).toBe(false);
    expect(isAllowedProxyRequest("PATCH", "/api/llm-wiki/projects/p1/reviews/r1")).toBe(false);
    expect(isAllowedProxyRequest("POST", "/api/llm-wiki/projects/p1/reviews/resolve")).toBe(false);
  });
});

describe("authentication", () => {
  it("accepts explicit bearer token and explicit disabled-auth config", () => {
    expect(
      isAuthenticated(
        { headers: { authorization: "Bearer webui-test-token" } },
        { authDisabled: false, webuiAccessToken: "webui-test-token", sessionSecret: "secret" },
      ),
    ).toBe(true);
    expect(
      isAuthenticated(
        { headers: {} },
        { authDisabled: true, webuiAccessToken: "", sessionSecret: "secret" },
      ),
    ).toBe(true);
  });

  it("returns a login page for unauthenticated WebUI pages", async () => {
    const response = await localRequest("/");
    expect(response.status).toBe(401);
    expect(response.body).toContain("LLM Wiki WebUI");
    expect(response.body).toContain("Access token");
  });

  it("returns 401 JSON for unauthenticated API requests", async () => {
    const response = await localRequest("/api/llm-wiki/health");
    expect(response.status).toBe(401);
    expect(response.json()).toMatchObject({ ok: false, error: "WebUI authentication required" });
  });

  it("rejects invalid login attempts", async () => {
    const response = await localRequest("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=wrong",
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain("Invalid access token.");
  });

  it("sets a strict HttpOnly session cookie on successful login", async () => {
    const response = await localRequest("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=webui-test-token",
    });
    const cookie = response.headers["set-cookie"]?.[0] ?? "";
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/");
    expect(cookie).toContain("llm_wiki_webui_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  it("allows a session cookie to access the WebUI shell", async () => {
    const login = await localRequest("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=webui-test-token",
    });
    const response = await localRequest("/", {
      headers: { cookie: login.headers["set-cookie"]?.[0] ?? "" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("Test Shell");
  });

  it("clears the session cookie on logout", async () => {
    const response = await localRequest("/auth/logout");
    const cookie = response.headers["set-cookie"]?.[0] ?? "";
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/auth/login");
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("proxy security", () => {
  it("allows bearer-authenticated API requests and forwards only the native API token upstream", async () => {
    let capturedTarget;
    let capturedOptions;
    globalThis.fetch = vi.fn(async (target, options) => {
      capturedTarget = target;
      capturedOptions = options;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await localRequest("/api/llm-wiki/health", {
      headers: { authorization: "Bearer webui-test-token" },
    });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(capturedTarget).toBe("http://native.example:19828/api/v1/health");
    expect(capturedOptions.headers.authorization).toBe("Bearer native-api-token");
  });

  it("passes through upstream error status and JSON", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: "upstream denied" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await localRequest("/api/llm-wiki/projects", {
      headers: { authorization: "Bearer webui-test-token" },
    });
    expect(response.status).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "upstream denied" });
  });

  it("rejects non-allowlisted API routes before contacting upstream", async () => {
    globalThis.fetch = vi.fn();
    const response = await localRequest("/api/llm-wiki/projects/p1/files", {
      method: "DELETE",
      headers: { authorization: "Bearer webui-test-token" },
    });
    expect(response.status).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, error: "Proxy route not allowed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed static paths without crashing", async () => {
    const response = await localRequest("/%E0%A4%A", {
      headers: { authorization: "Bearer webui-test-token" },
    });
    expect(response.status).toBe(400);
    expect(response.body).toBe("Bad request");
  });
});
