/**
 * 服务包裁决内核（纯函数）。
 *
 * 输入为不可变快照（批件、批次、配额、城市库存、条件），输出条目的现场状态：
 *
 * - active        满足全部适用闸门，照常提供
 * - suspended     被定点悬置（城市缺货 / 食品批次停用），等替代或撤换
 * - replaced      已被替代品顶替，原条目停止执行
 * - not_approved  审定/批次/过敏原/配额任一闸门未过，不得装机
 * - out_of_scope  不在本现场（机型/舱位/休息室/日期）适用范围内
 *
 * 关键隔离原则：
 * 1. 食品批次停用只作用于该批次承载的食品/手作条目；广播等非实物内容
 *    没有批次概念，绝不被批次停用波及。
 * 2. 某城市缺货只悬置“发货地=该城市”的条目，其他城市已确认安全的物料不动。
 * 3. 替代品必须携带自己的批件重新过闸，不能沿用原批准。
 */

import { withinWindow } from "./dates.js";

/** 条目是否实物物料（受批次与城市库存约束）。 */
export function isPhysical(entry) {
  return entry.kind === "snack" || entry.kind === "craft" || entry.kind === "experience_kit";
}

/** 条目的现场适用范围是否覆盖给定条件（不涉及批准状态）。 */
export function scopeMatches(entry, ctx) {
  const s = entry.scope;
  // 机上条目不进休息室清单，反之亦然
  if (entry.venue !== ctx.venue) return false;
  if (s.dateFrom && ctx.localDate < s.dateFrom) return false;
  if (s.dateTo && ctx.localDate > s.dateTo) return false;
  if (s.routes && s.routes.length && !s.routes.includes(ctx.route)) return false;
  if (s.cabins && s.cabins.length && !s.cabins.includes(ctx.cabin)) return false;
  // 机型：条目按其适配机型登记；换机型后旧机型专属条目立即出范围
  if (s.aircraftTypes && s.aircraftTypes.length && !s.aircraftTypes.includes(ctx.aircraftType)) return false;
  // 机上条目按航班供应；地面体验条目按休息室供应
  if (entry.venue === "lounge") {
    if (!ctx.loungeId || (s.loungeIds && s.loungeIds.length && !s.loungeIds.includes(ctx.loungeId))) return false;
  }
  return true;
}

/**
 * 评估单个条目。
 * @param {object} entry 服务条目（含 approvalId、batchId、originCity、scope）
 * @param {object} ctx { instant, localDate, route, cabin, aircraftType, loungeId }
 * @param {object} catalog { approvals, batches, quotas, stockHolds, replacedBy }
 */
