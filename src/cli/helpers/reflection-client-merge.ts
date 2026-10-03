import { readFile } from "node:fs/promises";
import type {
  ReflectionMemoryWorktreeFinalizeOptions,
  ReflectionMemoryWorktreeFinalizeResult,
} from "@/agent/memory-worktree";
import { requestReflectionMergeApproval } from "@/agent/reflection-merge-approval";
import { countUntrustedToolResults } from "@/cli/helpers/reflection-untrusted";

/**
 * Finalize options for `merge: "client"`: the agent's SDK client approves the
 * reflection branch before it merges. Other merge modes get none.
 */
export function clientMergeFinalizeOptions(params: {
  mergePolicy?: string;
  agentId: string;
  conversationId: string;
  messageRange?: { start?: string; end?: string };
  transcriptPayload?: string;
}): Pick<ReflectionMemoryWorktreeFinalizeOptions, "approve" | "messageRange"> {
  const messageRange = params.messageRange;
  if (params.mergePolicy !== "client") {
    return messageRange ? { messageRange } : {};
  }
  return {
    ...(messageRange ? { messageRange } : {}),
    approve: async (request) => {
      const payload = params.transcriptPayload;
      const untrusted = payload
        ? countUntrustedToolResults(
            await readFile(payload, "utf-8").catch(() => ""),
          )
        : 0;
      return requestReflectionMergeApproval({
        ...request,
        agent_id: params.agentId,
        conversation_id: params.conversationId,
        ...(payload ? { transcript_payload: payload } : {}),
        ...(untrusted ? { untrusted_tool_results: untrusted } : {}),
      });
    },
  };
}

/** The completion message of a client-rejected reflection (the transcript stays unconsumed). */
export function clientRejectedMessage(
  integration: ReflectionMemoryWorktreeFinalizeResult,
): string {
  const reason = integration.approval?.reason;
  return `Reflection finished, but its memory changes were not approved${reason ? ` (${reason})` : ""}; nothing was merged and it will retry later.`;
}
