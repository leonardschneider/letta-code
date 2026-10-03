// Client-approved reflection merges (`merge: "client"`).
//
// With this merge mode the harness does not merge a finished reflection
// branch on its own: it describes the branch to the SDK client that set the
// mode (`reflection_merge_request`) and waits for its decision
// (`reflection_merge_response`). No decision before the deadline is a
// rejection, and a rejected reflection leaves its transcript unconsumed so it
// can be retried. The listener registers one approver per agent; this module
// holds the registry and the decision contract, with no transport details.

export interface ReflectionMergeCommit {
  sha: string;
  subject: string;
  author: string;
}

export interface ReflectionMergeFile {
  path: string;
  status: "A" | "M" | "D";
}

export interface ReflectionMergeRequest {
  agent_id: string;
  conversation_id?: string;
  branch: string;
  base_head: string;
  head: string;
  commits: ReflectionMergeCommit[];
  files: ReflectionMergeFile[];
  diff_stat: string;
  /** Unified diff of the branch against `base_head`, truncated to a bound. */
  diff: string;
  diff_truncated: boolean;
  /** Path of the transcript payload the reflection read. */
  transcript_payload?: string;
  message_range?: { start?: string; end?: string };
  /** Tool results in the reflected transcript: content written by others. */
  untrusted_tool_results?: number;
}

export type ReflectionMergeDecision =
  | { decision: "approve"; reason?: string }
  | { decision: "approve_paths"; approve_paths: string[]; reason?: string }
  | { decision: "reject"; reason?: string };

export type ReflectionMergeApprover = (
  request: ReflectionMergeRequest,
  signal: AbortSignal,
) => Promise<ReflectionMergeDecision>;

export const DEFAULT_REFLECTION_MERGE_TIMEOUT_MS = 120_000;
export const REFLECTION_MERGE_TIMEOUT_ENV = "LETTA_REFLECTION_MERGE_TIMEOUT_MS";
export const REFLECTED_MESSAGES_TRAILER = "Reflected-Messages";
export const REFLECTION_APPROVAL_TRAILER = "Reflection-Approval";

const approvers = new Map<string, ReflectionMergeApprover>();

/** Register (or with `undefined`, remove) the approver of an agent's reflection merges. */
export function setReflectionMergeApprover(
  agentId: string,
  approver: ReflectionMergeApprover | undefined,
): void {
  if (approver) approvers.set(agentId, approver);
  else approvers.delete(agentId);
}

export function hasReflectionMergeApprover(agentId: string): boolean {
  return approvers.has(agentId);
}

/** The approval deadline: `LETTA_REFLECTION_MERGE_TIMEOUT_MS`, 1 s to 30 min. */
export function getReflectionMergeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(env[REFLECTION_MERGE_TIMEOUT_ENV]);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_REFLECTION_MERGE_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.trunc(value), 1_000), 30 * 60_000);
}

/** Validate a decision received from a client; anything malformed rejects. */
export function parseReflectionMergeDecision(
  value: unknown,
): ReflectionMergeDecision {
  if (!value || typeof value !== "object") {
    return { decision: "reject", reason: "invalid_response" };
  }
  const v = value as {
    decision?: unknown;
    approve_paths?: unknown;
    reason?: unknown;
  };
  const reason =
    typeof v.reason === "string" ? v.reason.slice(0, 500) : undefined;
  const withReason = reason ? { reason } : {};
  if (v.decision === "approve") return { decision: "approve", ...withReason };
  if (
    v.decision === "approve_paths" &&
    Array.isArray(v.approve_paths) &&
    v.approve_paths.every((path) => typeof path === "string")
  ) {
    return {
      decision: "approve_paths",
      approve_paths: v.approve_paths as string[],
      ...withReason,
    };
  }
  if (v.decision === "reject") return { decision: "reject", ...withReason };
  return { decision: "reject", reason: "invalid_response" };
}

/**
 * Ask the agent's approver. Fails closed: no approver, an error, or no answer
 * before the deadline is a rejection.
 */
export async function requestReflectionMergeApproval(
  request: ReflectionMergeRequest,
  timeoutMs = getReflectionMergeTimeoutMs(),
): Promise<ReflectionMergeDecision> {
  const approver = approvers.get(request.agent_id);
  if (!approver) return { decision: "reject", reason: "no_client" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReflectionMergeDecision>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ decision: "reject", reason: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      approver(request, controller.signal).then(
        parseReflectionMergeDecision,
        () => ({ decision: "reject", reason: "client_error" }) as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Trailers of a merge commit: the reflected message range and the client's decision. */
export function reflectionMergeTrailers(params: {
  messageRange?: { start?: string; end?: string };
  decision?: ReflectionMergeDecision["decision"];
}): string[] {
  const trailers: string[] = [];
  const { start, end } = params.messageRange ?? {};
  if (start || end) {
    trailers.push(
      `${REFLECTED_MESSAGES_TRAILER}: ${start ?? ""}..${end ?? ""}`,
    );
  }
  if (params.decision) {
    trailers.push(
      `${REFLECTION_APPROVAL_TRAILER}: ${params.decision} (client)`,
    );
  }
  return trailers;
}
