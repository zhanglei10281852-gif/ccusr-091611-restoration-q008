import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fmt } from "./time.js";

// 持久化运行器：决定由事件时间推导且幂等；进程中断恢复后，
// 未派发的决定继续派发，已派发的不重复，scheduled_at 始终是事件原本时间。
export class Runner {
  constructor(statePath) {
    this.statePath = statePath;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8"));
    } catch {
      return null;
    }
  }

  async save(state) {
    const path = this.statePath instanceof URL ? fileURLToPath(this.statePath) : this.statePath;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2));
  }

  async start(plan, wallNow = Date.now(), { crashAfter = null } = {}) {
    const state = {
      plan_generated_at: plan.generated_at,
      source_batch_id: plan.source_batch_id,
      started_at: wallNow,
      cursor: 0,
      log: [],
      decisions: plan.decisions.map((d) => ({ ...d, status: "pending" })),
    };
    await this.save(state);
    const fired = await this.advance(wallNow, { crashAfter });
    return { state, fired };
  }

  async advance(wallNow = Date.now(), { crashAfter = null } = {}) {
    const state = await this.load();
    if (!state) throw new Error("无运行状态，请先 start");
    const fired = [];
    let budget = crashAfter == null ? Infinity : crashAfter;

    while (state.cursor < state.decisions.length && budget > 0) {
      const d = state.decisions[state.cursor];
      // 只派发事件时间已到的决定；恢复后过去遗留的待办立即补发，但其 scheduled_at 不变
      if (d.scheduled_at > wallNow) break;
      d.status = "fired";
      d.fired_wall_at = wallNow;
      d.fired_wall_at_iso = fmt(wallNow);
      state.log.push({ decision_id: d.decision_id, type: d.type, scheduled_at_iso: d.scheduled_at_iso, fired_wall_at_iso: d.fired_wall_at_iso });
      fired.push(d);
      state.cursor++;
      budget--;
      await this.save(state);
      if (crashAfter != null && fired.length === crashAfter) {
        throw new Error("模拟进程中断（已在派发后持久化）");
      }
    }
    await this.save(state);
    return fired;
  }

  pending(state = null) {
    return state.decisions.slice(state.cursor);
  }
}
