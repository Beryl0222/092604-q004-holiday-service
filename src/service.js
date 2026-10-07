/** 节日航班服务包编排服务：命令入口、事件留痕与时点投影查询。 */
import { Clock } from "./clock.js";
import { EventStore } from "./store.js";
import {
  AIRPORTS,
  CATEGORIES,
  STAGES,
  findCoveringApproval,
  holdMatchesPlanItem,
  localDateAt,
  resolvePlanItems,
  usableBatches,
} from "./domain.js";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function dutyManager(plan) {
  return { role: "duty_manager", location: plan.departureAirport, note: "剩余风险由起飞站值班经理承担，等待交接" };
}

function applyEvent(state, event) {
  switch (event.type) {
    case "template_registered":
      state.templates.set(event.template.templateId, event.template);
      break;
    case "item_approved": {
      const list = state.approvals.get(event.itemId) ?? [];
      list.push({ approvalId: event.approvalId, itemId: event.itemId, approvedBy: event.approvedBy, scope: event.scope, at: event.at });
      state.approvals.set(event.itemId, list);
      break;
    }
    case "batch_declared":
      state.batches.set(event.batch.batchId, event.batch);
      break;
    case "hold_issued":
      state.holds.set(event.holdId, { holdId: event.holdId, scope: event.scope, reason: event.reason, issuedBy: event.issuedBy, at: event.at });
      break;
    case "plan_generated": {
      const items = new Map();
      for (const it of event.items) {
        items.set(it.itemId, {
          ...it,
          loads: [],
          signoff: null,
          substitution: null,
          withdrawal: null,
          handovers: [],
          riskOwner: it.status === "blocked" ? dutyManager(event) : null,
        });
      }
      state.plans.set(event.planId, {
        planId: event.planId,
        flightNumber: event.flightNumber,
        route: event.route,
        departureAirport: event.departureAirport,
        arrivalAirport: event.arrivalAirport,
        city: event.city,
        serviceDate: event.serviceDate,
        scheduledDeparture: event.scheduledDeparture,
        cabins: event.cabins,
        lounge: event.lounge,
        passengers: event.passengers,
        templateId: event.templateId,
        generatedAt: event.at,
        items,
      });
      break;
    }
    case "item_withdrawn": {
      const item = state.plans.get(event.planId)?.items.get(event.itemId);
      if (item) {
        item.status = "withdrawn";
        item.withdrawal = { holdId: event.holdId, reason: event.reason, at: event.at };
        item.riskOwner = event.riskOwner;
      }
      break;
    }
    case "substitution_applied": {
      const item = state.plans.get(event.planId)?.items.get(event.itemId);
      if (item) {
        item.status = "substituted";
        item.substitution = {
          substituteItemId: event.substituteItemId,
          basis: event.basis,
          appliedBy: event.appliedBy,
          approvalId: event.approvalId,
          batchIds: event.batchIds ?? null,
          allergens: event.allergens ?? null,
          at: event.at,
        };
        item.riskOwner = null;
      }
      break;
    }
    case "load_reported": {
      const item = state.plans.get(event.planId)?.items.get(event.itemId);
      if (item) item.loads.push({ quantity: event.quantity, loadedBy: event.loadedBy, at: event.at });
      break;
    }
    case "signoff_reported": {
      const item = state.plans.get(event.planId)?.items.get(event.itemId);
      if (item) item.signoff = { signedBy: event.signedBy, role: event.role, quantity: event.quantity, at: event.at };
      break;
    }
    case "handover_recorded": {
      const item = state.plans.get(event.planId)?.items.get(event.itemId);
      if (item) {
        item.handovers.push({ fromRole: event.fromRole, toRole: event.toRole, acceptedBy: event.acceptedBy, note: event.note ?? null, at: event.at });
        item.riskOwner = { role: event.toRole, holder: event.acceptedBy, note: event.note ?? null };
      }
      break;
    }
    case "conflict_raised":
      state.conflicts.set(event.conflictId, {
        conflictId: event.conflictId,
        kind: event.kind,
        planId: event.planId ?? null,
        itemId: event.itemId ?? null,
        holdId: event.holdId ?? null,
        messageId: event.messageId ?? null,
        detail: event.detail ?? null,
        raisedBy: event.raisedBy,
        raisedAt: event.at,
        status: "open",
        resolution: null,
      });
      break;
    case "conflict_resolved": {
      const conflict = state.conflicts.get(event.conflictId);
      if (conflict) {
        conflict.status = "resolved";
        conflict.resolution = { reviewerId: event.reviewerId, decision: event.decision, note: event.note ?? null, at: event.at };
      }
      break;
    }
    case "dispatch_issued":
      state.dispatches.set(event.dispatchKey, { dispatchKey: event.dispatchKey, planId: event.planId, itemId: event.itemId, stage: event.stage, at: event.at });
      break;
    case "message_processed":
      state.messages.set(event.messageId, { payloadHash: event.payloadHash, result: event.result });
      break;
    default:
      break;
  }
}

