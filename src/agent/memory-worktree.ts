import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { getAuthToken } from "@/agent/memory-auth";
import { runGit as runMemoryGit } from "@/agent/memory-git";
import { GIT_DISABLE_COMMIT_SIGNING_ARGS } from "@/agent/memory-git-signing";
import { withMemoryOperation } from "@/agent/memory-operation";
import {
  type ReflectionMergeDecision,
  type ReflectionMergeRequest,
  reflectionMergeTrailers,
} from "@/agent/reflection-merge-approval";
import { getMemfsServerUrl } from "@/backend/api/memfs-git-proxy";
import { debugLog } from "@/utils/debug";

const execFile = promisify(execFileCb);

const GIT_TIMEOUT_MS = 30_000;
const HARNESS_GIT_ENV = {
  GIT_AUTHOR_NAME: "Letta Code",
  GIT_AUTHOR_EMAIL: "noreply@letta.com",
  GIT_COMMITTER_NAME: "Letta Code",
  GIT_COMMITTER_EMAIL: "noreply@letta.com",
};

interface GitResult {
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const allArgs = [...GIT_DISABLE_COMMIT_SIGNING_ARGS, ...args];
    const { stdout, stderr } = await execFile("git", allArgs, {
      cwd,
      env: {
        ...process.env,
        ...HARNESS_GIT_ENV,
      },
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 5,
    });
    return {
      stdout: stdout?.toString() ?? "",
      stderr: stderr?.toString() ?? "",
    };
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    const details = [err.message, err.stderr, err.stdout]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n");
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}${details ? `: ${details}` : ""}`,
    );
  }
}

async function tryRunGit(
  cwd: string,
  args: string[],
): Promise<GitResult | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

function normalizeGitPath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function buildReflectionWorktreeId(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function summarizeReflectionCommitSubject(subject: string): string {
  const summary = subject
    .trim()
    .replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "")
    .trim();
  return summary || "reflection memory updates";
}

async function buildReflectionMergeMessage(
  parentMemoryDir: string,
  branchName: string,
): Promise<string> {
  const result = await tryRunGit(parentMemoryDir, [
    "log",
    "-1",
    "--pretty=%s",
    branchName,
  ]);
  const summary = summarizeReflectionCommitSubject(result?.stdout ?? "");
  return `merge(reflection): ${summary}`;
}

export interface ReflectionMemoryWorktree {
  id: string;
  parentMemoryDir: string;
  worktreeBaseDir: string;
  worktreeDir: string;
  branchName: string;
  baseHead: string;
  gitCommonDir: string;
}

export interface CreateReflectionMemoryWorktreeOptions {
  parentMemoryDir: string;
  now?: Date;
  /** Directory and branch prefix; memory workers use "memory-worker". */
  label?: string;
}

export async function createReflectionMemoryWorktree(
  options: CreateReflectionMemoryWorktreeOptions,
): Promise<ReflectionMemoryWorktree> {
  const parentMemoryDir = resolve(options.parentMemoryDir);
  const id = buildReflectionWorktreeId(options.now);
  const worktreeBaseDir = join(dirname(parentMemoryDir), "memory-worktrees");
  const label = options.label ?? "reflection";
  const worktreeDir = join(worktreeBaseDir, `${label}-${id}`);
  const branchName = `letta/${label}/${id}`;

  await mkdir(worktreeBaseDir, { recursive: true });

  const { stdout: baseHeadOut } = await runGit(parentMemoryDir, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const baseHead = baseHeadOut.trim();
  if (!baseHead) {
    throw new Error(
      `Unable to create reflection memory worktree: ${parentMemoryDir} has no HEAD`,
    );
  }

  await runGit(parentMemoryDir, [
    "worktree",
    "add",
    worktreeDir,
    "-b",
    branchName,
    baseHead,
  ]);

  const { stdout: commonDirOut } = await runGit(worktreeDir, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const gitCommonDir = normalizeGitPath(commonDirOut, worktreeDir);
  debugLog(
    "memfs-git",
    "reflection worktree created id=%s branch=%s dir=%s parent=%s baseHead=%s gitCommonDir=%s",
    id,
    branchName,
    worktreeDir,
    parentMemoryDir,
    baseHead,
    gitCommonDir,
  );

  return {
    id,
    parentMemoryDir,
    worktreeBaseDir,
    worktreeDir,
    branchName,
    baseHead,
    gitCommonDir,
  };
}

export interface ReflectionMemoryScope {
  primaryRoot: string;
  writableRoots: string[];
  readonlyRoots: string[];
}

export function buildReflectionMemoryScope(
  worktree: ReflectionMemoryWorktree,
): ReflectionMemoryScope {
  return {
    primaryRoot: worktree.worktreeDir,
    writableRoots: [worktree.worktreeDir, worktree.gitCommonDir],
    readonlyRoots: [dirname(worktree.parentMemoryDir)],
  };
}

export function buildReflectionIntegrationMemoryScope(
  worktree: ReflectionMemoryWorktree,
): ReflectionMemoryScope {
  return {
    primaryRoot: worktree.worktreeDir,
    writableRoots: [
      worktree.worktreeDir,
      worktree.parentMemoryDir,
      worktree.gitCommonDir,
    ],
    readonlyRoots: [],
  };
}

export type ReflectionMemoryWorktreeFinalizeStatus =
  | "merged"
  | "no_changes"
  | "parent_dirty"
  | "merge_conflict"
  | "dirty_uncommitted"
  | "rejected"
  | "failed";

export interface ReflectionMemoryWorktreeFinalizeResult {
  status: ReflectionMemoryWorktreeFinalizeStatus;
  parentMemoryDir: string;
  reflectionWorktreeDir: string;
  reflectionBranch: string;
  commitCount: number;
  head?: string;
  summary: string;
  error?: string;
  failurePhase?: "reflection" | "integration";
  /** `merge: "client"`: what the client decided. */
  approval?: ReflectionMergeDecision;
}

export function reflectionIntegrationConsumesTranscript(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return result.status === "merged" || result.status === "no_changes";
}

export function reflectionIntegrationShouldRecompile(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return result.status === "merged";
}

async function getStatusPorcelain(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ["status", "--porcelain"]);
  return stdout.trim();
}

export async function reflectionMemoryParentHasChanges(
  parentMemoryDir: string,
): Promise<boolean> {
  return (await getStatusPorcelain(resolve(parentMemoryDir))).length > 0;
}

async function getCommitCount(
  worktree: ReflectionMemoryWorktree,
): Promise<number> {
  const { stdout } = await runGit(worktree.worktreeDir, [
    "rev-list",
    "--count",
    `${worktree.baseHead}..HEAD`,
  ]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

async function getHead(cwd: string): Promise<string | undefined> {
  const result = await tryRunGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const head = result?.stdout.trim();
  return head || undefined;
}

async function refreshParentFromOrigin(parentMemoryDir: string): Promise<void> {
  const origin = await tryRunGit(parentMemoryDir, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  if (!origin) {
    return;
  }

  // Use the same authentication and transient Desktop proxy as memory sync.
  // Other origins (including local repositories) keep their own credentials.
  const memfsPrefix = `${getMemfsServerUrl().trim().replace(/\/+$/, "")}/v1/git/`;
  const token = origin.stdout.trim().startsWith(memfsPrefix)
    ? await getAuthToken()
    : undefined;
  await runMemoryGit(parentMemoryDir, ["fetch", "origin", "main"], token, {
    timeoutMs: GIT_TIMEOUT_MS,
  });

  const remoteIsAncestor = await tryRunGit(parentMemoryDir, [
    "merge-base",
    "--is-ancestor",
    "origin/main",
    "HEAD",
  ]);
  if (remoteIsAncestor) {
    return;
  }

  const localIsAncestor = await tryRunGit(parentMemoryDir, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    "origin/main",
  ]);
  if (localIsAncestor) {
    await runGit(parentMemoryDir, ["merge", "--ff-only", "origin/main"]);
    return;
  }

  try {
    await runGit(parentMemoryDir, ["rebase", "origin/main"]);
  } catch (error) {
    await tryRunGit(parentMemoryDir, ["rebase", "--abort"]);
    throw error;
  }
}

export interface ReflectionMemoryWorktreeState {
  commitCount: number;
  dirty: boolean;
  head?: string;
}

export async function inspectReflectionMemoryWorktree(
  worktree: ReflectionMemoryWorktree,
): Promise<ReflectionMemoryWorktreeState> {
  return {
    commitCount: await getCommitCount(worktree),
    dirty: (await getStatusPorcelain(worktree.worktreeDir)).length > 0,
    head: await getHead(worktree.worktreeDir),
  };
}

async function cleanupWorktreeAndBranch(
  parentMemoryDir: string,
  worktreeDir: string,
  branchName: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const removedWorktree = existsSync(worktreeDir);
  if (removedWorktree) {
    await runGit(parentMemoryDir, [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      worktreeDir,
    ]);
  }
  await tryRunGit(parentMemoryDir, [
    "branch",
    options.force ? "-D" : "-d",
    branchName,
  ]);
}

/** Finalize without taking the checkout lease; the caller must already hold it. */
export async function finalizeReflectionMemoryWorktreeUnlocked(
  worktree: ReflectionMemoryWorktree,
  options: ReflectionMemoryWorktreeFinalizeOptions,
): Promise<ReflectionMemoryWorktreeFinalizeResult> {
  if (!existsSync(worktree.worktreeDir) && options.knownNoChanges) {
    const branchHead = (
      await tryRunGit(worktree.parentMemoryDir, [
        "rev-parse",
        "--verify",
        worktree.branchName,
      ])
    )?.stdout.trim();
    if (branchHead && branchHead !== worktree.baseHead) {
      throw new Error(
        `Cannot finalize missing reflection worktree ${worktree.worktreeDir} as no-op: ${worktree.branchName} advanced from ${worktree.baseHead} to ${branchHead}`,
      );
    }
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=no_changes worktreeMissing=true cleanedUp=true",
      worktree.id,
    );
    return {
      status: "no_changes",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount: 0,
      head: worktree.baseHead,
      summary: "Reflection made no memory commits.",
    };
  }

  const commitCount = await getCommitCount(worktree);
  const status = await getStatusPorcelain(worktree.worktreeDir);
  const head = await getHead(worktree.worktreeDir);

  if (status.length > 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=dirty_uncommitted commitCount=%d cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
    );
    return {
      status: "dirty_uncommitted",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection memory worktree had uncommitted changes; it was cleaned up so the transcript can be retried.",
    };
  }

  if (!options.shouldMerge) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=failed commitCount=%d cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
    );
    return {
      status: "failed",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection subagent did not complete successfully; the worktree was cleaned up so the transcript can be retried.",
    };
  }

  if (commitCount === 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=no_changes cleanedUp=true",
      worktree.id,
    );
    return {
      status: "no_changes",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary: "Reflection made no memory commits.",
    };
  }

  const parentStatus = await getStatusPorcelain(worktree.parentMemoryDir);
  if (parentStatus.length > 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=parent_dirty commitCount=%d cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
    );
    return {
      status: "parent_dirty",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection produced memory updates, but the parent memory repo had uncommitted changes; the worktree was cleaned up so the transcript can be retried.",
    };
  }

  if (!options.requireAlreadyMerged) {
    try {
      await refreshParentFromOrigin(worktree.parentMemoryDir);
    } catch (error) {
      await cleanupWorktreeAndBranch(
        worktree.parentMemoryDir,
        worktree.worktreeDir,
        worktree.branchName,
        { force: true },
      );
      const message = error instanceof Error ? error.message : String(error);
      debugLog(
        "memfs-git",
        "reflection finalized id=%s status=failed phase=parent_refresh commitCount=%d cleanedUp=true retryable=true error=%s",
        worktree.id,
        commitCount,
        message,
      );
      return {
        status: "failed",
        parentMemoryDir: worktree.parentMemoryDir,
        reflectionWorktreeDir: worktree.worktreeDir,
        reflectionBranch: worktree.branchName,
        commitCount,
        head,
        failurePhase: "integration",
        error: message,
        summary:
          "Reflection produced memory updates, but the parent memory repo could not be refreshed; the worktree was cleaned up so the transcript can be retried.",
      };
    }
  }

  if (options.requireAlreadyMerged) {
    const alreadyMerged = await tryRunGit(worktree.parentMemoryDir, [
      "merge-base",
      "--is-ancestor",
      worktree.branchName,
      "HEAD",
    ]);
    if (!alreadyMerged) {
      await cleanupWorktreeAndBranch(
        worktree.parentMemoryDir,
        worktree.worktreeDir,
        worktree.branchName,
        { force: true },
      );
      return {
        status: "failed",
        parentMemoryDir: worktree.parentMemoryDir,
        reflectionWorktreeDir: worktree.worktreeDir,
        reflectionBranch: worktree.branchName,
        commitCount,
        head,
        failurePhase: "integration",
        summary:
          options.failureSummary ??
          "The primary-agent integration conversation did not merge the reflection branch; the worktree was cleaned up so the transcript can be retried.",
      };
    }

    const mergedHead = await getHead(worktree.parentMemoryDir);
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=merged integration=primary_agent commitCount=%d parentHead=%s cleanedUp=true",
      worktree.id,
      commitCount,
      mergedHead ?? "<none>",
    );
    return {
      status: "merged",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head: mergedHead,
      summary: `Primary agent integrated ${commitCount} reflection memory commit(s).`,
    };
  }

  let approval: ReflectionMergeDecision | undefined;
  if (options.approve) {
    // merge: "client": the SDK client decides before anything reaches main.
    approval = await options.approve(
      await describeReflectionBranch(worktree, options.messageRange),
    );
    const paths =
      approval.decision === "approve_paths" ? approval.approve_paths : [];
    if (
      approval.decision === "reject" ||
      (approval.decision === "approve_paths" &&
        !(await keepOnlyApprovedPaths(worktree, paths)))
    ) {
      await cleanupWorktreeAndBranch(
        worktree.parentMemoryDir,
        worktree.worktreeDir,
        worktree.branchName,
        { force: true },
      );
      debugLog(
        "memfs-git",
        "reflection finalized id=%s status=rejected reason=%s cleanedUp=true retryable=true",
        worktree.id,
        approval.reason ?? "",
      );
      return {
        status: "rejected",
        parentMemoryDir: worktree.parentMemoryDir,
        reflectionWorktreeDir: worktree.worktreeDir,
        reflectionBranch: worktree.branchName,
        commitCount,
        head,
        approval,
        summary: `The client rejected the reflection merge${approval.reason ? ` (${approval.reason})` : ""}; the worktree was cleaned up and the transcript was not consumed.`,
      };
    }
  }

  debugLog(
    "memfs-git",
    "reflection merge attempt id=%s branch=%s parent=%s commitCount=%d",
    worktree.id,
    worktree.branchName,
    worktree.parentMemoryDir,
    commitCount,
  );
  const trailers = reflectionMergeTrailers({
    messageRange: options.messageRange,
    decision: approval?.decision,
  });
  const mergeMessage = `${await buildReflectionMergeMessage(
    worktree.parentMemoryDir,
    worktree.branchName,
  )}${trailers.length ? `\n\n${trailers.join("\n")}` : ""}`;
  // Trailers need a merge commit: never fast-forward when there are any.
  const mergeResult = await tryRunGit(worktree.parentMemoryDir, [
    "merge",
    ...(trailers.length ? ["--no-ff"] : []),
    worktree.branchName,
    "-m",
    mergeMessage,
  ]);
  if (!mergeResult) {
    await tryRunGit(worktree.parentMemoryDir, ["merge", "--abort"]);
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=merge_conflict commitCount=%d mergeAbort=true cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
    );
    return {
      status: "merge_conflict",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection produced memory updates, but merging them into the parent memory repo conflicted; the worktree was cleaned up so the transcript can be retried.",
    };
  }

  const mergedHead = await getHead(worktree.parentMemoryDir);

  await cleanupWorktreeAndBranch(
    worktree.parentMemoryDir,
    worktree.worktreeDir,
    worktree.branchName,
  );
  debugLog(
    "memfs-git",
    "reflection finalized id=%s status=merged commitCount=%d parentHead=%s cleanedUp=true",
    worktree.id,
    commitCount,
    mergedHead ?? "<none>",
  );

  return {
    status: "merged",
    parentMemoryDir: worktree.parentMemoryDir,
    reflectionWorktreeDir: worktree.worktreeDir,
    reflectionBranch: worktree.branchName,
    commitCount,
    head: mergedHead,
    ...(approval ? { approval } : {}),
    summary: `Merged ${commitCount} reflection memory commit(s) into parent memory main.`,
  };
}

export async function finalizeReflectionMemoryWorktree(
  worktree: ReflectionMemoryWorktree,
  options: ReflectionMemoryWorktreeFinalizeOptions,
): Promise<ReflectionMemoryWorktreeFinalizeResult> {
  return withMemoryOperation(worktree.parentMemoryDir, () =>
    finalizeReflectionMemoryWorktreeUnlocked(worktree, options),
  );
}

export type MemoryWorkerWorktreeOutcome =
  | { status: "merged"; commitCount: number; head: string }
  | { status: "no_changes" }
  | { status: "discarded" }
  | { status: "merge_conflict"; commitCount: number; branchName: string }
  | { status: "failed"; error: string };

/**
 * Bring a memory worker's worktree back into the parent checkout. The caller
 * must hold the checkout lease. Commits are merged (fast-forward when
 * possible); uncommitted edits in the worktree are dropped, as are all edits
 * when `discard` is set (a cancelled worker). A merge that conflicts with the
 * parent's own changes is aborted and the branch is kept so nothing is lost.
 * Unlike reflection, a dirty parent does not block the merge: Git refuses only
 * when the parent's uncommitted files overlap the worker's commits, and that
 * surfaces as a conflict here.
 */
export async function integrateMemoryWorkerWorktree(
  worktree: ReflectionMemoryWorktree,
  options: { discard?: boolean } = {},
): Promise<MemoryWorkerWorktreeOutcome> {
  const cleanup = (force: boolean) =>
    cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force },
    );
  if (options.discard) {
    await cleanup(true);
    return { status: "discarded" };
  }
  let commitCount = 0;
  try {
    commitCount = await getCommitCount(worktree);
  } catch (error) {
    await cleanup(true).catch(() => undefined);
    return { status: "failed", error: String(error) };
  }
  if (commitCount === 0) {
    await cleanup(true);
    return { status: "no_changes" };
  }
  // Remove the worktree first so the branch can be merged from the parent;
  // the branch survives until the merge succeeds.
  if (existsSync(worktree.worktreeDir)) {
    await runGit(worktree.parentMemoryDir, [
      "worktree",
      "remove",
      "--force",
      worktree.worktreeDir,
    ]);
  }
  const merged = await tryRunGit(worktree.parentMemoryDir, [
    "merge",
    "--no-edit",
    "-m",
    `merge(memory): ${worktree.branchName}`,
    worktree.branchName,
  ]);
  if (!merged) {
    await tryRunGit(worktree.parentMemoryDir, ["merge", "--abort"]);
    return {
      status: "merge_conflict",
      commitCount,
      branchName: worktree.branchName,
    };
  }
  await tryRunGit(worktree.parentMemoryDir, [
    "branch",
    "-d",
    worktree.branchName,
  ]);
  const head = await getHead(worktree.parentMemoryDir);
  return { status: "merged", commitCount, head: head ?? "" };
}

const MAX_REFLECTION_DIFF_CHARACTERS = 64_000;

/** What a client sees before approving a reflection branch. */
export async function describeReflectionBranch(
  worktree: ReflectionMemoryWorktree,
  messageRange?: { start?: string; end?: string },
): Promise<Omit<ReflectionMergeRequest, "agent_id">> {
  const range = `${worktree.baseHead}..${worktree.branchName}`;
  const cwd = worktree.parentMemoryDir;
  const log = await runGit(cwd, [
    "log",
    "--reverse",
    "--format=%H%x1f%s%x1f%an <%ae>",
    range,
  ]);
  const names = await runGit(cwd, [
    "diff",
    "--name-status",
    "--no-renames",
    range.replace("..", "..."),
  ]);
  const stat = await runGit(cwd, [
    "diff",
    "--stat",
    worktree.baseHead,
    worktree.branchName,
  ]);
  const diff = await runGit(cwd, [
    "diff",
    "--no-color",
    worktree.baseHead,
    worktree.branchName,
  ]);
  return {
    branch: worktree.branchName,
    base_head: worktree.baseHead,
    head: (await getHead(worktree.worktreeDir)) ?? "",
    commits: log.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", subject = "", author = ""] = line.split("\x1f");
        return { sha, subject, author };
      }),
    files: names.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status = "M", path = ""] = line.split("\t");
        return {
          path,
          status: (status === "A" || status === "D" ? status : "M") as
            | "A"
            | "M"
            | "D",
        };
      }),
    diff_stat: stat.stdout.trim(),
    diff: diff.stdout.slice(0, MAX_REFLECTION_DIFF_CHARACTERS),
    diff_truncated: diff.stdout.length > MAX_REFLECTION_DIFF_CHARACTERS,
    ...(messageRange ? { message_range: messageRange } : {}),
  };
}

/**
 * Keep only `paths` of a reflection branch: one commit on the branch that
 * restores every other changed path to the base. False when nothing approved
 * remains (the merge is then rejected).
 */
async function keepOnlyApprovedPaths(
  worktree: ReflectionMemoryWorktree,
  paths: readonly string[],
): Promise<boolean> {
  const approved = new Set(paths);
  const changed = (
    await runGit(worktree.worktreeDir, [
      "diff",
      "--name-only",
      "--no-renames",
      worktree.baseHead,
      "HEAD",
    ])
  ).stdout
    .split("\n")
    .filter(Boolean);
  const dropped = changed.filter((path) => !approved.has(path));
  if (dropped.length === changed.length) return false;
  if (!dropped.length) return true;
  for (const path of dropped) {
    const atBase = await tryRunGit(worktree.worktreeDir, [
      "cat-file",
      "-e",
      `${worktree.baseHead}:${path}`,
    ]);
    await runGit(
      worktree.worktreeDir,
      atBase
        ? ["checkout", worktree.baseHead, "--", path]
        : ["rm", "-q", "--", path],
    );
  }
  await runGit(worktree.worktreeDir, [
    "commit",
    "-q",
    "-m",
    `chore(reflection): drop paths the client did not approve\n\nDropped: ${dropped.join(", ")}`,
  ]);
  return true;
}

export interface ReflectionMemoryWorktreeFinalizeOptions {
  /** `merge: "client"`: ask before merging; a rejection cleans up without consuming the transcript. */
  approve?: (
    request: Omit<ReflectionMergeRequest, "agent_id">,
  ) => Promise<ReflectionMergeDecision>;
  /** The reflected message range, recorded as a `Reflected-Messages` merge trailer. */
  messageRange?: { start?: string; end?: string };
  shouldMerge: boolean;
  knownNoChanges?: boolean;
  failureSummary?: string;
  requireAlreadyMerged?: boolean;
}
