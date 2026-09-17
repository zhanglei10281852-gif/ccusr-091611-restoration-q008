import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { loadModel } from "../src/model.js";
import { buildSamples } from "../src/samples.js";
import { trace } from "../src/tracer.js";
import { cleaningBoundaries } from "../src/cleaning.js";
import { capacityViolations, safeChambers } from "../src/capacity.js";
import { buildPlan } from "../src/scheduler.js";
import { Runner } from "../src/runner.js";
import { parse, fmt } from "../src/time.js";

const model = await loadModel();
const t = (iso) => parse(iso);

// ---------- 样本 / 培养期 / 舱门 ----------
test("样本生命周期：阳性即时确认、阴性满培养期才生效", () => {
  const { byBatch } = buildSamples(model);
  const s16 = byBatch.get("batch-organic-16").find((s) => s.sample_id === "s-16-0");
  assert.equal(s16.status, "negative_effective");
  // 报告 11:00 晚于采样+72h（次日 10:00）→ 生效取报告时刻
  assert.equal(s16.effective_at, t("2026-09-09T11:00:00+08:00"));

  const s11pos = byBatch.get("batch-organic-11").find((s) => s.sample_id === "s-11-pos");
  assert.equal(s11pos.status, "positive");
  assert.equal(s11pos.effective_at, t("2026-09-12T18:00:00+08:00"));
});

test("未满最短培养期的阴性不生效，按原采样时间安排复检", () => {
  const { byBatch } = buildSamples(model);
  const s = byBatch.get("batch-organic-31").find((x) => x.sample_id === "s-31-b");
  assert.equal(s.status, "premature_negative");
  assert.equal(s.effective_at, null);
  const plan = buildPlan(model);
  const retest = plan.decisions.find((d) => d.type === "retest_due" && d.sample_id === "s-31-b");
  assert.equal(retest.scheduled_at_iso, fmt(t("2026-09-14T14:00:00+08:00")));
});

test("超过检验时限的阴性结果失效并要求重采", () => {
  const { byBatch } = buildSamples(model);
  const s = byBatch.get("batch-organic-40").find((x) => x.sample_id === "s-40-old");
  assert.equal(s.status, "stale");
  const plan = buildPlan(model);
  assert.ok(plan.decisions.some((d) => d.type === "hold_due" && d.batch_id === "batch-organic-40"));
});

test("舱门意外开启作废在舱批次当前培养周期，30分钟后定时复检", () => {
  const state = buildSamples(model);
  const statuses = new Map(state.samples.map((s) => [s.sample_id, s.status]));
  assert.equal(statuses.get("s-52-0"), "invalidated_by_door");
  assert.equal(statuses.get("s-11-pre"), "invalidated_by_door");
  const plan = buildPlan(model);
  const inv = plan.decisions.filter((d) => d.type === "cycle_invalidated");
  assert.deepEqual(inv.map((d) => d.batch_id).sort(), ["batch-organic-11", "batch-organic-52"]);
  const retest = plan.decisions.find((d) => d.type === "retest_due" && d.batch_id === "batch-organic-52" && d.reason === "door_opened");
  assert.equal(retest.scheduled_at_iso, fmt(t("2026-09-12T02:30:00+08:00")));
});

// ---------- 传播谱系 ----------
const positive = buildSamples(model).samples.find((s) => s.status === "positive");
const tr = trace(model, positive.batch_id, positive.effective_at);

