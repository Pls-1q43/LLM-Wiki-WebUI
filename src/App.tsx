import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  FileSearch,
  FileText,
  FolderOpen,
  GitBranch,
  Layers,
  Loader2,
  Menu,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Search,
  Server,
  Settings,
  Tag,
  X,
} from "lucide-react";
import {
  ApiFileNode,
  ApiGraphEdge,
  ApiGraphNode,
  ApiHealth,
  ApiProject,
  ApiReviewItem,
  ApiReviewStatus,
  ApiSearchResult,
  LlmWikiApiClient,
} from "./lib/api-client";
import { GraphView } from "./components/GraphView";
import { unsupportedFeatures } from "./lib/feature-support";
import { flattenFiles, lintReadOnly, type LintIssue } from "./lib/lint";

type View = "wiki" | "sources" | "search" | "graph" | "review" | "lint" | "chat" | "settings";
type RootMode = "wiki" | "sources" | "all";
type AppUrlParams = {
  view?: View;
  project?: string;
  path?: string | null;
  q?: string;
  review?: ApiReviewStatus;
};

const APP_DISPLAY_NAME = "LLM Wiki WebUI";

const navItems: Array<{ id: View; labelKey: string; icon: typeof BookOpen }> = [
  { id: "wiki", labelKey: "nav.wiki", icon: BookOpen },
  { id: "sources", labelKey: "nav.sources", icon: FolderOpen },
  { id: "search", labelKey: "nav.search", icon: FileSearch },
  { id: "graph", labelKey: "nav.graph", icon: GitBranch },
  { id: "review", labelKey: "nav.review", icon: Activity },
  { id: "lint", labelKey: "nav.lint", icon: CheckCircle2 },
  { id: "chat", labelKey: "nav.chat", icon: MessageSquare },
  { id: "settings", labelKey: "nav.settings", icon: Settings },
];

const mobilePrimaryNav: View[] = ["wiki", "search", "graph", "review", "settings"];
const mobileSecondaryNav: View[] = ["sources", "lint", "chat"];

const client = new LlmWikiApiClient();

function isView(value: string | null): value is View {
  return Boolean(value && navItems.some((item) => item.id === value));
}

function isReviewStatus(value: string | null): value is ApiReviewStatus {
  return value === "unresolved" || value === "resolved" || value === "all";
}

function readUrlParams(): AppUrlParams {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const review = params.get("review");
  return {
    view: isView(view) ? view : undefined,
    project: params.get("project") || undefined,
    path: params.get("path") || null,
    q: params.get("q") || "",
    review: isReviewStatus(review) ? review : undefined,
  };
}

function appHref(params: AppUrlParams): string {
  const url = new URL(window.location.href);
  const next = new URLSearchParams(window.location.search);
  if (params.view) next.set("view", params.view);
  else next.delete("view");
  if (params.project) next.set("project", params.project);
  else next.delete("project");
  if (params.view === "graph") next.delete("path");
  else if (params.path) next.set("path", params.path);
  else next.delete("path");
  if (params.q) next.set("q", params.q);
  else next.delete("q");
  if (params.review && params.review !== "unresolved") next.set("review", params.review);
  else next.delete("review");
  if (params.view && params.view !== "graph") {
    for (const key of ["color", "node", "hideStructural", "hideIsolated", "maxLinks", "types"]) {
      next.delete(key);
    }
  }
  url.search = next.toString();
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

function shouldHandleInApp(event: MouseEvent<HTMLElement>) {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey
  );
}

function isMarkdown(path: string) {
  return /\.(md|mdx)$/i.test(path);
}

