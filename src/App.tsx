import {
  Activity,
  BookOpen,
  Brain,
  FileSearch,
  GitBranch,
  Inbox,
  MessageSquare,
  Settings,
} from "lucide-react";

const navItems = [
  { label: "Wiki", icon: BookOpen, active: true },
  { label: "Sources", icon: Inbox },
  { label: "Search", icon: FileSearch },
  { label: "Graph", icon: GitBranch },
  { label: "Review", icon: Activity },
  { label: "Chat", icon: MessageSquare },
  { label: "Settings", icon: Settings },
];

const samplePages = [
  { title: "index.md", type: "Catalog", updated: "Ready" },
  { title: "purpose.md", type: "Direction", updated: "Draft" },
  { title: "schema.md", type: "Rules", updated: "Draft" },
  { title: "overview.md", type: "Summary", updated: "Pending" },
];

const activityItems = [
  "Design web-first project model",
  "Map reference workflows to API contracts",
  "Prototype source traceability panel",
];

export function App() {
  return (
    <main className="app-shell">
      <aside className="nav-rail" aria-label="Primary navigation">
        <div className="brand-mark">LW</div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;

            return (
              <button
                className={item.active ? "nav-button active" : "nav-button"}
                key={item.label}
                type="button"
                title={item.label}
                aria-label={item.label}
              >
                <Icon size={20} strokeWidth={1.8} />
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="workspace-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>LLM Wiki WebUI</h1>
          </div>
          <span className="status-pill">New project</span>
        </header>

        <div className="tree-list">
          {samplePages.map((page) => (
            <button className="tree-row" key={page.title} type="button">
              <span>
                <strong>{page.title}</strong>
                <small>{page.type}</small>
              </span>
              <em>{page.updated}</em>
            </button>
          ))}
        </div>
      </section>

      <section className="reader-surface">
        <header className="reader-header">
          <div>
            <p className="eyebrow">Reference-informed blank slate</p>
            <h2>Build the browser-first knowledge workbench here.</h2>
          </div>
          <button className="primary-action" type="button">
            <Brain size={18} strokeWidth={1.9} />
            Plan ingest flow
          </button>
        </header>

        <article className="content-flow">
          <h3>Starting principles</h3>
          <p>
            This project begins cleanly while using the local llm_wiki codebase
            as a product and architecture reference. The first WebUI milestone
            should define source ingestion, wiki page browsing, graph discovery,
            and review states behind browser-friendly APIs.
          </p>

          <div className="metric-grid">
            <section>
              <span>Mode</span>
              <strong>Web-first</strong>
            </section>
            <section>
              <span>Reference</span>
              <strong>Local only</strong>
            </section>
            <section>
              <span>State</span>
              <strong>Scaffolded</strong>
            </section>
          </div>
        </article>
      </section>

      <aside className="detail-panel">
        <header className="panel-header compact">
          <div>
            <p className="eyebrow">Activity</p>
            <h2>Next Work</h2>
          </div>
        </header>
        <ol className="activity-list">
          {activityItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </aside>
    </main>
  );
}
