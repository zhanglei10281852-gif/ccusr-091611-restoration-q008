import { parseTime } from "./time.js";

export class AllocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AllocationError";
  }
}

// 资源竞争不可超配：新接触与既有接触并发数不得超过资源容量（默认 1）。
export function assertAllocation({ contacts, resources = [], candidate }) {
  const capacity = resources.find((r) => r.resource_id === candidate.resource_id)?.capacity ?? 1;
  const start = typeof candidate.start === "number" ? candidate.start : parseTime(candidate.start);
  const end = candidate.end == null ? Infinity : typeof candidate.end === "number" ? candidate.end : parseTime(candidate.end);
  const overlapping = contacts.filter(
    (c) =>
      c.resource_id === candidate.resource_id &&
      c.contact_id !== candidate.contact_id &&
      c.start < end &&
      start < (c.end ?? Infinity),
  );
  if (overlapping.length + 1 > capacity) {
    throw new AllocationError(
      `资源 ${candidate.resource_id} 容量为 ${capacity}，该时段已有 ${overlapping.length} 个接触：${overlapping.map((c) => c.contact_id).join("、")}`,
    );
  }
  return true;
}
