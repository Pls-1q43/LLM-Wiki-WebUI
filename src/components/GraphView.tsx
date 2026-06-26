import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  EyeOff,
  Filter,
  Layers,
  Lightbulb,
  Link2,
  Maximize,
  Network,
  RefreshCw,
  RotateCcw,
  Search,
  Tag,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSetSettings, useSigma } from "@react-sigma/core";
import "@react-sigma/core/lib/style.css";
import type { NodeHoverDrawingFunction } from "sigma/rendering";
import type { SigmaNodeEventPayload } from "sigma/types";
import { type ApiGraphEdge, type ApiGraphNode } from "../lib/api-client";
import {
  applyGraphFilters,
  applyGraphSearch,
  DEFAULT_GRAPH_FILTERS,
  detectKnowledgeGaps,
  findSurprisingConnections,
  hasActiveGraphFilters,
  normalizeGraphData,
  type CommunityInfo,
  type GraphEdge,
  type GraphFilterState,
  type GraphNode,
  type KnowledgeGap,
  type SurprisingConnection,
} from "../lib/graph-model";

type ColorMode = "type" | "community";
type GraphThemePalette = {
  defaultEdge: string;
  label: string;
  hoverLabelText: string;
  hoverLabelBackground: string;
  hoverLabelBorder: string;
  hoverLabelShadow: string;
  mutedNodeMixTarget: string;
  dimmedEdge: string;
  activeEdge: string;
};
type HoverState = { node: string; neighbors: Set<string> } | null;
type AppHrefParams = {
  view?: "wiki" | "graph";
  path?: string | null;
  q?: string;
};

const NODE_TYPE_COLORS: Record<string, string> = {
  entity: "#60a5fa",
  concept: "#c084fc",
  source: "#fb923c",
  query: "#4ade80",
  synthesis: "#f87171",
  overview: "#facc15",
  comparison: "#2dd4bf",
  finding: "#a855f7",
  thesis: "#f43f5e",
  methodology: "#14b8a6",
  other: "#94a3b8",
};

const CUSTOM_NODE_COLORS = ["#38bdf8", "#34d399", "#fbbf24", "#fb7185", "#a78bfa", "#22d3ee", "#f97316", "#84cc16"];
const COMMUNITY_COLORS = [
  "#60a5fa",
  "#4ade80",
  "#fb923c",
  "#c084fc",
  "#f87171",
  "#2dd4bf",
  "#facc15",
  "#f472b6",
  "#a78bfa",
  "#38bdf8",
  "#34d399",
  "#fbbf24",
];

const BASE_NODE_SIZE = 8;
const MAX_NODE_SIZE = 28;
const DEFAULT_NODE_SCALE = 1;
const DEFAULT_GRAPH_SPACING = 1;
const GRAPH_SPACING_DEBOUNCE_MS = 180;
const WORKER_LAYOUT_NODE_THRESHOLD = 220;

const positionCache = new Map<string, { x: number; y: number }>();
let lastLayoutDataKey = "";
let pendingLayoutDataKey = "";

function shouldHandleInApp(event: React.MouseEvent<HTMLElement>) {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey
  );
}

function nodeColor(type: string): string {
  if (NODE_TYPE_COLORS[type]) return NODE_TYPE_COLORS[type];
  let hash = 0;
  for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CUSTOM_NODE_COLORS[hash % CUSTOM_NODE_COLORS.length] ?? NODE_TYPE_COLORS.other;
}

