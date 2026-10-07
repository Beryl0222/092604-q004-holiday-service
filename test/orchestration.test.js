import assert from "node:assert/strict";
import test from "node:test";

import { Service, ROLES } from "../src/service.js";
import { localDate } from "../src/dates.js";

/** 可控时钟：测试需要在换机型、替代等操作后推进时间以验证时点视图。 */
class MutableClock {
  constructor(t0 = "2026-10-01T10:00:00.000Z") {
    this.t = Date.parse(t0);
  }
  now() {
    this.t += 1000;
    return new Date(this.t).toISOString();
  }
  advance(ms) {
    this.t += ms;
  }
}

// 跨午夜：PEK(+08:00) 当地已翻到 10-02，UTC 仍是 10-01
const DEP_UTC = "2026-10-01T17:30:00.000Z";
const LOCAL_DAY = "2026-10-02";

function buildWorld() {
  const clock = new MutableClock();
  const service = new Service({ clock });

  service.registerAirport({ airportId: "PEK", name: "北京", utcOffset: "+08:00" });
  service.registerAirport({ airportId: "SHA", name: "上海", utcOffset: "+08:00" });
  service.registerLounge({ loungeId: "PEK-L1", airportId: "PEK", name: "首都节日休息室" });

  service.registerFlight({
    flightId: "CA1234", scheduledDeparture: DEP_UTC, departureAirportId: "PEK",
    arrivalAirportId: "SHA", route: "PEK-SHA", aircraftTypeId: "A320", cabins: ["business", "economy"],
  });

  // 批件：内容审定（广播）与物料审定分开；替代品将各自携带新批件
  service.registerApproval({ approvalId: "ap-ann", kind: "content", title: "节日广播词审定", validFrom: "2026-10-01", validTo: "2026-10-31" });
  service.registerApproval({ approvalId: "ap-moon", kind: "material", title: "月饼审定", validFrom: LOCAL_DAY, validTo: "2026-10-31" });
  service.registerApproval({ approvalId: "ap-lantern", kind: "material", title: "灯笼手作审定", validFrom: LOCAL_DAY, validTo: "2026-10-31" });
  service.registerApproval({ approvalId: "ap-kit", kind: "material", title: "非遗彩绘审定", validFrom: LOCAL_DAY, validTo: "2026-10-31" });

  service.registerBatch({ batchId: "b-moon", originCity: "PEK", usableFrom: LOCAL_DAY, usableTo: "2026-10-10" });
  service.registerBatch({ batchId: "b-lantern", originCity: "SHA", usableFrom: LOCAL_DAY, usableTo: "2026-10-10" });
  service.registerBatch({ batchId: "b-kit", originCity: "PEK", usableFrom: LOCAL_DAY, usableTo: "2026-10-10" });

  service.registerAllergenDeclaration({ declarationId: "ad-moon", approvalId: "ap-moon", text: "含蛋黄、坚果" });
  service.registerAllergenDeclaration({ declarationId: "ad-lantern", approvalId: "ap-lantern", text: "无食品成分" });

  service.setQuota({ quotaKey: "moon", date: LOCAL_DAY, route: "PEK-SHA", cabin: "business", remaining: 50 });
  service.setQuota({ quotaKey: "moon", date: LOCAL_DAY, route: "PEK-SHA", cabin: "economy", remaining: 200 });
  service.setQuota({ quotaKey: "lantern", date: LOCAL_DAY, route: "PEK-SHA", cabin: "business", remaining: 50 });

  service.registerCatalogEntry({
    entryId: "ann-festival", kind: "announcement", title: "中秋节日广播词",
    approvalId: "ap-ann", venue: "in_flight",
  });
  service.registerCatalogEntry({
    entryId: "snack-moon", kind: "snack", title: "节日月饼",
    approvalId: "ap-moon", batchId: "b-moon", originCity: "PEK",
    allergenDeclarationId: "ad-moon", quotaKey: "moon", venue: "in_flight",
  });
  // 灯笼手作仅适配 A320：换 A330 后出适用范围，必须换
  service.registerCatalogEntry({
    entryId: "craft-lantern", kind: "craft", title: "灯笼手作物料",
    approvalId: "ap-lantern", batchId: "b-lantern", originCity: "SHA",
    allergenDeclarationId: "ad-lantern", quotaKey: "lantern", venue: "in_flight",
    scope: { aircraftTypes: ["A320"] },
  });
  service.registerCatalogEntry({
    entryId: "kit-heritage", kind: "experience_kit", title: "非遗兔爷彩绘套装",
    approvalId: "ap-kit", batchId: "b-kit", originCity: "PEK", venue: "in_flight",
  });

  service.registerPackage({
    packageId: "pkg-midautumn", theme: "中秋",
    entryIds: ["ann-festival", "snack-moon", "craft-lantern", "kit-heritage"],
  });

  return { service, clock };
}

