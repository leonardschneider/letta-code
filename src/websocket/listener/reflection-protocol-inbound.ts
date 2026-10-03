import { isReflectionLineDropList } from "@/agent/reflection-merge-approval";
import type {
  GetReflectionSettingsCommand,
  ReflectionMergeResponseCommand,
  SetReflectionSettingsCommand,
} from "@/types/protocol_v2";
import { isAgentRuntimeScope } from "./protocol-validation";

export function isGetReflectionSettingsCommand(
  value: unknown,
): value is GetReflectionSettingsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    runtime?: unknown;
  };
  return (
    c.type === "get_reflection_settings" &&
    typeof c.request_id === "string" &&
    isAgentRuntimeScope(c.runtime)
  );
}
export function isSetReflectionSettingsCommand(
  value: unknown,
): value is SetReflectionSettingsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    runtime?: unknown;
    settings?: unknown;
    scope?: unknown;
  };
  if (
    c.type !== "set_reflection_settings" ||
    typeof c.request_id !== "string" ||
    !isAgentRuntimeScope(c.runtime) ||
    !c.settings ||
    typeof c.settings !== "object"
  ) {
    return false;
  }
  const settings = c.settings as {
    trigger?: unknown;
    step_count?: unknown;
    merge?: unknown;
    merge_instructions?: unknown;
  };
  return (
    (settings.trigger === "off" ||
      settings.trigger === "step-count" ||
      settings.trigger === "compaction-event") &&
    typeof settings.step_count === "number" &&
    Number.isInteger(settings.step_count) &&
    settings.step_count > 0 &&
    (settings.merge === undefined ||
      settings.merge === "auto" ||
      settings.merge === "explicit" ||
      settings.merge === "client") &&
    (settings.merge_instructions === undefined ||
      typeof settings.merge_instructions === "string") &&
    (c.scope === undefined ||
      c.scope === "local_project" ||
      c.scope === "global" ||
      c.scope === "both")
  );
}

export function isReflectionMergeResponseCommand(
  value: unknown,
): value is ReflectionMergeResponseCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    decision?: unknown;
    approve_paths?: unknown;
    drop?: unknown;
    reason?: unknown;
  };
  return (
    c.type === "reflection_merge_response" &&
    typeof c.request_id === "string" &&
    (c.decision === "approve" ||
      c.decision === "reject" ||
      (c.decision === "approve_paths" &&
        Array.isArray(c.approve_paths) &&
        c.approve_paths.every((path) => typeof path === "string")) ||
      (c.decision === "approve_edits" && isReflectionLineDropList(c.drop))) &&
    (c.reason === undefined || typeof c.reason === "string")
  );
}
