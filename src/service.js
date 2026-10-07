/**
 * 节日航班服务包编排应用服务。
 *
 * 负责：航班/机型/休息室/物料/批件/配额登记、服务包构建与重评、
 * 换机型、批次停用与城市缺货的定点悬置、替代品重新审定、
 * 幂等装载签收、内容冲突的独立岗位核对、责任交接、故障恢复续派与时点视图。
 */
import { Clock } from "./clock.js";
import { Store } from "./store.js";
import { localDate, offsetMinutes } from "./dates.js";
import { evaluate, evaluateEntry, isPhysical } from "./rules.js";

// 缺省责任岗位（当单据未登记具体责任方时使用）
const ROLES = {
  PLANNER: "服务包编排岗",
  CONTENT: "内容审定岗",
  CATERING: "航食供应方",
  GROUND_HANDLER: "地面保障方",
  LOADER: "装机责任岗",
  CABIN_CREW: "客舱乘务组",
  LOUNGE_DUTY: "休息室值班岗",
  INDEPENDENT_REVIEW: "独立核对岗",
};

export class Service {
  constructor({ store = new Store(), clock = new Clock() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  health() {
    return { service: "holiday_service", status: "ok" };
  }

  register(recordId, ownerId) {
    const record = { recordId, ownerId, state: "draft", revision: 1, createdAt: this.clock.now() };
    this.store.add(record);
    return structuredClone(record);
  }

  find(recordId) {
    return this.store.get(recordId);
  }

  // -- 基础资料登记（全部版本化留痕） ----------------------------------------

  registerAirport({ airportId, name, utcOffset }) {
    offsetMinutes(utcOffset ?? "Z"); // 校验偏移格式
    return this.#put(`airport:${airportId}`, { airportId, name, utcOffset });
  }

  registerLounge({ loungeId, airportId, name }) {
    return this.#put(`lounge:${loungeId}`, { loungeId, airportId, name });
  }

  registerFlight({ flightId, scheduledDeparture, departureAirportId, arrivalAirportId, route, aircraftTypeId, cabins }) {
    return this.#put(`flight:${flightId}`, {
      flightId,
      scheduledDeparture,
      departureAirportId,
      arrivalAirportId,
      route,
      aircraftTypeId: aircraftTypeId ?? null,
      cabins: cabins ?? [],
    });
  }

  /** 临时更换机型：航班单据产生新修订，并触发所绑定服务包重评。 */
  changeAircraft(flightId, aircraftTypeId, { reason, by } = {}) {
    const flight = this.#requireDoc(`flight:${flightId}`, "航班");
    const previous = flight.data.aircraftTypeId;
    const at = this.clock.now();
    const revised = this.#put(`flight:${flightId}`, { ...flight.data, aircraftTypeId }, at, by);
    this.#log(flightId, "aircraft_changed", { flightId, previous, aircraftTypeId, reason: reason ?? null }, at, by);
    // 换机型后自动重评该航班全部已绑定服务包
    const refreshed = this.store
      .documentIds("binding:flight:")
      .map((id) => this.store.document(id))
      .filter((doc) => doc.data.flightId === flightId)
      .map((doc) => this.refreshManifest(this.#flightManifestId(flightId, doc.data.packageId, doc.data.cabin), { reason: "机型变更", at, by }));
    return { flight: revised, refreshedManifests: refreshed };
  }

  registerApproval({ approvalId, kind, title, state = "valid", validFrom, validTo, ownerId, scope }) {
    return this.#put(`approval:${approvalId}`, {
      approvalId,
      kind, // content（内容审定）| material（物料审定）
      title: title ?? "",
      state,
      validFrom: validFrom ?? null,
      validTo: validTo ?? null,
      ownerId: ownerId ?? (kind === "content" ? ROLES.CONTENT : ROLES.CATERING),
      scope: scope ?? null,
    });
  }

