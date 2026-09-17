import { addHours } from "./time.js";

// 采样生命周期：
//  - positive：报告时刻即确认
//  - negative：采样满 minimum_culture_hours 才生效；提前报告的阴性不生效
//  - 报告晚于 sample_report_deadline_hours：结果失效，须重采
//  - 培养周期内舱门开启：当前周期作废
export function buildSamples(model) {
  const { events, inspection } = model;
  const minHours = inspection.minimum_culture_hours;
  const deadlineHours = inspection.sample_report_deadline_hours;
  const delayHours = inspection.door_retest_delay_hours;

  const taken = new Map();
  for (const e of events) {
    if (e.type === "sample_taken") {
      taken.set(e.sample_id, {
        sample_id: e.sample_id,
        batch_id: e.batch_id,
        taken_at: e._at,
        reason: e.reason ?? "routine",
      });
    }
  }

  const samples = [...taken.values()];
  for (const s of samples) {
    s.report = null;
    s.effective_at = null;
    s.status = "pending"; // pending | positive | negative_effective | premature_negative | stale
  }

  for (const e of events) {
    if (e.type !== "result_reported") continue;
    const s = taken.get(e.sample_id);
    if (!s) throw new Error(`结果 ${e.event_id} 引用未知样本 ${e.sample_id}`);
    if (s.batch_id !== e.batch_id) throw new Error(`结果 ${e.event_id} 批次与采样不一致`);
    const ageHours = (e._at - s.taken_at) / model.HOUR;
    const report = {
      at: e._at,
      event_id: e.event_id,
      result: e.result,
      species: e.species ?? null,
      age_hours: ageHours,
    };
    s.report = report;
    if (e.result === "positive") {
      s.status = "positive";
      s.effective_at = e._at;
    } else if (ageHours > deadlineHours + 1e-9) {
      s.status = "stale";
    } else if (ageHours >= minHours - 1e-9) {
      s.status = "negative_effective";
      // 生效时刻取 max(报告时间, 采样+最短培养期)
      s.effective_at = Math.max(e._at, addHours(s.taken_at, minHours));
    } else {
      s.status = "premature_negative";
    }
  }

  // 舱门开启 → 作废开启时刻仍在舱（接触未结束）批次的未生效周期
  const invalidations = [];
  for (const e of events) {
    if (e.type !== "door_opened") continue;
    const occupants = model.contacts.filter(
      (c) =>
        c.resource_type === "chamber" &&
        c.resource_id === e.resource_id &&
        c._start <= e._at &&
        (c.ended_at == null || c._end > e._at),
    );
    for (const occ of occupants) {
      invalidations.push({
        door_event_id: e.event_id,
        chamber_id: e.resource_id,
        at: e._at,
        batch_id: occ.batch_id,
        retest_due_at: addHours(e._at, delayHours),
      });
      for (const s of samples) {
        if (s.batch_id !== occ.batch_id) continue;
        if (s.taken_at <= e._at && (s.status === "pending" || s.status === "premature_negative")) {
          s.status = "invalidated_by_door";
          s.invalidated_at = e._at;
        }
      }
    }
  }

  const byBatch = new Map();
  for (const s of samples) {
    if (!byBatch.has(s.batch_id)) byBatch.set(s.batch_id, []);
    byBatch.get(s.batch_id).push(s);
  }
  for (const list of byBatch.values()) list.sort((a, b) => a.taken_at - b.taken_at);

  return { samples, byBatch, invalidations };
}