export function evaluateEntry(entry, ctx, catalog) {
  const reasons = [];

  if (!scopeMatches(entry, ctx)) {
    return { status: "out_of_scope", reasons: ["不在当前日期/航线/舱位/机型/休息室适用范围"] };
  }

  // 已被替代品顶替：以替代条目的裁决为准，原条目不再执行
  const replacementId = catalog.replacedBy.get(entry.entryId);
  if (replacementId) {
    return { status: "replaced", reasons: [`已由替代条目 ${replacementId} 顶替`], replacementId };
  }

  // 闸门一：内容审定（广播词、讲解词等同样需要自己的审定批件）
  const approval = catalog.approvals.get(entry.approvalId);
  if (!approval) {
    return { status: "not_approved", reasons: ["缺少内容审定批件"] };
  }
  if (approval.state !== "valid") {
    reasons.push(`审定批件状态为 ${approval.state}`);
  }
  if (!withinWindow(ctx.localDate, approval.validFrom, approval.validTo)) {
    reasons.push("审定批件未覆盖当日");
  }
  if (approval.scope) {
    const a = approval.scope;
    if (a.routes && a.routes.length && !a.routes.includes(ctx.route)) reasons.push("审定范围不含本航线");
    if (a.cabins && a.cabins.length && !a.cabins.includes(ctx.cabin)) reasons.push("审定范围不含本舱位");
    if (a.aircraftTypes && a.aircraftTypes.length && !a.aircraftTypes.includes(ctx.aircraftType))
      reasons.push("审定范围不含现机型");
  }

  // 闸门二：食品/手作物料的供应批次（广播无批次，跳过）
  if (isPhysical(entry)) {
    if (!entry.batchId) {
      reasons.push("实物条目缺少供应批次");
    } else {
      const batch = catalog.batches.get(entry.batchId);
      if (!batch) {
        reasons.push("供应批次不存在");
      } else if (batch.state !== "released") {
        // 批次停用是供应事件：立即悬置本批次实物条目，等待替代（不波及广播）
        return {
          status: "suspended",
          reasons: [`批次 ${entry.batchId} 状态为 ${batch.state}，停止使用`],
          hold: { type: "batch_stop", batchId: entry.batchId },
        };
      } else if (!withinWindow(ctx.localDate, batch.usableFrom, batch.usableTo)) {
        reasons.push("供应批次不在可用期内");
      }
    }

    // 闸门三：过敏原声明（食品类必须有与批件绑定的声明）
    if (entry.kind === "snack" || entry.kind === "craft") {
      if (!entry.allergenDeclarationId) {
        reasons.push("缺少过敏原声明");
      } else {
        const decl = catalog.allergenDeclarations.get(entry.allergenDeclarationId);
        if (!decl) reasons.push("过敏原声明不存在");
        else if (decl.state !== "valid") reasons.push("过敏原声明已失效");
        else if (decl.approvalId !== entry.approvalId) reasons.push("过敏原声明未与本次审定批件绑定");
      }
    }

    // 闸门四：城市库存。某城市缺货只悬置从该城市发货的条目
    if (entry.originCity && catalog.stockHolds.has(entry.originCity)) {
      return {
        status: "suspended",
        reasons: [`发货地 ${entry.originCity} 缺货，定点悬置`],
        hold: { type: "city_stock", city: entry.originCity },
      };
    }
  }

  // 闸门五：配额（当日、当航线、当舱位）
  const quotaVerdict = checkQuota(entry, ctx, catalog.quotas);
  if (quotaVerdict) reasons.push(quotaVerdict);

  if (reasons.length) return { status: "not_approved", reasons };
  return { status: "active", reasons: [] };
}

/** 配额核对：按条目登记的配额键查剩余量；缺配额记录视为 0。 */
function checkQuota(entry, ctx, quotas) {
  if (!entry.quotaKey) return null;
  const key = `${entry.quotaKey}|${ctx.localDate}|${ctx.route}|${ctx.cabin}`;
  const q = quotas.get(key);
  if (!q) return `无配额记录（键 ${key}）`;
  if (q.remaining <= 0) return "配额已用尽";
  return null;
}

/** 汇总一次现场评估。 */
export function evaluate(entries, ctx, catalog) {
  const items = entries.map((entry) => ({ entry, verdict: evaluateEntry(entry, ctx, catalog) }));
  return {
    context: ctx,
    items,
    summary: summarize(items),
  };
}

function summarize(items) {  const out = { active: 0, suspended: 0, replaced: 0, not_approved: 0, out_of_scope: 0 };
  for (const { verdict } of items) out[verdict.status]++;
  return out;
}

/**
 * 推导任务清单：
 * - active        → 装载并等待签收
 * - suspended / not_approved / out_of_scope → 须换条目，进入替代核对
 * - replaced      → 已处理，不再产生任务
 * 任务带稳定键，供故障恢复时“继续派发未完成清单”而不重复下发。
 */
export function deriveTasks(packageId, evaluation) {
  const tasks = [];
  for (const { entry, verdict } of evaluation.items) {
    if (verdict.status === "active") {
      tasks.push({
        taskKey: `${packageId}:load:${entry.entryId}`,
        type: "load_and_sign",
        packageId,
        entryId: entry.entryId,
        venue: entry.venue,
        status: "pending",
      });
    } else if (verdict.status !== "replaced") {
      tasks.push({
        taskKey: `${packageId}:replace:${entry.entryId}`,
        type: "substitute_review",
        packageId,
        entryId: entry.entryId,
        venue: entry.venue,
        reasons: verdict.reasons,
        hold: verdict.hold ?? null,
        status: "pending",
      });
    }
  }
  return tasks;
}
