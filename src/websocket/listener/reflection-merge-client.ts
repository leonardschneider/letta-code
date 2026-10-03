import WebSocket from "ws";
import {
  getReflectionMergeTimeoutMs,
  parseReflectionMergeDecision,
  type ReflectionMergeApprover,
  type ReflectionMergeDecision,
  setReflectionMergeApprover,
} from "@/agent/reflection-merge-approval";
import type {
  ReflectionMergeRequestMessage,
  ReflectionMergeResponseCommand,
} from "@/types/protocol_v2";
import type { SafeSocketSend } from "./commands/types";

// Pending `reflection_merge_request`s, by request ID, with the socket that
// must answer each one (another connection cannot approve it).
const pending = new Map<
  string,
  { socket: WebSocket; resolve: (decision: ReflectionMergeDecision) => void }
>();

/**
 * Bind an agent's reflection merges to the connection that set
 * `merge: "client"`: each finished reflection branch is sent to it as a
 * `reflection_merge_request`, and its `reflection_merge_response` decides.
 * A closed socket, or no answer in time, rejects.
 */
export function bindReflectionMergeClient(
  agentId: string,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): void {
  const approver: ReflectionMergeApprover = (request, signal) =>
    new Promise((resolve) => {
      if (socket.readyState !== WebSocket.OPEN) {
        resolve({ decision: "reject", reason: "no_client" });
        return;
      }
      const requestId = `reflection-merge-${crypto.randomUUID()}`;
      const settle = (decision: ReflectionMergeDecision) => {
        pending.delete(requestId);
        socket.off("close", onClose);
        resolve(decision);
      };
      const onClose = () => settle({ decision: "reject", reason: "no_client" });
      signal.addEventListener(
        "abort",
        () => settle({ decision: "reject", reason: "timeout" }),
        { once: true },
      );
      socket.once("close", onClose);
      pending.set(requestId, { socket, resolve: settle });
      const message: ReflectionMergeRequestMessage = {
        type: "reflection_merge_request",
        request_id: requestId,
        ...request,
        expires_at: new Date(
          Date.now() + getReflectionMergeTimeoutMs(),
        ).toISOString(),
      };
      if (
        !safeSocketSend(
          socket,
          message,
          "listener_reflection_merge_send_failed",
          "listener_reflection_merge",
        )
      ) {
        settle({ decision: "reject", reason: "no_client" });
      }
    });
  setReflectionMergeApprover(agentId, approver);
}

/** The agent's merges are no longer client-approved (another merge mode was set). */
export function unbindReflectionMergeClient(agentId: string): void {
  setReflectionMergeApprover(agentId, undefined);
}

/** A client answered a merge request. Answers from another socket, or unknown requests, are ignored. */
export function handleReflectionMergeResponse(
  socket: WebSocket,
  command: ReflectionMergeResponseCommand,
): boolean {
  const entry = pending.get(command.request_id);
  if (!entry || entry.socket !== socket) return false;
  entry.resolve(parseReflectionMergeDecision(command));
  return true;
}
