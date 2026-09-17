// 资源竞争：同一时刻舱室批次数不得超配，托盘单承载；车辆允许重叠不校验。
export function occupancyAt(model, resourceType, resourceId, at) {
  return model.contacts.filter(
    (c) =>
      c.resource_type === resourceType &&
      c.resource_id === resourceId &&
      c._start <= at &&
      at < c._end,
  );
}

// 扫描所有接触端点，返回全部超配违规区间证据
export function capacityViolations(model) {
  const violations = [];
  const checkTimes = [...new Set(model.contacts.flatMap((c) => [c._start, c._end]))].sort((a, b) => a - b);

  for (const chamber of model.resources.chambers) {
    for (const t of checkTimes) {
      const occ = occupancyAt(model, "chamber", chamber.chamber_id, t);
      const batches = [...new Set(occ.map((c) => c.batch_id))];
      if (batches.length > chamber.capacity) {
        violations.push({
          resource_type: "chamber",
          resource_id: chamber.chamber_id,
          at: t,
          count: batches.length,
          capacity: chamber.capacity,
          batch_ids: batches,
        });
      }
    }
  }

  const trayToChamber = model.trayChamber;
  for (const [trayId] of trayToChamber) {
    for (const t of checkTimes) {
      const occ = occupancyAt(model, "tray", trayId, t);
      const batches = [...new Set(occ.map((c) => c.batch_id))];
      if (batches.length > 1) {
        violations.push({
          resource_type: "tray",
          resource_id: trayId,
          at: t,
          count: batches.length,
          capacity: 1,
          batch_ids: batches,
        });
      }
    }
  }
  return violations;
}

// 调度员视角：时刻 t 真正安全可用的舱位。
// 安全条件：该舱与其托盘在 t 之前最近一次有效清洁证明之后无污染区间覆盖 t，
// 且 t 时刻仍有空闲承载位（按在舱批次数计）。
export function safeChambers(model, traceResult, at) {
  const { contaminationByResource, boundaries } = traceResult;
  const out = [];
  for (const chamber of model.resources.chambers) {
    const resourceIds = [chamber.chamber_id, ...chamber.tray_ids];
    const reasons = [];

    for (const rid of resourceIds) {
      const certs = boundaries.get(rid) ?? [];
      const lastCert = [...certs].reverse().find((c) => c.valid && c.at <= at);
      const intervals = contaminationByResource.get(rid) ?? [];
      // 只有覆盖 t 且发生在最近一次有效清洁证明之后的污染才否决安全性
      const unblocked = intervals.filter(
        (iv) => iv.start <= at && at < iv.end && (!lastCert || iv.start >= lastCert.at),
      );
      if (unblocked.length) {
        reasons.push(`${rid} 在判定时刻处于污染区间（来源 ${unblocked.map((u) => u.batch_id).join("、")}）`);
      }
    }

    const occ = occupancyAt(model, "chamber", chamber.chamber_id, at);
    const used = new Set(occ.map((c) => c.batch_id)).size;
    const free = chamber.capacity - used;
    const safe = reasons.length === 0 && free > 0;
    out.push({
      chamber_id: chamber.chamber_id,
      name: chamber.name,
      capacity: chamber.capacity,
      occupied: used,
      free_slots: Math.max(0, free),
      safe,
      reasons: safe ? [] : [...reasons, ...(free <= 0 ? ["当前无空闲舱位"] : [])],
    });
  }
  return out;
}
