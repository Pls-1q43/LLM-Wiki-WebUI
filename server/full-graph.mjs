const DEFAULT_FILE_TREE_MAX_FILES = 10_000;

export async function buildFullGraphFromNativeApi({ projectId, upstreamBase, token, timeoutMs, fetchImpl = fetch }) {
  const filesJson = await fetchJson(
    upstreamUrl(
      upstreamBase,
      `/api/v1/projects/${encodeURIComponent(projectId)}/files?root=wiki&recursive=true&maxFiles=${DEFAULT_FILE_TREE_MAX_FILES}`,
    ),
    { token, timeoutMs, fetchImpl },
  );

  return {
    ok: true,
    projectId,
    ...graphFromFileTree(Array.isArray(filesJson.files) ? filesJson.files : []),
  };
}

export function graphFromFileTree(files, nativeNodes = [], nativeEdges = []) {
  const markdownFiles = collectMarkdownFiles(files);
  const nodeById = new Map();
  const aliasToId = new Map();

  for (const file of markdownFiles) {
    const id = graphNodeId(file.path);
    const label = fileStem(file.path);
    const node = {
      id,
      label,
      type: inferTypeFromPath(file.path),
      path: file.path,
      linkCount: 0,
    };
    nodeById.set(id, node);
    for (const alias of aliasKeys(id, label)) {
      if (alias && !aliasToId.has(alias)) aliasToId.set(alias, id);
    }
  }

  const nativeIdToFullId = new Map();
  for (const nativeNode of nativeNodes) {
    const fullId =
      typeof nativeNode.path === "string"
        ? graphNodeId(nativeNode.path)
        : resolveAlias(String(nativeNode.id ?? ""), aliasToId);
    if (!fullId) continue;
    nativeIdToFullId.set(String(nativeNode.id ?? ""), fullId);
    const node = nodeById.get(fullId);
    if (!node) continue;
    node.label = String(nativeNode.label ?? node.label);
    node.type = String(nativeNode.nodeType ?? nativeNode.type ?? node.type);
    node.linkCount = numberOrZero(nativeNode.linkCount);
  }

  const seenEdges = new Set();
  const edges = [];
  for (const edge of nativeEdges) {
    const source = nativeIdToFullId.get(String(edge.source ?? "")) ?? resolveAlias(String(edge.source ?? ""), aliasToId);
    const target = nativeIdToFullId.get(String(edge.target ?? "")) ?? resolveAlias(String(edge.target ?? ""), aliasToId);
    if (!source || !target || source === target || !nodeById.has(source) || !nodeById.has(target)) continue;
    const key = source < target ? `${source}::${target}` : `${target}::${source}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source, target, weight: numberOrZero(edge.weight) || 1 });
  }

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source) source.linkCount += 1;
    if (target) target.linkCount += 1;
  }

  return { nodes: [...nodeById.values()], edges };
}

function collectMarkdownFiles(nodes) {
  const out = [];
  function visit(items) {
    for (const node of items) {
      if (node?.isDir) visit(node.children || []);
      else if (typeof node?.path === "string" && /^wiki\/.*\.mdx?$/i.test(node.path)) out.push(node);
    }
  }
  visit(nodes);
  return out;
}

async function fetchJson(url, { token, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok || json.ok === false) {
      throw new Error(typeof json.error === "string" ? json.error : response.statusText);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function upstreamUrl(base, path) {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function fileStem(path) {
  const fileName = path.split(/[\\/]/).pop() || "";
  return fileName.replace(/\.[^.]+$/, "");
}

function graphNodeId(path) {
  return path.replace(/^wiki\//i, "").replace(/\.mdx?$/i, "");
}

function inferTypeFromPath(path) {
  const normalized = path.toLowerCase();
  if (normalized.includes("/entities/")) return "entity";
  if (normalized.includes("/concepts/")) return "concept";
  if (normalized.includes("/sources/")) return "source";
  if (normalized.endsWith("/overview.md")) return "overview";
  return "other";
}

function resolveAlias(value, aliasToId) {
  for (const alias of aliasKeys(value)) {
    const resolved = aliasToId.get(alias);
    if (resolved) return resolved;
  }
  return null;
}

function aliasKeys(...values) {
  const keys = [];
  for (const value of values) {
    const lower = String(value).trim().toLowerCase();
    if (!lower) continue;
    const normalized = lower.replaceAll(" ", "-");
    keys.push(lower);
    if (normalized !== lower) keys.push(normalized);
  }
  return keys;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
