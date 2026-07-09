import type { ApiFileNode } from "./api-client";
import { flattenFiles } from "./lint";

const WIKILINK_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;

export function transformWikilinks(body: string): string {
  if (!body.includes("[[")) return body;
  return body
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .split(/(`[^`\n]+`)/g)
        .map((inline, inlineIndex) => {
          if (inlineIndex % 2 === 1) return inline;
          return inline.replace(WIKILINK_RE, (_match, rawTarget: string, rawAlias?: string) => {
            const target = rawTarget.trim();
            const label = (rawAlias?.trim() || target).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
            return `[${label}](#${encodeURIComponent(target)})`;
          });
        })
        .join("");
    })
    .join("");
}

export function normalizeWikiTarget(value: string) {
  return value
    .replace(/\.md$/i, "")
    .split("/")
    .pop()!
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

export function resolveWikiTarget(target: string, files: ApiFileNode[]) {
  const flat = flattenFiles(files).filter((node) => !node.isDir && node.path.endsWith(".md"));
  const normalized = normalizeWikiTarget(target);
  return (
    flat.find((node) => node.path === target || node.path === `wiki/${target}`)?.path ??
    flat.find((node) => normalizeWikiTarget(node.path) === normalized)?.path ??
    null
  );
}