function project(events, asOf = null) {
  const state = {
    templates: new Map(),
    approvals: new Map(),
    batches: new Map(),
    holds: new Map(),
    plans: new Map(),
    messages: new Map(),
    conflicts: new Map(),
    dispatches: new Map(),
  };
  for (const event of events) {
    if (asOf && event.at > asOf) continue;
    applyEvent(state, event);
  }
  return state;
}

function itemReport(item) {
  return {
    itemId: item.itemId,
    name: item.name,
    category: item.category,
    stage: item.stage,
    cabins: item.cabins,
    status: item.status,
    reasons: item.reasons,
    plannedQuantity: item.plannedQuantity,
    evidence: item.evidence,
    loads: item.loads,
    signoff: item.signoff,
    substitution: item.substitution,
    withdrawal: item.withdrawal,
    riskOwner: item.riskOwner,
    handovers: item.handovers,
  };
}

function pickTemplate(state, serviceDate) {
  const covering = [...state.templates.values()].filter(
    (t) =>
      t.usage !== "substitution" &&
      (!t.validFrom || t.validFrom <= serviceDate) &&
      (!t.validTo || t.validTo >= serviceDate),
  );
  if (covering.length === 0) throw new Error(`运行日期 ${serviceDate} 无生效的服务包模板`);
  return covering[covering.length - 1];
}

export class OrchestrationService {
  constructor({ store = new EventStore(), clock = new Clock() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  health() {
    return { service: "holiday_service", status: "ok" };
  }

  #state(asOf = null) {
    return project(this.store.all(), asOf);
  }

  #emit(type, payload) {
    return this.store.append(type, payload, this.clock.now());
  }