function formatBytes(value?: number) {
  if (value === undefined) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function fileNameFromPath(path: string | null) {
  if (!path) return "";
  return path.split("/").filter(Boolean).pop() ?? path;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function collectTextPaths(nodes: ApiFileNode[], limit = 30) {
  return flattenFiles(nodes)
    .filter((node) => !node.isDir && /\.(md|mdx|txt|json|yaml|yml|csv|log)$/i.test(node.path))
    .slice(0, limit)
    .map((node) => node.path);
}

function findDefaultWikiPath(nodes: ApiFileNode[]): string | null {
  const flat = flattenFiles(nodes).filter((node) => !node.isDir && /\.mdx?$/i.test(node.path));
  return (
    flat.find((node) => node.path.toLowerCase() === "wiki/overview.md")?.path ??
    flat.find((node) => /(^|\/)overview\.mdx?$/i.test(node.path))?.path ??
    flat[0]?.path ??
    null
  );
}

function filePathExists(nodes: ApiFileNode[], path: string | null): boolean {
  if (!path) return false;
  return flattenFiles(nodes).some((node) => !node.isDir && node.path === path);
}

function countDescendantFiles(node: ApiFileNode): number {
  if (!node.isDir) return 1;
  return (node.children ?? []).reduce((total, child) => total + countDescendantFiles(child), 0);
}

function findAncestorDirs(nodes: ApiFileNode[], selectedPath: string | null): string[] {
  if (!selectedPath) return [];
  const ancestors: string[] = [];
  function visit(items: ApiFileNode[], current: string[]): boolean {
    for (const node of items) {
      if (node.path === selectedPath) {
        ancestors.push(...current);
        return true;
      }
      if (node.children && visit(node.children, node.isDir ? [...current, node.path] : current)) {
        return true;
      }
    }
    return false;
  }
  visit(nodes, []);
  return ancestors;
}

function treeStateKey(nodes: ApiFileNode[]): string {
  const parts: string[] = [];
  function visit(items: ApiFileNode[]) {
    for (const node of items) {
      parts.push(`${node.isDir ? "d" : "f"}:${node.path}`);
      if (node.children) visit(node.children);
    }
  }
  visit(nodes);
  return parts.join("|");
}

interface ParsedMarkdown {
  frontmatter: Record<string, string | string[]> | null;
  body: string;
}

function parseMarkdownFrontmatter(content: string): ParsedMarkdown {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { frontmatter: null, body: content };
  const frontmatter: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!item) continue;
    const [, key, rawValue] = item;
    const value = rawValue.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { frontmatter, body: content.slice(match[0].length) };
}

const WIKILINK_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;

function transformWikilinks(body: string): string {
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

function normalizeWikiTarget(value: string) {
  return value
    .replace(/\.md$/i, "")
    .split("/")
    .pop()!
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function resolveWikiTarget(target: string, files: ApiFileNode[]) {
  const flat = flattenFiles(files).filter((node) => !node.isDir && node.path.endsWith(".md"));
  const normalized = normalizeWikiTarget(target);
  return (
    flat.find((node) => node.path === target || node.path === `wiki/${target}`)?.path ??
    flat.find((node) => normalizeWikiTarget(node.path) === normalized)?.path ??
    null
  );
}

function unwrapWikiValue(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
  if (!match) return { slug: trimmed, label: trimmed };
  return { slug: match[1].trim(), label: (match[2] ?? match[1]).trim() };
}

function resolveSourceTarget(target: string, sources: ApiFileNode[]) {
  const flat = flattenFiles(sources).filter((node) => !node.isDir);
  const normalized = normalizeWikiTarget(target);
  return (
    flat.find((node) => node.path === target || node.path.endsWith(`/${target}`))?.path ??
    flat.find((node) => normalizeWikiTarget(node.path) === normalized)?.path ??
    null
  );
}

export function App() {
  const { t, i18n } = useTranslation();
  const initialUrlParams = useMemo(() => readUrlParams(), []);
  const [activeView, setActiveView] = useState<View>(initialUrlParams.view ?? "wiki");
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(initialUrlParams.project ?? "current");
  const [files, setFiles] = useState<ApiFileNode[]>([]);
  const [sources, setSources] = useState<ApiFileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(initialUrlParams.path ?? null);
  const [fileContent, setFileContent] = useState("");
  const [searchQuery, setSearchQuery] = useState(initialUrlParams.q ?? "");
  const [searchResults, setSearchResults] = useState<ApiSearchResult[]>([]);
  const [graphNodes, setGraphNodes] = useState<ApiGraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<ApiGraphEdge[]>([]);
  const [reviews, setReviews] = useState<ApiReviewItem[]>([]);
  const [reviewStatus, setReviewStatus] = useState<ApiReviewStatus>(initialUrlParams.review ?? "unresolved");
  const [lintIssues, setLintIssues] = useState<LintIssue[]>([]);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rescanMessage, setRescanMessage] = useState<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false);
  const [isMobileMoreOpen, setIsMobileMoreOpen] = useState(false);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceCloseRef = useRef<HTMLButtonElement>(null);

  const selectedProject = useMemo(
    () =>
      projects.find((project) => project.id === selectedProjectId) ??
      projects.find((project) => project.current) ??
      projects[0],
    [projects, selectedProjectId],
  );
  const defaultWikiPath = useMemo(() => findDefaultWikiPath(files), [files]);

  const activeTree = activeView === "sources" ? sources : files;

  const makeHref = useCallback(
    (params: AppUrlParams) =>
      appHref({
        view: params.view ?? activeView,
        project: params.project ?? selectedProject?.id ?? selectedProjectId,
        path: params.path === undefined ? selectedFile : params.path,
        q: params.q === undefined ? searchQuery : params.q,
        review: params.review ?? reviewStatus,
      }),
    [activeView, reviewStatus, searchQuery, selectedFile, selectedProject?.id, selectedProjectId],
  );

  const refreshHealth = useCallback(async () => {
    const value = await client.health();
    setHealth(value);
    return value;
  }, []);

  const refreshProjects = useCallback(async () => {
    const value = await client.projects();
    setProjects(value.projects);
    setSelectedProjectId((current) => {
      if (current !== "current" && value.projects.some((project) => project.id === current)) {
        return current;
      }
      return value.currentProject?.id ?? value.projects[0]?.id ?? "current";
    });
    return value;
  }, []);

  const refreshFiles = useCallback(async (id: string, root: RootMode) => {
    const value = await client.files(id, { root, recursive: true, maxFiles: 5000 });
    return value.files;
  }, []);

  const loadProjectData = useCallback(
    async (id: string) => {
      setLoading(t("common.loading"));
      const [wikiFilesResult, sourceFilesResult, reviewDataResult, graphDataResult] = await Promise.allSettled([
        refreshFiles(id, "wiki"),
        refreshFiles(id, "sources"),
        client.reviews(id, { status: reviewStatus, limit: 200 }),
        client.graph(id, { limit: 1000 }),
      ]);
      if (wikiFilesResult.status === "fulfilled") {
        setFiles(wikiFilesResult.value);
        setSelectedFile((current) => {
          if (activeView === "sources" && current) return current;
          return filePathExists(wikiFilesResult.value, current) ? current : findDefaultWikiPath(wikiFilesResult.value);
        });
      }
      if (sourceFilesResult.status === "fulfilled") setSources(sourceFilesResult.value);
      if (reviewDataResult.status === "fulfilled") setReviews(reviewDataResult.value.reviews);
      if (graphDataResult.status === "fulfilled") {
        setGraphNodes(graphDataResult.value.nodes);
        setGraphEdges(graphDataResult.value.edges);
      }
      const criticalFailure = graphDataResult.status === "rejected" && wikiFilesResult.status === "rejected";
      setError(criticalFailure ? String(graphDataResult.reason) : null);
      setLoading("");
    },
    [activeView, refreshFiles, reviewStatus, t],
  );

  useEffect(() => {
    let alive = true;
    async function boot() {
      try {
        setError(null);
        await refreshHealth();
        await refreshProjects();
      } catch (err) {
        if (!alive) return;
        setLoading("");
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    void boot();
    return () => {
      alive = false;
    };
  }, [refreshHealth, refreshProjects]);

  useEffect(() => {
    if (!selectedProject) return;
    void loadProjectData(selectedProject.id).catch((err) => {
      setLoading("");
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [selectedProject?.id, reviewStatus]);

  useEffect(() => {
    if (!selectedFile || !selectedProject) return;
    let alive = true;
    setFileContent("");
    client
      .fileContent(selectedProject.id, selectedFile)
      .then((value) => {
        if (alive) setFileContent(value.content);
      })
      .catch((err) => {
        if (alive) setFileContent(t("workspace.unableToLoad", { path: selectedFile, error: String(err) }));
      });
    return () => {
      alive = false;
    };
  }, [selectedFile, selectedProject?.id, t]);

  useEffect(() => {
    const next = appHref({
      view: activeView,
      project: selectedProject?.id ?? selectedProjectId,
      path: selectedFile,
      q: searchQuery,
      review: reviewStatus,
    });
    const current = `${window.location.pathname}${window.location.search}`;
    if (next !== current) window.history.replaceState(null, "", next);
  }, [activeView, reviewStatus, searchQuery, selectedFile, selectedProject?.id, selectedProjectId]);

  useEffect(() => {
    function handlePopState() {
      const params = readUrlParams();
      setActiveView(params.view ?? "wiki");
      setSelectedProjectId(params.project ?? "current");
      setSelectedFile(params.path ?? null);
      setSearchQuery(params.q ?? "");
      setReviewStatus(params.review ?? "unresolved");
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const runSearch = useCallback(async () => {
    if (!selectedProject || !searchQuery.trim()) return;
    setLoading(t("search.title"));
    setError(null);
    try {
      const value = await client.search(selectedProject.id, searchQuery, {
        topK: 12,
        includeContent: false,
      });
      setSearchResults(value.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading("");
    }
  }, [searchQuery, selectedProject, t]);

  useEffect(() => {
    if (activeView !== "search" || !searchQuery.trim()) return;
    const timer = window.setTimeout(() => void runSearch(), 350);
    return () => window.clearTimeout(timer);
  }, [activeView, runSearch, searchQuery]);

  const rescanSources = useCallback(async () => {
    if (!selectedProject) return;
    setLoading(t("sources.refreshFolder"));
    setRescanMessage(null);
    setError(null);
    try {
      const result = await client.rescan(selectedProject.id);
      setRescanMessage(JSON.stringify(result.result ?? result, null, 2));
      const [wikiFiles, sourceFiles] = await Promise.all([
        refreshFiles(selectedProject.id, "wiki"),
        refreshFiles(selectedProject.id, "sources"),
      ]);
      setFiles(wikiFiles);
      setSources(sourceFiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading("");
    }
  }, [refreshFiles, selectedProject, t]);

  const runLint = useCallback(async () => {
    if (!selectedProject) return;
    setLoading(t("lint.title"));
    setError(null);
    try {
      const allFiles = await refreshFiles(selectedProject.id, "all");
      const paths = collectTextPaths(allFiles, 80).filter((path) => path.startsWith("wiki/"));
      const contents: Record<string, string> = {};
      await Promise.all(
        paths.map(async (path) => {
          try {
            contents[path] = (await client.fileContent(selectedProject.id, path)).content;
          } catch {
            contents[path] = "";
          }
        }),
      );
      setLintIssues(lintReadOnly(allFiles, contents));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading("");
    }
  }, [refreshFiles, selectedProject, t]);

  const openPath = useCallback(
    (path: string, view: View = "wiki") => {
      setSelectedFile(path);
      setActiveView(view);
      setIsWorkspaceOpen(false);
    },
    [],
  );

  const activateView = useCallback(
    (view: View) => {
      if (view === "wiki" && activeView !== "wiki") setSelectedFile(defaultWikiPath);
      setActiveView(view);
      setIsWorkspaceOpen(false);
      setIsMobileMoreOpen(false);
    },
    [activeView, defaultWikiPath],
  );

  useEffect(() => {
    if (!isMobile) {
      setIsWorkspaceOpen(false);
      setIsMobileMoreOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (!isWorkspaceOpen) return;
    workspaceCloseRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setIsWorkspaceOpen(false);
      workspaceTriggerRef.current?.focus();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isWorkspaceOpen]);

  useEffect(() => {
    const pageTitle = (() => {
      if ((activeView === "wiki" || activeView === "sources") && selectedFile) {
        return fileNameFromPath(selectedFile);
      }
      if (activeView === "search" && searchQuery.trim()) {
        return `${t("search.title")}: ${searchQuery.trim()}`;
      }
      if (activeView === "sources") return t("sources.title");
      if (activeView === "graph") return t("graph.title");
      if (activeView === "review") return t("review.title");
      if (activeView === "lint") return t("lint.title");
      if (activeView === "settings") return t("nav.settings");
      if (activeView === "chat") return t("unsupported.chatTitle");
      const item = navItems.find((navItem) => navItem.id === activeView);
      return item ? t(item.labelKey) : t("app.title");
    })();
    document.title = `${pageTitle} | ${APP_DISPLAY_NAME}`;
  }, [activeView, searchQuery, selectedFile, t]);

  const activeViewLabel = t(navItems.find((navItem) => navItem.id === activeView)?.labelKey ?? "app.title");
  const mobileTitle =
    (activeView === "wiki" || activeView === "sources") && selectedFile
      ? fileNameFromPath(selectedFile)
      : activeView === "search" && searchQuery.trim()
        ? searchQuery.trim()
        : activeViewLabel;

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("nav.skipToContent")}
      </a>
      <aside className="nav-rail" aria-label={t("nav.primary")}>
        <div className="brand-mark" title={APP_DISPLAY_NAME} aria-label={APP_DISPLAY_NAME}>
          <img src="/llm-wiki-logo.jpg" alt="" aria-hidden="true" />
          <span>W</span>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            const label = t(item.labelKey);
            return (
              <a
                className={activeView === item.id ? "nav-button active" : "nav-button"}
                key={item.id}
                href={makeHref({ view: item.id, path: item.id === "wiki" ? defaultWikiPath : selectedFile })}
                title={label}
                aria-label={label}
                onClick={(event) => {
                  if (!shouldHandleInApp(event)) return;
                  event.preventDefault();
                  activateView(item.id);
                }}
              >
                <Icon size={20} strokeWidth={1.8} />
              </a>
            );
          })}
        </nav>
        <StatusDot health={health} />
      </aside>

      <WorkspacePanel
        activeTree={activeTree}
        activeView={activeView}
        idPrefix="desktop"
        makeHref={makeHref}
        onOpen={openPath}
        onProjectChange={setSelectedProjectId}
        onRefresh={() => selectedProject && loadProjectData(selectedProject.id)}
        onViewChange={activateView}
        projects={projects}
        selectedFile={selectedFile}
        defaultWikiPath={defaultWikiPath}
        selectedProject={selectedProject}
        selectedProjectId={selectedProjectId}
      />

      <MobileTopBar
        activeViewLabel={activeViewLabel}
        health={health}
        isMoreOpen={isMobileMoreOpen}
        onOpenFiles={() => setIsWorkspaceOpen(true)}
        onRefresh={() => selectedProject && loadProjectData(selectedProject.id)}
        onToggleMore={() => setIsMobileMoreOpen((value) => !value)}
        title={mobileTitle}
        triggerRef={workspaceTriggerRef}
      />

      <section id="main-content" className="reader-surface" tabIndex={-1}>
        {loading && (
          <div className="inline-status">
            <Loader2 className="spin" size={16} />
            {loading}
          </div>
        )}
        {error && (
          <div className="error-banner">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        )}
        {activeView === "wiki" && (
          <WikiView
            selectedFile={selectedFile}
            content={fileContent}
            files={files}
            sources={sources}
            onOpen={(path) => openPath(path, "wiki")}
            onOpenSource={(path) => openPath(path, "sources")}
            makeHref={makeHref}
            onTagSearch={(tag) => {
              setSearchQuery(tag);
              setActiveView("search");
            }}
          />
        )}
        {activeView === "sources" && (
          <SourcesView
            selectedFile={selectedFile}
            content={fileContent}
            onRescan={rescanSources}
            rescanMessage={rescanMessage}
          />
        )}
        {activeView === "search" && (
          <SearchView
            query={searchQuery}
            setQuery={setSearchQuery}
            results={searchResults}
            onSearch={runSearch}
            onOpen={(path) => openPath(path, "wiki")}
            makeHref={makeHref}
          />
        )}
        {activeView === "graph" && (
          <GraphView
            nodes={graphNodes}
            edges={graphEdges}
            query={searchQuery}
            setQuery={setSearchQuery}
            makeHref={makeHref}
            onOpen={(path) => openPath(path, "wiki")}
            onRefresh={() => selectedProject && loadProjectData(selectedProject.id)}
          />
        )}
        {activeView === "review" && (
          <ReviewView
            reviews={reviews}
            status={reviewStatus}
            setStatus={setReviewStatus}
            onOpen={(path) => openPath(path, "wiki")}
            makeHref={makeHref}
          />
        )}
        {activeView === "lint" && (
          <LintView issues={lintIssues} onRun={runLint} makeHref={makeHref} onOpen={(path) => openPath(path, "wiki")} />
        )}
        {activeView === "chat" && <UnsupportedView title={t("unsupported.chatTitle")} />}
        {activeView === "settings" && (
          <SettingsView
            health={health}
            project={selectedProject}
            files={files}
            sources={sources}
            graphNodes={graphNodes}
            reviews={reviews}
            language={i18n.language}
            onLanguageChange={(language) => void i18n.changeLanguage(language)}
          />
        )}
      </section>

      <MobileWorkspaceDrawer
        activeTree={activeTree}
        activeView={activeView}
        closeRef={workspaceCloseRef}
        idPrefix="mobile"
        isOpen={isWorkspaceOpen}
        makeHref={makeHref}
        onClose={() => {
          setIsWorkspaceOpen(false);
          workspaceTriggerRef.current?.focus();
        }}
        onOpen={openPath}
        onProjectChange={setSelectedProjectId}
        onRefresh={() => selectedProject && loadProjectData(selectedProject.id)}
        onViewChange={activateView}
        projects={projects}
        selectedFile={selectedFile}
        defaultWikiPath={defaultWikiPath}
        selectedProject={selectedProject}
        selectedProjectId={selectedProjectId}
      />

      <MobileBottomNav
        activeView={activeView}
        isMoreOpen={isMobileMoreOpen}
        makeHref={makeHref}
        onViewChange={activateView}
        selectedFile={selectedFile}
        defaultWikiPath={defaultWikiPath}
      />
    </main>
  );
}

function StatusDot({ health }: { health: ApiHealth | null }) {
  const { t } = useTranslation();
  const ok = health?.ok && health.status === "running" && health.enabled !== false;
  return (
    <div
      className="status-dot-wrap"
      title={ok ? t("status.nativeApiReachable") : t("status.nativeApiUnavailable")}
    >
      <span className={ok ? "status-dot ok" : "status-dot bad"} />
    </div>
  );
}

function WorkspacePanel({
  activeTree,
  activeView,
  defaultWikiPath,
  idPrefix,
  makeHref,
  onOpen,
  onProjectChange,
  onRefresh,
  onViewChange,
  projects,
  selectedFile,
  selectedProject,
  selectedProjectId,
}: {
  activeTree: ApiFileNode[];
  activeView: View;
  defaultWikiPath: string | null;
  idPrefix: string;
  makeHref: (params: AppUrlParams) => string;
  onOpen: (path: string, view?: View) => void;
  onProjectChange: (id: string) => void;
  onRefresh: () => void;
  onViewChange: (view: View) => void;
  projects: ApiProject[];
  selectedFile: string | null;
  selectedProject?: ApiProject;
  selectedProjectId: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="workspace-panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">{t("common.project")}</p>
          <h1>{selectedProject?.name ?? t("app.title")}</h1>
        </div>
        <button
          className="icon-action"
          type="button"
          title={t("workspace.refreshFromNativeApi")}
          onClick={onRefresh}
        >
          <RefreshCw size={17} />
        </button>
      </header>

      <label className="sr-only" htmlFor={`${idPrefix}-project-select`}>
        {t("common.project")}
      </label>
      <select
        id={`${idPrefix}-project-select`}
        className="select-input"
        value={selectedProject?.id ?? selectedProjectId}
        onChange={(event) => onProjectChange(event.target.value)}
      >
        {projects.length === 0 && <option value="current">{t("common.current")}</option>}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.current ? t("workspace.currentProjectPrefix") : ""}
            {project.name}
          </option>
        ))}
      </select>

      <div className="tree-tabs" role="tablist" aria-label={t("workspace.fileRoots")}>
        <a
          className={activeView !== "sources" ? "active" : ""}
          href={makeHref({ view: "wiki", path: defaultWikiPath })}
          onClick={(event) => {
            if (!shouldHandleInApp(event)) return;
            event.preventDefault();
            onViewChange("wiki");
          }}
        >
          {t("nav.wiki")}
        </a>
        <a
          className={activeView === "sources" ? "active" : ""}
          href={makeHref({ view: "sources", path: selectedFile })}
          onClick={(event) => {
            if (!shouldHandleInApp(event)) return;
            event.preventDefault();
            onViewChange("sources");
          }}
        >
          {t("nav.sources")}
        </a>
      </div>

      <div className="tree-list">
        <FileTree nodes={activeTree} selectedPath={selectedFile} makeHref={makeHref} onOpen={onOpen} />
      </div>
    </section>
  );
}

function MobileTopBar({
  activeViewLabel,
  health,
  isMoreOpen,
  onOpenFiles,
  onRefresh,
  onToggleMore,
  title,
  triggerRef,
}: {
  activeViewLabel: string;
  health: ApiHealth | null;
  isMoreOpen: boolean;
  onOpenFiles: () => void;
  onRefresh: () => void;
  onToggleMore: () => void;
  title: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <header className="mobile-topbar">
      <button
        ref={triggerRef}
        className="mobile-icon-button"
        type="button"
        aria-label={t("mobile.openFiles")}
        onClick={onOpenFiles}
      >
        <Menu size={19} />
      </button>
      <div className="mobile-title-stack">
        <span>{activeViewLabel}</span>
        <strong>{title}</strong>
      </div>
      <StatusDot health={health} />
      <button
        className="mobile-icon-button"
        type="button"
        aria-label={t("workspace.refreshFromNativeApi")}
        onClick={onRefresh}
      >
        <RefreshCw size={18} />
      </button>
      <button
        className={isMoreOpen ? "mobile-icon-button active" : "mobile-icon-button"}
        type="button"
        aria-expanded={isMoreOpen}
        aria-label={t("mobile.more")}
        onClick={onToggleMore}
      >
        <MoreHorizontal size={19} />
      </button>
    </header>
  );
}

function MobileWorkspaceDrawer({
  activeTree,
  activeView,
  closeRef,
  defaultWikiPath,
  idPrefix,
  isOpen,
  makeHref,
  onClose,
  onOpen,
  onProjectChange,
  onRefresh,
  onViewChange,
  projects,
  selectedFile,
  selectedProject,
  selectedProjectId,
}: {
  activeTree: ApiFileNode[];
  activeView: View;
  closeRef: RefObject<HTMLButtonElement | null>;
  defaultWikiPath: string | null;
  idPrefix: string;
  isOpen: boolean;
  makeHref: (params: AppUrlParams) => string;
  onClose: () => void;
  onOpen: (path: string, view?: View) => void;
  onProjectChange: (id: string) => void;
  onRefresh: () => void;
  onViewChange: (view: View) => void;
  projects: ApiProject[];
  selectedFile: string | null;
  selectedProject?: ApiProject;
  selectedProjectId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={isOpen ? "mobile-workspace-layer open" : "mobile-workspace-layer"} aria-hidden={!isOpen}>
      <button className="mobile-scrim" type="button" aria-label={t("mobile.closeFiles")} onClick={onClose} />
      <aside className="mobile-workspace-drawer" role="dialog" aria-modal="true" aria-label={t("mobile.filesAndProjects")}>
        <header className="mobile-drawer-header">
          <div>
            <p className="eyebrow">{t("mobile.filesAndProjects")}</p>
            <h2>{selectedProject?.name ?? t("app.title")}</h2>
          </div>
          <button ref={closeRef} className="icon-action" type="button" aria-label={t("mobile.closeFiles")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <WorkspacePanel
          activeTree={activeTree}
          activeView={activeView}
          defaultWikiPath={defaultWikiPath}
          idPrefix={idPrefix}
          makeHref={makeHref}
          onOpen={onOpen}
          onProjectChange={onProjectChange}
          onRefresh={onRefresh}
          onViewChange={onViewChange}
          projects={projects}
          selectedFile={selectedFile}
          selectedProject={selectedProject}
          selectedProjectId={selectedProjectId}
        />
      </aside>
    </div>
  );
}

function MobileBottomNav({
  activeView,
  defaultWikiPath,
  isMoreOpen,
  makeHref,
  onViewChange,
  selectedFile,
}: {
  activeView: View;
  defaultWikiPath: string | null;
  isMoreOpen: boolean;
  makeHref: (params: AppUrlParams) => string;
  onViewChange: (view: View) => void;
  selectedFile: string | null;
}) {
  const { t } = useTranslation();
  const primaryItems = navItems.filter((item) => mobilePrimaryNav.includes(item.id));
  const secondaryItems = navItems.filter((item) => mobileSecondaryNav.includes(item.id));
  return (
    <>
      <nav className="mobile-bottom-nav" aria-label={t("nav.primary")}>
        {primaryItems.map((item) => {
          const Icon = item.icon;
          const label = t(item.labelKey);
          return (
            <a
              className={activeView === item.id ? "mobile-tab active" : "mobile-tab"}
              key={item.id}
              href={makeHref({ view: item.id, path: item.id === "wiki" ? defaultWikiPath : selectedFile })}
              aria-current={activeView === item.id ? "page" : undefined}
              onClick={(event) => {
                if (!shouldHandleInApp(event)) return;
                event.preventDefault();
                onViewChange(item.id);
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
            </a>
          );
        })}
      </nav>
      <div className={isMoreOpen ? "mobile-more-menu open" : "mobile-more-menu"}>
        {secondaryItems.map((item) => {
          const Icon = item.icon;
          const label = t(item.labelKey);
          return (
            <a
              className={activeView === item.id ? "active" : ""}
              key={item.id}
              href={makeHref({ view: item.id, path: item.id === "wiki" ? defaultWikiPath : selectedFile })}
              onClick={(event) => {
                if (!shouldHandleInApp(event)) return;
                event.preventDefault();
                onViewChange(item.id);
              }}
            >
              <Icon size={18} />
              {label}
            </a>
          );
        })}
      </div>
    </>
  );
}

function FileTree({
  nodes,
  selectedPath,
  makeHref,
  onOpen,
}: {
  nodes: ApiFileNode[];
  selectedPath: string | null;
  makeHref: (params: AppUrlParams) => string;
  onOpen: (path: string, view?: View) => void;
}) {
  const { t } = useTranslation();
  const treeKey = useMemo(() => treeStateKey(nodes), [nodes]);
  const previousTreeKey = useRef(treeKey);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(findAncestorDirs(nodes, selectedPath)),
  );

  useEffect(() => {
    setExpanded((current) => {
      const ancestors = findAncestorDirs(nodes, selectedPath);
      if (previousTreeKey.current !== treeKey) {
        previousTreeKey.current = treeKey;
        return new Set(ancestors);
      }
      if (ancestors.every((path) => current.has(path))) return current;
      const next = new Set(current);
      for (const path of ancestors) next.add(path);
      return next;
    });
  }, [nodes, selectedPath, treeKey]);

  if (nodes.length === 0) {
    return <p className="muted-text">{t("workspace.noFiles")}</p>;
  }
  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }
  return (
    <>
      {nodes.map((node) => (
        <FileNodeView
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          expanded={expanded}
          makeHref={makeHref}
          onToggle={toggle}
          onOpen={onOpen}
          depth={0}
        />
      ))}
    </>
  );
}

function FileNodeView({
  node,
  selectedPath,
  expanded,
  makeHref,
  onToggle,
  onOpen,
  depth,
}: {
  node: ApiFileNode;
  selectedPath: string | null;
  expanded: Set<string>;
  makeHref: (params: AppUrlParams) => string;
  onToggle: (path: string) => void;
  onOpen: (path: string, view?: View) => void;
  depth: number;
}) {
  const { t } = useTranslation();
  const isExpanded = expanded.has(node.path);
  const hasChildren = Boolean(node.children?.length);
  const targetView: View = node.path.startsWith("raw/sources") ? "sources" : "wiki";
  const rowContent = (
    <>
      {node.isDir && (
        <span className="tree-chevron">
          {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
      )}
      <span>
        <strong>{node.name}</strong>
        <small>{node.path}</small>
      </span>
      <em>{node.isDir ? countDescendantFiles(node) : formatBytes(node.size)}</em>
    </>
  );
  return (
    <div>
      {node.isDir ? (
        <button
          className={selectedPath === node.path ? "tree-row active" : "tree-row"}
          style={{ paddingLeft: 10 + depth * 14 }}
          type="button"
          aria-expanded={isExpanded}
          onClick={() => onToggle(node.path)}
          title={node.path}
        >
          {rowContent}
        </button>
      ) : (
        <a
        className={selectedPath === node.path ? "tree-row active" : "tree-row"}
        style={{ paddingLeft: 10 + depth * 14 }}
        href={makeHref({ view: targetView, path: node.path })}
        onClick={(event) => {
          if (!shouldHandleInApp(event)) return;
          event.preventDefault();
          onOpen(node.path, targetView);
        }}
        title={node.path}
      >
          {rowContent}
        </a>
      )}
      {node.isDir && isExpanded && hasChildren
        ? node.children?.map((child) => (
            <FileNodeView
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              expanded={expanded}
              makeHref={makeHref}
              onToggle={onToggle}
              onOpen={onOpen}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  );
}

function WikiView({
  selectedFile,
  content,
  files,
  sources,
  onOpen,
  onOpenSource,
  makeHref,
  onTagSearch,
}: {
  selectedFile: string | null;
  content: string;
  files: ApiFileNode[];
  sources: ApiFileNode[];
  onOpen: (path: string) => void;
  onOpenSource: (path: string) => void;
  makeHref: (params: AppUrlParams) => string;
  onTagSearch: (tag: string) => void;
}) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parseMarkdownFrontmatter(content), [content]);
  const renderBody = useMemo(() => transformWikilinks(parsed.body), [parsed.body]);

  function handleLinkClick(event: MouseEvent<HTMLAnchorElement>, href?: string) {
    if (!href?.startsWith("#")) return;
    event.preventDefault();
    const rawTarget = (() => {
      try {
        return decodeURIComponent(href.slice(1));
      } catch {
        return href.slice(1);
      }
    })();
    const path = resolveWikiTarget(rawTarget, files);
    if (path) onOpen(path);
  }

  return (
    <article className="view-stack">
      <header className="reader-header wiki-reader-header">
        <div>
          <p className="eyebrow">{t("wiki.reader")}</p>
          <h2>{selectedFile ?? t("wiki.selectPage")}</h2>
        </div>
      </header>
      {selectedFile ? (
        isMarkdown(selectedFile) ? (
          <>
            {parsed.frontmatter && (
              <FrontmatterSummary
                data={parsed.frontmatter}
                files={files}
                sources={sources}
                onOpen={onOpen}
                onOpenSource={onOpenSource}
                makeHref={makeHref}
                onTagSearch={onTagSearch}
              />
            )}
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children, ...props }) => {
                    const isWikilink = typeof href === "string" && href.startsWith("#");
                    const wikiPath = isWikilink
                      ? resolveWikiTarget(
                          (() => {
                            try {
                              return decodeURIComponent(href.slice(1));
                            } catch {
                              return href.slice(1);
                            }
                          })(),
                          files,
                        )
                      : null;
                    return (
                      <a
                        href={wikiPath ? makeHref({ view: "wiki", path: wikiPath }) : href}
                        className={isWikilink ? "wiki-link" : undefined}
                        onClick={(event) => {
                          if (!isWikilink || !shouldHandleInApp(event)) return;
                          handleLinkClick(event, href);
                        }}
                        {...props}
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {renderBody || t("common.loading")}
              </ReactMarkdown>
            </div>
          </>
        ) : (
          <pre className="code-preview">{content || t("common.loading")}</pre>
        )
      ) : (
        <EmptyState title={t("wiki.noPageSelected")} body={t("wiki.choosePage")} />
      )}
    </article>
  );
}

const FRONTMATTER_PRIMARY_KEYS = new Set(["title", "type", "tags", "created", "description", "sources", "related", "origin"]);

function stringMetaValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrayMetaValue(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  return [value.trim()];
}

function FrontmatterSummary({
  data,
  files,
  sources,
  onOpen,
  onOpenSource,
  makeHref,
  onTagSearch,
}: {
  data: Record<string, string | string[]>;
  files: ApiFileNode[];
  sources: ApiFileNode[];
  onOpen: (path: string) => void;
  onOpenSource: (path: string) => void;
  makeHref: (params: AppUrlParams) => string;
  onTagSearch: (tag: string) => void;
}) {
  const title = stringMetaValue(data.title);
  const type = stringMetaValue(data.type);
  const created = stringMetaValue(data.created);
  const description = stringMetaValue(data.description);
  const origin = stringMetaValue(data.origin);
  const tags = arrayMetaValue(data.tags);
  const sourceItems = arrayMetaValue(data.sources);
  const relatedItems = arrayMetaValue(data.related);
  const extras = Object.entries(data).filter(([key, value]) => {
    if (FRONTMATTER_PRIMARY_KEYS.has(key)) return false;
    return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
  });
  const isMobile = useMediaQuery("(max-width: 860px)");
  const { t } = useTranslation();

  if (!title && !type && !created && tags.length === 0 && sourceItems.length === 0 && relatedItems.length === 0 && extras.length === 0) {
    return null;
  }

  return (
    <section className="frontmatter-panel">
      <div className="frontmatter-identity">
        <div className="frontmatter-icon">
          <FileText size={22} />
        </div>
        <div className="frontmatter-main">
          {title && <strong className="frontmatter-title">{title}</strong>}
          <div className="frontmatter-chip-row">
            {type && <span className="frontmatter-type">{type}</span>}
            {created && (
              <span className="frontmatter-muted-chip">
                <Calendar size={13} />
                {created}
              </span>
            )}
            {tags.map((tag) => (
              <a
                className="frontmatter-tag"
                href={makeHref({ view: "search", q: tag, path: null })}
                key={tag}
                onClick={(event) => {
                  if (!shouldHandleInApp(event)) return;
                  event.preventDefault();
                  onTagSearch(tag);
                }}
              >
                <Tag size={13} />
                {tag}
              </a>
            ))}
          </div>
        </div>
      </div>

      {description && <p className="frontmatter-description">{description}</p>}
      {origin && <div className="frontmatter-origin">{origin}</div>}

      {(sourceItems.length > 0 || relatedItems.length > 0 || extras.length > 0) && (
        <details className="frontmatter-details" open={!isMobile}>
          <summary>
            <span>{t("meta.details")}</span>
            <ChevronDown size={15} />
          </summary>
          <div className="frontmatter-details-body">
            {sourceItems.length > 0 && (
              <div className="frontmatter-section">
                <div className="frontmatter-section-title">
                  <Layers size={15} />
                  {t("meta.sources")} <span>({sourceItems.length})</span>
                </div>
                <div className="frontmatter-card-row">
                  {sourceItems.map((source) => {
                    const { slug, label } = unwrapWikiValue(source);
                    const path = resolveSourceTarget(slug, sources);
                    return (
                      <a
                        className={path ? "frontmatter-source-card" : "frontmatter-source-card unresolved"}
                        href={path ? makeHref({ view: "sources", path }) : undefined}
                        key={source}
                        aria-disabled={!path}
                        title={path ? label : t("meta.sourceNotExposed", { label })}
                        onClick={(event) => {
                          if (!path || !shouldHandleInApp(event)) return;
                          event.preventDefault();
                          onOpenSource(path);
                        }}
                      >
                        <FileText size={16} />
                        <span>{label}</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {relatedItems.length > 0 && (
              <div className="frontmatter-section">
                <div className="frontmatter-section-title">
                  <ArrowUpRight size={15} />
                  {t("meta.related")} <span>({relatedItems.length})</span>
                </div>
                <div className="frontmatter-chip-row">
                  {relatedItems.map((related) => {
                    const { slug, label } = unwrapWikiValue(related);
                    const path = resolveWikiTarget(slug, files);
                    return (
                      <a
                        className={path ? "frontmatter-related-chip" : "frontmatter-related-chip unresolved"}
                        href={path ? makeHref({ view: "wiki", path }) : undefined}
                        key={related}
                        aria-disabled={!path}
                        title={path ? label : t("meta.relatedNotFound", { label })}
                        onClick={(event) => {
                          if (!path || !shouldHandleInApp(event)) return;
                          event.preventDefault();
                          onOpen(path);
                        }}
                      >
                        {label}
                        {path && <ArrowUpRight size={12} />}
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {extras.length > 0 && (
              <div className="frontmatter-more">
                <span>{t("meta.more")}</span>
                {extras.map(([key, value]) => (
                  <div key={key}>
                    <code>{key}:</code>
                    <strong>{Array.isArray(value) ? value.join(", ") : value}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

function SourcesView({
  selectedFile,
  content,
  onRescan,
  rescanMessage,
}: {
  selectedFile: string | null;
  content: string;
  onRescan: () => void;
  rescanMessage: string | null;
}) {
  const { t } = useTranslation();
  return (
    <article className="view-stack">
      <header className="reader-header">
        <div>
          <p className="eyebrow">{t("sources.title")}</p>
          <h2>{selectedFile ?? t("sources.browse")}</h2>
        </div>
        <button className="primary-action" type="button" onClick={onRescan}>
          <RefreshCw size={18} />
          {t("sources.refreshFolder")}
        </button>
      </header>
      <div className="notice-box">
        {t("sources.readOnlyNotice")}
      </div>
      {selectedFile ? <pre className="code-preview">{content || t("common.loading")}</pre> : null}
      {rescanMessage && <pre className="code-preview compact">{rescanMessage}</pre>}
    </article>
  );
}

function SearchView({
  query,
  setQuery,
  results,
  onSearch,
  onOpen,
  makeHref,
}: {
  query: string;
  setQuery: (query: string) => void;
  results: ApiSearchResult[];
  onSearch: () => void;
  onOpen: (path: string) => void;
  makeHref: (params: AppUrlParams) => string;
}) {
  const { t } = useTranslation();
  return (
    <article className="view-stack">
      <header className="reader-header">
        <div>
          <p className="eyebrow">{t("search.eyebrow")}</p>
          <h2>{t("search.heading")}</h2>
        </div>
      </header>
      <form
        className="search-row"
        onSubmit={(event) => {
          event.preventDefault();
          void onSearch();
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search.placeholder")}
        />
        <button className="primary-action" type="submit">
          <Search size={18} />
          {t("search.title")}
        </button>
      </form>
      <div className="result-list">
        {results.map((result) => (
          <a
            className="result-row"
            href={makeHref({ view: "wiki", path: result.path })}
            key={result.path}
            onClick={(event) => {
              if (!shouldHandleInApp(event)) return;
              event.preventDefault();
              onOpen(result.path);
            }}
          >
            <strong>{result.title || result.path}</strong>
            <span>{result.snippet}</span>
            <em>
              {result.path} · {t("search.score", { score: result.score.toFixed(2) })}
            </em>
          </a>
        ))}
      </div>
    </article>
  );
}

function ReviewView({
  reviews,
  status,
  setStatus,
  onOpen,
  makeHref,
}: {
  reviews: ApiReviewItem[];
  status: ApiReviewStatus;
  setStatus: (status: ApiReviewStatus) => void;
  onOpen: (path: string) => void;
  makeHref: (params: AppUrlParams) => string;
}) {
  const { t } = useTranslation();
  return (
    <article className="view-stack">
      <header className="reader-header">
        <div>
          <p className="eyebrow">{t("review.title")}</p>
          <h2>{t("review.summary", { count: reviews.length })}</h2>
        </div>
        <select className="select-input narrow" value={status} onChange={(event) => setStatus(event.target.value as ApiReviewStatus)}>
          <option value="unresolved">{t("review.unresolved")}</option>
          <option value="resolved">{t("review.resolved")}</option>
          <option value="all">{t("review.all")}</option>
        </select>
      </header>
      <div className="result-list">
        {reviews.map((item) => (
          <section className="review-row" key={item.id || item.title}>
            <strong>{item.title || item.type}</strong>
            <p>{item.description}</p>
            {item.sourcePath && (
              <a
                className="link-button"
                href={makeHref({ view: "wiki", path: item.sourcePath })}
                onClick={(event) => {
                  if (!shouldHandleInApp(event)) return;
                  event.preventDefault();
                  onOpen(item.sourcePath!);
                }}
              >
                {item.sourcePath}
              </a>
            )}
            <div className="chip-row">
              <span>{item.type || t("review.title")}</span>
              <span>{item.resolved ? t("common.resolved") : t("common.unresolved")}</span>
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

function LintView({
  issues,
  onRun,
  onOpen,
  makeHref,
}: {
  issues: LintIssue[];
  onRun: () => void;
  onOpen: (path: string) => void;
  makeHref: (params: AppUrlParams) => string;
}) {
  const { t } = useTranslation();
  return (
    <article className="view-stack">
      <header className="reader-header">
        <div>
          <p className="eyebrow">{t("lint.title")}</p>
          <h2>{t("lint.heading")}</h2>
        </div>
        <button className="primary-action" type="button" onClick={onRun}>
          <CheckCircle2 size={18} />
          {t("lint.run")}
        </button>
      </header>
      <div className="notice-box">{t("lint.autoFixDisabled")}</div>
      <div className="result-list">
        {issues.map((issue, index) => (
          <a
            className="result-row"
            href={makeHref({ view: "wiki", path: issue.path })}
            key={`${issue.path}-${index}`}
            onClick={(event) => {
              if (!shouldHandleInApp(event)) return;
              event.preventDefault();
              onOpen(issue.path);
            }}
          >
            <strong>{t(`lint.issues.${issue.code}.title`, issue.values)}</strong>
            <span>{t(`lint.issues.${issue.code}.detail`, issue.values)}</span>
            <em>
              {t(`lint.severity.${issue.severity}`)} · {issue.path}
            </em>
          </a>
        ))}
      </div>
    </article>
  );
}

function UnsupportedView({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <article className="view-stack">
      <header className="reader-header">
        <div>
          <p className="eyebrow">{t("unsupported.surface")}</p>
          <h2>{title}</h2>
        </div>
        <span className="status-pill warn">{t("unsupported.waiting")}</span>
      </header>
      <div className="unsupported-grid">
        {unsupportedFeatures.map((feature) => (
          <section key={feature}>
            <CircleSlash size={20} />
            <strong>{t(`unsupported.${feature}.name`)}</strong>
            <p>{t(`unsupported.${feature}.reason`)}</p>
          </section>
        ))}
      </div>
    </article>
  );
}

function SettingsView({
  health,
  project,
  files,
  sources,
  graphNodes,
  reviews,
  language,
  onLanguageChange,
}: {
  health: ApiHealth | null;
  project?: ApiProject;
  files: ApiFileNode[];
  sources: ApiFileNode[];
  graphNodes: ApiGraphNode[];
  reviews: ApiReviewItem[];
  language: string;
  onLanguageChange: (language: string) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery("(max-width: 860px)");
  return (
    <article className="view-stack">
      <header className="reader-header">
        <div>
          <p className="eyebrow">{t("settings.runtimeApi")}</p>
          <h2>{t("settings.proxyStatus")}</h2>
        </div>
      </header>
      <div className="settings-grid">
        <InfoTile label={t("settings.apiStatus")} value={health?.status ?? t("common.unknown")} />
        <InfoTile label={t("settings.apiEnabled")} value={String(health?.enabled ?? t("common.unknown"))} />
        <InfoTile label={t("settings.authRequired")} value={String(health?.authRequired ?? t("common.unknown"))} />
        <InfoTile label={t("settings.tokenSource")} value={health?.tokenSource ?? t("settings.proxyEnvBrowser")} />
        <InfoTile label={t("settings.currentProject")} value={project?.name ?? t("common.none")} />
        <InfoTile label={t("settings.projectPath")} value={project?.path ?? t("common.none")} />
      </div>
      <label className="field-label" htmlFor="language-select">
        {t("app.language")}
      </label>
      <select
        id="language-select"
        className="select-input narrow"
        value={language.startsWith("zh") ? "zh" : "en"}
        onChange={(event) => onLanguageChange(event.target.value)}
      >
        <option value="en">{t("app.english")}</option>
        <option value="zh">{t("app.chinese")}</option>
      </select>
      <DetailsPanel
        health={health}
        project={project}
        files={files}
        sources={sources}
        graphNodes={graphNodes}
        reviews={reviews}
      />
      <details className="settings-json" open={!isMobile}>
        <summary>{t("settings.rawHealth")}</summary>
        <pre className="code-preview compact">{JSON.stringify(health, null, 2)}</pre>
      </details>
    </article>
  );
}

function DetailsPanel({
  health,
  project,
  files,
  sources,
  graphNodes,
  reviews,
}: {
  health: ApiHealth | null;
  project?: ApiProject;
  files: ApiFileNode[];
  sources: ApiFileNode[];
  graphNodes: ApiGraphNode[];
  reviews: ApiReviewItem[];
}) {
  const { t } = useTranslation();
  const wikiCount = flattenFiles(files).filter((node) => !node.isDir).length;
  const sourceCount = flattenFiles(sources).filter((node) => !node.isDir).length;

  return (
    <div className="settings-diagnostics">
      <header className="panel-header compact">
        <div>
          <p className="eyebrow">{t("diagnostics.title")}</p>
          <h2>{t("diagnostics.nativeBridge")}</h2>
        </div>
      </header>
      <div className="detail-list">
        <InfoTile label={t("diagnostics.nativeApi")} value={health?.status ?? t("common.unknown")} />
        <InfoTile
          label={t("common.auth")}
          value={health?.authRequired ? t("common.required") : t("status.openOrUnknown")}
        />
        <InfoTile label={t("common.project")} value={project?.name ?? t("common.none")} />
        <InfoTile label={t("diagnostics.wikiFiles")} value={String(wikiCount)} />
        <InfoTile label={t("diagnostics.sourceFiles")} value={String(sourceCount)} />
        <InfoTile label={t("diagnostics.graphNodes")} value={String(graphNodes.length)} />
        <InfoTile label={t("diagnostics.reviewItems")} value={String(reviews.length)} />
      </div>
      <div className="notice-box small">
        {t("diagnostics.notice")}
      </div>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <section className="info-tile">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <Server size={28} />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
