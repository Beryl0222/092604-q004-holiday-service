import assert from "node:assert/strict";
import test from "node:test";

import { makePlan, makeService, itemOf } from "./helpers.js";

test("某城市缺货不连带撤回其他地点已确认安全的物料", () => {
  const { service } = makeService();
  makePlan(service, { flightNumber: "CA1501" });
  makePlan(service, {
    flightNumber: "CA1519",
    route: "SHA-PEK",
    departureAirport: "SHA",
    arrivalAirport: "PEK",
    scheduledDeparture: "2027-02-06T02:00:00.000Z",
    lounge: { loungeId: "L-SHA-1", tier: "A" },
    passengers: { F: 2, Y: 100 },
  });
  service.reportSignoff({ messageId: "s-sh-1", planId: "CA1519@2027-02-06", itemId: "snack-lotus", signedBy: "地服甲", role: "地服", quantity: 102 });

  const result = service.issueHold({ holdId: "hold-bj-snack", scope: { city: "北京", category: "snack" }, reason: "北京点心缺货", issuedBy: "值班经理A" });

  assert.deepEqual(result.affected, [{ planId: "CA1501@2027-02-06", itemId: "snack-lotus", action: "withdrawn" }]);
  const sha = service.flightReport("CA1519@2027-02-06");
  assert.equal(itemOf(sha, "snack-lotus").status, "ready");
  assert.equal(itemOf(sha, "snack-lotus").signoff.signedBy, "地服甲");
  assert.equal(service.conflictQueue().open.length, 0);
});

test("食品批次停用不误伤广播内容", () => {
  const { service } = makeService();
  makePlan(service);
  const result = service.issueHold({ holdId: "hold-batch", scope: { batchId: "batch-lotus-bj" }, reason: "批次停用", issuedBy: "品控" });

  assert.deepEqual(result.affected, [{ planId: "CA1501@2027-02-06", itemId: "snack-lotus", action: "withdrawn" }]);
  const report = service.flightReport("CA1501@2027-02-06");
  assert.equal(itemOf(report, "snack-lotus").status, "withdrawn");
  assert.equal(itemOf(report, "bc-greeting").status, "ready");
  assert.equal(itemOf(report, "craft-papercut").status, "ready");
});

test("停用命中已签收物料时交独立岗位核对而非自动撤回", () => {
  const { service } = makeService();
  makePlan(service);
  service.reportSignoff({ messageId: "s-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", signedBy: "乘务长", role: "乘务", quantity: 154 });

  const result = service.issueHold({ holdId: "hold-signed", scope: { batchId: "batch-lotus-bj" }, reason: "批次复检", issuedBy: "品控" });
  assert.equal(result.affected[0].action, "conflict");
  assert.equal(itemOf(service.flightReport("CA1501@2027-02-06"), "snack-lotus").status, "ready");

  const conflictId = result.affected[0].conflictId;
  assert.throws(
    () => service.resolveConflict({ conflictId, reviewerId: "品控", decision: "withdraw" }),
    /独立岗位/,
  );
  service.resolveConflict({ conflictId, reviewerId: "独立核对岗", decision: "withdraw", note: "复检未通过" });
  const item = itemOf(service.flightReport("CA1501@2027-02-06"), "snack-lotus");
  assert.equal(item.status, "withdrawn");
  assert.equal(item.riskOwner.role, "duty_manager");
});

test("独立岗位裁定保留时已签收物料继续有效", () => {
  const { service } = makeService();
  makePlan(service);
  service.reportSignoff({ messageId: "s-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", signedBy: "乘务长", role: "乘务", quantity: 154 });
  const result = service.issueHold({ holdId: "hold-keep", scope: { batchId: "batch-lotus-bj" }, reason: "批次复检", issuedBy: "品控" });
  service.resolveConflict({ conflictId: result.affected[0].conflictId, reviewerId: "独立核对岗", decision: "keep", note: "复检通过" });
  assert.equal(itemOf(service.flightReport("CA1501@2027-02-06"), "snack-lotus").status, "ready");
  assert.equal(service.conflictQueue().open.length, 0);
});

test("停用必须限定范围，不得无范围撤回", () => {
  const { service } = makeService();
  makePlan(service);
  assert.throws(() => service.issueHold({ holdId: "hold-all", scope: {}, issuedBy: "品控" }), /限定/);
});
