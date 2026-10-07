/** 节日航班服务包的领域规则：当地日期、适用范围、计划解析、停用匹配与替代核对。 */

export const AIRPORTS = {
  PEK: { city: "北京", timeZone: "Asia/Shanghai" },
  SHA: { city: "上海", timeZone: "Asia/Shanghai" },
  CTU: { city: "成都", timeZone: "Asia/Shanghai" },
  HKG: { city: "香港", timeZone: "Asia/Hong_Kong" },
  LAX: { city: "洛杉矶", timeZone: "America/Los_Angeles" },
};

export const CATEGORIES = ["broadcast", "snack", "craft", "heritage"];
export const STAGES = ["inflight", "ground_lounge", "ground_load"];

const LOUNGE_RANK = { C: 1, B: 2, A: 3 };

/** 计划起飞地当地日期：跨午夜航班以计划起飞地当日为准。 */
export function localDateAt(instantIso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantIso));
  const take = (type) => parts.find((p) => p.type === type).value;
  return `${take("year")}-${take("month")}-${take("day")}`;
}

function listCovers(rule, value) {
  return !rule || rule.length === 0 || rule.includes(value);
}

/** 审定范围是否覆盖本次执行上下文（航线、起飞机场、舱位、运行日期）。 */
export function approvalCovers(approval, ctx) {
  const scope = approval.scope ?? {};
  if (!listCovers(scope.routes, ctx.route)) return false;
  if (!listCovers(scope.airports, ctx.airport)) return false;
  if (scope.cabins && scope.cabins.length > 0 && !ctx.cabins.every((c) => scope.cabins.includes(c))) return false;
  if (scope.validFrom && ctx.serviceDate < scope.validFrom) return false;
  if (scope.validTo && ctx.serviceDate > scope.validTo) return false;
  return true;
}

/** 后登记的审定优先，同一条目换版审定后新计划取新审定。 */
export function findCoveringApproval(approvals, ctx) {
  const covering = approvals.filter((a) => approvalCovers(a, ctx));
  return covering.length > 0 ? covering[covering.length - 1] : null;
}

function intersectCabins(rule, cabins) {
  return rule && rule.length > 0 ? cabins.filter((c) => rule.includes(c)) : [...cabins];
}

function plannedQuantity(item, cabins, ctx) {
  if (!item.quota?.perCabin) return null;
  let total = 0;
  for (const cabin of cabins) {
    total += (item.quota.perCabin[cabin] ?? 0) * (ctx.passengers?.[cabin] ?? 0);
  }
  return total;
}

/** 条目在起飞城市可用且声明齐全的供应批次（食品批次必须带过敏原声明）。 */
export function usableBatches(batches, item, ctx) {
  return [...batches.values()].filter(
    (b) =>
      b.itemId === item.itemId &&
      b.city === ctx.city &&
      (!b.expiresAt || b.expiresAt >= ctx.serviceDate) &&
      (item.category !== "snack" || Array.isArray(b.allergens)),
  );
}

function resolveItem(item, approvalsByItem, batches, ctx) {
  const reasons = [];
  const cabins = intersectCabins(item.appliesTo?.cabins, ctx.cabins);
  if (cabins.length === 0) reasons.push("舱位不适用");
  if (!listCovers(item.appliesTo?.routes, ctx.route)) reasons.push("航线不适用");
  if (!listCovers(item.appliesTo?.airports, ctx.airport)) reasons.push("起飞机场不适用");
  if (item.lounge?.required) {
    const have = ctx.lounge ? (LOUNGE_RANK[ctx.lounge.tier] ?? 0) : 0;
    const need = LOUNGE_RANK[item.lounge.minTier ?? "C"] ?? 1;
    if (have < need) reasons.push("休息室条件不满足");
  }
  const resolved = {
    itemId: item.itemId,
    name: item.name,
    category: item.category,
    stage: item.stage,
    cabins,
    plannedQuantity: plannedQuantity(item, cabins, ctx),
    reasons,
    evidence: { quota: item.quota ?? null },
  };
  if (reasons.length > 0) return { ...resolved, status: "excluded" };

  const approval = findCoveringApproval(approvalsByItem.get(item.itemId) ?? [], { ...ctx, cabins });
  if (approval) resolved.evidence.approvalId = approval.approvalId;
  else reasons.push("内容审定未覆盖本次适用范围");

  if (item.needsSupply) {
    const usable = usableBatches(batches, item, ctx);
    if (usable.length === 0) {
      reasons.push(item.category === "snack" ? "供应批次或过敏原声明缺失" : "供应批次不可用");
    } else {
      const total = usable.reduce((n, b) => n + (b.quantity ?? 0), 0);
      if (resolved.plannedQuantity != null && total < resolved.plannedQuantity) {
        reasons.push("供应批次数量不足");
      } else {
        resolved.evidence.batchIds = usable.map((b) => b.batchId);
        if (item.category === "snack") {
          resolved.evidence.allergens = [...new Set(usable.flatMap((b) => b.allergens))];
        }
      }
    }
  }
  return { ...resolved, status: reasons.length === 0 ? "ready" : "blocked" };
}

/** 由运行日期、起飞机场、航线、舱位与休息室条件解析现场可执行版本。 */
export function resolvePlanItems(template, approvalsByItem, batches, ctx) {
  return template.items.map((item) => resolveItem(item, approvalsByItem, batches, ctx));
}

/** 停用范围只命中同时满足全部限定维度（类别、批次、城市）的计划条目。 */
export function holdMatchesPlanItem(hold, plan, item) {
  const scope = hold.scope ?? {};
  if (scope.category && item.category !== scope.category) return false;
  if (scope.city && plan.city !== scope.city) return false;
  if (scope.batchId) {
    const batchIds = item.substitution?.batchIds ?? item.evidence?.batchIds ?? [];
    if (!batchIds.includes(scope.batchId)) return false;
  }
  return true;
}
