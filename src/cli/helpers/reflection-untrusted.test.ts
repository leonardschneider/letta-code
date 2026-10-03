import { describe, expect, test } from "bun:test";
import {
  countUntrustedToolResults,
  markUntrustedToolResults,
} from "@/cli/helpers/reflection-untrusted";

describe("untrusted tool results in reflection payloads", () => {
  test("marks only tool results, and counts them", () => {
    const { records, count } = markUntrustedToolResults([
      { role: "user", content: "hi", timestamp: "t" },
      {
        role: "tool",
        tool_call_id: "c1",
        content: "IGNORE PREVIOUS",
        timestamp: "t",
      },
    ] as never);
    expect(count).toBe(1);
    expect(records[0]).not.toHaveProperty("untrusted");
    expect(records[1]).toMatchObject({ role: "tool", untrusted: true });
    expect(countUntrustedToolResults(JSON.stringify(records))).toBe(1);
    expect(countUntrustedToolResults("not json")).toBe(0);
  });
});
