import { readFile } from "node:fs/promises";
const read = async (p) => JSON.parse(await readFile(new URL(p, import.meta.url), "utf8"));
const contract = await read("../domain/contract.json");
const contacts = await read("../examples/contacts.json");
const events = await read("../examples/events.json");
const batches = await read("../examples/batches.json");
const resources = await read("../domain/resources.json");
const protocols = await read("../domain/protocols.json");

const batchIds = new Set(batches.map((b) => b.batch_id));
const resourceIds = new Set([
  ...resources.chambers.map((c) => c.chamber_id),
  ...resources.vehicles.map((v) => v.vehicle_id),
  ...resources.workbenches.map((w) => w.workbench_id),
  ...resources.chambers.flatMap((c) => c.tray_ids),
]);
const protoTypes = new Set(protocols.protocols.map((p) => p.resource_type));

for (const contact of contacts) {
  if (!contract.required_contact_fields.every((field) => field in contact)) throw new Error("接触记录字段不完整");
  if (!contract.resource_types.includes(contact.resource_type)) throw new Error("未知资源类型");
  if (!batchIds.has(contact.batch_id)) throw new Error(`接触记录 ${contact.contact_id} 引用未知批次`);
  if (!resourceIds.has(contact.resource_id)) throw new Error(`接触记录 ${contact.contact_id} 引用未知资源`);
  if (!protoTypes.has(contact.resource_type)) throw new Error(`接触记录 ${contact.contact_id} 资源类型缺少清洁规程`);
  const start = Date.parse(contact.started_at);
  const end = contact.ended_at == null ? Infinity : Date.parse(contact.ended_at);
  if (!(start < end)) throw new Error("接触时间范围无效");
}

const sampleOwners = new Map();
for (const e of events) {
  if (!contract.required_event_fields.every((field) => field in e)) throw new Error(`事件 ${e.event_id ?? "?"} 字段不完整`);
  if (!contract.event_types.includes(e.type)) throw new Error(`事件 ${e.event_id} 类型未知`);
  if (Number.isNaN(Date.parse(e.at))) throw new Error(`事件 ${e.event_id} 时间无效`);
  if (e.batch_id && !batchIds.has(e.batch_id)) throw new Error(`事件 ${e.event_id} 引用未知批次`);
  if (e.resource_id && !resourceIds.has(e.resource_id)) throw new Error(`事件 ${e.event_id} 引用未知资源`);
  if (e.type === "sample_taken") sampleOwners.set(e.sample_id, e.batch_id);
}
for (const e of events) {
  if (e.type === "result_reported") {
    if (!contract.sample_results.includes(e.result)) throw new Error(`事件 ${e.event_id} 检验结果未知`);
    if (sampleOwners.get(e.sample_id) !== e.batch_id) throw new Error(`事件 ${e.event_id} 样本归属不一致`);
  }
}

// 接触区间不得越过将来的有效清洁证明（证明时批次必须已离场）——由引擎保证，此处仅做基础唯一校验
const contactIds = new Set();
for (const c of contacts) {
  if (contactIds.has(c.contact_id)) throw new Error(`接触记录标识重复: ${c.contact_id}`);
  contactIds.add(c.contact_id);
}

if (contract.minimum_culture_hours < 1) throw new Error("培养时限无效");
console.log("污染谱系契约、接触与事件样例格式有效");
