export const HOUR = 3_600_000;
const TZ_OFFSET_MS = 8 * HOUR; // 业务时间一律为 +08:00

export function parseTime(text) {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间: ${text}`);
  return ms;
}

export function formatTime(ms) {
  if (ms === Infinity) return "未解除";
  if (ms === -Infinity) return "最早记录";
  return new Date(ms + TZ_OFFSET_MS).toISOString().replace(".000Z", "+08:00");
}

// 半开区间 [start, end) 重叠判断；end 为 null 表示仍在进行
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return Math.max(aStart, bStart) < Math.min(aEnd ?? Infinity, bEnd ?? Infinity);
}