function byId(items, id) {
  return items.find((i) => i.entryId === id);
}

test("跨午夜航班按计划起飞地当地日期生效（UTC 10-01 / 北京 10-02）", () => {
  const { service } = buildWorld();
  const { manifest } = service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" });
  assert.equal(manifest.data.context.localDate, LOCAL_DAY);
  // 批件/批次窗口按 10-02 当日有效，四项全部照常
  assert.deepEqual(manifest.data.summary, { active: 4, suspended: 0, replaced: 0, not_approved: 0, out_of_scope: 0 });
  assert.equal(localDate(DEP_UTC, "+08:00"), LOCAL_DAY);
});

test("临时换机型：A320 专属灯笼出范围必须换，广播与其余物料照常", () => {
  const { service } = buildWorld();
  const built = service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" });
  const before = built.manifest.createdAt;

  const { refreshedManifests } = service.changeAircraft("CA1234", "A330", { reason: "机型临时调整", by: "duty-mgr" });
  const latest = refreshedManifests[0].manifest.data;

  assert.equal(byId(latest.items, "ann-festival").verdict.status, "active", "广播不受换机型影响");
  assert.equal(byId(latest.items, "snack-moon").verdict.status, "active");
  assert.equal(byId(latest.items, "kit-heritage").verdict.status, "active");
  assert.equal(byId(latest.items, "craft-lantern").verdict.status, "out_of_scope");
  assert.match(byId(latest.items, "craft-lantern").verdict.reasons[0], /机型/);

  // 换机型前的历史修订仍可回看，未被当前模板覆盖
  const past = service.store.documentAt(built.manifest.data.manifestId, before);
  assert.equal(past.revision, 1);
  assert.equal(byId(past.data.items, "craft-lantern").verdict.status, "active");
});

test("食品批次停用只悬置该批次实物，不误伤广播内容", () => {
  const { service } = buildWorld();
  service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" });
  service.stopBatch("b-moon", { reason: "抽检不合格" });

  const view = service.viewFlight({ flightId: "CA1234", cabin: "business" });
  assert.equal(byId(view.items, "snack-moon").expected.status, "suspended");
  assert.equal(byId(view.items, "snack-moon").expected.hold.type, "batch_stop");
  assert.equal(byId(view.items, "ann-festival").expected.status, "active", "广播无批次概念，保持照常");
  assert.equal(byId(view.items, "kit-heritage").expected.status, "active");
  // 剩余风险由批次责任方（航食供应方）承担
  assert.equal(byId(view.items, "snack-moon").risk.owner, ROLES.CATERING);
});

test("某城市缺货只悬置该城市发货条目，不连带撤回其他城市已确认物料", () => {
  const { service } = buildWorld();
  service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" });
  service.holdCityStock("SHA", { reason: "上海仓库调拨中断" });

  const view = service.viewFlight({ flightId: "CA1234", cabin: "business" });
  assert.equal(byId(view.items, "craft-lantern").expected.status, "suspended");
  assert.equal(byId(view.items, "craft-lantern").expected.hold.city, "SHA");
  assert.equal(byId(view.items, "snack-moon").expected.status, "active", "北京发货月饼不受上海缺货牵连");
  assert.equal(byId(view.items, "kit-heritage").expected.status, "active");
  assert.match(byId(view.items, "craft-lantern").risk.owner, /地面保障方（SHA）/);

  // 城市恢复后自动解除悬置
  service.releaseCityStock("SHA");
  const healed = service.viewFlight({ flightId: "CA1234", cabin: "business" });
  assert.equal(byId(healed.items, "craft-lantern").expected.status, "active");
});