  registerBatch({ batchId, state = "released", usableFrom, usableTo, originCity, ownerId }) {
    return this.#put(`batch:${batchId}`, {
      batchId,
      state,
      usableFrom: usableFrom ?? null,
      usableTo: usableTo ?? null,
      originCity: originCity ?? null,
      ownerId: ownerId ?? ROLES.CATERING,
    });
  }

  registerAllergenDeclaration({ declarationId, state = "valid", approvalId, text }) {
    return this.#put(`allergen:${declarationId}`, { declarationId, state, approvalId, text: text ?? "" });
  }

  setQuota({ quotaKey, date, route, cabin, remaining }) {
    return this.#put(`quota:${quotaKey}|${date}|${route}|${cabin}`, { quotaKey, date, route, cabin, remaining });
  }

  registerCatalogEntry(entry) {
    return this.#put(`entry:${entry.entryId}`, {
      venue: "in_flight",
      scope: {},
      ...entry,
    });
  }

  registerPackage({ packageId, theme, entryIds = [], loungeIds = [] }) {
    return this.#put(`pkg:${packageId}`, { packageId, theme, entryIds, loungeIds });
  }

  bindFlightPackage({ flightId, packageId, cabin }) {
    return this.#put(`binding:flight:${flightId}:${cabin}`, { flightId, packageId, cabin });
  }

  bindLoungePackage({ loungeId, packageId }) {
    return this.#put(`binding:lounge:${loungeId}`, { loungeId, packageId });
  }

  // -- 供应事件：定点悬置，不牵连其他现场 ------------------------------------

  /** 某城市缺货：只悬置从该城市发货的实物条目。 */
  holdCityStock(city, { reason, by } = {}) {
    const at = this.clock.now();
    const doc = this.#put(`hold:city:${city}`, { city, state: "held", reason: reason ?? null }, at, by);
    this.#log("supply", "city_stock_held", { city, reason: reason ?? null }, at, by);
    for (const id of this.#activeManifestIds()) this.refreshManifest(id, { reason: `城市 ${city} 缺货`, at, by });
    return doc;
  }

  releaseCityStock(city, { by } = {}) {
    const at = this.clock.now();
    const doc = this.#put(`hold:city:${city}`, { city, state: "released" }, at, by);
    this.#log("supply", "city_stock_released", { city }, at, by);
    for (const id of this.#activeManifestIds()) this.refreshManifest(id, { reason: `城市 ${city} 恢复供货`, at, by });
    return doc;
  }

  /** 食品批次停用：只击中该批次的实物条目，广播等内容不受影响。 */
  stopBatch(batchId, { reason, by } = {}) {
    const batch = this.#requireDoc(`batch:${batchId}`, "供应批次");
    const at = this.clock.now();
    const doc = this.#put(`batch:${batchId}`, { ...batch.data, state: "stopped", stopReason: reason ?? null }, at, by);
    this.#log(`batch:${batchId}`, "batch_stopped", { batchId, reason: reason ?? null }, at, by);
    for (const id of this.#activeManifestIds()) this.refreshManifest(id, { reason: `批次 ${batchId} 停用`, at, by });
    return doc;
  }

  // -- 服务包构建与重评 -------------------------------------------------------

  #flightManifestId(flightId, packageId, cabin) {
    return `manifest:${flightId}:${packageId}:${cabin}`;
  }

  buildFlightManifest({ flightId, packageId, cabin }) {
    const flight = this.#requireDoc(`flight:${flightId}`, "航班").data;
    if (!flight.aircraftTypeId) throw new Error("航班尚未指派机型，无法确定现场可执行版本");
    this.bindFlightPackage({ flightId, packageId, cabin });
    const manifestId = this.#flightManifestId(flightId, packageId, cabin);
    return this.#buildOrRefresh(manifestId, { kind: "flight", flightId, packageId, cabin });
  }

  buildLoungeManifest({ loungeId, packageId, date = null }) {
    const lounge = this.#requireDoc(`lounge:${loungeId}`, "休息室").data;
    const airport = this.#requireDoc(`airport:${lounge.airportId}`, "机场").data;
    const effectiveDate = date ?? localDate(this.clock.now(), airport.utcOffset);
    this.bindLoungePackage({ loungeId, packageId });
    const manifestId = `manifest-lounge:${loungeId}:${packageId}:${effectiveDate}`;
    return this.#buildOrRefresh(manifestId, { kind: "lounge", loungeId, packageId, date: effectiveDate });
  }

  /** 重新评估并产生新修订（历史修订保留，视图可回看任一时点）。 */
  refreshManifest(manifestId, { reason = null, at = this.clock.now(), by = null } = {}) {
    const existing = this.store.document(manifestId);
    if (!existing) throw new Error(`清单 ${manifestId} 尚未建立`);
    return this.#buildOrRefresh(manifestId, existing.data.basis, { revision: true, reason, at, by });
  }

  #buildOrRefresh(manifestId, basis, opts = {}) {
    const at = opts.at ?? this.clock.now();
    const by = opts.by ?? null;

    let ctx;
    let pkg;
    if (basis.kind === "flight") {
      const flight = this.#requireDoc(`flight:${basis.flightId}`, "航班").data;
      const airport = this.#requireDoc(`airport:${flight.departureAirportId}`, "起飞机场").data;
      pkg = this.#requireDoc(`pkg:${basis.packageId}`, "服务包").data;
      ctx = {
        venue: "in_flight",
        instant: flight.scheduledDeparture,
        localDate: localDate(flight.scheduledDeparture, airport.utcOffset),
        route: flight.route,
        cabin: basis.cabin,
        aircraftType: flight.aircraftTypeId,
        loungeId: null,
      };
    } else {
      const lounge = this.#requireDoc(`lounge:${basis.loungeId}`, "休息室").data;
      pkg = this.#requireDoc(`pkg:${basis.packageId}`, "服务包").data;
      ctx = {
        venue: "lounge",
        instant: at,
        localDate: basis.date,
        route: `lounge:${basis.loungeId}`,
        cabin: "lounge",
        aircraftType: null,
        loungeId: basis.loungeId,
      };
    }

    // 替代关系按清单隔离：仅在本现场生效的替代品参与评估，
    // 一个现场通过替代不会连带改变其他现场对同一原条目的裁决。
    const catalog = this.#buildCatalog(manifestId);
    const replacementEntries = [];
    for (const id of this.store.documentIds(`replace:${manifestId}:`)) {
      const doc = this.store.document(id);
      if (doc.data.status === "active") {
        const replacement = catalog.entries.get(doc.data.newEntryId);
        if (replacement) replacementEntries.push(replacement);
      }
    }
    const entries = [
      ...pkg.entryIds.map((id) => catalog.entries.get(id)).filter(Boolean),
      ...replacementEntries.filter(Boolean),
    ];

    const evaluation = evaluate(entries, ctx, catalog);
    const items = evaluation.items.map(({ entry, verdict }) => ({
      entryId: entry.entryId,
      replacesEntryId: entry.replacesEntryId ?? null,
      kind: entry.kind,
      venue: entry.venue,
      title: entry.title,
      approvalId: entry.approvalId,
      batchId: entry.batchId ?? null,
      originCity: entry.originCity ?? null,
      verdict,
      riskOwner: this.#riskOwner(entry, verdict, catalog),
    }));

    const rev = this.#put(
      manifestId,
      {
        manifestId,
        basis,
        context: ctx,
        items,
        summary: evaluation.summary,
      },
      at,
      by
    );

    // 同步任务并派发（稳定任务键；已完成/已取消的不动）
    const tasks = this.#syncTasks(manifestId, basis.packageId, items, at, by);
    const pendingKeys = tasks.filter((t) => t.status === "pending").map((t) => t.taskKey);
    const dispatchId = `dispatch:${manifestId}:r${rev.revision}`;
    this.store.recordDispatch({ dispatchId, manifestId, taskKeys: pendingKeys, at });
    this.#log(manifestId, opts.revision ? "manifest_refreshed" : "manifest_built", {
      revision: rev.revision,
      reason: opts.reason ?? null,
      summary: evaluation.summary,
      dispatched: pendingKeys,
    }, at, by);

    return { manifest: rev, tasks, dispatchId, pending: pendingKeys };
  }

  // 任务键按清单隔离：同一服务包在不同舱位/休息室是不同现场，任务互不串单
  #loadKey(manifestId, entryId) {
    return `${manifestId}:load:${entryId}`;
  }

  #replaceKey(manifestId, entryId) {
    return `${manifestId}:replace:${entryId}`;
  }

  #syncTasks(manifestId, packageId, items, at, by) {
    const desired = new Map();
    for (const item of items) {
      if (item.verdict.status === "active") {
        const key = this.#loadKey(manifestId, item.entryId);
        desired.set(key, {
          taskKey: key,
          type: "load_and_sign",
          packageId,
          manifestId,
          entryId: item.entryId,
          venue: item.venue,
        });
      }
    }
    // 须换条目（悬置/不合格/出范围）产生替代核对任务；已替代的不产生
    for (const item of items) {
      const v = item.verdict;
      if (v.status === "suspended" || v.status === "not_approved" || v.status === "out_of_scope") {
        const key = this.#replaceKey(manifestId, item.entryId);
        desired.set(key, {
          taskKey: key,
          type: "substitute_review",
          packageId,
          manifestId,
          entryId: item.entryId,
          venue: item.venue,
          reasons: v.reasons,
          hold: v.hold ?? null,
        });
      }
    }

    const result = [];
    for (const [key, patch] of desired) {
      const existing = this.store.getTask(key);
      if (existing && (existing.status === "done" || existing.status === "cancelled")) {
        result.push(existing);
        continue;
      }
      const saved = this.store.upsertTask({ ...patch, status: existing?.status ?? "pending" });
      if (!existing) this.#log(manifestId, "task_opened", { taskKey: key, type: saved.type }, at, by);
      result.push(saved);
    }
    // 取消不再需要的待办（如悬置解除、条目已被替代）
    for (const task of this.store.listTasks(packageId)) {
      if (task.manifestId === manifestId && task.status === "pending" && !desired.has(task.taskKey)) {
        const cancelled = this.store.upsertTask({ taskKey: task.taskKey, status: "cancelled" });
        this.#log(manifestId, "task_cancelled", { taskKey: task.taskKey }, at, by);
        result.push(cancelled);
      }
    }
    return result;
  }

  // -- 替代品：必须重新核对适用范围，不得沿用原批准 --------------------------

  /**
   * 提交替代品。系统用替代品自身的批件/批次/过敏原/配额重新过闸：
   * - 通过：替代品生效，原条目标记 replaced，装机任务下发，剩余风险转移给装机链；
   * - 不通过：拒绝替代，原条目维持悬置，剩余风险仍归原责任方，并记录拒绝原因。
   */
  proposeSubstitution({ packageId, origEntryId, newEntry, basis, proposedBy, reviewId }) {
    const at = this.clock.now();
    if (!newEntry?.entryId) throw new Error("替代品必须包含新的条目编号");
    if (!newEntry.approvalId) throw new Error("替代品必须携带自己的审定批件，不得沿用原批准");
    const orig = this.store.document(`entry:${origEntryId}`);
    if (!orig) throw new Error("原条目不存在");
    if (newEntry.approvalId === orig.data.approvalId) {
      throw new Error("替代品沿用了原批准编号，必须重新审定");
    }

    // 替代品作为新条目登记（独立版本、独立批件）
    this.registerCatalogEntry({
      venue: orig.data.venue,
      ...newEntry,
      replacesEntryId: origEntryId,
    });

    // 在每个已建清单的现场上下文中重新过闸
    const checks = this.store
      .documentIds(orig.data.venue === "lounge" ? "manifest-lounge:" : "manifest:")
      .map((id) => this.store.document(id))
      .filter((doc) => doc.data.basis.packageId === packageId)
      .map((doc) => {
        const catalog = this.#buildCatalog(doc.data.manifestId);
        const entry = catalog.entries.get(newEntry.entryId);
        const verdict = evaluateEntry(entry, doc.data.context, catalog);
        return { manifestId: doc.data.manifestId, verdict };
      });

    // 替代品可能只在部分现场适用：仅在通过的现场生效，其余现场维持原状
    const passed = checks.filter((c) => c.verdict.status === "active");
    const failed = checks.filter((c) => c.verdict.status !== "active");
    if (!passed.length) {
      this.#log(`replace:${packageId}:${origEntryId}`, "substitution_rejected", {
        packageId, origEntryId, newEntryId: newEntry.entryId, basis: basis ?? null,
        checks, proposedBy: proposedBy ?? null, reviewId: reviewId ?? null,
      }, at, proposedBy);
      return { accepted: false, checks, residualRisk: this.#currentRiskOwner(packageId, origEntryId) };
    }

    for (const c of passed) {
      const docId = `replace:${c.manifestId}:${origEntryId}`;
      this.#put(docId, {
        packageId, manifestId: c.manifestId, origEntryId, newEntryId: newEntry.entryId,
        status: "active", basis: basis ?? null, proposedBy: proposedBy ?? null,
        independentReviewId: reviewId ?? null, scope: c.verdict.reasons.length ? c.verdict.reasons : null,
      }, at, proposedBy);
      this.#log(docId, "substitution_accepted", {
        origEntryId, newEntryId: newEntry.entryId, basis: basis ?? null,
      }, at, proposedBy);
      this.refreshManifest(c.manifestId, { reason: `替代条目 ${newEntry.entryId} 生效`, at, by: proposedBy });
    }
    for (const c of failed) {
      this.#log(`replace:${c.manifestId}:${origEntryId}`, "substitution_scope_rejected", {
        origEntryId, newEntryId: newEntry.entryId, reasons: c.verdict.reasons,
      }, at, proposedBy);
    }
    return { accepted: true, passedManifests: passed.map((c) => c.manifestId), rejectedScopes: failed };
  }

  // -- 装载与签收：幂等、冲突独立核对、责任交接 ------------------------------

  /**
   * 装载上报。eventId 相同的重复消息只处理一次。
   * 同一任务收到内容相互冲突（数量/状况不一致）的上报时，任务挂起并交独立核对岗。
   */
  reportLoad({ manifestId, entryId, eventId, loaderId, quantity = 1, condition = "ok", at = this.clock.now() }) {
    const task = this.#loadTask(manifestId, entryId);
    // 先取此前的装载上报（当前消息尚未入日志），用于内容冲突比对
    const prev = this.store.eventLog(manifestId)
      .filter((e) => e.type === "loaded" && e.payload.entryId === entryId)
      .slice(-1)[0];
    const id = eventId ?? `load:${task.taskKey}:${loaderId}:${quantity}:${condition}:${at}`;
    const { event, duplicated } = this.store.appendEvent({
      eventId: id, streamId: manifestId, type: "loaded", at,
      actor: loaderId, payload: { entryId, quantity, condition },
    });
    if (duplicated) return { processed: false, duplicated: true, eventId: id };

    if (task.status === "conflict") return { processed: true, conflictOpen: true };

    if (prev && (prev.payload.quantity !== quantity || prev.payload.condition !== condition) && prev.actor !== loaderId) {
      this.store.upsertTask({ taskKey: task.taskKey, status: "conflict" });
      this.#put(`review:${task.taskKey}`, {
        taskKey: task.taskKey, manifestId, entryId, status: "open",
        reports: [prev, event], openedAt: at,
      }, at, loaderId);
      this.#log(manifestId, "load_conflict", { taskKey: task.taskKey, events: [prev.eventId, id] }, at, loaderId);
      return { processed: true, conflict: true, taskKey: task.taskKey };
    }

    this.store.upsertTask({ taskKey: task.taskKey, status: "loaded", loadedBy: loaderId, loadedAt: at, quantity });
    // 装载上报仅记录到货与待签收状态，责任仍在装机链；签收时才正式交接
    return { processed: true, status: "loaded", taskKey: task.taskKey };
  }

  /** 签收：责任正式转移到接收方。冲突未决前不得签收。 */
  reportSignoff({ manifestId, entryId, eventId, signerId, signerName, quantity = 1, at = this.clock.now() }) {
    const task = this.#loadTask(manifestId, entryId);
    if (task.status === "conflict") throw new Error("装载冲突未由独立核对岗裁决，不得签收");
    const id = eventId ?? `sign:${task.taskKey}:${signerId}:${quantity}:${at}`;
    const { duplicated } = this.store.appendEvent({
      eventId: id, streamId: manifestId, type: "signed", at,
      actor: signerId, payload: { entryId, quantity, signerName: signerName ?? null },
    });
    if (duplicated) return { processed: false, duplicated: true, eventId: id };

    this.store.upsertTask({
      taskKey: task.taskKey, status: "done", signedBy: signerId, signedByName: signerName ?? null,
      signedAt: at, quantity,
    });
    // 签收即责任由装机岗正式移交接收方（客舱乘务组 / 休息室值班岗）
    const toRole = this.#receivingRole(task);
    this.#log(manifestId, "risk_handoff", {
      entryId, from: ROLES.LOADER, to: toRole, via: "signoff", signerId,
    }, at, signerId);
    return { processed: true, status: "signed", riskOwner: toRole };
  }

  /** 独立岗位裁决装载冲突；裁决人不得是冲突上报人之一。 */
  resolveLoadConflict({ taskKey, decision, reviewerId, note, at = this.clock.now() }) {
    const review = this.#requireDoc(`review:${taskKey}`, "冲突核对单");
    if (review.data.status !== "open") throw new Error("该冲突已裁决");
    const reporters = new Set(review.data.reports.map((r) => r.actor));
    if (reporters.has(reviewerId)) throw new Error("核对岗位必须独立于冲突上报人");
    const task = this.store.getTask(taskKey);
    this.#put(`review:${taskKey}`, { ...review.data, status: "resolved", decision, reviewerId, note: note ?? null, resolvedAt: at }, at, reviewerId);
    const next = decision === "reject_load" ? "pending" : "loaded";
    this.store.upsertTask({ taskKey, status: next, conflictResolvedBy: reviewerId });
    this.#log(task.manifestId, "conflict_resolved", { taskKey, decision, reviewerId }, at, reviewerId);
    return { taskKey, status: next, reviewer: { id: reviewerId, role: ROLES.INDEPENDENT_REVIEW } };
  }

  // -- 故障恢复：继续派发未完成清单 ------------------------------------------

  /** 系统故障恢复后调用：返回所有仍未完成的任务并续派，已签收的不重复。 */
  recoverDispatch() {
    const at = this.clock.now();
    const pending = this.store.pendingDispatchItems();
    for (const task of pending) {
      this.#log(task.manifestId, "dispatch_continued", { taskKey: task.taskKey, type: task.type }, at, null);
    }
    return { recoveredAt: at, pending };
  }

  // -- 值班经理视图：当时应备 / 实际签收 / 替代理由 / 责任交接 ----------------

  viewFlight({ flightId, cabin, packageId = null, at = this.clock.now() }) {
    const pkgId = packageId ?? this.#inferPackageId("binding:flight:", (d) => d.flightId === flightId && d.cabin === cabin);
    const manifestId = this.#flightManifestId(flightId, pkgId, cabin);
    return this.#view(manifestId, at, { flightId, cabin });
  }

  viewLounge({ loungeId, date = null, packageId = null, at = this.clock.now() }) {
    const pkgId = packageId ?? this.#inferPackageId("binding:lounge:", (d) => d.loungeId === loungeId);
    const lounge = this.#requireDoc(`lounge:${loungeId}`, "休息室").data;
    const airport = this.#requireDoc(`airport:${lounge.airportId}`, "机场").data;
    const effectiveDate = date ?? localDate(at, airport.utcOffset);
    return this.#view(`manifest-lounge:${loungeId}:${pkgId}:${effectiveDate}`, at, { loungeId, date: effectiveDate });
  }

  #view(manifestId, at, locator) {
    const rev = this.store.documentAt(manifestId, at);
    if (!rev) return { found: false, ...locator, at, message: "该时点尚无已发布的服务清单" };

    const events = this.store.eventLog(manifestId).filter((e) => e.at <= at);
    const items = rev.data.items.map((item) => {
      const entryEvents = events.filter((e) => e.payload?.entryId === item.entryId || e.payload?.origEntryId === item.entryId);
      const loaded = entryEvents.filter((e) => e.type === "loaded").pop() ?? null;
      const signed = entryEvents.filter((e) => e.type === "signed").pop() ?? null;
      const handoffs = entryEvents.filter((e) => e.type === "risk_handoff").map((e) => e.payload);
      const sub = this.store.documentAt(`replace:${manifestId}:${item.entryId}`, at);

      return {
        entryId: item.entryId,
        title: item.title,
        kind: item.kind,
        venue: item.venue,
        expected: item.verdict,                 // 当时应备
        actual: signed                           // 实际签收
          ? { status: "signed", signedBy: signed.actor, signedAt: signed.at, quantity: signed.payload.quantity, signerName: signed.payload.signerName }
          : loaded
            ? { status: "loaded", loadedBy: loaded.actor, loadedAt: loaded.at, quantity: loaded.payload.quantity }
            : { status: "not_received" },
        substitution: sub ? {                     // 替代理由
          replacedEntry: item.entryId,
          replacementEntry: sub.data.newEntryId,
          basis: sub.data.basis,
          proposedBy: sub.data.proposedBy,
          independentReviewId: sub.data.independentReviewId,
          at: sub.createdAt,
        } : (item.replacesEntryId ? { isReplacementFor: item.replacesEntryId } : null),
        risk: {                                   // 责任交接链与当前剩余风险承担方
          owner: signed ? this.#receivingRole({ venue: item.venue }) : item.riskOwner,
          handoffs,
        },
      };
    });

    return {
      found: true,
      ...locator,
      at,
      viewedRevision: rev.revision,
      basis: rev.data.basis,
      effectiveLocalDate: rev.data.context.localDate,
      summary: rev.data.summary,
      items,
      openReplacements: items.filter((i) =>
        ["suspended", "not_approved", "out_of_scope"].includes(i.expected.status) && !i.substitution),
    };
  }

  // -- 内部工具 ---------------------------------------------------------------

  #inferPackageId(prefix, predicate) {
    for (const id of this.store.documentIds(prefix)) {
      const doc = this.store.document(id);
      if (predicate(doc.data)) return doc.data.packageId;
    }
    throw new Error("未找到服务包绑定");
  }

  #activeManifestIds() {
    return this.store.documentIds("manifest");
  }

  #loadTask(manifestId, entryId) {
    this.#requireDoc(manifestId, "服务清单");
    const task = this.store.getTask(this.#loadKey(manifestId, entryId));
    if (!task || task.manifestId !== manifestId) throw new Error(`条目 ${entryId} 在本清单没有装机任务`);
    return task;
  }

  #receivingRole(task) {
    return task.venue === "lounge" ? ROLES.LOUNGE_DUTY : ROLES.CABIN_CREW;
  }

  #currentRiskOwner(packageId, origEntryId) {
    for (const id of this.store.documentIds("manifest")) {
      const doc = this.store.document(id);
      if (doc.data.basis.packageId !== packageId) continue;
      const item = doc.data.items.find((i) => i.entryId === origEntryId);
      if (item) return { manifestId: id, owner: item.riskOwner, reasons: item.verdict.reasons };
    }
    return null;
  }

  #riskOwner(entry, verdict, catalog) {
    switch (verdict.status) {
      case "active":
        return ROLES.LOADER;
      case "suspended":
        if (verdict.hold?.type === "city_stock")
          return `${ROLES.GROUND_HANDLER}（${verdict.hold.city}）`;
        if (verdict.hold?.type === "batch_stop") {
          const batch = catalog.batches.get(entry.batchId);
          return batch?.ownerId ?? ROLES.CATERING;
        }
        return ROLES.GROUND_HANDLER;
      case "not_approved": {
        const approval = catalog.approvals.get(entry.approvalId);
        return approval?.ownerId ?? (isPhysical(entry) ? ROLES.CATERING : ROLES.CONTENT);
      }
      case "out_of_scope":
        return ROLES.PLANNER;
      case "replaced":
        return null;
      default:
        return ROLES.PLANNER;
    }
  }

  #buildCatalog(manifestId = null) {
    const map = (prefix, keyField) => {
      const out = new Map();
      for (const id of this.store.documentIds(prefix)) {
        const doc = this.store.document(id);
        out.set(doc.data[keyField], doc.data);
      }
      return out;
    };
    const approvals = map("approval:", "approvalId");
    const batches = map("batch:", "batchId");
    const allergenDeclarations = map("allergen:", "declarationId");
    const entries = map("entry:", "entryId");

    const quotas = new Map();
    for (const id of this.store.documentIds("quota:")) {
      const q = this.store.document(id).data;
      quotas.set(`${q.quotaKey}|${q.date}|${q.route}|${q.cabin}`, q);
    }
    const stockHolds = new Set();
    for (const id of this.store.documentIds("hold:city:")) {
      const hold = this.store.document(id).data;
      if (hold.state === "held") stockHolds.add(hold.city);
    }
    // 替代关系按清单隔离：只读取本现场的 replace 单据
    const replacedBy = new Map();
    if (manifestId) {
      for (const id of this.store.documentIds(`replace:${manifestId}:`)) {
        const d = this.store.document(id).data;
        if (d.status === "active") replacedBy.set(d.origEntryId, d.newEntryId);
      }
    }
    return { approvals, batches, allergenDeclarations, entries, quotas, stockHolds, replacedBy };
  }

  #put(docId, data, at = this.clock.now(), author = null) {
    return this.store.putDocument({ docId, data, at, author });
  }

  #log(streamId, type, payload, at = this.clock.now(), actor = null) {
    const eventId = `evt:${streamId}:${type}:${this.store.eventLog(streamId).length + 1}:${at}`;
    return this.store.appendEvent({ eventId, streamId, type, at, actor, payload });
  }

  #requireDoc(docId, label) {
    const doc = this.store.document(docId);
    if (!doc) throw new Error(`${label}不存在：${docId}`);
    return doc;
  }
}

export { ROLES };