function graphThemePalette(isDark: boolean): GraphThemePalette {
  return isDark
    ? {
        defaultEdge: "rgba(100,116,139,0.18)",
        label: "#f8fafc",
        hoverLabelText: "#f8fafc",
        hoverLabelBackground: "rgba(15,23,42,0.94)",
        hoverLabelBorder: "rgba(148,163,184,0.38)",
        hoverLabelShadow: "rgba(2,6,23,0.55)",
        mutedNodeMixTarget: "#334155",
        dimmedEdge: "rgba(71,85,105,0.12)",
        activeEdge: "#38bdf8",
      }
    : {
        defaultEdge: "#cbd5e1",
        label: "#1e293b",
        hoverLabelText: "#0f172a",
        hoverLabelBackground: "rgba(255,255,255,0.97)",
        hoverLabelBorder: "rgba(15,23,42,0.14)",
        hoverLabelShadow: "rgba(15,23,42,0.18)",
        mutedNodeMixTarget: "#e2e8f0",
        dimmedEdge: "rgba(148,163,184,0.22)",
        activeEdge: "#1e293b",
      };
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function createGraphNodeHoverRenderer(palette: GraphThemePalette): NodeHoverDrawingFunction {
  return (context, data, settings) => {
    const label = typeof data.label === "string" ? data.label : "";
    const labelSize = settings.labelSize;
    const font = settings.labelFont;
    const weight = settings.labelWeight;
    const nodeRadius = Math.max(data.size, labelSize / 2) + 3;

    context.save();
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 2;
    context.shadowBlur = 10;
    context.shadowColor = palette.hoverLabelShadow;
    context.fillStyle = palette.hoverLabelBackground;
    context.strokeStyle = palette.hoverLabelBorder;
    context.lineWidth = 1;

    context.beginPath();
    context.arc(data.x, data.y, nodeRadius, 0, Math.PI * 2);
    context.closePath();
    context.fill();
    context.stroke();

    if (label) {
      context.font = `${weight} ${labelSize}px ${font}`;
      const paddingX = 8;
      const paddingY = 4;
      const gap = 6;
      const textWidth = context.measureText(label).width;
      const boxWidth = Math.ceil(textWidth + paddingX * 2);
      const boxHeight = Math.ceil(labelSize + paddingY * 2);
      const boxX = data.x + nodeRadius + gap;
      const boxY = data.y - boxHeight / 2;

      drawRoundedRect(context, boxX, boxY, boxWidth, boxHeight, 5);
      context.fill();
      context.stroke();

      context.shadowBlur = 0;
      context.shadowOffsetY = 0;
      context.fillStyle = palette.hoverLabelText;
      context.fillText(label, boxX + paddingX, data.y + labelSize / 3);
    }

    context.restore();
  };
}

function useResolvedDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setIsDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

function mixColor(color1: string, color2: string, ratio: number): string {
  const hex = (color: string) => parseInt(color, 16);
  const r1 = hex(color1.slice(1, 3));
  const g1 = hex(color1.slice(3, 5));
  const b1 = hex(color1.slice(5, 7));
  const r2 = hex(color2.slice(1, 3));
  const g2 = hex(color2.slice(3, 5));
  const b2 = hex(color2.slice(5, 7));
  const r = Math.round(r1 + (r2 - r1) * ratio);
  const g = Math.round(g1 + (g2 - g1) * ratio);
  const b = Math.round(b1 + (b2 - b1) * ratio);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function graphDensityScale(nodeCount: number): number {
  if (nodeCount <= 150) return 1;
  return Math.max(0.35, Math.sqrt(150 / nodeCount));
}

function nodeSize(linkCount: number, maxLinks: number, nodeCount: number, userScale: number): number {
  if (maxLinks === 0) return BASE_NODE_SIZE;
  const ratio = linkCount / maxLinks;
  return (BASE_NODE_SIZE + Math.sqrt(ratio) * (MAX_NODE_SIZE - BASE_NODE_SIZE)) * graphDensityScale(nodeCount) * userScale;
}

function labelSizeThreshold(nodeCount: number): number {
  if (nodeCount > 2500) return 18;
  if (nodeCount > 1200) return 14;
  if (nodeCount > 600) return 10;
  return 6;
}

function labelDensity(nodeCount: number): number {
  if (nodeCount > 2500) return 0.08;
  if (nodeCount > 1200) return 0.14;
  if (nodeCount > 600) return 0.24;
  return 0.4;
}

function layoutIterations(nodeCount: number): number {
  if (nodeCount > 2500) return 28;
  if (nodeCount > 1200) return 40;
  if (nodeCount > 600) return 65;
  if (nodeCount > 250) return 90;
  return 140;
}

function edgeVisibilityThreshold(nodeCount: number): number {
  if (nodeCount > 2500) return 0.16;
  if (nodeCount > 1200) return 0.1;
  if (nodeCount > 700) return 0.05;
  return 0;
}

function graphDataKey(nodes: readonly GraphNode[], edges: readonly GraphEdge[], graphSpacing: number): string {
  const nodeIds = nodes.map((node) => node.id).sort();
  const edgeIds = edges.map((edge) => `${edge.source}->${edge.target}:${Math.round(edge.weight * 1000)}`).sort();
  return `${hashParts(nodeIds)}:${hashParts(edgeIds)}:${nodes.length}:${edges.length}:${graphSpacing.toFixed(2)}`;
}

function hashParts(parts: readonly string[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeLayoutWorker(): Worker | null {
  try {
    return new Worker(new URL("./graph-layout-worker.ts", import.meta.url), { type: "module" });
  } catch (err) {
    console.warn("[Graph] failed to start layout worker; falling back to main-thread layout:", err);
    return null;
  }
}

function readGraphUrl() {
  const params = new URLSearchParams(window.location.search);
  const color = params.get("color");
  const hiddenTypes = params.get("types");
  return {
    colorMode: color === "community" ? "community" : ("type" as ColorMode),
    selectedNodeId: params.get("node") || null,
    hideStructural: params.get("hideStructural") !== "false",
    hideIsolated: params.get("hideIsolated") === "true",
    maxLinks: params.get("maxLinks") ? Number(params.get("maxLinks")) : undefined,
    hiddenTypes: new Set(hiddenTypes ? hiddenTypes.split(",").filter(Boolean) : []),
  };
}

function writeGraphUrl(state: {
  colorMode: ColorMode;
  selectedNodeId: string | null;
  query: string;
  filters: GraphFilterState;
}) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "graph");
  if (state.query.trim()) url.searchParams.set("q", state.query.trim());
  else url.searchParams.delete("q");
  if (state.colorMode === "community") url.searchParams.set("color", "community");
  else url.searchParams.delete("color");
  if (state.selectedNodeId) url.searchParams.set("node", state.selectedNodeId);
  else url.searchParams.delete("node");
  if (!state.filters.hideStructural) url.searchParams.set("hideStructural", "false");
  else url.searchParams.delete("hideStructural");
  if (state.filters.hideIsolated) url.searchParams.set("hideIsolated", "true");
  else url.searchParams.delete("hideIsolated");
  if (state.filters.maxLinks !== undefined) url.searchParams.set("maxLinks", String(state.filters.maxLinks));
  else url.searchParams.delete("maxLinks");
  if (state.filters.hiddenTypes.size > 0) url.searchParams.set("types", [...state.filters.hiddenTypes].sort().join(","));
  else url.searchParams.delete("types");
  const next = `${url.pathname}${url.search}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next !== current) window.history.replaceState(null, "", next);
}

function GraphLoader({
  nodes,
  edges,
  colorMode,
  nodeScale,
  graphSpacing,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  colorMode: ColorMode;
  nodeScale: number;
  graphSpacing: number;
}) {
  const loadGraph = useLoadGraph();
  const sigma = useSigma();

  useEffect(() => {
    const dataKey = graphDataKey(nodes, edges, graphSpacing);
    const needsLayout = dataKey !== lastLayoutDataKey && dataKey !== pendingLayoutDataKey;
    let cancelled = false;
    let worker: Worker | null = null;

    const graph = new Graph();
    const maxLinks = Math.max(...nodes.map((node) => node.linkCount), 1);
    const weakEdgeThreshold = edgeVisibilityThreshold(nodes.length);

    for (const node of nodes) {
      const cached = positionCache.get(node.id);
      const color =
        colorMode === "community" ? COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length] : nodeColor(node.type);
      graph.addNode(node.id, {
        type: "circle",
        x: cached?.x ?? Math.random() * 100,
        y: cached?.y ?? Math.random() * 100,
        size: nodeSize(node.linkCount, maxLinks, nodes.length, nodeScale),
        color,
        label: node.label,
        nodePath: node.path,
        nodeType: node.type,
        linkCount: node.linkCount,
        community: node.community,
      });
    }

    const maxWeight = Math.max(...edges.map((edge) => edge.weight), 1);
    for (const edge of edges) {
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
      const key = `${edge.source}->${edge.target}`;
      if (graph.hasEdge(key) || graph.hasEdge(`${edge.target}->${edge.source}`)) continue;
      const normalizedWeight = edge.weight / maxWeight;
      graph.addEdgeWithKey(key, edge.source, edge.target, {
        color: `rgba(100,116,139,${0.18 + normalizedWeight * 0.36})`,
        size: 0.45 + normalizedWeight * 0.85,
        weight: edge.weight,
        normalizedWeight,
        sourceNode: edge.source,
        targetNode: edge.target,
        lowPriority: weakEdgeThreshold > 0 && normalizedWeight < weakEdgeThreshold,
      });
    }

    const runMainThreadLayout = () => {
      const settings = forceAtlas2.inferSettings(graph);
      forceAtlas2.assign(graph, {
        iterations: layoutIterations(nodes.length),
        settings: {
          ...settings,
          gravity: 1,
          scalingRatio: graphSpacing * (nodes.length > 400 ? 3 : 2),
          strongGravityMode: true,
          barnesHutOptimize: nodes.length > 50,
        },
      });
      graph.forEachNode((id, attrs) => {
        positionCache.set(id, { x: Number(attrs.x), y: Number(attrs.y) });
      });
      lastLayoutDataKey = dataKey;
    };

    if (needsLayout && nodes.length > 1 && nodes.length < WORKER_LAYOUT_NODE_THRESHOLD) {
      runMainThreadLayout();
    }

    loadGraph(graph);

    if (needsLayout && nodes.length >= WORKER_LAYOUT_NODE_THRESHOLD) {
      worker = makeLayoutWorker();
      if (!worker) {
        runMainThreadLayout();
        loadGraph(graph);
        return undefined;
      }

      pendingLayoutDataKey = dataKey;
      worker.onmessage = (event: MessageEvent<{ key: string; positions: Array<{ id: string; x: number; y: number }> }>) => {
        if (cancelled || event.data.key !== dataKey) return;
        for (const { id, x, y } of event.data.positions) {
          if (!graph.hasNode(id)) continue;
          graph.setNodeAttribute(id, "x", x);
          graph.setNodeAttribute(id, "y", y);
          positionCache.set(id, { x, y });
        }
        lastLayoutDataKey = dataKey;
        if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = "";
        sigma.refresh();
      };
      worker.onerror = (event) => {
        if (cancelled) return;
        console.warn("[Graph] layout worker failed; falling back to main-thread layout:", event.message);
        if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = "";
        runMainThreadLayout();
        loadGraph(graph);
      };
      worker.postMessage({
        key: dataKey,
        nodes: nodes.map((node) => {
          const cached = positionCache.get(node.id);
          return {
            id: node.id,
            x: cached?.x ?? graph.getNodeAttribute(node.id, "x"),
            y: cached?.y ?? graph.getNodeAttribute(node.id, "y"),
          };
        }),
        edges: edges.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight })),
        iterations: layoutIterations(nodes.length),
        scalingRatio: graphSpacing * (nodes.length > 400 ? 3 : 2),
      });
    }

    return () => {
      cancelled = true;
      if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = "";
      worker?.terminate();
    };
  }, [colorMode, edges, graphSpacing, loadGraph, nodeScale, nodes, sigma]);

  return null;
}

function GraphRenderSettings({
  hoverState,
  highlightedNodes,
  nodeCount,
  palette,
}: {
  hoverState: HoverState;
  highlightedNodes: Set<string>;
  nodeCount: number;
  palette: GraphThemePalette;
}) {
  const sigma = useSigma();
  const setSettings = useSetSettings();

  useEffect(() => {
    setSettings({
      hideEdgesOnMove: true,
      hideLabelsOnMove: true,
      labelDensity: labelDensity(nodeCount),
      labelRenderedSizeThreshold: labelSizeThreshold(nodeCount),
      renderEdgeLabels: false,
      labelColor: { color: palette.label },
      defaultDrawNodeHover: createGraphNodeHoverRenderer(palette),
      nodeReducer: (node, attrs) => {
        const result = { ...attrs };
        const hasHover = !!hoverState;
        const hasHighlight = highlightedNodes.size > 0;
        const isHoverNode = hoverState?.node === node;
        const isHoverNeighbor = hoverState?.neighbors.has(node) ?? false;
        const isHighlighted = highlightedNodes.has(node);

        if (isHighlighted) {
          result.size = (Number(attrs.size) || BASE_NODE_SIZE) * 1.45;
          result.forceLabel = true;
          result.zIndex = 10;
        }
        if (isHoverNode) {
          result.size = (Number(attrs.size) || BASE_NODE_SIZE) * 1.4;
          result.forceLabel = true;
          result.zIndex = 10;
        }
        if ((hasHover && !isHoverNode && !isHoverNeighbor) || (hasHighlight && !isHighlighted)) {
          result.color = mixColor(String(attrs.color ?? "#94a3b8"), palette.mutedNodeMixTarget, 0.75);
          result.label = "";
          result.size = (Number(attrs.size) || BASE_NODE_SIZE) * 0.6;
        }
        return result;
      },
      edgeReducer: (_edge, attrs) => {
        const source = String(attrs.sourceNode ?? "");
        const target = String(attrs.targetNode ?? "");
        const result = { ...attrs };
        const hasHover = !!hoverState;
        const hasHighlight = highlightedNodes.size > 0;
        const hoverEdge = hasHover && (source === hoverState?.node || target === hoverState?.node);
        const highlightedEdge = hasHighlight && highlightedNodes.has(source) && highlightedNodes.has(target);

        if (attrs.lowPriority && !hoverEdge && !highlightedEdge) {
          result.hidden = true;
          return result;
        }
        if ((hasHover && !hoverEdge) || (hasHighlight && !highlightedEdge)) {
          result.color = palette.dimmedEdge;
          result.size = 0.18;
        }
        if (hoverEdge || highlightedEdge) {
          result.color = palette.activeEdge;
          result.size = Math.max(1.6, (Number(attrs.size) || 0.6) * 2.2);
        }
        return result;
      },
    });
    sigma.refresh();
  }, [highlightedNodes, hoverState, nodeCount, palette, setSettings, sigma]);

  return null;
}

function GraphEvents({
  onNodeClick,
  onNodeContextMenu,
  onHoverChange,
}: {
  onNodeClick: (nodeId: string) => void;
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void;
  onHoverChange: (state: HoverState) => void;
}) {
  const registerEvents = useRegisterEvents();
  const sigma = useSigma();

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => onNodeClick(node),
      rightClickNode: (payload: SigmaNodeEventPayload) => {
        payload.preventSigmaDefault();
        payload.event.original.preventDefault();
        const point = clientPointFromEvent(payload.event.original);
        onNodeContextMenu(nodeIdFromPayload(payload), point.x, point.y);
      },
      rightClickStage: () => onNodeContextMenu("", 0, 0),
      enterNode: ({ node }) => {
        sigma.getContainer().style.cursor = "pointer";
        onHoverChange({ node, neighbors: new Set(sigma.getGraph().neighbors(node)) });
      },
      leaveNode: () => {
        sigma.getContainer().style.cursor = "default";
        onHoverChange(null);
      },
    });
  }, [onHoverChange, onNodeClick, onNodeContextMenu, registerEvents, sigma]);
  return null;
}

function nodeIdFromPayload(payload: SigmaNodeEventPayload): string {
  return payload.node;
}

function clientPointFromEvent(event: MouseEvent | TouchEvent) {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  const touch = event.touches[0] ?? event.changedTouches[0];
  return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 };
}

function ZoomControls() {
  const sigma = useSigma();
  return (
    <div className="graph-zoom-controls">
      <button type="button" title="Zoom in" onClick={() => sigma.getCamera().animatedZoom({ duration: 200 })}>
        <ZoomIn size={16} />
      </button>
      <button type="button" title="Zoom out" onClick={() => sigma.getCamera().animatedUnzoom({ duration: 200 })}>
        <ZoomOut size={16} />
      </button>
      <button type="button" title="Reset view" onClick={() => sigma.getCamera().animatedReset({ duration: 300 })}>
        <Maximize size={16} />
      </button>
    </div>
  );
}

export function GraphView({
  nodes: apiNodes,
  edges: apiEdges,
  query,
  setQuery,
  makeHref,
  onOpen,
  onRefresh,
}: {
  nodes: ApiGraphNode[];
  edges: ApiGraphEdge[];
  query: string;
  setQuery: (query: string) => void;
  makeHref: (params: AppHrefParams) => string;
  onOpen: (path: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const isDarkMode = useResolvedDarkMode();
  const graphPalette = useMemo(() => graphThemePalette(isDarkMode), [isDarkMode]);
  const drawNodeHover = useMemo(() => createGraphNodeHoverRenderer(graphPalette), [graphPalette]);
  const [localNodes, setLocalNodes] = useState<ApiGraphNode[]>(apiNodes);
  const [localEdges, setLocalEdges] = useState<ApiGraphEdge[]>(apiEdges);
  const [loading, setLoading] = useState(apiNodes.length === 0 && apiEdges.length === 0);
  const [error, setError] = useState<string | null>(null);
  const initialUrl = useMemo(() => readGraphUrl(), []);
  const [colorMode, setColorMode] = useState<ColorMode>(initialUrl.colorMode);
  const [showFilters, setShowFilters] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [searchOpen, setSearchOpen] = useState(Boolean(query.trim()));
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [nodeScale, setNodeScale] = useState(DEFAULT_NODE_SCALE);
  const [graphSpacingDraft, setGraphSpacingDraft] = useState(DEFAULT_GRAPH_SPACING);
  const [graphSpacing, setGraphSpacing] = useState(DEFAULT_GRAPH_SPACING);
  const [filters, setFilters] = useState<GraphFilterState>(() => ({
    ...DEFAULT_GRAPH_FILTERS,
    hiddenTypes: initialUrl.hiddenTypes,
    hiddenNodeIds: new Set(),
    hideStructural: initialUrl.hideStructural,
    hideIsolated: initialUrl.hideIsolated,
    maxLinks: Number.isFinite(initialUrl.maxLinks) ? initialUrl.maxLinks : undefined,
  }));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialUrl.selectedNodeId);
  const [hoverState, setHoverState] = useState<HoverState>(null);
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set());
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [sigmaKey, setSigmaKey] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalNodes(apiNodes);
    setLocalEdges(apiEdges);
    setError(null);
    setLoading(false);
  }, [apiEdges, apiNodes]);

  useEffect(() => {
    const timer = window.setTimeout(() => setGraphSpacing(graphSpacingDraft), GRAPH_SPACING_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [graphSpacingDraft]);

  useEffect(() => {
    setIsResizing(true);
    const timer = window.setTimeout(() => {
      setSigmaKey((value) => value + 1);
      setIsResizing(false);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [selectedNodeId, showInsights]);

  const graph = useMemo(() => normalizeGraphData(localNodes, localEdges), [localEdges, localNodes]);
  const filteredGraph = useMemo(() => applyGraphFilters(graph.nodes, graph.edges, filters), [filters, graph.edges, graph.nodes]);
  const searchedGraph = useMemo(() => applyGraphSearch(filteredGraph.nodes, filteredGraph.edges, query), [filteredGraph, query]);
  const selectedNode = selectedNodeId ? graph.nodes.find((node) => node.id === selectedNodeId) ?? null : null;
  const typeCounts = useMemo(
    () =>
      graph.nodes.reduce<Record<string, number>>((acc, node) => {
        acc[node.type] = (acc[node.type] ?? 0) + 1;
        return acc;
      }, {}),
    [graph.nodes],
  );
  const insights = useMemo(
    () => ({
      surprising: findSurprisingConnections(graph.nodes, graph.edges).filter((item) => !dismissedInsights.has(item.key)),
      gaps: detectKnowledgeGaps(graph.nodes, graph.edges, graph.communities).filter(
        (gap) => !dismissedInsights.has(knowledgeGapKey(gap)),
      ),
    }),
    [dismissedInsights, graph.communities, graph.edges, graph.nodes],
  );
  const hiddenCount = graph.nodes.length - filteredGraph.nodes.length;
  const filtersActive = hasActiveGraphFilters(filters);
  const searchActive = query.trim().length > 0;
  const activeHighlights = searchActive ? searchedGraph.matchedNodeIds : highlightedNodes;
  const contextNode = nodeMenu ? graph.nodes.find((node) => node.id === nodeMenu.nodeId) : null;

  useEffect(() => {
    writeGraphUrl({ colorMode, selectedNodeId, query, filters });
  }, [colorMode, filters, query, selectedNodeId]);

  useEffect(() => {
    if (query.trim()) setSearchOpen(true);
  }, [query]);

  const resetFilters = useCallback(() => {
    setFilters({
      ...DEFAULT_GRAPH_FILTERS,
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
    });
    setNodeScale(DEFAULT_NODE_SCALE);
    setGraphSpacingDraft(DEFAULT_GRAPH_SPACING);
    setGraphSpacing(DEFAULT_GRAPH_SPACING);
    setHighlightedNodes(new Set());
    setNodeMenu(null);
  }, []);

  const handleNodeContextMenu = useCallback((nodeId: string, clientX: number, clientY: number) => {
    if (!nodeId) {
      setNodeMenu(null);
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    setNodeMenu({
      nodeId,
      x: rect ? clientX - rect.left : clientX,
      y: rect ? clientY - rect.top : clientY,
    });
  }, []);

  if (loading) {
    return (
      <article className="graph-page">
        <div className="graph-empty">
          <RefreshCw className="spin" size={34} />
          <strong>{t("graph.buildingGraph")}</strong>
        </div>
      </article>
    );
  }

  if (error) {
    return (
      <article className="graph-page">
        <div className="graph-empty">
          <Network size={40} />
          <strong>{error}</strong>
          <button className="graph-empty-action" type="button" onClick={onRefresh}>{t("graph.retry")}</button>
        </div>
      </article>
    );
  }

  if (graph.nodes.length === 0) {
    return (
      <article className="graph-page">
        <div className="graph-empty">
          <Network size={40} />
          <strong>{t("graph.noPages")}</strong>
          <span>{t("graph.importSourcesHint")}</span>
        </div>
      </article>
    );
  }

  return (
    <article className="graph-page">
      <header className="graph-topbar">
        <div className="graph-title-group">
          <Network size={18} />
          <strong>{t("graph.knowledgeGraph")}</strong>
          <span>{searchedGraph.nodes.length}/{graph.nodes.length}</span>
          <span>{searchedGraph.edges.length}/{graph.edges.length}</span>
          {hiddenCount > 0 && <em>{hiddenCount} {t("graph.hidden")}</em>}
        </div>
        <div className="graph-toolbar">
          {searchOpen ? (
            <label className="graph-search">
              <Search size={15} />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    if (query.trim()) setQuery("");
                    else setSearchOpen(false);
                  }
                }}
                placeholder={t("graph.searchPlaceholder")}
              />
              <button
                type="button"
                title={query ? t("graph.clearSearch") : t("graph.closeSearch")}
                onClick={() => {
                  if (query) setQuery("");
                  else setSearchOpen(false);
                }}
              >
                <X size={14} />
              </button>
            </label>
          ) : (
            <button type="button" title={t("graph.searchLabel")} onClick={() => setSearchOpen(true)}>
              <Search size={15} />
            </button>
          )}
          <button className={showFilters ? "active" : ""} type="button" onClick={() => setShowFilters((value) => !value)}>
            <Filter size={15} />
            {t("graph.filter")}
          </button>
          {filtersActive && (
            <button type="button" title={t("graph.reset")} onClick={resetFilters}>
              <RotateCcw size={15} />
            </button>
          )}
          <button className={colorMode === "type" ? "active" : ""} type="button" onClick={() => setColorMode("type")}>
            <Tag size={15} />
            {t("graph.type")}
          </button>
          <button className={colorMode === "community" ? "active" : ""} type="button" onClick={() => setColorMode("community")}>
            <Layers size={15} />
            {t("graph.community")}
          </button>
          {(insights.surprising.length > 0 || insights.gaps.length > 0) && (
            <button
              className={showInsights ? "active" : ""}
              type="button"
              title={t("graph.insights")}
              onClick={() => setShowInsights((value) => !value)}
            >
              <Lightbulb size={15} />
              <span>{insights.surprising.length + insights.gaps.length}</span>
            </button>
          )}
          <button type="button" title={t("workspace.refreshFromNativeApi")} onClick={onRefresh}>
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      <div className="graph-body">
        <div className="graph-canvas-shell" ref={containerRef} onClick={() => setNodeMenu(null)} onContextMenu={(event) => event.preventDefault()}>
          {isResizing ? (
            <div className="graph-resizing">{t("graph.resizing")}</div>
          ) : (
            <SigmaContainer
              key={sigmaKey}
              style={{ width: "100%", height: "100%", background: "transparent" }}
              settings={{
                defaultNodeType: "circle",
                renderEdgeLabels: false,
                hideEdgesOnMove: true,
                hideLabelsOnMove: true,
                defaultEdgeColor: graphPalette.defaultEdge,
                defaultNodeColor: "#94a3b8",
                labelSize: 13,
                labelWeight: "bold",
                labelColor: { color: graphPalette.label },
                defaultDrawNodeHover: drawNodeHover,
                stagePadding: 30,
              }}
            >
              <GraphLoader
                nodes={searchedGraph.nodes}
                edges={searchedGraph.edges}
                colorMode={colorMode}
                nodeScale={nodeScale}
                graphSpacing={graphSpacing}
              />
              <GraphEvents
                onNodeClick={(nodeId) => {
                  setSelectedNodeId(nodeId);
                  setHighlightedNodes(new Set([nodeId]));
                }}
                onNodeContextMenu={handleNodeContextMenu}
                onHoverChange={setHoverState}
              />
              <GraphRenderSettings
                hoverState={hoverState}
                highlightedNodes={activeHighlights}
                nodeCount={searchedGraph.nodes.length}
                palette={graphPalette}
              />
              <ZoomControls />
            </SigmaContainer>
          )}

          {searchedGraph.nodes.length === 0 && (
            <div className="graph-no-results">
              <Search size={34} />
              <strong>{query.trim() ? t("graph.noSearchResults") : t("graph.noVisibleNodes")}</strong>
              {query.trim() && <button type="button" onClick={() => setQuery("")}>{t("graph.clearSearch")}</button>}
            </div>
          )}

          {showFilters && (
            <GraphFiltersPanel
              filters={filters}
              setFilters={setFilters}
              nodeScale={nodeScale}
              setNodeScale={setNodeScale}
              graphSpacing={graphSpacingDraft}
              setGraphSpacing={setGraphSpacingDraft}
              typeCounts={typeCounts}
              nodes={graph.nodes}
              visibleNodes={filteredGraph.nodes.length}
              visibleEdges={filteredGraph.edges.length}
              totalNodes={graph.nodes.length}
              totalEdges={graph.edges.length}
              resetFilters={resetFilters}
            />
          )}

          {nodeMenu && contextNode && (
            <div className="graph-node-menu" style={{ left: nodeMenu.x, top: nodeMenu.y }} onClick={(event) => event.stopPropagation()}>
              <strong>{contextNode.label}</strong>
              <span>{contextNode.linkCount} {t("graph.links")}</span>
              <button
                type="button"
                onClick={() => {
                  setFilters((previous) => ({
                    ...previous,
                    hiddenNodeIds: new Set([...previous.hiddenNodeIds, contextNode.id]),
                  }));
                  setNodeMenu(null);
                }}
              >
                <EyeOff size={14} />
                {t("graph.hideThisNode")}
              </button>
            </div>
          )}

          <GraphLegend
            colorMode={colorMode}
            collapsed={legendCollapsed}
            setCollapsed={setLegendCollapsed}
            typeCounts={typeCounts}
            communities={graph.communities}
            filters={filters}
            setFilters={setFilters}
          />
        </div>

        {showInsights && (
          <GraphInsightsPanel
            surprising={insights.surprising}
            gaps={insights.gaps}
            highlightedNodes={highlightedNodes}
            setHighlightedNodes={setHighlightedNodes}
            dismiss={(key) => setDismissedInsights((previous) => new Set([...previous, key]))}
          />
        )}

        {selectedNode && (
          <GraphNodePanel
            node={selectedNode}
            makeHref={makeHref}
            onOpen={onOpen}
            onClose={() => {
              setSelectedNodeId(null);
              setHighlightedNodes(new Set());
            }}
          />
        )}
      </div>
    </article>
  );
}

function GraphFiltersPanel({
  filters,
  setFilters,
  nodeScale,
  setNodeScale,
  graphSpacing,
  setGraphSpacing,
  typeCounts,
  nodes,
  visibleNodes,
  visibleEdges,
  totalNodes,
  totalEdges,
  resetFilters,
}: {
  filters: GraphFilterState;
  setFilters: React.Dispatch<React.SetStateAction<GraphFilterState>>;
  nodeScale: number;
  setNodeScale: (value: number) => void;
  graphSpacing: number;
  setGraphSpacing: (value: number) => void;
  typeCounts: Record<string, number>;
  nodes: GraphNode[];
  visibleNodes: number;
  visibleEdges: number;
  totalNodes: number;
  totalEdges: number;
  resetFilters: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="graph-filter-panel">
      <header>
        <strong><Filter size={15} /> {t("graph.graphFilters")}</strong>
        <button type="button" onClick={resetFilters}>{t("graph.reset")}</button>
      </header>
      <div className="graph-filter-section">
        <span>{t("graph.quickFilters")}</span>
        <label><input type="checkbox" checked={filters.hideStructural} onChange={(event) => setFilters((prev) => ({ ...prev, hideStructural: event.target.checked }))} />{t("graph.hideIndexOverview")}</label>
        <label><input type="checkbox" checked={filters.hideIsolated} onChange={(event) => setFilters((prev) => ({ ...prev, hideIsolated: event.target.checked }))} />{t("graph.hideIsolated")}</label>
      </div>
      <div className="graph-filter-section">
        <span>{t("graph.maxLinks")}</span>
        <input
          type="number"
          min={0}
          value={filters.maxLinks ?? ""}
          placeholder="Any"
          onChange={(event) => {
            const value = Number(event.target.value);
            setFilters((prev) => ({ ...prev, maxLinks: event.target.value === "" || !Number.isFinite(value) ? undefined : Math.max(0, value) }));
          }}
        />
        <small>{t("graph.maxLinksHint")}</small>
      </div>
      <div className="graph-filter-section">
        <span>{t("graph.displayTuning")}</span>
        <label>{t("graph.nodeSize")} <output>{Math.round(nodeScale * 100)}%</output><input type="range" min={0.5} max={1.5} step={0.05} value={nodeScale} onChange={(event) => setNodeScale(Number(event.target.value))} /></label>
        <label>{t("graph.spacing")} <output>{Math.round(graphSpacing * 100)}%</output><input type="range" min={0.6} max={2.2} step={0.05} value={graphSpacing} onChange={(event) => setGraphSpacing(Number(event.target.value))} /></label>
      </div>
      <div className="graph-filter-section">
        <span>{t("graph.nodeTypes")}</span>
        <div className="graph-type-grid">
          {Object.entries(typeCounts).map(([type, count]) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={!filters.hiddenTypes.has(type)}
                onChange={(event) => {
                  setFilters((prev) => {
                    const next = new Set(prev.hiddenTypes);
                    if (event.target.checked) next.delete(type);
                    else next.add(type);
                    return { ...prev, hiddenTypes: next };
                  });
                }}
              />
              {t(`graph.nodeTypeLabels.${type}`, type)} <em>{count}</em>
            </label>
          ))}
        </div>
      </div>
      {filters.hiddenNodeIds.size > 0 && (
        <div className="graph-filter-section">
          <span>{t("graph.hiddenNodes")}</span>
          {[...filters.hiddenNodeIds].map((id) => {
            const node = nodes.find((item) => item.id === id);
            return (
              <button key={id} type="button" onClick={() => setFilters((prev) => {
                const next = new Set(prev.hiddenNodeIds);
                next.delete(id);
                return { ...prev, hiddenNodeIds: next };
              })}>
                {node?.label ?? id} · {t("graph.show")}
              </button>
            );
          })}
        </div>
      )}
      <footer>{t("graph.showingStats", { pages: visibleNodes, total: totalNodes, links: visibleEdges, totalLinks: totalEdges })}</footer>
    </section>
  );
}

function GraphLegend({
  colorMode,
  collapsed,
  setCollapsed,
  typeCounts,
  communities,
  filters,
  setFilters,
}: {
  colorMode: ColorMode;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  typeCounts: Record<string, number>;
  communities: CommunityInfo[];
  filters: GraphFilterState;
  setFilters: React.Dispatch<React.SetStateAction<GraphFilterState>>;
}) {
  const { t } = useTranslation();
  return (
    <section className="graph-legend">
      <header>
        <strong>{colorMode === "type" ? t("graph.nodeTypesLabel") : t("graph.communitiesLabel")}</strong>
        <button type="button" onClick={() => setCollapsed(!collapsed)}>{collapsed ? ">" : "v"}</button>
      </header>
      {!collapsed && (
        colorMode === "type" ? (
          <div>
            {Object.entries(typeCounts).map(([type, count]) => {
              const hidden = filters.hiddenTypes.has(type);
              return (
                <button
                  className={hidden ? "muted" : ""}
                  key={type}
                  type="button"
                  onDoubleClick={() => setFilters((prev) => {
                    const next = new Set(prev.hiddenTypes);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return { ...prev, hiddenTypes: next };
                  })}
                  title={t("graph.doubleClickToggle")}
                >
                  <i style={{ background: hidden ? "#94a3b8" : nodeColor(type) }} />
                  <span>{t(`graph.nodeTypeLabels.${type}`, type)}</span>
                  <em>{count}</em>
                </button>
              );
            })}
          </div>
        ) : (
          <div>
            {communities.map((community) => (
              <span key={community.id} title={community.topNodes.join(", ")}>
                <i style={{ background: COMMUNITY_COLORS[community.id % COMMUNITY_COLORS.length] }} />
                <span>{community.topNodes[0] ?? t("graph.cluster", { id: community.id })}</span>
                <em>{community.nodeCount}</em>
              </span>
            ))}
          </div>
        )
      )}
    </section>
  );
}

function GraphInsightsPanel({
  surprising,
  gaps,
  highlightedNodes,
  setHighlightedNodes,
  dismiss,
}: {
  surprising: SurprisingConnection[];
  gaps: KnowledgeGap[];
  highlightedNodes: Set<string>;
  setHighlightedNodes: (ids: Set<string>) => void;
  dismiss: (key: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="graph-insights-panel">
      <header><Lightbulb size={16} /><strong>{t("graph.insights")}</strong></header>
      {surprising.length > 0 && (
        <section>
          <h3><Link2 size={15} />{t("graph.surprisingConnections")}</h3>
          {surprising.map((item) => {
            const ids = new Set([item.source.id, item.target.id]);
            const active = highlightedNodes.size === ids.size && [...ids].every((id) => highlightedNodes.has(id));
            return (
              <button key={item.key} className={active ? "active" : ""} type="button" onClick={() => setHighlightedNodes(active ? new Set() : ids)}>
                <strong>{item.source.label} - {item.target.label}</strong>
                <span>{item.reasons.join(", ")}</span>
                <i onClick={(event) => { event.stopPropagation(); dismiss(item.key); }}><X size={14} /></i>
              </button>
            );
          })}
        </section>
      )}
      {gaps.length > 0 && (
        <section>
          <h3><AlertTriangle size={15} />{t("graph.knowledgeGaps")}</h3>
          {gaps.map((gap) => {
            const key = knowledgeGapKey(gap);
            const ids = new Set(gap.nodeIds);
            const active = highlightedNodes.size > 0 && [...highlightedNodes].every((id) => ids.has(id));
            return (
              <button key={key} className={active ? "active" : ""} type="button" onClick={() => setHighlightedNodes(active ? new Set() : ids)}>
                <strong>{gap.title}</strong>
                <span>{gap.description}</span>
                <small>{gap.suggestion}</small>
                <em>{t("unsupported.deepResearch.reason")}</em>
                <i onClick={(event) => { event.stopPropagation(); dismiss(key); }}><X size={14} /></i>
              </button>
            );
          })}
        </section>
      )}
    </aside>
  );
}

function GraphNodePanel({
  node,
  makeHref,
  onOpen,
  onClose,
}: {
  node: GraphNode;
  makeHref: (params: AppHrefParams) => string;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="graph-node-panel">
      <header>
        <span>{t(`graph.nodeTypeLabels.${node.type}`, node.type)}</span>
        <button type="button" onClick={onClose}><X size={16} /></button>
      </header>
      <strong>{node.label}</strong>
      <dl>
        <dt>{t("graph.links")}</dt>
        <dd>{node.linkCount}</dd>
        <dt>{t("graph.community")}</dt>
        <dd>{node.community + 1}</dd>
        {node.path && (
          <>
            <dt>Path</dt>
            <dd>{node.path}</dd>
          </>
        )}
      </dl>
      {node.path && (
        <a
          className="primary-action"
          href={makeHref({ view: "wiki", path: node.path })}
          onClick={(event) => {
            if (!shouldHandleInApp(event)) return;
            event.preventDefault();
            onOpen(node.path!);
          }}
        >
          {t("graph.openPage")}
        </a>
      )}
    </aside>
  );
}

function knowledgeGapKey(gap: KnowledgeGap) {
  return `gap:${gap.type}:${gap.title}:${gap.nodeIds.join(",")}`;
}