test("替代品必须重新审定：沿用原批准被拒，重新核对适用范围后才生效", () => {
  const { service } = buildWorld();
  service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" });
  service.stopBatch("b-moon");

  assert.throws(
    () => service.proposeSubstitution({
      packageId: "pkg-midautumn", origEntryId: "snack-moon",
      newEntry: { entryId: "snack-moon-x", kind: "snack", title: "备用糕点", approvalId: "ap-moon", batchId: "b-alt" },
    }),
    /重新审定|沿用原批准/
  );

  // 合规替代品：自带内容/物料批件、批次、过敏原声明
  service.registerApproval({ approvalId: "ap-alt", kind: "material", title: "备用糕点审定", validFrom: LOCAL_DAY, validTo: "2026-10-31" });
  service.registerBatch({ batchId: "b-alt", originCity: "PEK", usableFrom: LOCAL_DAY, usableTo: "2026-10-10" });
  service.registerAllergenDeclaration({ declarationId: "ad-alt", approvalId: "ap-alt", text: "含小麦" });
  service.setQuota({ quotaKey: "moon", date: LOCAL_DAY, route: "PEK-SHA", cabin: "business", remaining: 40 });

  const res = service.proposeSubstitution({
    packageId: "pkg-midautumn", origEntryId: "snack-moon",
    newEntry: {
      entryId: "snack-moon-x", kind: "snack", title: "备用糕点", venue: "in_flight",
      approvalId: "ap-alt", batchId: "b-alt", originCity: "PEK",
      allergenDeclarationId: "ad-alt", quotaKey: "moon",
    },
    basis: "同风味替代，独立批次与过敏原核对通过", proposedBy: "catering-1", reviewId: "rev-77",
  });
  assert.equal(res.accepted, true);

  const view = service.viewFlight({ flightId: "CA1234", cabin: "business" });
  assert.equal(byId(view.items, "snack-moon").expected.status, "replaced");
  assert.equal(byId(view.items, "snack-moon-x").expected.status, "active");
  assert.equal(byId(view.items, "snack-moon").substitution.replacementEntry, "snack-moon-x");
  assert.equal(byId(view.items, "snack-moon").substitution.basis, "同风味替代，独立批次与过敏原核对通过");
});

test("替代品在不适用的舱位被拒，不影响其在适用舱位生效", () => {
  const { service } = buildWorld();
  service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" });
  service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "economy" });
  service.stopBatch("b-moon");

  // 替代批件只覆盖商务舱
  service.registerApproval({
    approvalId: "ap-alt-biz", kind: "material", title: "商务舱备用糕点",
    validFrom: LOCAL_DAY, validTo: "2026-10-31", scope: { cabins: ["business"] },
  });
  service.registerBatch({ batchId: "b-alt-biz", originCity: "PEK", usableFrom: LOCAL_DAY, usableTo: "2026-10-10" });
  service.registerAllergenDeclaration({ declarationId: "ad-alt-biz", approvalId: "ap-alt-biz", text: "含小麦" });

  const res = service.proposeSubstitution({
    packageId: "pkg-midautumn", origEntryId: "snack-moon",
    newEntry: {
      entryId: "snack-moon-biz", kind: "snack", title: "商务舱备用糕点", venue: "in_flight",
      approvalId: "ap-alt-biz", batchId: "b-alt-biz", originCity: "PEK",
      allergenDeclarationId: "ad-alt-biz",
    },
    basis: "仅商务舱供应", proposedBy: "catering-1",
  });
  assert.deepEqual(res.passedManifests, ["manifest:CA1234:pkg-midautumn:business"]);
  assert.equal(res.rejectedScopes[0].manifestId, "manifest:CA1234:pkg-midautumn:economy");

  const economy = service.viewFlight({ flightId: "CA1234", cabin: "economy" });
  assert.equal(byId(economy.items, "snack-moon").expected.status, "suspended", "经济舱现场维持悬置，未被商务舱替代牵连");
});