test("影响集合：直接时间重叠与共用资源滞留均扩展集合", () => {
  // 16 与阳性批次在 vehicle-2 时间重叠；23/31 在阳性批次离开后上车（滞留传播）
  for (const b of ["batch-organic-16", "batch-organic-23", "batch-organic-31", "batch-organic-52"]) {
    assert.ok(tr.infectedAt.has(b), `${b} 应在影响集合内`);
  }
  // 52 最早经 chamber-b 与已感染的 16 时间重叠（9/10 20:00）；chamber-a 是另一条更晚路径
  const ev52 = tr.evidence
    .filter((e) => e.batch_id === "batch-organic-52")
    .sort((a, b) => a.at - b.at)[0];
  assert.equal(ev52.resource_id, "chamber-b");
  assert.equal(ev52.kind, "shared_resource_overlap");
  assert.equal(tr.infectedAt.get("batch-organic-52"), t("2026-09-10T20:00:00+08:00"));
  // 16 为时间重叠传播；23 为阳性批次离开后的滞留传播
  const ev16 = tr.evidence.find((e) => e.batch_id === "batch-organic-16");
  assert.equal(ev16.kind, "shared_resource_overlap");
  const ev23 = tr.evidence.find((e) => e.batch_id === "batch-organic-23");
  assert.equal(ev23.kind, "shared_resource_persistence");
  assert.equal(ev23.resource_id, "vehicle-2");
});

test("传播不能越过已证明清洁完成的边界", () => {
  const b = cleaningBoundaries(model);
  // chamber-c 与 tray-5 于 9/9 14:30 取得有效证明（40 在证明前使用，80 在证明后使用）
  assert.ok(b.get("chamber-c").some((c) => c.valid && c.at === t("2026-09-09T14:30:00+08:00")));
  // 80 使用 chamber-c/tray-5/bench-1，全部位于有效清洁之后 → 排除
  assert.ok(!tr.infectedAt.has("batch-organic-80"));
  // vehicle-5 证明 12:30 阻断 16(上午)→11(下午)；11 只作为阳性种子本身
  assert.ok(!tr.evidence.some((e) => e.batch_id === "batch-organic-11" && e.resource_id === "vehicle-5"));
  // bench-1 证明 15:00 阻断 16/23/40 → 80
  assert.ok(!tr.evidence.some((e) => e.batch_id === "batch-organic-80"));
});

test("仅 cleaning_started 不构成边界：vehicle-2 消杀未证明，滞留传播继续", () => {
  const v2 = cleaningBoundaries(model).get("vehicle-2");
  assert.ok(!v2 || v2.every((c) => !c.valid));
  assert.ok(tr.infectedAt.has("batch-organic-23"));
  assert.ok(tr.infectedAt.has("batch-organic-31"));
});

test("传播不能回溯：后到的阳性不感染已离开的批次", () => {
  // 40 的全部接触早于/无重叠连通路径到阳性区域，且被清洁边界切断
  assert.ok(!tr.infectedAt.has("batch-organic-40"));
  // 70 只使用独立的 chamber-d，与其阳性集合无任何资源相交
  assert.ok(!tr.infectedAt.has("batch-organic-70"));
});

test("阳性批次既往接触被回溯为种子（解释为何波及同车早班批次）", () => {
  assert.ok(tr.evidence.some((e) => e.kind === "source_retroactive"));
  // 16 最早暴露时刻 = 两车重叠开始 09:00
  assert.equal(tr.infectedAt.get("batch-organic-16"), t("2026-09-10T09:00:00+08:00"));
});

// ---------- 舱位安全与资源竞争 ----------
test("调度员只能看到真正安全可用的舱位", () => {
  const at = t("2026-09-12T19:00:00+08:00");
  const rows = safeChambers(model, tr, at);
  const byId = new Map(rows.map((r) => [r.chamber_id, r]));
  assert.equal(byId.get("chamber-d").safe, true, "chamber-d 清洁证明后无污染，应有空舱位");
  assert.equal(byId.get("chamber-a").safe, false, "chamber-a 容纳阳性与52，污染中");
  assert.equal(byId.get("chamber-b").safe, false, "chamber-b 被已感染的31占用");
  assert.equal(byId.get("chamber-c").safe, false, "chamber-c 虽清洁，但80在舱无空位");
  assert.ok(byId.get("chamber-c").reasons.some((r) => r.includes("无空闲舱位")));
});

