import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadEventFile, normalizeEvents } from "../src/log.js";
import { deriveState, explainChain } from "../src/engine.js";
import { deriveJobs } from "../src/scheduler.js";
import { assertAllocation, AllocationError } from "../src/allocate.js";
import { parseTime } from "../src/time.js";

const readJson = async (rel) => JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));
const contract = await readJson("../domain/contract.json");
const resources = await readJson("../domain/resources.json");
const strains = await readJson("../domain/strains.json");
const protocols = await readJson("../domain/protocols.json");
const raw = await loadEventFile(new URL("../examples/events.json", import.meta.url).pathname);
const { events, contacts } = normalizeEvents(raw, contract);

const NOW = parseTime("2026-09-11T12:00:00+08:00");
const derive = (now) => deriveState({ events, contacts, contract, resources, strains, protocols, now });
const state = derive(NOW);

const recallIds = (s) => [...s.batches.values()].filter((b) => b.contaminated).map((b) => b.batch_id).sort();

test("新阳性经共用资源时间重叠波及应召回的批次", () => {
  assert.deepEqual(recallIds(state), ["batch-organic-11", "batch-organic-16", "batch-organic-21", "batch-organic-22"]);
});

test("召回推导链可解释到阳性源头", () => {
  const chain = explainChain(state, "batch-organic-21").join("\n");
  assert.match(chain, /contact-3/); // 批次 21 经 contact-3 接触 vehicle-2
  assert.match(chain, /vehicle-2/);
  assert.match(chain, /s-c1/); // 源头是 chamber-1 的复检阳性样本
});

test("清洁认证边界阻断传播：边界之后的接触被排除", () => {
  const b23 = state.batches.get("batch-organic-23");
  assert.equal(b23.contaminated, false);
  assert.equal(b23.exclusions.length, 1);
  assert.match(b23.exclusions[0].reason, /清洁认证边界/);
});

test("污染窗口开始之前的接触被排除", () => {
  const b24 = state.batches.get("batch-organic-24");
  assert.equal(b24.contaminated, false);
  assert.match(b24.exclusions[0].reason, /早于 vehicle-2 污染窗口开始/);
});

test("阴性结果须等最短培养期结束才生效", () => {
  const s1 = state.sampleRows.find((s) => s.sample_id === "s-1");
  assert.equal(s1.effective_at, parseTime("2026-09-12T08:30:00+08:00")); // 采样 + 72h
  assert.equal(s1.effective, false); // 报告时培养期未满
  const later = derive(parseTime("2026-09-12T08:30:00+08:00"));
  assert.equal(later.sampleRows.find((s) => s.sample_id === "s-1").effective, true); // 到期即刻生效
});

test("舱门意外开启使当前培养循环失效", () => {
  const s16 = state.sampleRows.find((s) => s.sample_id === "s-16");
  assert.equal(s16.void, true);
  assert.equal(s16.void_at, parseTime("2026-09-11T10:00:00+08:00"));
  assert.equal(s16.effective, false);
  const jobs = deriveJobs(state, { protocols, strains, now: NOW });
  assert.ok(jobs.some((j) => j.id === "notify:resample:s-16")); // 触发重新采样通知
  assert.ok(!jobs.some((j) => j.id === "release:s-16")); // 失效样本不再产生释放决定
});

test("只报告真正安全可用的舱位", () => {
  const byId = new Map(state.availability.map((a) => [a.resource_id, a]));
  assert.equal(byId.get("chamber-3").available, true);
  assert.equal(byId.get("chamber-1").available, false); // 高风险规程：清洁后阴性培养期未满
  assert.match(byId.get("chamber-1").reasons.join(), /清洁后阴性尚未生效/);
  assert.equal(byId.get("chamber-2").available, false); // 被污染批次占用且已污染
  assert.match(byId.get("chamber-2").reasons.join(), /污染未清除/);
  assert.equal(byId.get("tray-5").available, false); // 污染后一直未清洁
  assert.equal(byId.get("vehicle-2").available, true); // 认证清洁之后恢复可用
});

test("清洁后阴性生效且空闲后舱位恢复可用", () => {
  const later = derive(parseTime("2026-09-13T19:00:00+08:00"));
  const chamber1 = later.availability.find((a) => a.resource_id === "chamber-1");
  assert.equal(chamber1.available, true);
});

test("放行合规：培养期未满即放行属违规", () => {
  const byBatch = new Map(state.releaseChecks.map((r) => [r.batch_id, r]));
  assert.equal(byBatch.get("batch-organic-25").valid, false); // 阴性 09-09 10:00 才生效，08:00 已放行
  assert.equal(byBatch.get("batch-organic-21").valid, true);
  assert.equal(byBatch.get("batch-organic-22").valid, true);
  assert.equal(byBatch.get("batch-organic-23").valid, true);
});

test("资源竞争不可超配：容量内重叠允许，超容量拒绝", () => {
  assert.equal(state.conflicts.length, 0); // vehicle-2 容量 2，历史重叠未超配
  assert.equal(
    assertAllocation({
      contacts,
      resources,
      candidate: { contact_id: "contact-new", resource_id: "vehicle-2", start: "2026-09-10T10:00:00+08:00", end: "2026-09-10T10:30:00+08:00" },
    }),
    true,
  );
  assert.throws(
    () =>
      assertAllocation({
        contacts,
        resources,
        candidate: { contact_id: "contact-new", resource_id: "vehicle-2", start: "2026-09-10T09:05:00+08:00", end: "2026-09-10T09:15:00+08:00" },
      }),
    AllocationError,
  ); // 与 contact-1、contact-2 同时重叠，超出容量 2
  assert.throws(
    () =>
      assertAllocation({
        contacts,
        resources,
        candidate: { contact_id: "contact-x", resource_id: "chamber-1", start: "2026-09-08T09:00:00+08:00", end: "2026-09-08T10:00:00+08:00" },
      }),
    AllocationError,
  ); // 隔离舱容量 1，不可重复占用
});

test("推导是事件与当前时间的纯函数，可确定重放", () => {
  assert.deepEqual(recallIds(derive(NOW)), recallIds(state));
});
