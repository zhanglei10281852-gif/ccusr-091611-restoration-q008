// 全部时间以 epoch 毫秒表示；输入为带偏移的 ISO8601 字符串。
export const HOUR = 3600_000;

export function parse(at) {
  if (at == null) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) throw new Error(`无效时间: ${at}`);
  return t;
}

export function fmt(ms) {
  return new Date(ms).toISOString();
}

// 按固定偏移显示，如 +08:00
export function fmtTZ(ms, offsetMinutes = 480) {
  const shifted = new Date(ms + offsetMinutes * 60_000);
  const iso = shifted.toISOString();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${iso.slice(0, 19)}${sign}${hh}:${mm}`;
}

export function addHours(ms, hours) {
  return ms + hours * HOUR;
}
