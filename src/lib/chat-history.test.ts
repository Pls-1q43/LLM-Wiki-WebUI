import { describe, expect, it } from "vitest";
import {
  chatHistoryExportFilename,
  chatStorageKey,
  deleteChatHistoryEntry,
  exportChatHistoryMarkdown,
  importChatHistoryExport,
  loadChatHistoryIndex,
  loadStoredChat,
  parseChatHistoryMarkdown,
  renameChatHistoryEntry,
  saveStoredChat,
  scanChatHistory,
  upsertChatHistoryEntry,
  type ChatHistoryMessage,
} from "./chat-history";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const messages: ChatHistoryMessage[] = [
  { id: "u1", role: "user", content: "Tell me about [[overview]]." },
  {
    id: "a1",
    role: "assistant",
    content: "Read [[overview]].",
    references: [{ kind: "wiki", title: "overview.md", path: "wiki/overview.md", score: 0.98 }],
    toolEvents: [{ tool: "llm.generate", status: "completed" }],
    usage: { promptChars: 10, completionChars: 20, referenceCount: 1 },
  },
];

describe("chat history persistence", () => {
  it("migrates legacy per-session chat storage into a project index", () => {
    const storage = new MemoryStorage();
    storage.setItem(chatStorageKey("p1", "s1"), JSON.stringify(messages));

    const entries = scanChatHistory(storage, "p1", new Date("2026-07-09T10:00:00.000Z"));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: "s1",
      messageCount: 2,
      preview: "Read [[overview]].",
    });
    expect(loadChatHistoryIndex(storage, "p1")).toHaveLength(1);
  });

  it("updates metadata when messages are saved", () => {
    const storage = new MemoryStorage();
    saveStoredChat(storage, "p1", "s1", messages);

    const entries = upsertChatHistoryEntry(storage, "p1", "s1", messages, new Date("2026-07-09T10:00:00.000Z"));

    expect(entries[0].title).toBe("Tell me about [[overview]].");
    expect(entries[0].updatedAt).toBe("2026-07-09T10:00:00.000Z");
    expect(entries[0].messageCount).toBe(2);
  });

  it("renames and deletes a local-only chat record", () => {
    const storage = new MemoryStorage();
    saveStoredChat(storage, "p1", "s1", messages);
    upsertChatHistoryEntry(storage, "p1", "s1", messages);

    expect(renameChatHistoryEntry(storage, "p1", "s1", "Research chat")[0].title).toBe("Research chat");
    expect(deleteChatHistoryEntry(storage, "p1", "s1")).toHaveLength(0);
    expect(storage.getItem(chatStorageKey("p1", "s1"))).toBeNull();
  });

  it("exports readable markdown plus raw JSON", () => {
    const entry = {
      sessionId: "s1",
      title: "Research chat",
      createdAt: "2026-07-09T10:00:00.000Z",
      updatedAt: "2026-07-09T10:01:00.000Z",
      messageCount: 2,
      preview: "Read [[overview]].",
    };

    const markdown = exportChatHistoryMarkdown("p1", entry, messages);

    expect(markdown).toContain('projectId: "p1"');
    expect(markdown).toContain("Browser localStorage only");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("Tell me about [[overview]].");
    expect(markdown).toContain("## Raw record");
    expect(markdown).toContain('"toolEvents"');
    expect(chatHistoryExportFilename(entry)).toBe("llm-wiki-chat-Research-chat-s1.md");
  });

  it("imports an exported markdown record losslessly", () => {
    const storage = new MemoryStorage();
    const entry = {
      sessionId: "s1",
      title: "Research chat",
      createdAt: "2026-07-09T10:00:00.000Z",
      updatedAt: "2026-07-09T10:01:00.000Z",
      messageCount: 2,
      preview: "Read [[overview]].",
    };
    const markdown = exportChatHistoryMarkdown("p1", entry, messages);
    const parsed = parseChatHistoryMarkdown(markdown, new Date("2026-07-09T11:00:00.000Z"));

    const result = importChatHistoryExport(storage, "p1", parsed, () => "new-session");

    expect(result.conflict).toBe(false);
    expect(result.entry.sessionId).toBe("s1");
    expect(loadStoredChat(storage, "p1", "s1")).toEqual(messages);
    expect(loadChatHistoryIndex(storage, "p1")[0].title).toBe("Research chat");
  });

  it("imports with a new session id instead of overwriting conflicts", () => {
    const storage = new MemoryStorage();
    saveStoredChat(storage, "p1", "s1", [{ id: "existing", role: "user", content: "keep me" }]);
    upsertChatHistoryEntry(storage, "p1", "s1", [{ id: "existing", role: "user", content: "keep me" }]);
    const markdown = exportChatHistoryMarkdown(
      "p1",
      {
        sessionId: "s1",
        title: "Imported chat",
        createdAt: "2026-07-09T10:00:00.000Z",
        updatedAt: "2026-07-09T10:01:00.000Z",
        messageCount: 2,
        preview: "Read [[overview]].",
      },
      messages,
    );

    const result = importChatHistoryExport(storage, "p1", parseChatHistoryMarkdown(markdown), () => "s2");

    expect(result.conflict).toBe(true);
    expect(result.entry.sessionId).toBe("s2");
    expect(loadStoredChat(storage, "p1", "s1")[0].content).toBe("keep me");
    expect(loadStoredChat(storage, "p1", "s2")).toEqual(messages);
  });
});
