import type { NormalizedRecord } from "@letta-ai/trajectory";

/**
 * Mark tool results in a reflection payload as untrusted: their content was
 * written by someone else (a web page, a document, a ticket, an API), so a
 * reflection must treat any instructions in them as data, never as memory
 * directives. The marker is additive (`untrusted: true` on `role: "tool"`
 * records); readers that do not know it ignore it.
 */
export function markUntrustedToolResults(records: NormalizedRecord[]): {
  records: (NormalizedRecord & { untrusted?: true })[];
  count: number;
} {
  let count = 0;
  const marked = records.map((record) => {
    if (record.role !== "tool") return record;
    count++;
    return { ...record, untrusted: true as const };
  });
  return { records: marked, count };
}

/** Count the untrusted tool results of a normalized payload (0 when it is not one). */
export function countUntrustedToolResults(payload: string): number {
  try {
    const records = JSON.parse(payload) as {
      role?: unknown;
      untrusted?: unknown;
    }[];
    return Array.isArray(records)
      ? records.filter((r) => r?.role === "tool" && r.untrusted === true).length
      : 0;
  } catch {
    return 0;
  }
}
