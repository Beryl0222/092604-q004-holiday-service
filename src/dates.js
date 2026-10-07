/**
 * 业务日期工具。
 *
 * 所有“当日生效”的判断都以计划起飞机场所在时区的当地日期为准：
 * 跨午夜航班（例如 UTC 时间已翻日、但起飞地仍是前一日）按起飞地当日规则生效。
 */

const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;

/** 以 "+08:00" / "-0500" / "Z" 形式的偏移量换算为分钟数。 */
export function offsetMinutes(offset) {
  if (offset === "Z" || offset === "UTC" || offset === undefined) return 0;
  const m = OFFSET_RE.exec(offset);
  if (!m) throw new Error(`无法识别的时区偏移: ${offset}`);
  const value = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -value : value;
}

/** 取某时刻在给定偏移下的当地日历日，返回 "YYYY-MM-DD"。 */
export function localDate(instant, offset) {
  const shift = offsetMinutes(offset);
  const shifted = new Date(new Date(instant).getTime() + shift * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** 当地日期 d1 是否不晚于 d2（字符串 YYYY-MM-DD 可直接比较）。 */
export function onOrBefore(d1, d2) {
  return d1 <= d2;
}

/** 当地日期 d 是否落在 [from, to] 闭区间内；端点缺省表示不限。 */
export function withinWindow(date, from, to) {
  return (!from || date >= from) && (!to || date <= to);
}