test("资源竞争不可超配：样例数据无超配", () => {
  assert.deepEqual(capacityViolations(model), []);
});

// ---------- 定时决定 ----------
test("召回决定：已放行批次同样召回并附证据链", () => {
  const plan = buildPlan(model);
  const recalls = plan.decisions.filter((d) => d.type === "recall_due");
  const recalled = new Map(recalls.map((d) => [d.batch_id, d]));
  assert.deepEqual([...recalled.keys()].sort(), ["batch-organic-16", "batch-organic-23", "batch-organic-31", "batch-organic-52"]);
  assert.equal(recalled.get("batch-organic-16").had_been_released, true);
  assert.equal(recalled.get("batch-organic-31").had_been_released, true);
  assert.equal(recalled.get("batch-organic-52").had_been_released, false);
  assert.ok(recalled.get("batch-organic-16").chain.length >= 1);
});

test("放行早于阴性生效时刻为例外；生效后的放行当时有效（之后可再被召回）", () => {
  const plan = buildPlan(model);
  const ex = plan.decisions.find((d) => d.type === "release_exception" && d.batch_id === "batch-organic-31");
  assert.ok(ex, "31 在 09:30 放行，但阴性 10:00 才生效");
  const rel16 = plan.decisions.find((d) => d.type === "batch_released" && d.batch_id === "batch-organic-16");
  assert.ok(rel16 && rel16.formal_release_recorded);
});

test("阳性通知与源头处置按菌种风险级别生成", () => {
  const plan = buildPlan(model);
  const note = plan.decisions.find((d) => d.type === "positive_notification");
  assert.equal(note.species, "aspergillus-active");
  assert.equal(note.risk_level, "high");
  assert.ok(plan.decisions.some((d) => d.type === "source_treatment_due"));
});

