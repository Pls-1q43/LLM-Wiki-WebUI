import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { ApiGraphEdge, ApiGraphNode } from "./api-client";

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  path?: string;
  linkCount: number;
  community: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface CommunityInfo {
  id: number;
  nodeCount: number;
  cohesion: number;
  topNodes: string[];
}

export interface GraphFilterState {
  hiddenTypes: ReadonlySet<string>;
  hiddenNodeIds: ReadonlySet<string>;
  hideStructural: boolean;
  hideIsolated: boolean;
  maxLinks?: number;
}

export interface FilteredGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hiddenNodeIds: Set<string>;
}

export interface GraphSearchResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  matchedNodeIds: Set<string>;
}

export interface SurprisingConnection {
  source: GraphNode;
  target: GraphNode;
  score: number;
  reasons: string[];
  key: string;
}

export interface KnowledgeGap {
  type: "isolated-node" | "sparse-community" | "bridge-node";
  title: string;
  description: string;
  nodeIds: string[];
  suggestion: string;
}

export const DEFAULT_GRAPH_FILTERS: GraphFilterState = {
  hiddenTypes: new Set(),
  hiddenNodeIds: new Set(),
  hideStructural: true,
  hideIsolated: false,
  maxLinks: undefined,
};

const STRUCTURAL_IDS = new Set(["index", "overview", "log", "schema", "purpose"]);

export function normalizeGraphData(
  apiNodes: readonly ApiGraphNode[],
  apiEdges: readonly ApiGraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] } {
  const edges = apiEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    weight: edge.weight ?? 1,
  }));
  const prelimNodes = apiNodes.map((node) => ({
    id: node.id,
    label: node.label || node.id,
    linkCount: node.linkCount ?? 0,
  }));
  const { assignments, communities } = detectCommunities(prelimNodes, edges);
  const nodes = apiNodes.map((node) => ({
    id: node.id,
    label: node.label || node.id,
    type: node.type || "other",
    path: node.path,
    linkCount: node.linkCount ?? 0,
    community: assignments.get(node.id) ?? 0,
  }));
  return { nodes, edges, communities };
}

export function detectCommunities(
  nodes: { id: string; label: string; linkCount: number }[],
  edges: GraphEdge[],
): { assignments: Map<string, number>; communities: CommunityInfo[] } {
  if (nodes.length === 0) return { assignments: new Map(), communities: [] };

  const graph = new Graph({ type: "undirected" });
  for (const node of nodes) graph.addNode(node.id);
  for (const edge of edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    const key = `${edge.source}->${edge.target}`;
    if (!graph.hasEdge(key) && !graph.hasEdge(`${edge.target}->${edge.source}`)) {
      graph.addEdgeWithKey(key, edge.source, edge.target, { weight: edge.weight });
    }
  }

  const rawAssignments = louvain(graph, { resolution: 1 }) as Record<string, number>;
  const assignments = new Map(Object.entries(rawAssignments).map(([id, community]) => [id, community]));
  for (const node of nodes) {
    if (!assignments.has(node.id)) assignments.set(node.id, 0);
  }

  const groups = new Map<number, string[]>();
  for (const [nodeId, communityId] of assignments) {
    const group = groups.get(communityId) ?? [];
    group.push(nodeId);
    groups.set(communityId, group);
  }

  const edgeSet = new Set<string>();
  for (const edge of edges) {
    edgeSet.add(`${edge.source}:::${edge.target}`);
    edgeSet.add(`${edge.target}:::${edge.source}`);
  }
  const nodeInfo = new Map(nodes.map((node) => [node.id, node]));
  const communities: CommunityInfo[] = [];
  for (const [communityId, memberIds] of groups) {
    const possibleEdges = memberIds.length > 1 ? (memberIds.length * (memberIds.length - 1)) / 2 : 1;
    let intraEdges = 0;
    for (let i = 0; i < memberIds.length; i += 1) {
      for (let j = i + 1; j < memberIds.length; j += 1) {
        if (edgeSet.has(`${memberIds[i]}:::${memberIds[j]}`)) intraEdges += 1;
      }
    }
    const topNodes = [...memberIds]
      .sort((a, b) => (nodeInfo.get(b)?.linkCount ?? 0) - (nodeInfo.get(a)?.linkCount ?? 0))
      .slice(0, 5)
      .map((id) => nodeInfo.get(id)?.label ?? id);
    communities.push({
      id: communityId,
      nodeCount: memberIds.length,
      cohesion: intraEdges / possibleEdges,
      topNodes,
    });
  }

  communities.sort((a, b) => b.nodeCount - a.nodeCount);
  const idRemap = new Map<number, number>();
  communities.forEach((community, index) => {
    idRemap.set(community.id, index);
    community.id = index;
  });
  for (const [nodeId, oldId] of assignments) assignments.set(nodeId, idRemap.get(oldId) ?? 0);
  return { assignments, communities };
}

export function isStructuralGraphNode(node: Pick<GraphNode, "id" | "path" | "type">): boolean {
  const id = node.id.toLowerCase();
  if (STRUCTURAL_IDS.has(id) || node.type === "overview") return true;
  const normalizedPath = (node.path ?? "").replace(/\\/g, "/").toLowerCase();
  return (
    normalizedPath.endsWith("/wiki/index.md") ||
    normalizedPath.endsWith("/wiki/overview.md") ||
    normalizedPath.endsWith("/wiki/log.md") ||
    normalizedPath.endsWith("/purpose.md") ||
    normalizedPath.endsWith("/schema.md")
  );
}

