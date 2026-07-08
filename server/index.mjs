import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFullGraphFromNativeApi } from "./full-graph.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "../dist");
const port = Number(process.env.PORT || 19829);
const host = process.env.HOST || "0.0.0.0";
const upstreamBase = (process.env.LLM_WIKI_API_BASE_URL || "http://host.docker.internal:19828")
  .replace(/\/+$/, "");
const token = process.env.LLM_WIKI_API_TOKEN?.trim();
const webuiAccessToken = process.env.WEBUI_ACCESS_TOKEN?.trim();
const authDisabled = process.env.WEBUI_AUTH_DISABLED === "true";
export const DEFAULT_PROXY_TIMEOUT_MS = 90_000;
const timeoutMs = Number(process.env.LLM_WIKI_PROXY_TIMEOUT_MS || DEFAULT_PROXY_TIMEOUT_MS);
const maxBodyBytes = 1024 * 1024;
const sessionCookieName = "llm_wiki_webui_session";
const sessionSecret = randomBytes(32).toString("base64url");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export function rewriteProxyUrl(requestUrl, baseUrl = upstreamBase) {
  const url = new URL(requestUrl, "http://webui.local");
  if (!url.pathname.startsWith("/api/llm-wiki")) return null;
  const suffix = url.pathname.slice("/api/llm-wiki".length) || "/health";
  const upstreamPath = suffix.startsWith("/api/v1") ? suffix : `/api/v1${suffix}`;
  return `${baseUrl.replace(/\/+$/, "")}${upstreamPath}${url.search}`;
}

function normalizeProxyPath(requestUrl) {
  const url = new URL(requestUrl, "http://webui.local");
  if (!url.pathname.startsWith("/api/llm-wiki")) return null;
  const suffix = url.pathname.slice("/api/llm-wiki".length) || "/health";
  return suffix.startsWith("/api/v1") ? suffix.slice("/api/v1".length) || "/health" : suffix;
}