test("全部决定严格按事件原本发生时间排序", () => {
  const plan = buildPlan(model);
  const ts = plan.decisions.map((d) => d.scheduled_at);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

// ---------- 进程恢复 ----------
test("进程中断恢复后决定按原事件时间继续且不重复派发", async () => {
  const statePath = "/tmp/mold-quarantine-test-state/runner.json";
  await rm(statePath, { force: true });
  const plan = buildPlan(model, { now: t("2026-09-30T00:00:00+08:00") });
  const runner = new Runner(statePath);

  // 模拟派发 3 个决定后进程崩溃
  await assert.rejects(() => runner.start(plan, t("2026-09-30T00:00:00+08:00"), { crashAfter: 3 }));
  let state = await runner.load();
  assert.equal(state.cursor, 3);

  // 恢复：剩余决定继续派发
  const rest = await runner.advance(t("2026-09-30T00:00:00+08:00"));
  state = await runner.load();
  assert.equal(state.cursor, plan.decisions.length);
  assert.equal(rest.length, plan.decisions.length - 3);

  // 再恢复无重复
  const again = await runner.advance(t("2026-09-30T00:00:00+08:00"));
  assert.equal(again.length, 0);

  // scheduled_at 始终是事件原本时间，而非派发墙钟时间
  const fired = state.decisions;
  assert.ok(fired[0].scheduled_at < t("2026-09-30T00:00:00+08:00"));
  assert.deepEqual(
    fired.map((d) => d.scheduled_at),
    [...fired.map((d) => d.scheduled_at)].sort((a, b) => a - b),
  );
  await rm("/tmp/mold-quarantine-test-state", { recursive: true, force: true });
});

test("恢复时未到事件时间的未来决定不会提前派发", async () => {
  const statePath = "/tmp/mold-quarantine-test-state-2/runner.json";
  await rm(statePath, { force: true });
  const plan = buildPlan(model);
  const runner = new Runner(statePath);
  await runner.start(plan, plan.decisions[0].scheduled_at - 1);
  const state = await runner.load();
  assert.equal(state.cursor, 0);
  await rm("/tmp/mold-quarantine-test-state-2", { recursive: true, force: true });
});

// ---------- 合成数据：检测器必须真的能发现问题 ----------
test("超配检测：舱室超额与托盘双承载都会被发现", () => {
  const synthetic = {
    resources: {
      chambers: [
        { chamber_id: "c1", capacity: 1, tray_ids: ["t1"] },
        { chamber_id: "c2", capacity: 2, tray_ids: ["t2"] },
      ],
    },
    trayChamber: new Map([["t1", "c1"], ["t2", "c2"]]),
    contacts: [
      { contact_id: "x1", resource_type: "chamber", resource_id: "c1", batch_id: "B1", _start: 0, _end: 100 },
      { contact_id: "x2", resource_type: "chamber", resource_id: "c1", batch_id: "B2", _start: 10, _end: 90 },
      { contact_id: "x3", resource_type: "tray", resource_id: "t2", batch_id: "B3", _start: 0, _end: 100 },
      { contact_id: "x4", resource_type: "tray", resource_id: "t2", batch_id: "B4", _start: 50, _end: 150 },
    ],
  };
  const v = capacityViolations(synthetic);
  assert.ok(v.some((x) => x.resource_id === "c1" && x.count === 2 && x.capacity === 1));
  assert.ok(v.some((x) => x.resource_id === "t2" && x.batch_ids.sort().join() === "B3,B4"));
});

test("清洁证明校验：缺步骤、时长不足、仅有 started 均不构成边界", () => {
  const H = model.HOUR;
  const synthetic = {
    HOUR: H,
    protocolsByType: model.protocolsByType,
    events: [
      { event_id: "s1", type: "cleaning_started", _at: 0, resource_id: "r-missing-step", resource_type: "chamber" },
      { event_id: "c1", type: "cleaning_certified", _at: 3 * H, resource_id: "r-missing-step", resource_type: "chamber", steps: ["表面擦拭"] },
      { event_id: "s2", type: "cleaning_started", _at: 0, resource_id: "r-too-short", resource_type: "vehicle" },
      { event_id: "c2", type: "cleaning_certified", _at: 0.5 * H, resource_id: "r-too-short", resource_type: "vehicle", steps: ["表面擦拭"] },
      { event_id: "s3", type: "cleaning_started", _at: 0, resource_id: "r-start-only", resource_type: "vehicle" },
      { event_id: "s4", type: "cleaning_started", _at: 0, resource_id: "r-valid", resource_type: "vehicle" },
      { event_id: "c4", type: "cleaning_certified", _at: 1 * H, resource_id: "r-valid", resource_type: "vehicle", steps: ["表面擦拭"] },
    ],
  };
  const b = cleaningBoundaries(synthetic);
  assert.equal(b.get("r-missing-step")[0].valid, false);
  assert.match(b.get("r-missing-step")[0].reason, /缺少步骤/);
  assert.equal(b.get("r-too-short")[0].valid, false);
  assert.match(b.get("r-too-short")[0].reason, /不足/);
  assert.equal((b.get("r-start-only") ?? []).filter((c) => c.valid).length, 0);
  assert.equal(b.get("r-valid")[0].valid, true);
});

test("边界阻断是定向的：证明时刻之前的接触仍可被追溯感染", () => {
  // chamber-c 证明在 9/9 14:30；批次 40 在证明前使用该舱，
  // 若它另有与阳性集合相连的路径，清洁证明不能“洗白”证明之前的暴露。
  // 本样例中 40 无任何连通路径，故安全；此处校验证明时刻本身不排除早段接触参与计算。
  const segs = tr.segmentsByResource.get("chamber-c");
  const pre = segs.filter((s) => s.start < t("2026-09-09T14:30:00+08:00"));
  const post = segs.filter((s) => s.start >= t("2026-09-09T14:30:00+08:00"));
  assert.ok(pre.some((s) => s.batch_id === "batch-organic-40"));
  assert.ok(post.every((s) => s.region > 0));
});
