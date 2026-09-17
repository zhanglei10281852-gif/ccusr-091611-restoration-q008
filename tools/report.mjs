import { loadModel } from "../src/model.js";
import { trace } from "../src/tracer.js";
import { buildSamples } from "../src/samples.js";
import { safeChambers, capacityViolations } from "../src/capacity.js";
import { buildPlan } from "../src/scheduler.js";
import { fmtTZ } from "../src/time.js";

const model = await loadModel();
const samples = buildSamples(model);
const positive = samples.samples.find((s) => s.status === "positive");
const tr = trace(model, positive.batch_id, positive.effective_at);

// 判定时刻：阳性报告后
const at = positive.effective_at + 3600_000;
const plan = buildPlan(model, { now: at });

const tz = model.contract.timezone ?? "+00:00";
const [, sign, hh, mm] = /([+-])(\d{2}):(\d{2})/.exec(tz);
const offsetMin = (sign === "+" ? 1 : -1) * (Number(hh) * 60 + Number(mm));
const f = (ms) => fmtTZ(ms, offsetMin);

const name = (id) => model.batchIndex.get(id)?.name ?? id;
const line = () => console.log("─".repeat(64));

console.log(`霉害隔离处置报告（判定时刻 ${f(at)}）`);
line();
console.log(`阳性源头：${positive.batch_id} ${name(positive.batch_id)}`);
console.log(`  样本 ${positive.sample_id}，菌种 ${positive.report.species}（风险 ${model.risks.species[positive.report.species].level}）`);
console.log(`  阳性确认时刻 ${f(positive.effective_at)}`);
line();

console.log("一、阳性影响集合（由接触时段与清洁边界推导，按最早暴露排序）");
for (const row of plan.trace.infected) {
  const rel = model.events.find((e) => e.type === "batch_released" && e.batch_id === row.batch_id);
  const tag = rel && rel._at < positive.effective_at ? "（已放行→须召回）" : "";
  console.log(`  ${row.batch_id} ${name(row.batch_id)}${tag}  最早暴露 ${f(row.exposed_at)}`);
}
console.log("传播证据：");
for (const e of plan.trace.evidence) {
  if (e.kind === "source_positive") continue;
  if (e.kind === "source_retroactive") console.log(`  回溯种子：${e.contact_id}`);
  else console.log(`  → ${e.batch_id} 经 ${e.resource_type} ${e.resource_id}（${e.kind}，接触 ${e.contact_id}）`);
}
console.log("排除批次：");
const excluded = model.batches.filter((b) => !tr.infectedAt.has(b.batch_id));
for (const b of excluded) console.log(`  ${b.batch_id} ${b.name}`);
line();

console.log("二、真正安全可用的舱位");
for (const c of safeChambers(model, tr, at)) {
  console.log(`  ${c.safe ? "✅" : "❌"} ${c.chamber_id} ${c.name} 空闲 ${c.free_slots}/${c.capacity}${c.safe ? "" : "：" + c.reasons.join("；")}`);
}
line();

console.log("三、样本与培养期判定");
for (const s of plan.samples) {
  console.log(`  ${s.sample_id} ${s.batch_id} ${s.status}` +
    (s.effective_at ? ` 生效 ${f(s.effective_at)}` : ""));
}
line();

console.log("四、定时决定（事件时间序）");
for (const d of plan.decisions) {
  console.log(`  [${f(d.scheduled_at)}] ${d.type} ${d.batch_id ?? d.chamber_id ?? ""} ${d.reason ?? ""}`.trim());
}
line();

const violations = capacityViolations(model);
console.log(`五、资源竞争：${violations.length ? "发现超配" : "无超配"}`);
for (const v of violations) console.log(`  ⚠ ${v.resource_type} ${v.resource_id} @${f(v.at)} ${v.count}>${v.capacity} ${v.batch_ids.join(",")}`);
