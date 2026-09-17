import { HOUR, formatTime } from "./time.js";

const INF = Infinity;
const batchKey = (id) => `batch:${id}`;
const resourceKey = (id) => `resource:${id}`;

// 由事件流推导全部结论；不读取任何人工填写的状态。
// now 为毫秒时间戳；同一批事件 + 同一 now 必得同一结果（纯函数，可重放）。
export function deriveState({ events, contacts, contract, resources = [], strains = [], protocols = [], now }) {
  const cultureMs = contract.minimum_culture_hours * HOUR;
  const resourceById = new Map(resources.map((r) => [r.resource_id, r]));
  const capacityOf = (id) => resourceById.get(id)?.capacity ?? 1;
  const riskOf = (strain) => strains.find((s) => s.strain === strain)?.risk_level ?? null;
  const protocolFor = (strain) => protocols.find((p) => p.risk_level === riskOf(strain)) ?? null;

  const contactsByBatch = new Map();
  const contactsByResource = new Map();
  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const c of contacts) {
    push(contactsByBatch, c.batch_id, c);
    push(contactsByResource, c.resource_id, c);
  }

  // ---- 事件索引 ----
  const samples = new Map();
  const results = [];
  const certified = new Map(); // resource_id -> 已认证清洁时刻（升序）
  const cleanings = new Map(); // cleaning_id -> {resource_id, started_at, certified_at}
  const doorOpenings = [];
  const releases = [];
  for (const e of events) {
    switch (e.type) {
      case "sample_taken":
        samples.set(e.sample_id, { sample_id: e.sample_id, subject_kind: e.subject_kind, subject_id: e.subject_id, at: e.atMs, strain: e.strain ?? null });
        break;
      case "result_reported": {
        const sample = samples.get(e.sample_id);
        if (!sample) throw new Error(`结果引用了不存在的样本: ${e.sample_id}`);
        results.push({ sample_id: e.sample_id, result: e.result, strain: e.strain ?? sample.strain ?? null, at: e.atMs });
        break;
      }
      case "cleaning_started":
        cleanings.set(e.cleaning_id, { resource_id: e.resource_id, started_at: e.atMs, certified_at: null });
        break;
      case "cleaning_certified": {
        const cleaning = cleanings.get(e.cleaning_id);
        if (!cleaning) throw new Error(`清洁认证缺少开始记录: ${e.cleaning_id}`);
        cleaning.certified_at = e.atMs;
        push(certified, e.resource_id, e.atMs);
        break;
      }
      case "door_opened":
        doorOpenings.push({ resource_id: e.resource_id, at: e.atMs });
        break;
      case "batch_released":
        releases.push({ batch_id: e.batch_id, at: e.atMs });
        break;
    }
  }
  for (const list of certified.values()) list.sort((a, b) => a - b);
  const lastCleaningBefore = (resourceId, t) => {
    let result = -INF;
    for (const x of certified.get(resourceId) ?? []) {
      if (x <= t) result = x;
      else break;
    }
    return result;
  };
  const nextCleaningAfter = (resourceId, t) => {
    for (const x of certified.get(resourceId) ?? []) {
      if (x >= t) return x;
    }
    return INF;
  };

  // ---- 样本：培养期生效与舱门失效 ----
  const batchInChamberAt = (batchId, resourceId, t) =>
    (contactsByBatch.get(batchId) ?? []).some(
      (c) => c.resource_id === resourceId && c.resource_type === "chamber" && c.start <= t && t < (c.end ?? INF),
    );
  const sampleRows = [];
  for (const r of results) {
    const s = samples.get(r.sample_id);
    let voidAt = null;
    for (const d of doorOpenings) {
      // 舱门在培养期 (采样, 采样+最短培养期) 内开启 → 当前循环失效
      if (!(s.at < d.at && d.at < s.at + cultureMs)) continue;
      const concerns =
        s.subject_kind === "resource" ? s.subject_id === d.resource_id : batchInChamberAt(s.subject_id, d.resource_id, d.at);
      if (concerns) {
        voidAt = d.at;
        break;
      }
    }
    const effectiveAt = s.at + cultureMs;
    sampleRows.push({
      ...s,
      result: r.result,
      strain: r.strain,
      reported_at: r.at,
      effective_at: effectiveAt,
      void: voidAt !== null,
      void_at: voidAt,
      // 阴性须等最短培养期结束才生效；失效样本永不生效
      effective: r.result === "negative" && voidAt === null && effectiveAt <= now,
    });
  }

  // ---- 污染传播（不动点迭代）----
  // 阳性主体自上一次认证清洁起视为污染，直至下一次认证清洁（清洁证明构成传播边界）。
  // 共用资源的接触时段与污染窗口重叠 → 对方自重叠起点被污染。
  const contaminated = new Map();
  const addInterval = (key, kind, id, start, end, reason) => {
    let subj = contaminated.get(key);
    if (!subj) {
      subj = { kind, id, intervals: [], reasons: [], detected_at: null, root_strain: null };
      contaminated.set(key, subj);
    }
    if (reason) {
      if (!subj.reasons.some((r) => r.label === reason.label)) subj.reasons.push(reason);
      if (reason.detected_at != null && (subj.detected_at == null || reason.detected_at < subj.detected_at)) {
        subj.detected_at = reason.detected_at;
      }
      if (reason.root_strain && !subj.root_strain) subj.root_strain = reason.root_strain;
    }
    for (const iv of subj.intervals) {
      if (iv.start <= end && start <= iv.end) {
        let changed = false;
        if (start < iv.start) {
          iv.start = start;
          changed = true;
        }
        if (end > iv.end) {
          iv.end = end;
          changed = true;
        }
        return changed;
      }
    }
    subj.intervals.push({ start, end });
    return true;
  };

  for (const row of sampleRows) {
    if (row.result !== "positive") continue;
    const isResource = row.subject_kind === "resource";
    const start = isResource ? lastCleaningBefore(row.subject_id, row.at) : -INF;
    const end = isResource ? nextCleaningAfter(row.subject_id, row.at) : INF;
    addInterval(isResource ? resourceKey(row.subject_id) : batchKey(row.subject_id), row.subject_kind, row.subject_id, start, end, {
      kind: "source",
      label: `复检样本 ${row.sample_id} 阳性（${row.strain ?? "未知菌种"}）`,
      sample_id: row.sample_id,
      detected_at: row.reported_at,
      root_strain: row.strain,
    });
  }

  const fmtRange = (s, e) => `${formatTime(s)} ~ ${formatTime(e)}`;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;
    for (const subj of [...contaminated.values()]) {
      const list = subj.kind === "batch" ? contactsByBatch.get(subj.id) ?? [] : contactsByResource.get(subj.id) ?? [];
      for (const c of list) {
        for (const iv of subj.intervals) {
          const oStart = Math.max(c.start, iv.start);
          const oEnd = Math.min(c.end ?? INF, iv.end);
          if (!(oStart < oEnd)) continue;
          if (subj.kind === "batch") {
            changed =
              addInterval(resourceKey(c.resource_id), "resource", c.resource_id, oStart, nextCleaningAfter(c.resource_id, oStart), {
                kind: "via",
                label: `接触 ${c.contact_id}（${c.resource_id}，${fmtRange(oStart, oEnd)}）与 ${subj.id} 的污染窗口重叠`,
                contact_id: c.contact_id,
                from: batchKey(subj.id),
                detected_at: subj.detected_at,
                root_strain: subj.root_strain,
              }) || changed;
          } else {
            changed =
              addInterval(batchKey(c.batch_id), "batch", c.batch_id, oStart, INF, {
                kind: "via",
                label: `接触 ${c.contact_id}（${subj.id}，${fmtRange(oStart, oEnd)}）处于污染窗口内`,
                contact_id: c.contact_id,
                from: resourceKey(subj.id),
                detected_at: subj.detected_at,
                root_strain: subj.root_strain,
              }) || changed;
          }
        }
      }
    }
  }

  // ---- 批次结论：召回或排除（附排除原因）----
  const batchIds = new Set([
    ...contactsByBatch.keys(),
    ...releases.map((r) => r.batch_id),
    ...sampleRows.filter((s) => s.subject_kind === "batch").map((s) => s.subject_id),
  ]);
  const batches = new Map();
  for (const id of batchIds) {
    const subj = contaminated.get(batchKey(id));
    const releasedAt = releases.filter((r) => r.batch_id === id).map((r) => r.at).sort((a, b) => a - b).at(-1) ?? null;
    batches.set(id, {
      batch_id: id,
      contaminated: Boolean(subj),
      intervals: subj?.intervals ?? [],
      reasons: subj?.reasons ?? [],
      detected_at: subj?.detected_at ?? null,
      released_at: releasedAt,
      status: subj ? "recall" : "clear",
      exclusions: [],
    });
  }
  for (const b of batches.values()) {
    if (b.contaminated) continue;
    for (const c of contactsByBatch.get(b.batch_id) ?? []) {
      const rsubj = contaminated.get(resourceKey(c.resource_id));
      if (!rsubj) continue;
      for (const iv of rsubj.intervals) {
        const cEnd = c.end ?? INF;
        if (cEnd <= iv.start) {
          b.exclusions.push({
            contact_id: c.contact_id,
            resource_id: c.resource_id,
            reason: `接触 ${c.contact_id} 结束（${formatTime(cEnd)}）早于 ${c.resource_id} 污染窗口开始（${formatTime(iv.start)}）`,
          });
        } else if (c.start >= iv.end) {
          b.exclusions.push({
            contact_id: c.contact_id,
            resource_id: c.resource_id,
            reason: `接触 ${c.contact_id} 开始（${formatTime(c.start)}）晚于 ${c.resource_id} 的清洁认证边界（${formatTime(iv.end)}）`,
          });
        }
      }
    }
  }

  // ---- 资源可用性（只报告真正安全可用的舱位）----
  const resourceIds = new Set([...resources.map((r) => r.resource_id), ...contactsByResource.keys()]);
  const availability = [];
  for (const rid of resourceIds) {
    const meta = resourceById.get(rid);
    const type = meta?.resource_type ?? contacts.find((c) => c.resource_id === rid)?.resource_type ?? null;
    const reasons = [];
    const activeInterval = contaminated.get(resourceKey(rid))?.intervals.find((iv) => iv.start <= now && now < iv.end);
    if (activeInterval) reasons.push(`污染未清除（窗口至 ${formatTime(activeInterval.end)}）`);
    if ([...cleanings.values()].some((c) => c.resource_id === rid && c.certified_at === null)) reasons.push("清洁已开始但未认证");
    const occupying = (contactsByResource.get(rid) ?? []).filter((c) => c.start <= now && now < (c.end ?? INF));
    if (occupying.length) reasons.push(`占用中（${occupying.map((c) => c.batch_id).join("、")}）`);
    // 高风险规程：清洁认证后仍须阴性培养生效，才算真正安全
    for (const p of sampleRows.filter((s) => s.subject_kind === "resource" && s.subject_id === rid && s.result === "positive")) {
      if (!protocolFor(p.strain)?.requires_post_cleaning_negative) continue;
      const cleanAt = nextCleaningAfter(rid, p.at);
      if (cleanAt === INF) continue; // 尚未清洁，上面已标记污染
      const post = sampleRows.find((s) => s.subject_kind === "resource" && s.subject_id === rid && s.result === "negative" && !s.void && s.at >= cleanAt);
      if (!post) reasons.push("清洁后阴性样本缺失");
      else if (post.effective_at > now) reasons.push(`清洁后阴性尚未生效（${formatTime(post.effective_at)} 生效）`);
    }
    availability.push({ resource_id: rid, resource_type: type, available: reasons.length === 0, reasons, capacity: capacityOf(rid) });
  }

  // ---- 放行合规：放行时刻必须已有生效阴性 ----
  const releaseChecks = releases.map((r) => {
    const ok = sampleRows.some((s) => s.subject_kind === "batch" && s.subject_id === r.batch_id && s.result === "negative" && !s.void && s.effective_at <= r.at);
    return { batch_id: r.batch_id, at: r.at, valid: ok, reason: ok ? null : "放行时无已生效阴性结果（培养期未满或样本已失效）" };
  });

  // ---- 资源竞争：并发接触不得超过容量 ----
  const conflicts = [];
  for (const [rid, list] of contactsByResource) {
    const cap = capacityOf(rid);
    const points = [];
    for (const c of list) {
      points.push({ t: c.start, d: 1, c });
      points.push({ t: c.end ?? INF, d: -1, c });
    }
    points.sort((a, b) => a.t - b.t || a.d - b.d);
    let current = 0;
    let episode = false;
    const active = new Set();
    for (const p of points) {
      if (p.d === 1) {
        current++;
        active.add(p.c.contact_id);
        if (current > cap && !episode) {
          episode = true;
          conflicts.push({ resource_id: rid, at: p.t, concurrent: current, capacity: cap, contacts: [...active] });
        }
      } else {
        current--;
        active.delete(p.c.contact_id);
        if (current <= cap) episode = false;
      }
    }
  }

  return { now, sampleRows, contaminated, batches, availability, releaseChecks, conflicts, contacts, events };
}

// 把某批次的污染来源展开为主推导链（供调度人员回答“为何波及”）。
// 每个主体沿首次致污的原因回溯到阳性源头；全部旁证仍保留在 reasons 中。
export function explainChain(state, batchId) {
  const lines = [];
  const visit = (key, depth, seen) => {
    const subj = state.contaminated.get(key);
    if (!subj || seen.has(key) || !subj.reasons.length) return;
    seen.add(key);
    const primary = subj.reasons[0];
    lines.push(`${"　".repeat(depth)}↳ ${subj.id}：${primary.label}`);
    if (primary.from) visit(primary.from, depth + 1, seen);
  };
  visit(batchKey(batchId), 0, new Set());
  return lines;
}