  #findItem(state, itemId) {
    for (const template of state.templates.values()) {
      const found = template.items.find((i) => i.itemId === itemId);
      if (found) return found;
    }
    return null;
  }

  registerTemplate(template) {
    if (!template?.templateId) throw new Error("模板缺少编号");
    if (!Array.isArray(template.items) || template.items.length === 0) throw new Error("模板缺少条目");
    const seen = new Set();
    for (const item of template.items) {
      if (seen.has(item.itemId)) throw new Error(`条目编号重复：${item.itemId}`);
      seen.add(item.itemId);
      if (!CATEGORIES.includes(item.category)) throw new Error(`条目类别无效：${item.itemId}`);
      if (!STAGES.includes(item.stage)) throw new Error(`执行阶段无效：${item.itemId}`);
    }
    if (this.#state().templates.has(template.templateId)) {
      throw new Error("模板编号已存在，模板不可覆盖，请以新编号登记新版本");
    }
    this.#emit("template_registered", { template });
    return structuredClone(template);
  }

  approveContent({ itemId, approvalId, approvedBy, scope = {} }) {
    if (!this.#findItem(this.#state(), itemId)) throw new Error(`未登记的条目：${itemId}`);
    if (!approvalId || !approvedBy) throw new Error("审定缺少编号或审定人");
    this.#emit("item_approved", { itemId, approvalId, approvedBy, scope });
    return { itemId, approvalId, status: "approved" };
  }

  declareBatch(batch) {
    if (!batch?.batchId) throw new Error("批次缺少编号");
    if (!this.#findItem(this.#state(), batch.itemId)) throw new Error(`未登记的条目：${batch.itemId}`);
    if (!batch.city) throw new Error("批次缺少供应城市");
    this.#emit("batch_declared", { batch });
    return structuredClone(batch);
  }

  generatePlan(input) {
    const state = this.#state();
    const airport = AIRPORTS[input.departureAirport];
    if (!airport) throw new Error(`未知起飞机场：${input.departureAirport}`);
    if (!input.scheduledDeparture) throw new Error("缺少计划起飞时刻");
    const serviceDate = localDateAt(input.scheduledDeparture, airport.timeZone);
    const template = input.templateId ? state.templates.get(input.templateId) : pickTemplate(state, serviceDate);
    if (!template) throw new Error(`模板不存在：${input.templateId}`);
    const ctx = {
      route: input.route,
      airport: input.departureAirport,
      city: airport.city,
      serviceDate,
      cabins: input.cabins ?? [],
      lounge: input.lounge ?? null,
      passengers: input.passengers ?? null,
    };
    const items = resolvePlanItems(template, state.approvals, state.batches, ctx);
    const planId = input.planId ?? `${input.flightNumber}@${serviceDate}`;
    if (state.plans.has(planId)) throw new Error(`航班计划已存在：${planId}`);
    this.#emit("plan_generated", {
      planId,
      flightNumber: input.flightNumber,
      route: input.route,
      departureAirport: input.departureAirport,
      arrivalAirport: input.arrivalAirport ?? null,
      city: airport.city,
      serviceDate,
      scheduledDeparture: input.scheduledDeparture,
      cabins: ctx.cabins,
      lounge: ctx.lounge,
      passengers: ctx.passengers,
      templateId: template.templateId,
      items,
    });
    return this.flightReport(planId);
  }

  issueHold({ holdId, scope = {}, reason, issuedBy }) {
    if (!holdId) throw new Error("停用缺少编号");
    if (!scope.category && !scope.batchId && !scope.city) {
      throw new Error("停用必须限定类别、批次或城市，不得无范围撤回");
    }
    const state = this.#state();
    if (state.holds.has(holdId)) throw new Error(`停用编号已存在：${holdId}`);
    this.#emit("hold_issued", { holdId, scope, reason: reason ?? null, issuedBy });
    const hold = { holdId, scope };
    const affected = [];
    for (const plan of state.plans.values()) {
      for (const item of plan.items.values()) {
        if (item.status !== "ready" && item.status !== "substituted") continue;
        if (!holdMatchesPlanItem(hold, plan, item)) continue;
        if (item.signoff) {
          const conflictId = `${holdId}:${plan.planId}:${item.itemId}`;
          this.#emit("conflict_raised", {
            conflictId,
            kind: "hold_on_signed",
            planId: plan.planId,
            itemId: item.itemId,
            holdId,
            detail: `停用「${reason ?? holdId}」命中已签收物料，交独立岗位核对`,
            raisedBy: issuedBy,
          });
          affected.push({ planId: plan.planId, itemId: item.itemId, action: "conflict", conflictId });
        } else {
          this.#emit("item_withdrawn", {
            planId: plan.planId,
            itemId: item.itemId,
            holdId,
            reason: reason ?? null,
            riskOwner: dutyManager(plan),
          });
          affected.push({ planId: plan.planId, itemId: item.itemId, action: "withdrawn" });
        }
      }
    }
    return { holdId, affected };
  }

  applySubstitution({ planId, itemId, substituteItemId, basis, appliedBy }) {
    const state = this.#state();
    const plan = state.plans.get(planId);
    if (!plan) throw new Error(`航班计划不存在：${planId}`);
    const item = plan.items.get(itemId);
    if (!item) throw new Error(`计划条目不存在：${itemId}`);
    if (!["ready", "blocked", "withdrawn"].includes(item.status)) {
      throw new Error(`条目当前状态不可替代：${item.status}`);
    }
    if (!basis) throw new Error("替代必须记录替代依据");
    const substitute = this.#findItem(state, substituteItemId);
    if (!substitute) throw new Error(`替代品未登记：${substituteItemId}`);
    if (substitute.category !== item.category) throw new Error("替代品类别必须与原条目一致");
    const ctx = { route: plan.route, airport: plan.departureAirport, city: plan.city, serviceDate: plan.serviceDate, cabins: item.cabins };
    const approval = findCoveringApproval(state.approvals.get(substituteItemId) ?? [], ctx);
    if (!approval) {
      throw new Error("替代品未获得覆盖本次适用范围的审定，不能沿用原批准");
    }
    let batchIds = null;
    let allergens = null;
    if (substitute.needsSupply) {
      const usable = usableBatches(state.batches, substitute, ctx);
      if (usable.length === 0) throw new Error("替代品供应批次或过敏原声明不可用");
      batchIds = usable.map((b) => b.batchId);
      if (substitute.category === "snack") allergens = [...new Set(usable.flatMap((b) => b.allergens))];
    }
    this.#emit("substitution_applied", {
      planId,
      itemId,
      substituteItemId,
      basis,
      appliedBy,
      approvalId: approval.approvalId,
      batchIds,
      allergens,
    });
    return this.flightReport(planId).items.find((i) => i.itemId === itemId);
  }

  reportLoad(message) {
    return this.#idempotent("load", message, (m) => {
      const { item } = this.#planItem(m.planId, m.itemId);
      if (!["ready", "substituted"].includes(item.status)) {
        throw new Error(`条目状态不可装载：${item.status}`);
      }
      this.#emit("load_reported", { planId: m.planId, itemId: m.itemId, quantity: m.quantity ?? null, loadedBy: m.loadedBy });
      return { status: "recorded", planId: m.planId, itemId: m.itemId };
    });
  }

  reportSignoff(message) {
    return this.#idempotent("signoff", message, (m) => {
      const { item } = this.#planItem(m.planId, m.itemId);
      if (!m.signedBy || !m.role) throw new Error("签收缺少责任人或岗位");
      if (!["ready", "substituted"].includes(item.status)) {
        throw new Error(`条目状态不可签收：${item.status}`);
      }
      this.#emit("signoff_reported", { planId: m.planId, itemId: m.itemId, quantity: m.quantity ?? null, signedBy: m.signedBy, role: m.role });
      return { status: "recorded", planId: m.planId, itemId: m.itemId };
    });
  }

  #planItem(planId, itemId) {
    const state = this.#state();
    const plan = state.plans.get(planId);
    if (!plan) throw new Error(`航班计划不存在：${planId}`);
    const item = plan.items.get(itemId);
    if (!item) throw new Error(`计划条目不存在：${itemId}`);
    return { plan, item };
  }

  /** 装载与签收消息按消息编号幂等：重复只处理一次，同号不同内容交独立岗位核对。 */
  #idempotent(kind, message, execute) {
    if (!message?.messageId) throw new Error("消息缺少编号");
    const state = this.#state();
    const payloadHash = canonical({ kind, ...message });
    const seen = state.messages.get(message.messageId);
    if (seen) {
      if (seen.payloadHash === payloadHash) return { ...seen.result, duplicate: true };
      const conflictId = `msg:${message.messageId}`;
      if (!state.conflicts.has(conflictId)) {
        this.#emit("conflict_raised", {
          conflictId,
          kind: "message_payload_mismatch",
          messageId: message.messageId,
          detail: "同一消息编号携带不同内容，交独立岗位核对",
          raisedBy: message.loadedBy ?? message.signedBy ?? "unknown",
        });
      }
      return { status: "conflict", conflictId };
    }
    const result = execute(message);
    this.#emit("message_processed", { messageId: message.messageId, payloadHash, result });
    return result;
  }

  recordHandover({ planId, itemId, fromRole, toRole, acceptedBy, note }) {
    this.#planItem(planId, itemId);
    if (!toRole || !acceptedBy) throw new Error("责任交接缺少接收岗位或接收人");
    this.#emit("handover_recorded", { planId, itemId, fromRole: fromRole ?? null, toRole, acceptedBy, note: note ?? null });
    return this.flightReport(planId).items.find((i) => i.itemId === itemId);
  }

  resolveConflict({ conflictId, reviewerId, decision, note }) {
    const state = this.#state();
    const conflict = state.conflicts.get(conflictId);
    if (!conflict) throw new Error(`冲突不存在：${conflictId}`);
    if (conflict.status !== "open") throw new Error("冲突已处理");
    if (reviewerId === conflict.raisedBy) throw new Error("内容冲突须由独立岗位核对，提出人不得自行裁定");
    this.#emit("conflict_resolved", { conflictId, reviewerId, decision, note: note ?? null });
    if (conflict.kind === "hold_on_signed" && decision === "withdraw") {
      const plan = state.plans.get(conflict.planId);
      this.#emit("item_withdrawn", {
        planId: conflict.planId,
        itemId: conflict.itemId,
        holdId: conflict.holdId,
        reason: `独立岗位裁定撤回：${note ?? conflict.holdId}`,
        riskOwner: dutyManager(plan),
      });
    }
    return { conflictId, status: "resolved", decision };
  }

  #undispatched(state) {
    const pending = [];
    for (const plan of state.plans.values()) {
      for (const item of plan.items.values()) {
        if (item.status !== "ready" && item.status !== "substituted") continue;
        const dispatchKey = `${plan.planId}:${item.itemId}`;
        if (state.dispatches.has(dispatchKey)) continue;
        pending.push({ dispatchKey, planId: plan.planId, itemId: item.itemId, name: item.name, stage: item.stage });
      }
    }
    return pending;
  }

  pendingChecklist() {
    return { pending: this.#undispatched(this.#state()) };
  }

  /** 故障恢复后继续派发未完成清单；派发键确定，重复恢复不会重复派发。 */
  resumeDispatch() {
    const pending = this.#undispatched(this.#state());
    for (const p of pending) {
      this.#emit("dispatch_issued", { dispatchKey: p.dispatchKey, planId: p.planId, itemId: p.itemId, stage: p.stage });
    }
    return { issued: pending.map((p) => p.dispatchKey) };
  }

  flightReport(planId, asOf = null) {
    const state = this.#state(asOf);
    const plan = state.plans.get(planId);
    if (!plan) throw new Error(`航班计划不存在：${planId}`);
    const items = [...plan.items.values()].map(itemReport);
    return {
      planId: plan.planId,
      flightNumber: plan.flightNumber,
      route: plan.route,
      departureAirport: plan.departureAirport,
      arrivalAirport: plan.arrivalAirport,
      serviceDate: plan.serviceDate,
      scheduledDeparture: plan.scheduledDeparture,
      templateId: plan.templateId,
      generatedAt: plan.generatedAt,
      items,
      residualRisks: items
        .filter((i) => (i.status === "withdrawn" || i.status === "blocked") && !i.substitution)
        .map((i) => ({ itemId: i.itemId, name: i.name, owner: i.riskOwner, reason: i.withdrawal?.reason ?? i.reasons.join("；") })),
    };
  }

  loungeReport(loungeId, asOf = null) {
    const state = this.#state(asOf);
    const flights = [...state.plans.values()]
      .filter((p) => p.lounge?.loungeId === loungeId)
      .map((p) => ({
        planId: p.planId,
        flightNumber: p.flightNumber,
        serviceDate: p.serviceDate,
        items: [...p.items.values()].filter((i) => i.stage === "ground_lounge").map(itemReport),
      }));
    return { loungeId, flights };
  }

  conflictQueue() {
    return { open: [...this.#state().conflicts.values()].filter((c) => c.status === "open") };
  }
}
