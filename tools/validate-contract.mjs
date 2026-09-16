import { readFile } from "node:fs/promises";
const contract = JSON.parse(await readFile(new URL("../domain/contract.json", import.meta.url), "utf8"));
const contacts = JSON.parse(await readFile(new URL("../examples/contacts.json", import.meta.url), "utf8"));
for (const contact of contacts) {
  if (!contract.required_contact_fields.every((field) => field in contact)) throw new Error("接触记录字段不完整");
  if (!contract.resource_types.includes(contact.resource_type)) throw new Error("未知资源类型");
  if (!(new Date(contact.started_at) < new Date(contact.ended_at))) throw new Error("接触时间范围无效");
}
if (contract.minimum_culture_hours < 1) throw new Error("培养时限无效");
console.log("污染谱系契约与接触样例格式有效");

