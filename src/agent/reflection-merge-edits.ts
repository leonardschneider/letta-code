// What the SDK client sees of a reflection branch before approving it, and
// the edits it may ask for (`approve_paths`, `approve_edits`), applied as one
// commit on the branch before the merge. Only `merge: "client"` uses these.
import { execFile as execFileCb } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { GIT_DISABLE_COMMIT_SIGNING_ARGS } from "@/agent/memory-git-signing";
import type { ReflectionMemoryWorktree } from "@/agent/memory-worktree";
import type {
  ReflectionLineDrop,
  ReflectionMergeRequest,
} from "@/agent/reflection-merge-approval";

const execFile = promisify(execFileCb);
const HARNESS_GIT_ENV = {
  GIT_AUTHOR_NAME: "Letta Code",
  GIT_AUTHOR_EMAIL: "noreply@letta.com",
  GIT_COMMITTER_NAME: "Letta Code",
  GIT_COMMITTER_EMAIL: "noreply@letta.com",
};

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string }> {
  const { stdout } = await execFile(
    "git",
    [...GIT_DISABLE_COMMIT_SIGNING_ARGS, ...args],
    {
      cwd,
      env: { ...process.env, ...HARNESS_GIT_ENV },
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 5,
    },
  );
  return { stdout: stdout?.toString() ?? "" };
}

async function tryRunGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string } | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

async function getHead(cwd: string): Promise<string | undefined> {
  const result = await tryRunGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  return result?.stdout.trim() || undefined;
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
export async function keepOnlyApprovedPaths(
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

/** Lines `git diff -U0` says the branch added to `path`, as head line numbers. */
async function addedLines(
  worktree: ReflectionMemoryWorktree,
  path: string,
): Promise<Set<number>> {
  const diff = await runGit(worktree.worktreeDir, [
    "diff",
    "-U0",
    "--no-color",
    "--no-renames",
    worktree.baseHead,
    "HEAD",
    "--",
    path,
  ]);
  const added = new Set<number>();
  for (const match of diff.stdout.matchAll(
    /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
  )) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line++) added.add(line);
  }
  return added;
}

/**
 * Remove `drops` from the branch as one commit (`approve_edits`). Fails
 * closed (false, nothing committed) unless every drop names a file the branch
 * changed, a line range inside it made only of lines the branch added, and
 * the exact text of those lines; ranges may not overlap.
 */
export async function dropApprovedLines(
  worktree: ReflectionMemoryWorktree,
  drops: readonly ReflectionLineDrop[],
): Promise<boolean> {
  const byPath = new Map<string, ReflectionLineDrop[]>();
  for (const drop of drops) {
    if (
      drop.path.split("/").some((p) => !p || p === "." || p === "..") ||
      drop.path.startsWith(".git")
    ) {
      return false;
    }
    byPath.set(drop.path, [...(byPath.get(drop.path) ?? []), drop]);
  }
  const updates = new Map<string, string>();
  for (const [path, list] of byPath) {
    const shown = await tryRunGit(worktree.worktreeDir, [
      "show",
      `HEAD:${path}`,
    ]);
    if (!shown) return false;
    const lines = shown.stdout.split("\n");
    const added = await addedLines(worktree, path);
    const remove = new Set<number>();
    for (const drop of list) {
      if (drop.end > lines.length) return false;
      const range: number[] = [];
      for (let line = drop.start; line <= drop.end; line++) range.push(line);
      if (range.some((line) => !added.has(line) || remove.has(line))) {
        return false;
      }
      if (lines.slice(drop.start - 1, drop.end).join("\n") !== drop.text) {
        return false;
      }
      for (const line of range) remove.add(line);
    }
    updates.set(
      path,
      lines.filter((_line, index) => !remove.has(index + 1)).join("\n"),
    );
  }
  for (const [path, text] of updates) {
    await writeFile(join(worktree.worktreeDir, path), text, "utf-8");
  }
  await runGit(worktree.worktreeDir, ["add", "--", ...updates.keys()]);
  const dropped = drops
    .map((drop) => `${drop.path}:${drop.start}-${drop.end}`)
    .join(", ");
  await runGit(worktree.worktreeDir, [
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    `chore(reflection): drop lines the client did not approve\n\nDropped: ${dropped}`,
  ]);
  return true;
}
