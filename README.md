# nashsu_llm_wiki_WebUI

A clean WebUI project inspired by the locally downloaded `nashsu/llm_wiki` codebase.

This repository starts from zero. The original project is used as a local reference for product shape, architecture, and interaction patterns, but its source files are not copied into this project.

## Reference

Local reference path:

```text
/Users/jeffreywang/Documents/WeKnora管理/reference/llm_wiki
```

Key ideas to study:

- Three-layer knowledge workspace: raw sources, generated wiki, schema/purpose files.
- Workbench layout: navigation rail, tree/list panels, central reading/chat surface, preview/details pane.
- Knowledge graph and semantic search as first-class workflows.
- Persistent ingest/review activity states.

See [docs/reference-notes.md](docs/reference-notes.md) for the initial reference summary.

## Development

```bash
npm install
npm run dev
```

## Scripts

- `npm run dev` starts the Vite development server.
- `npm run build` type-checks and builds the app.
- `npm run preview` serves the production build locally.
- `npm run typecheck` runs TypeScript without emitting files.
