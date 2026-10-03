import { describe, expect, test } from "bun:test";
import {
  isReflectionMergeResponseCommand,
  isSetReflectionSettingsCommand,
} from "@/websocket/listener/protocol-inbound";

describe("client-approved reflection merge protocol", () => {
  test("accepts merge: client", () => {
    expect(
      isSetReflectionSettingsCommand({
        type: "set_reflection_settings",
        request_id: "r1",
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        settings: { trigger: "step-count", step_count: 3, merge: "client" },
        scope: "local_project",
      }),
    ).toBe(true);
  });

  test("validates merge responses", () => {
    const base = { type: "reflection_merge_response", request_id: "x" };
    expect(
      isReflectionMergeResponseCommand({ ...base, decision: "approve" }),
    ).toBe(true);
    expect(
      isReflectionMergeResponseCommand({
        ...base,
        decision: "reject",
        reason: "no",
      }),
    ).toBe(true);
    expect(
      isReflectionMergeResponseCommand({
        ...base,
        decision: "approve_paths",
        approve_paths: ["a.md"],
      }),
    ).toBe(true);
    expect(
      isReflectionMergeResponseCommand({ ...base, decision: "approve_paths" }),
    ).toBe(false);
    expect(
      isReflectionMergeResponseCommand({
        ...base,
        decision: "approve_edits",
        drop: [{ path: "a.md", start: 2, end: 3, text: "x\ny" }],
      }),
    ).toBe(true);
    expect(
      isReflectionMergeResponseCommand({
        ...base,
        decision: "approve_edits",
        drop: [{ path: "a.md", start: 0, end: 1, text: "" }],
      }),
    ).toBe(false);
    expect(
      isReflectionMergeResponseCommand({ ...base, decision: "approve_edits" }),
    ).toBe(false);
    expect(
      isReflectionMergeResponseCommand({ ...base, decision: "maybe" }),
    ).toBe(false);
    expect(
      isReflectionMergeResponseCommand({
        type: "reflection_merge_response",
        decision: "approve",
      }),
    ).toBe(false);
  });
});
