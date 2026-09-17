import { cleaningBoundaries } from "./cleaning.js";

// 时间感知的污染传播：
//  1) 每条接触区间在资源的有效清洁证明时刻处被切割，传播不能越过证明边界；
//  2) 同一“清洁区域”（两证明之间）内，污染可随时间向后滞留，时间重叠的共用会
//     扩展到先到但仍在场的批次；
//  3) 只能由早向晚传播，不能回溯感染已经离开的批次；
//  4) 阳性批次按采样复检需要追溯其全部既往接触（回溯种子）。
export function buildSegments(model, boundaries) {
  const byResource = new Map();
  for (const c of model.contacts) {
    const certs = (boundaries.get(c.resource_id) ?? []).filter((x) => x.valid);
    const pieces = [];
    let cursor = c._start;
    for (const cert of certs) {
      if (cert.at <= cursor) continue;
      if (cert.at >= c._end) break;
      pieces.push({ start: cursor, end: cert.at });
      cursor = cert.at;
    }
    pieces.push({ start: cursor, end: c._end });

    for (const piece of pieces) {
      const seg = {
        resource_id: c.resource_id,
        resource_type: c.resource_type,
        batch_id: c.batch_id,
        contact_id: c.contact_id,
        start: piece.start,
        end: piece.end,
        open: c.ended_at == null,
      };
      if (!byResource.has(c.resource_id)) byResource.set(c.resource_id, []);
      byResource.get(c.resource_id).push(seg);
    }
  }

  // 区域编号：每经过一次有效证明，区域 +1。区域内污染滞留，跨区域被阻断。
  for (const [resourceId, segs] of byResource) {
    const certs = (boundaries.get(resourceId) ?? []).filter((x) => x.valid).map((x) => x.at).sort((a, b) => a - b);
    segs.sort((a, b) => a.start - b.start);
    for (const s of segs) {
      s.region = certs.filter((b) => b <= s.start).length;
    }
  }
  return byResource;
}

export function trace(model, sourceBatchId, sourceSince = -Infinity) {
  const boundaries = cleaningBoundaries(model);
  const segmentsByResource = buildSegments(model, boundaries);

  const segmentsByBatch = new Map();
  for (const segs of segmentsByResource.values()) {
    for (const s of segs) {
      if (!segmentsByBatch.has(s.batch_id)) segmentsByBatch.set(s.batch_id, []);
      segmentsByBatch.get(s.batch_id).push(s);
    }
  }

  const infectedAt = new Map(); // batch_id -> 最早可证实暴露时刻
  const evidence = [] // 传播证据链
    ;
  const queue = [];

  const infect = (batchId, at, via) => {
    const prev = infectedAt.get(batchId);
    if (prev == null || at < prev) {
      infectedAt.set(batchId, at);
      queue.push({ batchId, at });
      if (via) evidence.push({ batch_id: batchId, at, ...via });
    }
  };

  // 回溯种子：源批次在其各接触段起点即视为带菌
  infect(sourceBatchId, sourceSince, { kind: "source_positive" });
  for (const s of segmentsByBatch.get(sourceBatchId) ?? []) {
    if (s.start < sourceSince) infect(sourceBatchId, s.start, { kind: "source_retroactive", contact_id: s.contact_id });
  }

  while (queue.length) {
    queue.sort((a, b) => a.at - b.at);
    const { batchId, at } = queue.shift();
    if (at !== infectedAt.get(batchId)) continue; // 已有更早时间，过期松弛项

    for (const seg of segmentsByBatch.get(batchId) ?? []) {
      if (seg.end <= at) continue; // 暴露时该批次已离开，不能回溯
      const entry = Math.max(at, seg.start);

      for (const other of segmentsByResource.get(seg.resource_id) ?? []) {
        if (other.region !== seg.region) continue; // 清洁证明边界，阻断
        if (other.end <= entry) continue; // 污染到达前已离开，不能回溯
        if (other.batch_id === batchId) continue;
        const hitAt = Math.max(entry, other.start);
        infect(other.batch_id, hitAt, {
          // 目标进入时施感批次仍在场→时间重叠；施感批次已离场→污染滞留
          kind: other.start < seg.end ? "shared_resource_overlap" : "shared_resource_persistence",
          resource_id: seg.resource_id,
          resource_type: seg.resource_type,
          contact_id: other.contact_id,
          from_contact_id: seg.contact_id,
        });
      }
    }
  }

  // 每个资源被污染的时间区间（用于舱位安全判断）
  const contaminationByResource = new Map();
  for (const segs of segmentsByResource.values()) {
    const dirty = [];
    for (const s of segs) {
      const t = infectedAt.get(s.batch_id);
      if (t == null || t >= s.end) continue;
      dirty.push({ start: Math.max(t, s.start), end: s.end, open: s.open, batch_id: s.batch_id });
    }
    if (dirty.length) contaminationByResource.set(segs[0].resource_id, dirty);
  }

  // 定点后重新判定证据类型：目标进入时若仍有任一已感染批次在场则为时间重叠，
  // 否则为污染滞留；同一目标接触只保留最有力（重叠优先）且最早的一条。
  const segByContact = new Map();
  for (const segs of segmentsByResource.values()) for (const s of segs) segByContact.set(s.contact_id, s);
  const best = new Map();
  for (const e of evidence) {
    if (!e.contact_id || !e.resource_id) continue;
    const target = segByContact.get(e.contact_id);
    if (!target) continue;
    const coOccupant = (segmentsByResource.get(e.resource_id) ?? []).some(
      (s) =>
        s.region === target.region &&
        s.start <= target.start &&
        target.start < s.end &&
        s.batch_id !== target.batch_id &&
        (infectedAt.get(s.batch_id) ?? Infinity) <= target.start,
    );
    const fixed = { ...e, at: Math.min(e.at, target.start), kind: coOccupant ? "shared_resource_overlap" : "shared_resource_persistence" };
    const key = `${target.batch_id}|${e.contact_id}`;
    const prev = best.get(key);
    if (!prev || (fixed.kind === "shared_resource_overlap" && prev.kind !== "shared_resource_overlap") || fixed.at < prev.at) {
      best.set(key, fixed);
    }
  }
  const fixedEvidence = [
    ...evidence.filter((e) => e.kind === "source_retroactive" || e.kind === "source_positive"),
    ...best.values(),
  ].sort((a, b) => a.at - b.at);
  evidence.length = 0;
  evidence.push(...fixedEvidence);

  return {
    boundaries,
    segmentsByResource,
    infectedAt,
    evidence,
    contaminationByResource,
  };
}
