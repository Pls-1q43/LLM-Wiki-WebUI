import { describe, expect, it } from "vitest";
import type { ApiFileNode } from "./lib/api-client";
import { resolveWikiTarget, transformWikilinks } from "./lib/wiki-links";

describe("wiki link helpers", () => {
  it("turns markdown wikilinks into hash links while preserving code spans", () => {
    expect(transformWikilinks("See [[丰饶经济学]] and [[wiki/overview|Overview]].")).toBe(
      "See [丰饶经济学](#%E4%B8%B0%E9%A5%B6%E7%BB%8F%E6%B5%8E%E5%AD%A6) and [Overview](#wiki%2Foverview).",
    );
    expect(transformWikilinks("Do not touch `[[inline]]` or ```\n[[block]]\n```.")).toBe(
      "Do not touch `[[inline]]` or ```\n[[block]]\n```.",
    );
  });

  it("resolves chat wikilink targets to exposed wiki markdown paths", () => {
    const files: ApiFileNode[] = [
      {
        name: "wiki",
        path: "wiki",
        isDir: true,
        children: [
          { name: "overview.md", path: "wiki/overview.md", isDir: false },
          { name: "丰饶经济学.md", path: "wiki/concepts/丰饶经济学.md", isDir: false },
        ],
      },
    ];

    expect(resolveWikiTarget("丰饶经济学", files)).toBe("wiki/concepts/丰饶经济学.md");
    expect(resolveWikiTarget("wiki/overview.md", files)).toBe("wiki/overview.md");
    expect(resolveWikiTarget("missing", files)).toBeNull();
  });
});