test("装载与签收重复消息只处理一次", () => {
  const { service } = buildWorld();
  const mid = service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" }).manifest.data.manifestId;

  const r1 = service.reportLoad({ manifestId: mid, entryId: "ann-festival", eventId: "msg-1", loaderId: "loader-a", quantity: 1 });
  const r2 = service.reportLoad({ manifestId: mid, entryId: "ann-festival", eventId: "msg-1", loaderId: "loader-a", quantity: 1 });
  assert.equal(r1.processed, true);
  assert.equal(r2.duplicated, true);

  const s1 = service.reportSignoff({ manifestId: mid, entryId: "ann-festival", eventId: "msg-2", signerId: "crew-1", signerName: "乘务长" });
  const s2 = service.reportSignoff({ manifestId: mid, entryId: "ann-festival", eventId: "msg-2", signerId: "crew-1", signerName: "乘务长" });
  assert.equal(s1.status, "signed");
  assert.equal(s2.duplicated, true);

  const events = service.store.eventLog(mid).filter((e) => ["loaded", "signed"].includes(e.type));
  assert.equal(events.length, 2, "重复消息没有产生第二条留痕");
});

test("装载内容冲突交独立岗位核对，冲突未决不得签收", () => {
  const { service } = buildWorld();
  const mid = service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" }).manifest.data.manifestId;

  service.reportLoad({ manifestId: mid, entryId: "snack-moon", eventId: "l1", loaderId: "loader-a", quantity: 1, condition: "damaged" });
  const conflict = service.reportLoad({ manifestId: mid, entryId: "snack-moon", eventId: "l2", loaderId: "loader-b", quantity: 1, condition: "ok" });
  assert.equal(conflict.conflict, true);

  assert.throws(
    () => service.reportSignoff({ manifestId: mid, entryId: "snack-moon", eventId: "s9", signerId: "crew-1" }),
    /冲突/
  );

  const taskKey = conflict.taskKey;
  assert.throws(
    () => service.resolveLoadConflict({ taskKey, decision: "confirm_load", reviewerId: "loader-a" }),
    /独立/
  );
  const resolved = service.resolveLoadConflict({ taskKey, decision: "confirm_load", reviewerId: "qc-indep", note: "外包装轻微压痕，内容完好" });
  assert.equal(resolved.status, "loaded");

  const signed = service.reportSignoff({ manifestId: mid, entryId: "snack-moon", eventId: "s10", signerId: "crew-1", signerName: "乘务长" });
  assert.equal(signed.riskOwner, ROLES.CABIN_CREW);
});

test("故障恢复后继续派发未完成清单，已签收不重复", () => {
  const { service } = buildWorld();
  const mid = service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" }).manifest.data.manifestId;
  service.reportLoad({ manifestId: mid, entryId: "ann-festival", eventId: "l-ann", loaderId: "loader-a" });
  service.reportSignoff({ manifestId: mid, entryId: "ann-festival", eventId: "s-ann", signerId: "crew-1" });

  const recovered = service.recoverDispatch();
  const keys = recovered.pending.map((t) => t.entryId);
  assert.ok(keys.includes("snack-moon"));
  assert.ok(keys.includes("kit-heritage"));
  assert.ok(!keys.includes("ann-festival"), "已签收条目不再续派");
});

