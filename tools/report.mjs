import { readFile } from "node:fs/promises";
import { loadEventFile, normalizeEvents } from "../src/log.js";
import { deriveState, explainChain } from "../src/engine.js";
import { deriveJobs } from "../src/scheduler.js";
import { parseTime, formatTime } from "../src/time.js";

// 用法: node tools/report.mjs [事件文件] [--at ISO时间]
const args = process.argv.slice(2);
const atIndex = args.indexOf("--at");
const eventPath = args[0] && args[0] !== "--at" ? args[0] : "examples/events.json";
const now = parseTime(atIndex >= 0 ? args[atIndex + 1] : "2026-09-11T12:00:00+08:00");

const readJson = async (rel) => JSON.parse(await readFile(rel, "utf8"));
const contract = await readJson("domain/contract.json");
const resources = await readJson("domain/resources.json");
const strains = await readJson("domain/strains.json");
const protocols = await readJson("domain/protocols.json");

const raw = await loadEventFile(eventPath);
const { events, contacts } = normalizeEvents(raw, contract);
const state = deriveState({ events, contacts, contract, resources, strains, protocols, now });
const jobs = deriveJobs(state, { protocols, strains, now });

const line = (s = "") => console.log(s);
line(`=== 霉害隔离污染谱系报告（截至 ${formatTime(now)}）===`);

const recalls = [...state.batches.values()].filter((b) => b.contaminated);
line(`\n■ 召回清单（${recalls.length} 批）`);
for (const b of recalls) {
  line(`  ${b.batch_id}${b.released_at ? "（已放行，须立即追回）" : "（在库）"}`);
  for (const l of explainChain(state, b.batch_id)) line(`    ${l}`);
}

const cleared = [...state.batches.values()].filter((b) => !b.contaminated && b.exclusions.length);
line(`\n■ 排除说明（${cleared.length} 批曾接触污染资源但排除）`);
for (const b of cleared) {
  for (const ex of b.exclusions) line(`  ${b.batch_id}：${ex.reason}`);
}

line(`\n■ 舱位与资源可用性`);
for (const a of state.availability) {
  line(`  ${a.available ? "✓" : "✗"} ${a.resource_id}（${a.resource_type}）${a.available ? " 可用" : ` ${a.reasons.join("；")}`}`);
}

const invalid = state.releaseChecks.filter((r) => !r.valid);
line(`\n■ 放行合规（${state.releaseChecks.length} 次放行，${invalid.length} 次违规）`);
for (const r of invalid) line(`  ✗ ${r.batch_id} 于 ${formatTime(r.at)} 放行：${r.reason}`);

line(`\n■ 资源超配冲突（${state.conflicts.length}）`);
for (const c of state.conflicts) {
  line(`  ✗ ${c.resource_id} 于 ${formatTime(c.at)} 并发 ${c.concurrent} > 容量 ${c.capacity}：${c.contacts.join("、")}`);
}
if (!state.conflicts.length) line("  （无）");

const due = jobs.filter((j) => j.at <= now);
const upcoming = jobs.filter((j) => j.at > now);
line(`\n■ 到期任务（${due.length}，按事件时间排序）`);
for (const j of due) line(`  [${formatTime(j.at)}] ${j.kind} ${j.id}`);
line(`\n■ 未来任务（${upcoming.length}）`);
for (const j of upcoming) line(`  [${formatTime(j.at)}] ${j.kind} ${j.id}`);
