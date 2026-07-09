import type { ApiChatImage, ApiChatReference, ApiChatToolEvent } from "./api-client";

export type ChatHistoryRole = "user" | "assistant" | "system";

export interface ChatHistoryMessage {
  id: string;
  role: ChatHistoryRole;
  content: string;
  images?: ApiChatImage[];
  references?: ApiChatReference[];
  toolEvents?: ApiChatToolEvent[];
  usage?: {
    promptChars?: number;
    completionChars?: number;
    referenceCount?: number;
    toolEventCount?: number;
  };
}

export interface ChatHistoryEntry {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface ParsedChatHistoryExport {
  projectId?: string;
  entry: ChatHistoryEntry;
  messages: ChatHistoryMessage[];
}

export interface ImportChatHistoryResult {
  entry: ChatHistoryEntry;
  originalSessionId: string;
  conflict: boolean;
}

export const CHAT_STORAGE_PREFIX = "llm-wiki-webui:chat:";
export const CHAT_INDEX_STORAGE_PREFIX = "llm-wiki-webui:chat-index:";
export const MAX_STORED_CHAT_MESSAGES = 40;

export function chatStorageKey(projectId: string, sessionId: string) {
  return `${CHAT_STORAGE_PREFIX}${projectId}:${sessionId}`;
}

export function chatIndexStorageKey(projectId: string) {
  return `${CHAT_INDEX_STORAGE_PREFIX}${projectId}`;
}

export function parseStoredChat(raw: string | null): ChatHistoryMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item, index) => ({
        id: typeof item.id === "string" ? item.id : `msg_migrated_${index}`,
        role: item.role === "assistant" || item.role === "system" ? item.role : "user",
        content: typeof item.content === "string" ? item.content : "",
        images: Array.isArray(item.images) ? item.images : undefined,
        references: Array.isArray(item.references) ? item.references : undefined,
        toolEvents: Array.isArray(item.toolEvents) ? item.toolEvents : undefined,
        usage: item.usage && typeof item.usage === "object" ? item.usage : undefined,
      }))
      .slice(-MAX_STORED_CHAT_MESSAGES);
  } catch {
    return [];
  }
}

export function loadStoredChat(storage: Storage, projectId: string, sessionId: string): ChatHistoryMessage[] {
  return parseStoredChat(storage.getItem(chatStorageKey(projectId, sessionId)));
}

export function saveStoredChat(storage: Storage, projectId: string, sessionId: string, messages: ChatHistoryMessage[]) {
  storage.setItem(chatStorageKey(projectId, sessionId), JSON.stringify(messages.slice(-MAX_STORED_CHAT_MESSAGES)));
}

