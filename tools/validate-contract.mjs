import { readFile } from "node:fs/promises";
import { normalizeEvents } from "../src/log.js";

const readJson = async (rel) => JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));

const contract = await readJson("../domain/contract.json");
const contacts = await readJson("../examples/contacts.json");
const resources = await readJson("../domain/resources.json");
const strains = await readJson("../domain/strains.json");
const protocols = await readJson("../domain/protocols.json");
const eventRecords = await readJson("../examples/events.json");

// 接触样例：字段、资源类型、时间范围
for (const contact of contacts) {
  if (!contract.required_contact_fields.every((field) => field in contact)) throw new Error("接触记录字段不完整");
  if (!contract.resource_types.includes(contact.resource_type)) throw new Error("未知资源类型");
  if (!(new Date(contact.started_at) < new Date(contact.ended_at))) throw new Error("接触时间范围无效");
}
if (contract.minimum_culture_hours < 1) throw new Error("培养时限无效");

// 资源目录：类型合法、容量为正
const resourceIds = new Set();
for (const r of resources) {
  if (!contract.resource_types.includes(r.resource_type)) throw new Error(`资源目录含未知类型: ${r.resource_id}`);
  if (!Number.isInteger(r.capacity) || r.capacity < 1) throw new Error(`资源容量无效: ${r.resource_id}`);
  resourceIds.add(r.resource_id);
}

// 菌种与清洁规程：风险级别合法且每个级别都有规程
const riskLevels = new Set(strains.map((s) => s.risk_level));
for (const s of strains) {
  if (!s.strain || !s.risk_level) throw new Error("菌种记录缺少 strain 或 risk_level");
}
for (const level of riskLevels) {
  const protocol = protocols.find((p) => p.risk_level === level);
  if (!protocol) throw new Error(`缺少风险级别 ${level} 的清洁规程`);
  if (!(protocol.reinspection_interval_hours >= 1)) throw new Error(`复检间隔无效: ${level}`);
}

// 历史事件：类型合法、接触配对、引用完整
const { events } = normalizeEvents(eventRecords, contract);
const sampleIds = new Set();
const startedContacts = new Set();
const startedCleanings = new Set();
const batchesWithContacts = new Set();
for (const e of events) {
  if (e.type === "sample_taken") {
    if (!e.sample_id || !e.subject_kind || !e.subject_id) throw new Error(`采样事件字段不完整: ${e.event_id}`);
    sampleIds.add(e.sample_id);
  }
  if (e.type === "contact_started") {
    startedContacts.add(e.contact_id);
    batchesWithContacts.add(e.batch_id);
    if (!resourceIds.has(e.resource_id)) throw new Error(`接触引用了未登记的资源: ${e.resource_id}`);
  }
  if (e.type === "cleaning_started") startedCleanings.add(e.cleaning_id);
}
for (const e of events) {
  if (e.type === "result_reported" && !sampleIds.has(e.sample_id)) throw new Error(`结果引用了不存在的样本: ${e.sample_id}`);
  if (e.type === "result_reported" && !["positive", "negative"].includes(e.result)) throw new Error(`未知检验结果: ${e.event_id}`);
  if (e.type === "cleaning_certified" && !startedCleanings.has(e.cleaning_id)) throw new Error(`清洁认证缺少开始记录: ${e.cleaning_id}`);
  if (e.type === "batch_released" && !batchesWithContacts.has(e.batch_id)) throw new Error(`放行批次无任何接触记录: ${e.batch_id}`);
}

console.log("污染谱系契约、资源目录、清洁规程与历史事件格式有效");
