import type { ApiFileNode, ApiGraphEdge, ApiGraphNode } from "./api-client";

export interface FullGraphBuildOptions {
  concurrency?: number;
}

type RawGraphPage = {
  id: string;
  label: string;
  type: string;
  path: string;
  links: string[];
  aliases: string[];
};

const DEFAULT_CONTENT_CONCURRENCY = 8;

export function collectMarkdownFiles(nodes: readonly ApiFileNode[]): ApiFileNode[] {
  const out: ApiFileNode[] = [];
  function visit(items: readonly ApiFileNode[]) {
    for (const node of items) {
      if (node.isDir) {
        visit(node.children ?? []);
      } else if (/^wiki\/.*\.mdx?$/i.test(node.path)) {
        out.push(node);
      }
    }
  }
  visit(nodes);
  return out;
}

export async function buildFullGraphFromFiles(
  files: readonly ApiFileNode[],
  loadContent: (path: string) => Promise<string>,
  options: FullGraphBuildOptions = {},
): Promise<{ nodes: ApiGraphNode[]; edges: ApiGraphEdge[] }> {
  const markdownFiles = collectMarkdownFiles(files);
  const raw = new Map<string, RawGraphPage>();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONTENT_CONCURRENCY);
  let cursor = 0;

  async function worker() {
    while (cursor < markdownFiles.length) {
      const file = markdownFiles[cursor];
      cursor += 1;
      if (!file) continue;
      const id = graphNodeId(file.path);
      if (!id) continue;
      const stem = fileStem(file.path);
      try {
        const content = await loadContent(file.path);
        const label = extractTitle(content, file.name);
        raw.set(id, {
          id,
          label,
          type: extractType(content),
          path: file.path,
          links: extractWikilinks(content),
          aliases: [id, stem, label],
        });
      } catch {
        // Match the native graph builder's tolerant behavior: unreadable files
        // are skipped instead of failing the whole graph.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, markdownFiles.length) }, () => worker()));
  return graphFromRawPages(raw);
}

export function graphFromRawPages(raw: Map<string, RawGraphPage>): { nodes: ApiGraphNode[]; edges: ApiGraphEdge[] } {
  const ids = new Set(raw.keys());
  const aliases = buildAliasIndex(raw);
  const linkCount = new Map([...raw.keys()].map((id) => [id, 0]));
  const seenEdges = new Set<string>();
  const edges: ApiGraphEdge[] = [];

  for (const [source, page] of raw) {
    for (const link of page.links) {
      const target = resolveLink(link, ids, aliases);
      if (!target || target === source) continue;
      const key = source < target ? `${source}::${target}` : `${target}::${source}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      linkCount.set(source, (linkCount.get(source) ?? 0) + 1);
      linkCount.set(target, (linkCount.get(target) ?? 0) + 1);
      edges.push({ source, target, weight: 1 });
    }
  }

  const nodes = [...raw.values()]
    .filter((page) => page.type !== "query")
    .map((page) => ({
      id: page.id,
      label: page.label,
      type: page.type,
      path: page.path,
      linkCount: linkCount.get(page.id) ?? 0,
    }));

  return { nodes, edges };
}

export function extractType(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const value = line.trim().match(/^type:\s*(.+)$/i)?.[1];
    if (value) return value.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  }
  return "other";
}

export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  for (const match of content.matchAll(pattern)) {
    const target = match[1]?.split("|")[0]?.trim();
    if (target) links.push(target);
  }
  return links;
}

function extractTitle(content: string, fallbackName: string): string {
  const frontmatterTitle = content.match(/^---\s*[\r\n]+[\s\S]*?^title:\s*(.+?)\s*$/m)?.[1];
  if (frontmatterTitle) return cleanTitle(frontmatterTitle);
  const h1 = content.match(/^#\s+(.+?)\s*$/m)?.[1];
  if (h1) return cleanTitle(h1);
  return fallbackName.replace(/\.mdx?$/i, "");
}

function cleanTitle(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function fileStem(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  return fileName.replace(/\.[^.]+$/, "");
}

function graphNodeId(path: string): string {
  return path.replace(/^wiki\//i, "").replace(/\.mdx?$/i, "");
}

function buildAliasIndex(raw: Map<string, RawGraphPage>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const page of raw.values()) {
    for (const alias of page.aliases) {
      for (const key of aliasKeys(alias)) {
        if (key && !aliases.has(key)) aliases.set(key, page.id);
      }
    }
  }
  return aliases;
}

function resolveLink(raw: string, ids: Set<string>, aliases: Map<string, string>): string | null {
  const target = raw.split("#")[0]?.trim() ?? "";
  if (ids.has(target)) return target;
  for (const key of aliasKeys(target)) {
    const resolved = aliases.get(key);
    if (resolved) return resolved;
  }
  return null;
}

function aliasKeys(value: string): string[] {
  const lower = value.trim().toLowerCase();
  const normalized = lower.replaceAll(" ", "-");
  return lower === normalized ? [lower] : [lower, normalized];
}
