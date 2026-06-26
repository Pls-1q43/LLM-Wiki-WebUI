# Reference Notes

These notes summarize the local `nashsu/llm_wiki` reference without copying its implementation.

## Source

- Local path: `/Users/jeffreywang/Documents/WeKnora管理/reference/llm_wiki`
- Stack observed: React, Vite, TypeScript, Tauri, Zustand, graphology/sigma, Milkdown, i18next.
- Product focus: a desktop knowledge-base app that ingests raw sources, generates wiki pages, links them, and exposes search, graph, lint, review, and research workflows.

## Ideas To Carry Forward

- Treat the WebUI as a dense workbench, not a landing page.
- Keep navigation persistent and predictable.
- Separate source ingestion, wiki reading/editing, graph exploration, search, and review as distinct modes.
- Model activity state explicitly so long-running ingest and review tasks can be monitored.
- Preserve source traceability in the UI whenever generated wiki content is shown.

## Initial WebUI Direction

This new project should begin as a browser-first interface. Desktop-specific pieces such as Tauri commands, local filesystem access, and bundled MCP server code should be redesigned behind web-friendly APIs rather than copied directly.
