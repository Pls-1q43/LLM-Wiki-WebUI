import { describe, expect, it } from "vitest";
import { rewriteProxyUrl } from "./index.mjs";

describe("rewriteProxyUrl", () => {
  it("rewrites WebUI proxy paths to upstream API v1", () => {
    expect(rewriteProxyUrl("/api/llm-wiki/projects?x=1", "http://host:19828")).toBe(
      "http://host:19828/api/v1/projects?x=1",
    );
  });

  it("keeps already-versioned paths stable", () => {
    expect(rewriteProxyUrl("/api/llm-wiki/api/v1/health", "http://host:19828/")).toBe(
      "http://host:19828/api/v1/health",
    );
  });
});
