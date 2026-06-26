import { describe, expect, it } from "vitest";
import {
  applyGraphFilters,
  applyGraphSearch,
  DEFAULT_GRAPH_FILTERS,
  detectCommunities,
  detectKnowledgeGaps,
  findSurprisingConnections,
  hasActiveGraphFilters,
  isStructuralGraphNode,
  normalizeGraphData,
  type GraphEdge,
  type GraphFilterState,
  type GraphNode,
} from "./graph-model";

const nodes: GraphNode[] = [
  { id: "index", label: "Index", type: "other", path: "wiki/index.md", linkCount: 4, community: 0 },
  { id: "concept-a", label: "Concept A", type: "concept", path: "wiki/concepts/a.md", linkCount: 2, community: 0 },
  { id: "entity-b", label: "Entity B", type: "entity", path: "wiki/entities/b.md", linkCount: 3, community: 0 },
  { id: "source-c", label: "Source C", type: "source", path: "wiki/sources/c.md", linkCount: 1, community: 1 },
  { id: "isolated", label: "Isolated", type: "concept", path: "wiki/concepts/isolated.md", linkCount: 0, community: 2 },
];

const edges: GraphEdge[] = [
  { source: "index", target: "concept-a", weight: 1 },
  { source: "index", target: "entity-b", weight: 1 },
  { source: "concept-a", target: "entity-b", weight: 2 },
  { source: "source-c", target: "entity-b", weight: 3 },
];

function makeFilters(overrides: Partial<GraphFilterState> = {}): GraphFilterState {
  return {
    ...DEFAULT_GRAPH_FILTERS,
    hiddenTypes: new Set<string>(),
    hiddenNodeIds: new Set<string>(),
    ...overrides,
  };
}

describe("graph model", () => {
  it("normalizes API graph data and assigns communities", () => {
    const out = normalizeGraphData(
      [{ id: "a", label: "A", type: "concept", path: "wiki/a.md", linkCount: 1 }],
      [{ source: "a", target: "missing" }],
    );

    expect(out.nodes[0]).toMatchObject({ id: "a", label: "A", type: "concept", linkCount: 1 });
    expect(out.nodes[0].community).toBeTypeOf("number");
  });

  it("detects structural graph nodes by id, type, and path", () => {
    expect(isStructuralGraphNode(nodes[0])).toBe(true);
    expect(isStructuralGraphNode({ ...nodes[1], id: "overview" })).toBe(true);
    expect(isStructuralGraphNode({ ...nodes[1], type: "overview" })).toBe(true);
    expect(isStructuralGraphNode(nodes[1])).toBe(false);
  });

  it("applies structural, type, manual, isolated, and hub filters", () => {
    expect(applyGraphFilters(nodes, edges, makeFilters()).nodes.map((node) => node.id)).not.toContain("index");

    expect(
      applyGraphFilters(nodes, edges, makeFilters({ hideStructural: false, hiddenTypes: new Set(["source"]) })).nodes.map(
        (node) => node.id,
      ),
    ).not.toContain("source-c");

    expect(
      applyGraphFilters(nodes, edges, makeFilters({ hideStructural: false, hiddenNodeIds: new Set(["entity-b"]) })).edges,
    ).toEqual([{ source: "index", target: "concept-a", weight: 1 }]);

    expect(
      applyGraphFilters(nodes, edges, makeFilters({ hideStructural: false, hideIsolated: true })).nodes.map(
        (node) => node.id,
      ),
    ).not.toContain("isolated");

    expect(
      applyGraphFilters(nodes, edges, makeFilters({ hideStructural: false, maxLinks: 2 })).nodes.map((node) => node.id),
    ).not.toContain("entity-b");
  });

  it("reports active filters", () => {
    expect(hasActiveGraphFilters(makeFilters({ hideStructural: false }))).toBe(false);
    expect(hasActiveGraphFilters(makeFilters())).toBe(true);
    expect(hasActiveGraphFilters(makeFilters({ hideStructural: false, hiddenTypes: new Set(["concept"]) }))).toBe(true);
  });

  it("searches by label, id, type, and path", () => {
    expect(applyGraphSearch(nodes, edges, "concept").nodes.map((node) => node.id)).toEqual(["concept-a", "isolated"]);
    expect(applyGraphSearch(nodes, edges, "entity").nodes.map((node) => node.id)).toEqual(["entity-b"]);
    expect(applyGraphSearch(nodes, edges, "sources").nodes.map((node) => node.id)).toEqual(["source-c"]);
    expect(applyGraphSearch(nodes, edges, "wiki").edges).toHaveLength(4);
  });

  it("calculates communities and graph insights", () => {
    const { assignments, communities } = detectCommunities(
      nodes.map((node) => ({ id: node.id, label: node.label, linkCount: node.linkCount })),
      edges,
    );
    const enriched = nodes.map((node) => ({ ...node, community: assignments.get(node.id) ?? 0 }));

    expect(communities.length).toBeGreaterThan(0);
    expect(findSurprisingConnections(enriched, edges, 3).length).toBeGreaterThan(0);
    expect(detectKnowledgeGaps(enriched, edges, communities, 3).length).toBeGreaterThan(0);
  });
});