function fullGraphProjectId(requestUrl) {
  const path = normalizeProxyPath(requestUrl);
  const match = path?.match(/^\/projects\/([^/]+)\/graph\/full$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isAllowedProxyRequest(method, requestUrl) {
  const path = normalizeProxyPath(requestUrl);
  if (!path) return false;
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    if (path === "/health" || path === "/projects") return true;
    if (/^\/projects\/[^/]+\/files$/.test(path)) return true;
    if (/^\/projects\/[^/]+\/files\/content$/.test(path)) return true;
    if (/^\/projects\/[^/]+\/reviews$/.test(path)) return true;
    if (/^\/projects\/[^/]+\/graph$/.test(path)) return true;
    return false;
  }
  if (normalizedMethod === "POST") {
    if (/^\/projects\/[^/]+\/search$/.test(path)) return true;
    if (/^\/projects\/[^/]+\/sources\/rescan$/.test(path)) return true;
    if (/^\/projects\/[^/]+\/chat$/.test(path)) return true;
  }
  return false;
}

export function validateRuntimeConfig(env = process.env) {
  if (env.WEBUI_AUTH_DISABLED === "true") return;
  if (!env.WEBUI_ACCESS_TOKEN?.trim()) {
    throw new Error(
      "WEBUI_ACCESS_TOKEN is required. Set a strong token, or explicitly set WEBUI_AUTH_DISABLED=true for local-only development.",
    );
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(res.req?.method === "HEAD" ? undefined : JSON.stringify(body));
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(res.req?.method === "HEAD" ? undefined : body);
}

function sessionValue(accessToken = webuiAccessToken, secret = sessionSecret) {
  return createHmac("sha256", secret).update(accessToken).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header = "") {
  const cookies = new Map();
  const value = Array.isArray(header) ? header.join(";") : String(header || "");
  for (const part of value.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies.set(rawName, rawValue.join("="));
  }
  return cookies;
}

export function isAuthenticated(req, config = { authDisabled, webuiAccessToken, sessionSecret }) {
  if (config.authDisabled) return true;
  if (!config.webuiAccessToken) return false;
  const authHeader = req.headers.authorization;
  const auth = Array.isArray(authHeader) ? authHeader[0] ?? "" : String(authHeader || "");
  const prefix = "Bearer ";
  if (auth.startsWith(prefix) && safeEqual(auth.slice(prefix.length).trim(), config.webuiAccessToken)) {
    return true;
  }
  const cookie = parseCookies(req.headers.cookie).get(sessionCookieName);
  return Boolean(cookie && safeEqual(cookie, sessionValue(config.webuiAccessToken, config.sessionSecret)));
}

function loginPage(error = "") {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Login | LLM Wiki WebUI</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #f5f7f4; color: #13201d; }
      main { width: min(360px, calc(100vw - 32px)); }
      form { display: grid; gap: 14px; padding: 24px; border: 1px solid #dce6e1; border-radius: 10px; background: white; box-shadow: 0 16px 34px rgb(19 32 29 / 10%); }
      h1 { margin: 0; font-size: 20px; }
      p { margin: 0; color: #42544f; line-height: 1.5; }
      label { display: grid; gap: 7px; font-size: 13px; font-weight: 700; }
      input { height: 40px; border: 1px solid #c6d4ce; border-radius: 8px; padding: 0 10px; font: inherit; }
      button { height: 40px; border: 0; border-radius: 8px; background: #0f766e; color: white; font: inherit; font-weight: 800; cursor: pointer; }
      .error { color: #b42318; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <form method="post" action="/auth/login">
        <h1>LLM Wiki WebUI</h1>
        <p>Enter the WebUI access token to continue.</p>
        ${message}
        <label>Access token<input name="token" type="password" autocomplete="current-password" autofocus required /></label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sendLoginPage(res, status = 200, error = "") {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(res.req?.method === "HEAD" ? undefined : loginPage(error));
}

function redirect(res, location) {
  res.writeHead(303, {
    location,
    "cache-control": "no-store",
  });
  res.end();
}

async function handleAuth(req, res) {
  if (req.url?.startsWith("/auth/logout")) {
    res.writeHead(303, {
      location: "/auth/login",
      "set-cookie": `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  if (!req.url?.startsWith("/auth/login")) {
    sendJson(res, 404, { ok: false, error: "Auth route not found" });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (isAuthenticated(req)) redirect(res, "/");
    else sendLoginPage(res);
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 405, "Method not allowed", { allow: "GET, POST" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendLoginPage(res, 413, err instanceof Error ? err.message : String(err));
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  let submitted = "";
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(body.toString("utf8"));
      submitted = typeof json.token === "string" ? json.token : "";
    } catch {
      submitted = "";
    }
  } else {
    submitted = new URLSearchParams(body.toString("utf8")).get("token") ?? "";
  }

  if (!webuiAccessToken || !safeEqual(submitted, webuiAccessToken)) {
    sendLoginPage(res, 401, "Invalid access token.");
    return;
  }

  res.writeHead(303, {
    location: "/",
    "set-cookie": `${sessionCookieName}=${sessionValue()}; HttpOnly; SameSite=Strict; Path=/`,
    "cache-control": "no-store",
  });
  res.end();
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyRequest(req, res) {
  if (!isAllowedProxyRequest(req.method ?? "GET", req.url ?? "")) {
    sendJson(res, 403, { ok: false, error: "Proxy route not allowed" });
    return;
  }

  const target = rewriteProxyUrl(req.url);
  if (!target) {
    sendJson(res, 404, { ok: false, error: "Proxy route not found" });
    return;
  }

  let body;
  try {
    body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  } catch (err) {
    sendJson(res, 413, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: req.headers.accept || "application/json",
  };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(text);
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      error: `Failed to reach LLM Wiki API at ${upstreamBase}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function handleFullGraphRequest(req, res) {
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  const projectId = fullGraphProjectId(req.url ?? "");
  if (!projectId) {
    sendJson(res, 404, { ok: false, error: "Full graph route not found" });
    return;
  }
  try {
    const graph = await buildFullGraphFromNativeApi({
      projectId,
      upstreamBase,
      token,
      timeoutMs: Math.max(timeoutMs, 180_000),
    });
    sendJson(res, 200, graph);
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      error: `Failed to build full LLM Wiki graph: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function serveStatic(req, res) {
  let url;
  let requested;
  try {
    url = new URL(req.url, "http://webui.local");
    requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }
  const candidate = requested === "/" ? join(root, "index.html") : join(root, requested);
  const path = resolve(candidate);
  const fallback = join(root, "index.html");
  const withinRoot = path === root || path.startsWith(`${root}${sep}`);
  const finalPath = withinRoot && existsSync(path) && statSync(path).isFile() ? path : fallback;
  const ext = extname(finalPath);
  res.writeHead(200, {
    "content-type": contentTypes[ext] || "application/octet-stream",
    "cache-control": finalPath === fallback ? "no-store" : "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(finalPath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.url?.startsWith("/auth/")) {
    void handleAuth(req, res);
    return;
  }
  if (!isAuthenticated(req)) {
    if (req.url?.startsWith("/api/llm-wiki")) {
      sendJson(res, 401, { ok: false, error: "WebUI authentication required" });
      return;
    }
    sendLoginPage(res, 401);
    return;
  }
  if (req.url?.startsWith("/api/llm-wiki")) {
    if (fullGraphProjectId(req.url)) {
      void handleFullGraphRequest(req, res);
      return;
    }
    void proxyRequest(req, res);
    return;
  }
  serveStatic(req, res);
});

if (process.env.NODE_ENV !== "test") {
  validateRuntimeConfig();
  server.listen(port, host, () => {
    console.log(`LLM Wiki WebUI listening on http://${host}:${port}`);
    console.log(`Proxying LLM Wiki API to ${upstreamBase}/api/v1`);
  });
}

export { server };
