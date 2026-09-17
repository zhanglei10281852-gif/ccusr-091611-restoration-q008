import { readFile } from "node:fs/promises";
import { parseTime } from "./time.js";

// 读取事件文件：支持 JSON 数组与 JSONL 两种格式
export async function loadEventFile(path) {
  const text = await readFile(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`事件文件须为数组: ${path}`);
  return data;
}

// 把原始记录规整为：按时间排序的事件列表 + 接触区间列表。
// 同时接受两种形态：
//   1. contact_started / contact_ended 事件对（按 contact_id 配对）；
//   2. 带 started_at / ended_at 的区间式接触记录（如 examples/contacts.json）。
export function normalizeEvents(raw, contract) {
  const events = [];
  const contacts = [];
  const seenContacts = new Map();
  const addContact = (c) => {
    const prev = seenContacts.get(c.contact_id);
    if (prev) {
      if (prev.batch_id !== c.batch_id || prev.resource_id !== c.resource_id || prev.start !== c.start || prev.end !== c.end) {
        throw new Error(`接触记录冲突: ${c.contact_id}`);
      }
      return;
    }
    seenContacts.set(c.contact_id, c);
    contacts.push(c);
  };

  for (const item of raw) {
    if ("started_at" in item) {
      for (const field of contract.required_contact_fields) {
        if (!(field in item)) throw new Error(`接触记录字段不完整: ${item.contact_id ?? "?"}`);
      }
      addContact({
        contact_id: item.contact_id,
        batch_id: item.batch_id,
        resource_id: item.resource_id,
        resource_type: item.resource_type,
        start: parseTime(item.started_at),
        end: item.ended_at == null ? null : parseTime(item.ended_at),
      });
      continue;
    }
    if (!contract.event_types.includes(item.type)) throw new Error(`未知事件类型: ${item.type}`);
    if (!item.event_id) throw new Error(`事件缺少 event_id: ${item.type}`);
    if (!item.at) throw new Error(`事件缺少时间: ${item.event_id}`);
    events.push({ ...item, atMs: parseTime(item.at) });
  }

  events.sort((a, b) => a.atMs - b.atMs || a.event_id.localeCompare(b.event_id));

  const open = new Map();
  for (const e of events) {
    if (e.type === "contact_started") {
      for (const field of ["contact_id", "batch_id", "resource_id", "resource_type"]) {
        if (!(field in e)) throw new Error(`接触开始事件字段不完整: ${e.event_id}`);
      }
      if (open.has(e.contact_id)) throw new Error(`接触重复开始: ${e.contact_id}`);
      open.set(e.contact_id, e);
    } else if (e.type === "contact_ended") {
      const started = open.get(e.contact_id);
      if (!started) throw new Error(`接触结束缺少开始: ${e.contact_id}`);
      open.delete(e.contact_id);
      addContact({
        contact_id: e.contact_id,
        batch_id: started.batch_id,
        resource_id: started.resource_id,
        resource_type: started.resource_type,
        start: started.atMs,
        end: e.atMs,
      });
    }
  }
  // 未结束的接触视为进行中（end = null）
  for (const [contactId, started] of open) {
    addContact({
      contact_id: contactId,
      batch_id: started.batch_id,
      resource_id: started.resource_id,
      resource_type: started.resource_type,
      start: started.atMs,
      end: null,
    });
  }

  for (const c of contacts) {
    if (!contract.resource_types.includes(c.resource_type)) throw new Error(`未知资源类型: ${c.resource_type}`);
    if (!(c.end === null || c.start < c.end)) throw new Error(`接触时间范围无效: ${c.contact_id}`);
  }
  return { events, contacts };
}
