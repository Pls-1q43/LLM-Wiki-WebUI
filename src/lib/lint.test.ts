import { describe, expect, it } from "vitest";
import { lintReadOnly } from "./lint";

describe("lintReadOnly", () => {
  it("detects missing headings and dangling wikilinks", () => {
    const issues = lintReadOnly(
      [
        { name: "index.md", path: "wiki/index.md", isDir: false },
        { name: "topic.md", path: "wiki/topic.md", isDir: false },
      ],
      {
        "wiki/index.md": "No heading\n\n[[Missing Page]]",
        "wiki/topic.md": "# Topic",
      },
    );

    expect(issues.map((issue) => issue.title)).toContain("Missing H1");
    expect(issues.map((issue) => issue.title)).toContain("Possible dangling wikilink");
  });
});
