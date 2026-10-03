import type {
  ReflectionMergeCommit,
  ReflectionMergeFile,
} from "@/agent/reflection-merge-approval";
import type { AgentRuntimeScope } from "./runtime-scope";

export type ReflectionTriggerMode = "off" | "step-count" | "compaction-event";
/**
 * `auto`: the harness merges a finished reflection branch itself.
 * `explicit`: a separate conversation of the agent integrates it.
 * `client`: the SDK client that set this mode approves or rejects it first
 * (see {@link ReflectionMergeRequestMessage}).
 */
export type ReflectionMergeMode = "auto" | "explicit" | "client";
export type ReflectionSettingsScope = "local_project" | "global" | "both";
export interface ReflectionSettingsSnapshot {
  agent_id: string;
  trigger: ReflectionTriggerMode;
  step_count: number;
  merge: ReflectionMergeMode;
  merge_instructions: string;
  /** Merge modes this harness supports (`client` when it can ask before merging). */
  merge_modes?: ReflectionMergeMode[];
}

export interface SetReflectionSettingsCommand {
  type: "set_reflection_settings";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  runtime: AgentRuntimeScope;
  settings: {
    trigger: ReflectionTriggerMode;
    step_count: number;
    merge?: ReflectionMergeMode;
    merge_instructions?: string;
  };
  scope?: ReflectionSettingsScope;
}

/**
 * `merge: "client"`: the harness asks the SDK client that set this mode
 * before merging a finished reflection branch into memory.
 */
export interface ReflectionMergeRequestMessage {
  type: "reflection_merge_request";
  request_id: string;
  agent_id: string;
  conversation_id?: string;
  branch: string;
  base_head: string;
  head: string;
  commits: ReflectionMergeCommit[];
  files: ReflectionMergeFile[];
  diff_stat: string;
  diff: string;
  diff_truncated: boolean;
  transcript_payload?: string;
  message_range?: { start?: string; end?: string };
  untrusted_tool_results?: number;
  /** When the harness stops waiting and rejects the merge. */
  expires_at: string;
}

/** The client's answer. No answer before `expires_at` is a rejection. */
export interface ReflectionMergeResponseCommand {
  type: "reflection_merge_response";
  request_id: string;
  decision: "approve" | "reject" | "approve_paths";
  approve_paths?: string[];
  reason?: string;
}
