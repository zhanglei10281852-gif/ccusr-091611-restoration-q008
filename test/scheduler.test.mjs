import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEventFile, normalizeEvents } from "../src/log.js";
import { deriveState } from "../src/engine.js";
import { deriveJobs, Scheduler } from "../src/scheduler.js";
import { parseTime } from "../src/time.js";

const readJson = async (rel) => JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));
const contract = await readJson("../domain/contract.json");
const resources = await readJson("../domain/resources.json");
const strains = await readJson("../domain/strains.json");
const protocols = await readJson("../domain/protocols.json");
const raw = await loadEventFile(new URL("../examples/events.json", import.meta.url).pathname);
const { events, contacts } = normalizeEvents(raw, contract);

const NOW1 = parseTime("2026-09-11T12:00:00+08:00");
const NOW2 = parseTime("2026-09-13T19:00:00+08:00");
const derive = (now) => deriveState({ events, contacts, contract, resources, strains, protocols, now });

test("到期任务按事件原本时间生成", () => {
  const jobs = deriveJobs(derive(NOW1), { protocols, strains, now: NOW1 });
  const due = jobs.filter((j) => j.at <= NOW1);
  // 阳性报告时刻即产生召回通知
  for (const id of ["batch-organic-11", "batch-organic-16", "batch-organic-21", "batch-organic-22"]) {
    const job = due.find((j) => j.id === `notify:recall:${id}`);
    assert.ok(job, `缺少召回通知 ${id}`);
    assert.equal(job.at, parseTime("2026-09-10T12:00:00+08:00"));
  }
  // 未清洁的污染资源按菌种风险级别（高 → 24h）定时复检
  assert.ok(due.some((j) => j.id === "reinspect:tray-5:1" && j.at === parseTime("2026-09-11T12:00:00+08:00")));
  assert.ok(due.some((j) => j.id === "reinspect:chamber-2:1"));
  // 培养期结束时刻产生释放决定 / 舱位解除任务
  assert.ok(jobs.some((j) => j.id === "release:s-1" && j.at === parseTime("2026-09-12T08:30:00+08:00")));
  assert.ok(jobs.some((j) => j.id === "clearance:s-c2" && j.at === parseTime("2026-09-13T18:30:00+08:00")));
});

test("进程恢复后按事件原本时间继续，不重发不漏发", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "quarantine-journal-"));
  const journal = path.join(dir, "journal.jsonl");
  const fired1 = [];
  const fired2 = [];

  // 第一次运行：触发当前到期的任务
  const scheduler1 = await new Scheduler(journal).recover();
  await scheduler1.run(deriveJobs(derive(NOW1), { protocols, strains, now: NOW1 }), NOW1, async (job) => {
    fired1.push(job);
  });

  // 模拟进程重启：新实例从同一 journal 恢复，时间推进到两天后
  const scheduler2 = await new Scheduler(journal).recover();
  await scheduler2.run(deriveJobs(derive(NOW2), { protocols, strains, now: NOW2 }), NOW2, async (job) => {
    fired2.push(job);
  });

  // 不重发
  const ids1 = new Set(fired1.map((j) => j.id));
  assert.ok(fired2.every((j) => !ids1.has(j.id)));
  // 恢复后逾期的任务按原定事件时间补发
  const ids2 = fired2.map((j) => j.id);
  for (const id of ["release:s-1", "clearance:s-c2", "reinspect:tray-5:2", "reinspect:tray-5:3", "reinspect:chamber-2:2", "reinspect:chamber-2:3"]) {
    assert.ok(ids2.includes(id), `恢复后漏发 ${id}`);
  }
  // 触发顺序按事件原本时间，而非恢复时刻
  const ats = fired2.map((j) => j.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
  assert.ok(fired2.every((j) => j.at <= NOW2));
  // journal 持久化了全部触发记录
  const lines = (await readFile(journal, "utf8")).split("\n").filter((l) => l.trim());
  assert.equal(lines.length, fired1.length + fired2.length);
});
