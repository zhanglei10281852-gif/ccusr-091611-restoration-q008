// 定时决定派发器（可中断、可恢复）。
//   node tools/run-scheduler.mjs                启动或恢复，派发事件时间已到的决定
//   node tools/run-scheduler.mjs --now ISO      指定墙钟当前时刻
//   node tools/run-scheduler.mjs --reset        清除持久化状态后重新开始
//   node tools/run-scheduler.mjs --crash-after N 派发 N 条后模拟进程崩溃
import { rm } from "node:fs/promises";
import { loadModel } from "../src/model.js";
import { buildSamples } from "../src/samples.js";
import { buildPlan } from "../src/scheduler.js";
import { Runner } from "../src/runner.js";
import { parse, fmtTZ } from "../src/time.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const statePath = new URL("../data/runner-state.json", import.meta.url);

const model = await loadModel();
const positive = buildSamples(model).samples.find((s) => s.status === "positive");
if (!positive) throw new Error("事件史中暂无阳性结果，无可执行的隔离处置计划");

if (args.includes("--reset")) await rm(statePath, { force: true });
const wallNow = arg("--now") ? parse(arg("--now")) : Date.now();
const crashAfter = arg("--crash-after") ? Number(arg("--crash-after")) : null;

const tz = model.contract.timezone ?? "+00:00";
const m = /([+-])(\d{2}):(\d{2})/.exec(tz);
const offsetMin = (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3]));
const f = (ms) => fmtTZ(ms, offsetMin);

const runner = new Runner(statePath);
let state = await runner.load();
let fired;
if (!state) {
  const plan = buildPlan(model, { now: wallNow });
  console.log(`生成处置计划：源头 ${plan.source_batch_id}，共 ${plan.decisions.length} 条定时决定`);
  try {
    ({ fired } = await runner.start(plan, wallNow, { crashAfter }));
  } catch (err) {
    console.log(`进程中断：${err.message}`);
    process.exit(2);
  }
} else {
  console.log(`从持久化状态恢复：已派发 ${state.cursor} 条，墙钟 ${f(wallNow)}`);
  fired = await runner.advance(wallNow, { crashAfter });
}
state = await runner.load();

for (const d of fired) {
  const target = d.batch_id ?? d.chamber_id ?? "";
  console.log(`派发 [${f(d.scheduled_at)}] ${d.type} ${target} ${d.reason ?? ""}`.trim());
}
console.log(`本次派发 ${fired.length} 条；剩余待派发 ${state.decisions.length - state.cursor} 条`);