test("值班经理视图：当时应备、实际签收、替代理由、责任交接齐全且为时点快照", () => {
  const { service, clock } = buildWorld();
  const built = service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" });
  const mid = built.manifest.data.manifestId;
  const afterBuild = clock.now();

  service.stopBatch("b-moon");
  service.registerApproval({ approvalId: "ap-alt", kind: "material", validFrom: LOCAL_DAY, validTo: "2026-10-31" });
  service.registerBatch({ batchId: "b-alt", originCity: "PEK", usableFrom: LOCAL_DAY, usableTo: "2026-10-10" });
  service.registerAllergenDeclaration({ declarationId: "ad-alt", approvalId: "ap-alt", text: "含小麦" });
  service.setQuota({ quotaKey: "moon", date: LOCAL_DAY, route: "PEK-SHA", cabin: "business", remaining: 5 });
  service.proposeSubstitution({
    packageId: "pkg-midautumn", origEntryId: "snack-moon",
    newEntry: { entryId: "snack-moon-x", kind: "snack", title: "备用糕点", venue: "in_flight", approvalId: "ap-alt", batchId: "b-alt", originCity: "PEK", allergenDeclarationId: "ad-alt", quotaKey: "moon" },
    basis: "批次停用替代", proposedBy: "catering-1",
  });
  service.reportLoad({ manifestId: mid, entryId: "snack-moon-x", eventId: "lx", loaderId: "loader-a" });
  service.reportSignoff({ manifestId: mid, entryId: "snack-moon-x", eventId: "sx", signerId: "crew-9", signerName: "当班乘务长" });

  // 当前视图：替代品已签收，责任在客舱
  const now = service.viewFlight({ flightId: "CA1234", cabin: "business" });
  const x = byId(now.items, "snack-moon-x");
  assert.equal(x.actual.status, "signed");
  assert.equal(x.actual.signerName, "当班乘务长");
  assert.equal(x.risk.owner, ROLES.CABIN_CREW);
  assert.ok(x.risk.handoffs.some((h) => h.to === ROLES.CABIN_CREW && h.via === "signoff"));

  // 回到建包当时：看到的是修订1——月饼当时应备且未签收，没有被后续替代覆盖
  const then = service.viewFlight({ flightId: "CA1234", cabin: "business", at: afterBuild });
  assert.equal(then.viewedRevision, 1);
  const moonThen = byId(then.items, "snack-moon");
  assert.equal(moonThen.expected.status, "active");
  assert.equal(moonThen.actual.status, "not_received");
  assert.equal(byId(then.items, "snack-moon-x"), undefined, "时点快照不含后来才出现的替代品");
});

test("配额用尽的条目不装机，剩余风险归内容/供应责任方", () => {
  const { service } = buildWorld();
  service.setQuota({ quotaKey: "moon", date: LOCAL_DAY, route: "PEK-SHA", cabin: "business", remaining: 0 });
  const { manifest } = service.buildFlightManifest({ flightId: "CA1234", packageId: "pkg-midautumn", cabin: "business" });
  assert.equal(byId(manifest.data.items, "snack-moon").verdict.status, "not_approved");
  assert.match(byId(manifest.data.items, "snack-moon").verdict.reasons.join(), /配额/);
});

test("休息室按自有现场条件出清单：机上广播不进入，地面物料照常", () => {
  const { service } = buildWorld();
  service.registerApproval({ approvalId: "ap-tea", kind: "material", validFrom: LOCAL_DAY, validTo: "2026-10-31" });
  service.registerBatch({ batchId: "b-tea", originCity: "PEK", usableFrom: LOCAL_DAY, usableTo: "2026-10-10" });
  service.registerAllergenDeclaration({ declarationId: "ad-tea", approvalId: "ap-tea", text: "含茶多酚" });
  service.registerCatalogEntry({
    entryId: "lounge-tea", kind: "snack", title: "休息室节气茶点", venue: "lounge",
    approvalId: "ap-tea", batchId: "b-tea", originCity: "PEK", allergenDeclarationId: "ad-tea",
    scope: { loungeIds: ["PEK-L1"] },
  });
  service.registerPackage({ packageId: "pkg-lounge", theme: "中秋地面", entryIds: ["lounge-tea", "ann-festival"] });

  const { manifest } = service.buildLoungeManifest({ loungeId: "PEK-L1", packageId: "pkg-lounge", date: LOCAL_DAY });
  const ids = manifest.data.items.map((i) => i.entryId);
  assert.ok(ids.includes("lounge-tea"));
  assert.equal(byId(manifest.data.items, "lounge-tea").verdict.status, "active");
  assert.equal(byId(manifest.data.items, "ann-festival").verdict.status, "out_of_scope", "机上广播被 venue 隔离，不执行");

  const view = service.viewLounge({ loungeId: "PEK-L1", date: LOCAL_DAY });
  assert.equal(byId(view.items, "lounge-tea").actual.status, "not_received");
});
