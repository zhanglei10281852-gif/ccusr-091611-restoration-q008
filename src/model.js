import { readFile } from "node:fs/promises";
import { parse, HOUR } from "./time.js";

export async function loadModel(base = new URL("../", import.meta.url)) {
  const read = async (p) => JSON.parse(await readFile(new URL(p, base), "utf8"));
  const [contract, resources, risks, inspection, protocols, batches, contacts, events] =
    await Promise.all([
      read("domain/contract.json"),
      read("domain/resources.json"),
      read("domain/risks.json"),
      read("domain/inspection.json"),
      read("domain/protocols.json"),
      read("examples/batches.json"),
      read("examples/contacts.json"),
      read("examples/events.json"),
    ]);

  for (const c of contacts) {
    for (const f of contract.required_contact_fields) {
      if (!(f in c)) throw new Error(`接触记录 ${c.contact_id ?? "?"} 缺少字段 ${f}`);
    }
    if (!contract.resource_types.includes(c.resource_type)) throw new Error(`接触记录 ${c.contact_id} 资源类型未知`);
    const s = parse(c.started_at);
    const e = parse(c.ended_at);
    c._open = c.ended_at == null;
    if (!(s < (e ?? Infinity))) throw new Error(`接触记录 ${c.contact_id} 时间范围无效`);
    c._start = s;
    c._end = e ?? Infinity;
  }

  for (const e of events) {
    for (const f of contract.required_event_fields) {
      if (!(f in e)) throw new Error(`事件 ${e.event_id ?? "?"} 缺少字段 ${f}`);
    }
    if (!contract.event_types.includes(e.type)) throw new Error(`事件 ${e.event_id} 类型未知`);
    e._at = parse(e.at);
  }

  const batchIndex = new Map(batches.map((b) => [b.batch_id, b]));
  for (const e of events) {
    if (e.batch_id && !batchIndex.has(e.batch_id)) {
      throw new Error(`事件 ${e.event_id} 引用未知批次 ${e.batch_id}`);
    }
  }
  const knownResources = new Set([
    ...resources.chambers.map((c) => c.chamber_id),
    ...resources.vehicles.map((v) => v.vehicle_id),
    ...resources.workbenches.map((w) => w.workbench_id),
    ...resources.chambers.flatMap((c) => c.tray_ids),
  ]);
  for (const ref of [...contacts, ...events]) {
    const rid = ref.resource_id;
    if (rid && !knownResources.has(rid)) throw new Error(`记录 ${ref.contact_id ?? ref.event_id} 引用未知资源 ${rid}`);
  }

  const protocolsByType = new Map(protocols.protocols.map((p) => [p.resource_type, p]));
  const chamberIndex = new Map(resources.chambers.map((c) => [c.chamber_id, c]));
  const trayChamber = new Map();
  for (const c of resources.chambers) for (const t of c.tray_ids) trayChamber.set(t, c.chamber_id);

  return {
    contract,
    resources,
    risks,
    inspection: {
      ...inspection,
      minimum_culture_hours: inspection.minimum_culture_hours ?? contract.minimum_culture_hours,
    },
    protocols,
    protocolsByType,
    chamberIndex,
    trayChamber,
    batches,
    batchIndex,
    contacts,
    events: events.sort((a, b) => a._at - b._at),
    HOUR,
  };
}
