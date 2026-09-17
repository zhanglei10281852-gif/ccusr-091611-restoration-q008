import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HOUR } from "./time.js";

// 由推导状态生成全部定时任务。任务 id 与触发时刻都是事件的确定性函数，
// 因此进程恢复后重放同一事件日志，仍按事件原本发生的时间继续。
export function deriveJobs(state, { protocols = [], strains = [], now }) {
  const jobs = [];
  const riskOf = (strain) => strains.find((s) => s.strain === strain)?.risk_level ?? null;
  const intervalHoursFor = (strain) => protocols.find((p) => p.risk_level === riskOf(strain))?.reinspection_interval_hours ?? 24;

  for (const s of state.sampleRows) {
    if (s.result === "negative" && !s.void) {
      // 培养期结束时刻：批次 → 释放决定；资源 → 舱位解除
      jobs.push(
        s.subject_kind === "batch"
          ? { id: `release:${s.sample_id}`, kind: "release_decision", at: s.effective_at, batch_id: s.subject_id, sample_id: s.sample_id }
          : { id: `clearance:${s.sample_id}`, kind: "chamber_clearance", at: s.effective_at, resource_id: s.subject_id, sample_id: s.sample_id },
      );
    }
    if (s.void) {
      jobs.push({ id: `notify:resample:${s.sample_id}`, kind: "notify_resample", at: s.void_at, sample_id: s.sample_id, subject_id: s.subject_id });
    }
  }
  for (const b of state.batches.values()) {
    if (b.contaminated) {
      jobs.push({ id: `notify:recall:${b.batch_id}`, kind: "notify_recall", at: b.detected_at, batch_id: b.batch_id });
    }
  }
  // 仍未清洁的污染资源：按菌种风险级别定时复检
  for (const subj of state.contaminated.values()) {
    if (subj.kind !== "resource") continue;
    const active = subj.intervals.some((iv) => iv.start <= now && now < iv.end);
    if (!active) continue;
    const step = intervalHoursFor(subj.root_strain) * HOUR;
    for (let k = 1; ; k++) {
      const at = subj.detected_at + k * step;
      jobs.push({ id: `reinspect:${subj.id}:${k}`, kind: "reinspect", at, resource_id: subj.id, sequence: k });
      if (at > now) break; // 生成全部到期任务 + 下一个未来任务
    }
  }
  return jobs.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// 已触发任务写入日志（journal）；恢复时读取，保证不重发、不漏发，
// 逾期任务按原定事件时间顺序补发。
export class Scheduler {
  constructor(journalPath) {
    this.journalPath = journalPath;
    this.fired = new Set();
  }

  async recover() {
    let text = "";
    try {
      text = await readFile(this.journalPath, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    for (const line of text.split("\n")) {
      if (line.trim()) this.fired.add(JSON.parse(line).job_id);
    }
    return this;
  }

  async run(jobs, now, sink) {
    const due = jobs
      .filter((j) => j.at <= now && !this.fired.has(j.id))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const firedJobs = [];
    for (const job of due) {
      await sink(job);
      this.fired.add(job.id);
      await mkdir(path.dirname(this.journalPath), { recursive: true });
      await appendFile(this.journalPath, JSON.stringify({ job_id: job.id, fired_at: new Date(now).toISOString() }) + "\n");
      firedJobs.push(job);
    }
    return firedJobs;
  }
}
