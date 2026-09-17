// 清洁规程评估：只有 cleaning_certified 构成传播边界。
// 有效证明要求：同一资源存在更早的 cleaning_started、步骤齐全、时长达标。
export function cleaningBoundaries(model) {
  const { events, protocolsByType } = model;
  const byResource = new Map();

  for (const e of events) {
    if (e.type !== "cleaning_started") continue;
    const list = byResource.get(e.resource_id) ?? [];
    list.push({ kind: "start", at: e._at });
    byResource.set(e.resource_id, list);
  }
  for (const e of events) {
    if (e.type !== "cleaning_certified") continue;
    const list = byResource.get(e.resource_id) ?? [];
    list.push({ kind: "certify", at: e._at, event: e });
    byResource.set(e.resource_id, list);
  }

  // resource_id -> [{ at, valid, reason }]，valid 的证明时刻才可作为边界
  const boundaries = new Map();
  for (const [resourceId, list] of byResource) {
    list.sort((a, b) => a.at - b.at);
    const certs = [];
    let lastStart = null;
    for (const item of list) {
      if (item.kind === "start") {
        lastStart = item.at;
      } else {
        const proto = protocolsByType.get(item.event.resource_type);
        const hours = lastStart == null ? null : (item.at - lastStart) / model.HOUR;
        const steps = item.event.steps ?? [];
        const missing = proto ? proto.required_steps.filter((s) => !steps.includes(s)) : [];
        const valid =
          proto != null &&
          lastStart != null &&
          hours >= proto.min_cleaning_hours - 1e-9 &&
          missing.length === 0;
        certs.push({
          at: item.at,
          valid,
          reason: valid
            ? null
            : lastStart == null
              ? "缺少 cleaning_started"
              : missing.length
                ? `缺少步骤: ${missing.join("、")}`
                : `消杀时长 ${hours}h 不足 ${proto.min_cleaning_hours}h`,
        });
      }
    }
    boundaries.set(resourceId, certs);
  }
  return boundaries;
}
