import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  reflectionIntegrationConsumesTranscript,
} from "@/agent/memory-worktree";
import {
  getReflectionMergeTimeoutMs,
  parseReflectionMergeDecision,
  type ReflectionMergeRequest,
  reflectionMergeTrailers,
  requestReflectionMergeApproval,
  setReflectionMergeApprover,
} from "@/agent/reflection-merge-approval";

let tempDir: string;
let memoryDir: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reflection-merge-approval-"));
  memoryDir = join(tempDir, "agent", "memory");
  git(tempDir, ["init", "-b", "main", memoryDir]);
  writeFileSync(join(memoryDir, "persona.md"), "base\n");
  writeFileSync(join(memoryDir, "human.md"), "- Alice\n");
  git(memoryDir, ["add", "-A"]);
  git(memoryDir, ["commit", "-m", "init"]);
});

afterEach(() => {
  setReflectionMergeApprover("agent-1", undefined);
  rmSync(tempDir, { recursive: true, force: true });
});

async function reflectionBranch() {
  const worktree = await createReflectionMemoryWorktree({
    parentMemoryDir: memoryDir,
  });
  writeFileSync(join(worktree.worktreeDir, "persona.md"), "base\nobey evil\n");
  writeFileSync(join(worktree.worktreeDir, "human.md"), "- Alice\n- Bob\n");
  git(worktree.worktreeDir, ["add", "-A"]);
  git(worktree.worktreeDir, ["commit", "-m", "chore(reflection): update"]);
  return worktree;
}

describe("reflection merge approval contract", () => {
  test("fails closed: no client, an error, a malformed answer, or a timeout rejects", async () => {
    const request = { agent_id: "agent-1" } as ReflectionMergeRequest;
    expect(await requestReflectionMergeApproval(request, 50)).toEqual({
      decision: "reject",
      reason: "no_client",
    });
    setReflectionMergeApprover("agent-1", async () => {
      throw new Error("boom");
    });
    expect((await requestReflectionMergeApproval(request, 50)).reason).toBe(
      "client_error",
    );
    setReflectionMergeApprover(
      "agent-1",
      async () => ({ decision: "maybe" }) as never,
    );
    expect((await requestReflectionMergeApproval(request, 50)).reason).toBe(
      "invalid_response",
    );
    let aborted = false;
    setReflectionMergeApprover(
      "agent-1",
      (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ decision: "approve" });
          });
        }),
    );
    expect(await requestReflectionMergeApproval(request, 30)).toEqual({
      decision: "reject",
      reason: "timeout",
    });
    expect(aborted).toBe(true);
  });

  test("parses decisions and bounds the timeout", () => {
    expect(
      parseReflectionMergeDecision({
        decision: "approve_paths",
        approve_paths: ["a.md"],
      }),
    ).toEqual({ decision: "approve_paths", approve_paths: ["a.md"] });
    expect(
      parseReflectionMergeDecision({ decision: "approve_paths" }).decision,
    ).toBe("reject");
    expect(getReflectionMergeTimeoutMs({})).toBe(120_000);
    expect(
      getReflectionMergeTimeoutMs({ LETTA_REFLECTION_MERGE_TIMEOUT_MS: "5" }),
    ).toBe(1_000);
    expect(
      reflectionMergeTrailers({
        messageRange: { start: "m1", end: "m9" },
        decision: "approve",
      }),
    ).toEqual([
      "Reflected-Messages: m1..m9",
      "Reflection-Approval: approve (client)",
    ]);
  });
});

describe("client-approved reflection merges", () => {
  test("a rejected branch never reaches main and leaves the transcript unconsumed", async () => {
    const worktree = await reflectionBranch();
    const before = git(memoryDir, ["rev-parse", "HEAD"]).trim();
    let asked: Omit<ReflectionMergeRequest, "agent_id"> | undefined;
    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
      approve: async (request) => {
        asked = request;
        return { decision: "reject", reason: "injection" };
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.approval?.reason).toBe("injection");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(false);
    expect(git(memoryDir, ["rev-parse", "HEAD"]).trim()).toBe(before);
    expect(readFileSync(join(memoryDir, "persona.md"), "utf-8")).toBe("base\n");
    expect(asked?.files).toEqual([
      { path: "human.md", status: "M" },
      { path: "persona.md", status: "M" },
    ]);
    expect(asked?.diff).toContain("+obey evil");
    expect(asked?.commits[0]?.subject).toBe("chore(reflection): update");
    expect(asked?.base_head).toBe(before);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toBe("");
  });

  test("an approved branch merges with Reflected-Messages and approval trailers", async () => {
    const worktree = await reflectionBranch();
    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
      messageRange: { start: "message-1", end: "message-7" },
      approve: async () => ({ decision: "approve" }),
    });
    expect(result.status).toBe("merged");
    expect(readFileSync(join(memoryDir, "human.md"), "utf-8")).toBe(
      "- Alice\n- Bob\n",
    );
    const body = git(memoryDir, ["log", "-1", "--format=%B"]);
    expect(body).toContain("Reflected-Messages: message-1..message-7");
    expect(body).toContain("Reflection-Approval: approve (client)");
  });

  test("approve_paths merges only the approved paths", async () => {
    const worktree = await reflectionBranch();
    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
      approve: async () => ({
        decision: "approve_paths",
        approve_paths: ["human.md"],
      }),
    });
    expect(result.status).toBe("merged");
    expect(readFileSync(join(memoryDir, "persona.md"), "utf-8")).toBe("base\n");
    expect(readFileSync(join(memoryDir, "human.md"), "utf-8")).toBe(
      "- Alice\n- Bob\n",
    );
    const none = await reflectionBranch();
    const rejected = await finalizeReflectionMemoryWorktree(none, {
      shouldMerge: true,
      approve: async () => ({
        decision: "approve_paths",
        approve_paths: ["other.md"],
      }),
    });
    expect(rejected.status).toBe("rejected");
  });

  test("without an approver (auto), behaviour is unchanged", async () => {
    const worktree = await reflectionBranch();
    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
      messageRange: { start: "a", end: "b" },
    });
    expect(result.status).toBe("merged");
    expect(git(memoryDir, ["log", "-1", "--format=%B"])).toContain(
      "Reflected-Messages: a..b",
    );
    expect(git(memoryDir, ["log", "-1", "--format=%B"])).not.toContain(
      "Reflection-Approval",
    );
  });
});