export function applyGraphFilters(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  filters: GraphFilterState,
): FilteredGraph {
  const hiddenNodeIds = new Set<string>();
  for (const node of nodes) {
    if (
      filters.hiddenNodeIds.has(node.id) ||
      filters.hiddenTypes.has(node.type) ||
      (filters.hideStructural && isStructuralGraphNode(node)) ||
      (filters.hideIsolated && node.linkCount <= 0) ||
      (filters.maxLinks !== undefined && node.linkCount > filters.maxLinks)
    ) {
      hiddenNodeIds.add(node.id);
    }
  }
  const visibleNodes = nodes.filter((node) => !hiddenNodeIds.has(node.id));
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  return { nodes: visibleNodes, edges: visibleEdges, hiddenNodeIds };
}

export function hasActiveGraphFilters(filters: GraphFilterState): boolean {
  return (
    filters.hideStructural ||
    filters.hideIsolated ||
    filters.hiddenTypes.size > 0 ||
    filters.hiddenNodeIds.size > 0 ||
    filters.maxLinks !== undefined
  );
}

export function applyGraphSearch(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  query: string,
): GraphSearchResult {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { nodes: [...nodes], edges: [...edges], matchedNodeIds: new Set() };
  const matchedNodeIds = new Set<string>();
  const matchedNodes = nodes.filter((node) => {
    const haystack = [node.label, node.id, node.type, node.path ?? ""].join(" ").toLowerCase();
    const matched = tokens.every((token) => haystack.includes(token));
    if (matched) matchedNodeIds.add(node.id);
    return matched;
  });
  const visibleNodeIds = new Set(matchedNodes.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  return { nodes: matchedNodes, edges: visibleEdges, matchedNodeIds };
}

export function findSurprisingConnections(
  nodes: GraphNode[],
  edges: GraphEdge[],
  limit = 5,
): SurprisingConnection[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const maxDegree = Math.max(...nodes.map((node) => node.linkCount), 1);
  const scored: SurprisingConnection[] = [];
  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target || STRUCTURAL_IDS.has(source.id) || STRUCTURAL_IDS.has(target.id)) continue;
    let score = 0;
    const reasons: string[] = [];
    if (source.community !== target.community) {
      score += 3;
      reasons.push("crosses community boundary");
    }
    if (source.type !== target.type) {
      score += 1;
      reasons.push("different types");
    }
    const minDegree = Math.min(source.linkCount, target.linkCount);
    const maxPairDegree = Math.max(source.linkCount, target.linkCount);
    if (minDegree <= 2 && maxPairDegree >= maxDegree * 0.5) {
      score += 2;
      reasons.push("peripheral node links to hub");
    }
    if (edge.weight < 2 && edge.weight > 0) {
      score += 1;
      reasons.push("weak but present connection");
    }
    if (score >= 3) {
      scored.push({ source, target, score, reasons, key: [source.id, target.id].sort().join(":::") });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function detectKnowledgeGaps(
  nodes: GraphNode[],
  edges: GraphEdge[],
  communities: CommunityInfo[],
  limit = 8,
): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = [];
  const isolatedNodes = nodes.filter(
    (node) => node.linkCount <= 1 && node.type !== "overview" && !STRUCTURAL_IDS.has(node.id),
  );
  if (isolatedNodes.length > 0) {
    gaps.push({
      type: "isolated-node",
      title: `${isolatedNodes.length} isolated page${isolatedNodes.length > 1 ? "s" : ""}`,
      description:
        isolatedNodes
          .slice(0, 5)
          .map((node) => node.label)
          .join(", ") + (isolatedNodes.length > 5 ? ` and ${isolatedNodes.length - 5} more` : ""),
      nodeIds: isolatedNodes.map((node) => node.id),
      suggestion: "These pages have few or no connections. Consider adding [[wikilinks]] to related pages.",
    });
  }
  for (const community of communities) {
    if (community.cohesion < 0.15 && community.nodeCount >= 3) {
      gaps.push({
        type: "sparse-community",
        title: `Sparse cluster: ${community.topNodes[0] ?? `Community ${community.id}`}`,
        description: `${community.nodeCount} pages with cohesion ${community.cohesion.toFixed(2)}.`,
        nodeIds: nodes.filter((node) => node.community === community.id).map((node) => node.id),
        suggestion: "This knowledge area lacks internal cross-references.",
      });
    }
  }
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const communityNeighbors = new Map(nodes.map((node) => [node.id, new Set<number>()]));
  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    communityNeighbors.get(source.id)?.add(target.community);
    communityNeighbors.get(target.id)?.add(source.community);
  }
  const bridgeNodes = nodes
    .filter((node) => !STRUCTURAL_IDS.has(node.id) && (communityNeighbors.get(node.id)?.size ?? 0) >= 3)
    .sort((a, b) => (communityNeighbors.get(b.id)?.size ?? 0) - (communityNeighbors.get(a.id)?.size ?? 0))
    .slice(0, 3);
  for (const bridge of bridgeNodes) {
    gaps.push({
      type: "bridge-node",
      title: `Key bridge: ${bridge.label}`,
      description: `Connects ${communityNeighbors.get(bridge.id)?.size ?? 0} different knowledge clusters.`,
      nodeIds: [bridge.id],
      suggestion: "This page bridges multiple knowledge areas. Keeping it strong improves the whole wiki.",
    });
  }
  return gaps.slice(0, limit);
}
