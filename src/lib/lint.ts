import type { ApiFileNode } from "./api-client";

export interface LintIssue {
  path: string;
  severity: "info" | "warning";
  title: string;
  detail: string;
  code: "missingIndex" | "emptyPage" | "missingH1" | "danglingWikilink";
  values?: Record<string, string>;
}

export function flattenFiles(nodes: ApiFileNode[]): ApiFileNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flattenFiles(node.children) : [])]);
}

export function lintReadOnly(files: ApiFileNode[], contents: Record<string, string>): LintIssue[] {
  const issues: LintIssue[] = [];
  const flat = flattenFiles(files).filter((node) => !node.isDir);
  const mdPaths = new Set(flat.map((node) => node.path).filter((path) => path.endsWith(".md")));
  const knownSlugs = new Set(
    [...mdPaths].map((path) => path.split("/").pop()?.replace(/\.md$/i, "") ?? path),
  );

  if (!mdPaths.has("wiki/index.md")) {
    issues.push({
      path: "wiki/index.md",
      severity: "warning",
      title: "Missing index",
      detail: "The exposed wiki tree does not include wiki/index.md.",
      code: "missingIndex",
    });
  }

  for (const path of mdPaths) {
    const content = contents[path] ?? "";
    if (!content.trim()) {
      issues.push({
        path,
        severity: "warning",
        title: "Empty page",
        detail: "This page is empty or could not be loaded through the API.",
        code: "emptyPage",
      });
      continue;
    }
    if (!/^#\s+/m.test(content)) {
      issues.push({
        path,
        severity: "info",
        title: "Missing H1",
        detail: "This page has no Markdown H1 heading.",
        code: "missingH1",
      });
    }
    const wikilinks = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) =>
      match[1].trim(),
    );
    for (const link of wikilinks) {
      const normalized = link.toLowerCase().replace(/\s+/g, "-");
      const exists = [...knownSlugs].some((slug) => slug.toLowerCase() === normalized);
      if (!exists) {
        issues.push({
          path,
          severity: "info",
          title: "Possible dangling wikilink",
          detail: `[[${link}]] does not match a currently exposed Markdown filename.`,
          code: "danglingWikilink",
          values: { link },
        });
      }
    }
  }

  return issues;
}
