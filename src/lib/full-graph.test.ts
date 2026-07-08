import { describe, expect, it } from "vitest";
import { buildFullGraphFromFiles, collectMarkdownFiles, extractType, extractWikilinks } from "./full-graph";
import type { ApiFileNode } from "./api-client";

const files: ApiFileNode[] = [
  {
    name: "wiki",
    path: "wiki",
    isDir: true,
    children: [
      { name: "Overview.md", path: "wiki/Overview.md", isDir: false },
      { name: "Concept A.md", path: "wiki/concepts/Concept A.md", isDir: false },
      { name: "Entity B.md", path: "wiki/entities/Entity B.md", isDir: false },
      { name: "Entity B.md", path: "wiki/archive/Entity B.md", isDir: false },
      { name: "image.png", path: "wiki/assets/image.png", isDir: false },
    ],
  },
];

describe("full graph builder", () => {
  it("collects only wiki markdown files", () => {
    expect(collectMarkdownFiles(files).map((file) => file.path).sort()).toEqual([
      "wiki/Overview.md",
      "wiki/archive/Entity B.md",
      "wiki/concepts/Concept A.md",
      "wiki/entities/Entity B.md",
    ]);
  });

  it("extracts node type and wikilinks like the native graph builder", () => {
    expect(extractType("type: 'Concept'\n# A")).toBe("concept");
    expect(extractWikilinks("[[A]] [[B|label]] [[ ]]")).toEqual(["A", "B"]);
  });

  it("builds an untruncated graph from file content", async () => {
    const content: Record<string, string> = {
      "wiki/Overview.md": "# Overview\ntype: overview\n[[Concept A]]\n[[Entity B]]",
      "wiki/archive/Entity B.md": "# Archived Entity B\ntype: entity",
      "wiki/concepts/Concept A.md": "# Concept A\ntype: concept\n[[Entity B]]",
      "wiki/entities/Entity B.md": "# Entity B\ntype: entity\n[[Concept A]]",
    };

    const graph = await buildFullGraphFromFiles(files, async (path) => content[path] ?? "");

    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      "Overview",
      "archive/Entity B",
      "concepts/Concept A",
      "entities/Entity B",
    ]);
    expect(graph.nodes.find((node) => node.id === "concepts/Concept A")).toMatchObject({
      label: "Concept A",
      type: "concept",
      path: "wiki/concepts/Concept A.md",
      linkCount: 2,
    });
    expect(graph.edges.map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      "Overview->concepts/Concept A",
      "Overview->entities/Entity B",
      "concepts/Concept A->entities/Entity B",
    ]);
  });
});