export function loadChatHistoryIndex(storage: Storage, projectId: string): ChatHistoryEntry[] {
  try {
    const raw = storage.getItem(chatIndexStorageKey(projectId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object" && typeof item.sessionId === "string")
      .map((item) => ({
        sessionId: item.sessionId,
        title: typeof item.title === "string" ? item.title : "",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
        messageCount: typeof item.messageCount === "number" ? item.messageCount : 0,
        preview: typeof item.preview === "string" ? item.preview : "",
      }));
  } catch {
    return [];
  }
}

export function saveChatHistoryIndex(storage: Storage, projectId: string, entries: ChatHistoryEntry[]) {
  const deduped = new Map<string, ChatHistoryEntry>();
  for (const entry of entries) {
    if (!entry.sessionId) continue;
    deduped.set(entry.sessionId, entry);
  }
  storage.setItem(
    chatIndexStorageKey(projectId),
    JSON.stringify(
      Array.from(deduped.values()).sort(
        (left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""),
      ),
    ),
  );
}

export function deriveChatHistoryEntry(
  sessionId: string,
  messages: ChatHistoryMessage[],
  existing?: ChatHistoryEntry,
  now = new Date(),
): ChatHistoryEntry {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  const lastContent = [...messages].reverse().find((message) => message.content.trim())?.content.trim() ?? "";
  const fallbackTitle = firstUser?.content.trim() || lastContent || sessionId;
  const updatedAt = now.toISOString();
  return {
    sessionId,
    title: existing?.title?.trim() || truncateSingleLine(fallbackTitle, 48),
    createdAt: existing?.createdAt || updatedAt,
    updatedAt,
    messageCount: messages.length,
    preview: truncateSingleLine(lastContent || fallbackTitle, 96),
  };
}

export function upsertChatHistoryEntry(
  storage: Storage,
  projectId: string,
  sessionId: string,
  messages: ChatHistoryMessage[],
  now = new Date(),
) {
  if (messages.length === 0) return loadChatHistoryIndex(storage, projectId);
  const entries = loadChatHistoryIndex(storage, projectId);
  const existing = entries.find((entry) => entry.sessionId === sessionId);
  const next = deriveChatHistoryEntry(sessionId, messages, existing, now);
  const merged = [next, ...entries.filter((entry) => entry.sessionId !== sessionId)];
  saveChatHistoryIndex(storage, projectId, merged);
  return loadChatHistoryIndex(storage, projectId);
}

export function scanChatHistory(storage: Storage, projectId: string, now = new Date()): ChatHistoryEntry[] {
  const entries = new Map(loadChatHistoryIndex(storage, projectId).map((entry) => [entry.sessionId, entry]));
  const prefix = `${CHAT_STORAGE_PREFIX}${projectId}:`;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const sessionId = key.slice(prefix.length);
    const messages = parseStoredChat(storage.getItem(key));
    if (messages.length === 0) continue;
    entries.set(sessionId, deriveChatHistoryEntry(sessionId, messages, entries.get(sessionId), now));
  }
  const value = Array.from(entries.values()).filter((entry) => entry.messageCount > 0);
  saveChatHistoryIndex(storage, projectId, value);
  return loadChatHistoryIndex(storage, projectId);
}

export function renameChatHistoryEntry(storage: Storage, projectId: string, sessionId: string, title: string) {
  const entries = loadChatHistoryIndex(storage, projectId);
  saveChatHistoryIndex(
    storage,
    projectId,
    entries.map((entry) => (entry.sessionId === sessionId ? { ...entry, title: title.trim() || entry.title } : entry)),
  );
  return loadChatHistoryIndex(storage, projectId);
}

export function deleteChatHistoryEntry(storage: Storage, projectId: string, sessionId: string) {
  storage.removeItem(chatStorageKey(projectId, sessionId));
  const entries = loadChatHistoryIndex(storage, projectId).filter((entry) => entry.sessionId !== sessionId);
  saveChatHistoryIndex(storage, projectId, entries);
  return entries;
}

export function exportChatHistoryMarkdown(projectId: string, entry: ChatHistoryEntry, messages: ChatHistoryMessage[]) {
  const lines = [
    "---",
    `projectId: ${yamlQuote(projectId)}`,
    `sessionId: ${yamlQuote(entry.sessionId)}`,
    `title: ${yamlQuote(entry.title)}`,
    `createdAt: ${yamlQuote(entry.createdAt)}`,
    `updatedAt: ${yamlQuote(entry.updatedAt)}`,
    `exportedAt: ${yamlQuote(new Date().toISOString())}`,
    `messageCount: ${messages.length}`,
    `storage: ${yamlQuote("Browser localStorage only; not persisted in native LLM Wiki.")}`,
    "---",
    "",
    `# ${entry.title || entry.sessionId}`,
    "",
    "> This WebUI chat export comes from browser localStorage only. It is not stored in native LLM Wiki and does not sync across devices.",
    "",
  ];
  for (const message of messages) {
    lines.push(`## ${roleLabel(message.role)}`, "");
    if (message.content.trim()) lines.push(message.content.trim(), "");
    if (message.references?.length) {
      lines.push("### References", "");
      for (const reference of message.references) {
        lines.push(`- ${reference.title || reference.path} (${reference.kind}${reference.score !== undefined ? `, ${reference.score}` : ""})`);
      }
      lines.push("");
    }
    if (message.toolEvents?.length) {
      lines.push("### Tool events", "");
      for (const event of message.toolEvents) {
        lines.push(`- ${event.tool}: ${event.status}${event.detail ? ` (${event.detail})` : ""}`);
      }
      lines.push("");
    }
    if (message.usage) {
      lines.push("### Usage", "");
      lines.push(`- promptChars: ${message.usage.promptChars ?? 0}`);
      lines.push(`- completionChars: ${message.usage.completionChars ?? 0}`);
      lines.push(`- referenceCount: ${message.usage.referenceCount ?? message.references?.length ?? 0}`);
      lines.push("");
    }
  }
  lines.push("## Raw record", "", "```json", JSON.stringify(messages, null, 2), "```", "");
  return lines.join("\n");
}

export function chatHistoryExportFilename(entry: ChatHistoryEntry) {
  const title = slugifyFilename(entry.title || "chat");
  return `llm-wiki-chat-${title}-${slugifyFilename(entry.sessionId)}.md`;
}

export function parseChatHistoryMarkdown(markdown: string, now = new Date()): ParsedChatHistoryExport {
  const frontmatter = parseFrontmatter(markdown);
  const rawJson = extractRawRecordJson(markdown);
  const messages = parseStoredChat(rawJson);
  if (messages.length === 0) {
    throw new Error("Chat export does not contain a valid raw message record.");
  }
  const sessionId = frontmatter.sessionId || `imported_${now.getTime().toString(36)}`;
  const createdAt = frontmatter.createdAt || now.toISOString();
  const updatedAt = frontmatter.updatedAt || createdAt;
  const derived = deriveChatHistoryEntry(sessionId, messages, undefined, new Date(updatedAt));
  return {
    projectId: frontmatter.projectId,
    entry: {
      ...derived,
      title: frontmatter.title || derived.title,
      createdAt,
      updatedAt,
    },
    messages,
  };
}

export function importChatHistoryExport(
  storage: Storage,
  targetProjectId: string,
  parsed: ParsedChatHistoryExport,
  sessionIdFactory: () => string,
): ImportChatHistoryResult {
  const existing = loadChatHistoryIndex(storage, targetProjectId);
  const originalSessionId = parsed.entry.sessionId;
  const conflict =
    storage.getItem(chatStorageKey(targetProjectId, originalSessionId)) !== null ||
    existing.some((entry) => entry.sessionId === originalSessionId);
  const sessionId = conflict ? uniqueSessionId(storage, targetProjectId, sessionIdFactory) : originalSessionId;
  const entry = { ...parsed.entry, sessionId };
  saveStoredChat(storage, targetProjectId, sessionId, parsed.messages);
  saveChatHistoryIndex(storage, targetProjectId, [entry, ...existing.filter((item) => item.sessionId !== sessionId)]);
  return { entry, originalSessionId, conflict };
}

function roleLabel(role: ChatHistoryRole) {
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  return "User";
}

function truncateSingleLine(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function yamlQuote(value: string) {
  return JSON.stringify(value);
}

function parseFrontmatter(markdown: string) {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const values: Record<string, string> = {};
  if (!match) return values;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!item) continue;
    const rawValue = item[2].trim();
    try {
      values[item[1]] = JSON.parse(rawValue);
    } catch {
      values[item[1]] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
  return values;
}

function extractRawRecordJson(markdown: string) {
  const rawSection = markdown.match(/##\s+Raw record[\s\S]*?```json\s*([\s\S]*?)```/i);
  if (rawSection) return rawSection[1].trim();
  const jsonBlocks = [...markdown.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  if (jsonBlocks.length === 0) throw new Error("Chat export is missing a raw JSON record.");
  return jsonBlocks[jsonBlocks.length - 1];
}

function uniqueSessionId(storage: Storage, projectId: string, sessionIdFactory: () => string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sessionId = sessionIdFactory();
    if (storage.getItem(chatStorageKey(projectId, sessionId)) === null) return sessionId;
  }
  return `imported_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugifyFilename(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "chat";
}
