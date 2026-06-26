import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "../dist");
const port = Number(process.env.PORT || 19829);
const host = process.env.HOST || "0.0.0.0";
const upstreamBase = (process.env.LLM_WIKI_API_BASE_URL || "http://host.docker.internal:19828")
  .replace(/\/+$/, "");
const token = process.env.LLM_WIKI_API_TOKEN?.trim();
const timeoutMs = Number(process.env.LLM_WIKI_PROXY_TIMEOUT_MS || 30_000);
const maxBodyBytes = 1024 * 1024;

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

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
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

function serveStatic(req, res) {
  const url = new URL(req.url, "http://webui.local");
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidate = requested === "/" ? join(root, "index.html") : join(root, requested);
  const path = resolve(candidate);
  const fallback = join(root, "index.html");
  const finalPath = path.startsWith(root) && existsSync(path) && statSync(path).isFile() ? path : fallback;
  const ext = extname(finalPath);
  res.writeHead(200, {
    "content-type": contentTypes[ext] || "application/octet-stream",
    "cache-control": finalPath === fallback ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(finalPath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/llm-wiki")) {
    void proxyRequest(req, res);
    return;
  }
  serveStatic(req, res);
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, host, () => {
    console.log(`LLM Wiki WebUI listening on http://${host}:${port}`);
    console.log(`Proxying LLM Wiki API to ${upstreamBase}/api/v1`);
  });
}

export { server };
