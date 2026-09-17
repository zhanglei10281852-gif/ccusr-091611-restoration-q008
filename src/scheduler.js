import { addHours, fmt } from "./time.js";
import { buildSamples } from "./samples.js";
import { trace } from "./tracer.js";

let seq = 0;
function decision(type, scheduledAt, fields = {}) {
  return {
    decision_id: `d-${String(++seq).padStart(3, "0")}`,
    type,
    scheduled_at: scheduledAt,
    scheduled_at_iso: fmt(scheduledAt),
    ...fields,
  };
}

// 纯函数：由完整事件史推导全部定时决定，按事件原本发生的时刻排序。
// 运行器（runner）负责在进程恢复后按 scheduled_at 继续派发。
export function buildPlan(model, { now = Date.now() } = {}) {
  const sampleState = buildSamples(model);
  const { samples, byBatch, invalidations } = sampleState;

  const positive = samples.find((s) => s.status === "positive");
  const sourceBatchId = positive?.batch_id ?? null;
  const tr = sourceBatchId ? trace(model, sourceBatchId, positive.effective_at) : null;

  const releasedAt = new Map(); // batch_id -> 正式放行事件
  for (const e of model.events) {
    if (e.type === "batch_released") releasedAt.set(e.batch_id, e);
  }

  const decisions = [];

  // 1) 舱门意外开启：周期作废 + 定时复检
  for (const inv of invalidations) {
    decisions.push(
      decision("cycle_invalidated", inv.at, {
        batch_id: inv.batch_id,
        chamber_id: inv.chamber_id,
        door_event_id: inv.door_event_id,
      }),
      decision("retest_due", inv.retest_due_at, {
        batch_id: inv.batch_id,
        chamber_id: inv.chamber_id,
        reason: "door_opened",
        ref_event_id: inv.door_event_id,
      }),
    );
  }

  // 2) 无效结果：超时失效 / 未满培养期
  for (const s of samples) {
    if (s.status === "stale") {
      decisions.push(
        decision("hold_due", s.report.at, { batch_id: s.batch_id, sample_id: s.sample_id, reason: "报告超检验时限，结果失效" }),
        decision("retest_due", s.report.at, { batch_id: s.batch_id, sample_id: s.sample_id, reason: "stale_report" }),
      );
    } else if (s.status === "premature_negative") {
      decisions.push(
        decision("hold_due", s.report.at, { batch_id: s.batch_id, sample_id: s.sample_id, reason: `阴性报告时培养仅 ${s.report.age_hours}h，未满 ${model.inspection.minimum_culture_hours}h` }),
        decision("retest_due", addHours(s.taken_at, model.inspection.minimum_culture_hours), {
          batch_id: s.batch_id,
          sample_id: s.sample_id,
          reason: "await_culture_completion",
        }),
      );
    }
  }

  // 3) 阴性生效时刻的释放决定（放行事件校验）
  for (const s of samples) {
    if (s.status !== "negative_effective") continue;
    const rel = releasedAt.get(s.batch_id);
    const exposed = tr ? tr.infectedAt.has(s.batch_id) && tr.infectedAt.get(s.batch_id) <= s.effective_at : false;

    if (rel && rel._at < s.effective_at) {
      decisions.push(
        decision("release_exception", rel._at, {
          batch_id: s.batch_id,
          sample_id: s.sample_id,
          reason: "放行早于阴性生效时刻",
          release_event_id: rel.event_id,
        }),
      );
    } else if (exposed) {
      decisions.push(
        decision("release_denied", s.effective_at, {
          batch_id: s.batch_id,
          sample_id: s.sample_id,
          reason: "阴性生效时该批次已处于阳性传播影响集合内",
          exposed_at: tr.infectedAt.get(s.batch_id),
        }),
      );
    } else {
      decisions.push(
        decision("batch_released", s.effective_at, {
          batch_id: s.batch_id,
          sample_id: s.sample_id,
          basis: "阴性结果满最短培养期生效",
          formal_release_recorded: !!rel && rel._at >= s.effective_at,
        }),
      );
    }
  }

  // 4) 阳性确认：通知、源头处置、按暴露时刻排序的召回（已放行批次同样召回）
  if (positive) {
    const t = positive.effective_at;
    decisions.push(
      decision("positive_notification", t, {
        batch_id: sourceBatchId,
        sample_id: positive.sample_id,
        species: positive.report.species,
        risk_level: model.risks.species[positive.report.species]?.level ?? null,
      }),
      decision("source_treatment_due", t, {
        batch_id: sourceBatchId,
        reason: model.risks.species[positive.report.species]?.action ?? "source_batch_treatment",
      }),
    );

    const exposed = [...tr.infectedAt.entries()]
      .filter(([b]) => b !== sourceBatchId)
      .sort((a, b) => a[1] - b[1]);
    for (const [batchId, at] of exposed) {
      const wasReleased = releasedAt.has(batchId) && releasedAt.get(batchId)._at < t;
      decisions.push(
        decision("recall_due", t, {
          batch_id: batchId,
          exposed_at: at,
          had_been_released: wasReleased,
          release_event_id: wasReleased ? releasedAt.get(batchId).event_id : null,
          chain: tr.evidence
            .filter((e) => e.batch_id === batchId)
            .map((e) => ({ kind: e.kind, resource_id: e.resource_id, contact_id: e.contact_id })),
        }),
      );
    }
  }

  decisions.sort((a, b) => a.scheduled_at - b.scheduled_at || a.decision_id.localeCompare(b.decision_id));
  for (const [i, d] of decisions.entries()) {
    if (!d.decision_id) d.decision_id = `d-${String(i + 1).padStart(3, "0")}`;
  }

  return {
    generated_at: now,
    source_batch_id: sourceBatchId,
    positive_confirmed_at: positive?.effective_at ?? null,
    decisions,
    trace: tr
      ? {
          infected: [...tr.infectedAt.entries()]
            .filter(([b]) => b !== sourceBatchId)
            .map(([batch_id, at]) => ({ batch_id, exposed_at: at, exposed_at_iso: fmt(at) }))
            .sort((a, b) => a.exposed_at - b.exposed_at),
          evidence: tr.evidence,
        }
      : null,
    samples: samples.map((s) => ({
      sample_id: s.sample_id,
      batch_id: s.batch_id,
      status: s.status,
      taken_at: s.taken_at,
      effective_at: s.effective_at,
      report_at: s.report?.at ?? null,
    })),
    invalidations,
  };
}
