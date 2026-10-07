import assert from "node:assert/strict";
import test from "node:test";

import { FakeClock, makePlan, makeService, itemOf, TEMPLATE } from "./helpers.js";

test("航班报告返回当时快照，不被后续模板修改覆盖", () => {
  const clock = new FakeClock();
  const { service } = makeService(clock);

  clock.set("2027-02-02T00:00:00.000Z");
  makePlan(service, { flightNumber: "CA1501" });
  clock.set("2027-02-03T00:00:00.000Z");
  service.reportSignoff({ messageId: "s-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", signedBy: "乘务长", role: "乘务", quantity: 154 });

  // 后续修改：新模板版本调整配额，新审定换版
  clock.set("2027-02-04T00:00:00.000Z");
  const v2 = structuredClone(TEMPLATE);
  v2.templateId = "tpl-spring-2027-v2";
  v2.items.find((i) => i.itemId === "snack-lotus").quota.perCabin.Y = 2;
  service.registerTemplate(v2);
  service.approveContent({ itemId: "snack-lotus", approvalId: "appr-snack-lotus-2", approvedBy: "内容审定组", scope: { validFrom: "2027-02-01", validTo: "2027-02-20" } });
  makePlan(service, { flightNumber: "CA1502" });

  const before = service.flightReport("CA1501@2027-02-06");
  const snackBefore = itemOf(before, "snack-lotus");
  assert.equal(snackBefore.evidence.approvalId, "appr-snack-lotus-1");
  assert.equal(snackBefore.plannedQuantity, 154);
  assert.equal(snackBefore.signoff.signedBy, "乘务长");

  const after = service.flightReport("CA1502@2027-02-06");
  const snackAfter = itemOf(after, "snack-lotus");
  assert.equal(snackAfter.evidence.approvalId, "appr-snack-lotus-2");
  assert.equal(snackAfter.plannedQuantity, 304);
});

test("asOf 查询返回该时点应备与签收状态", () => {
  const clock = new FakeClock();
  const { service } = makeService(clock);
  clock.set("2027-02-02T00:00:00.000Z");
  makePlan(service);
  clock.set("2027-02-03T00:00:00.000Z");
  service.reportSignoff({ messageId: "s-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", signedBy: "乘务长", role: "乘务", quantity: 154 });

  const early = service.flightReport("CA1501@2027-02-06", "2027-02-02T12:00:00.000Z");
  assert.equal(itemOf(early, "snack-lotus").signoff, null);
  const late = service.flightReport("CA1501@2027-02-06", "2027-02-03T12:00:00.000Z");
  assert.equal(itemOf(late, "snack-lotus").signoff.signedBy, "乘务长");
});

test("剩余风险责任随交接转移并全程留痕", () => {
  const clock = new FakeClock();
  const { service } = makeService(clock);
  makePlan(service);
  service.issueHold({ holdId: "hold-craft", scope: { batchId: "batch-craft-bj" }, reason: "手作物料缺货", issuedBy: "值班经理A" });

  let report = service.flightReport("CA1501@2027-02-06");
  const risk = report.residualRisks.find((r) => r.itemId === "craft-papercut");
  assert.equal(risk.owner.role, "duty_manager");

  service.recordHandover({ planId: "CA1501@2027-02-06", itemId: "craft-papercut", fromRole: "duty_manager", toRole: "乘务长", acceptedBy: "张三", note: "机上替代讲解由乘务组承担" });
  report = service.flightReport("CA1501@2027-02-06");
  const craft = itemOf(report, "craft-papercut");
  assert.equal(craft.riskOwner.holder, "张三");
  assert.equal(craft.handovers.length, 1);
  assert.equal(report.residualRisks.find((r) => r.itemId === "craft-papercut").owner.holder, "张三");
});

test("休息室报告只含该休息室地面条目并反映时点状态", () => {
  const clock = new FakeClock();
  const { service } = makeService(clock);
  clock.set("2027-02-02T00:00:00.000Z");
  makePlan(service);
  clock.set("2027-02-03T00:00:00.000Z");
  service.issueHold({ holdId: "hold-tea", scope: { batchId: "batch-tea-bj" }, reason: "茶艺物料复检", issuedBy: "品控" });

  const now = service.loungeReport("L-PEK-A");
  assert.equal(now.flights.length, 1);
  assert.deepEqual(now.flights[0].items.map((i) => i.itemId).sort(), ["craft-papercut", "heritage-tea"]);
  assert.equal(now.flights[0].items.find((i) => i.itemId === "heritage-tea").status, "withdrawn");

  const earlier = service.loungeReport("L-PEK-A", "2027-02-02T12:00:00.000Z");
  assert.equal(earlier.flights[0].items.find((i) => i.itemId === "heritage-tea").status, "ready");
});
