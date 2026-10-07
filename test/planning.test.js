import assert from "node:assert/strict";
import test from "node:test";

import { localDateAt } from "../src/domain.js";
import { makePlan, makeService, itemOf, PLAN_INPUT, TEMPLATE } from "./helpers.js";

test("按日期、机场、航线、舱位与休息室解析出现场可执行版本", () => {
  const { service } = makeService();
  const report = makePlan(service);
  assert.equal(report.serviceDate, "2027-02-06");
  assert.equal(itemOf(report, "bc-greeting").status, "ready");
  const snack = itemOf(report, "snack-lotus");
  assert.equal(snack.status, "ready");
  assert.equal(snack.plannedQuantity, 154);
  assert.deepEqual(snack.evidence.batchIds, ["batch-lotus-bj"]);
  assert.deepEqual(snack.evidence.allergens.sort(), ["egg", "gluten"]);
  assert.equal(snack.evidence.approvalId, "appr-snack-lotus-1");
  assert.equal(itemOf(report, "craft-papercut").status, "ready");
  assert.deepEqual(itemOf(report, "craft-papercut").cabins, ["F"]);
  assert.equal(itemOf(report, "heritage-tea").status, "ready");
});

test("休息室等级不足时仅排除依赖休息室的条目", () => {
  const { service } = makeService();
  const report = makePlan(service, { lounge: { loungeId: "L-PEK-B", tier: "B" } });
  assert.equal(itemOf(report, "heritage-tea").status, "excluded");
  assert.ok(itemOf(report, "heritage-tea").reasons.includes("休息室条件不满足"));
  assert.equal(itemOf(report, "craft-papercut").status, "ready");
  assert.equal(itemOf(report, "bc-greeting").status, "ready");
});

test("舱位交集为空时条目不适用", () => {
  const { service } = makeService();
  const report = makePlan(service, { cabins: ["Y"], passengers: { Y: 150 } });
  assert.equal(itemOf(report, "craft-papercut").status, "excluded");
  assert.ok(itemOf(report, "craft-papercut").reasons.includes("舱位不适用"));
  assert.equal(itemOf(report, "snack-lotus").status, "ready");
});

test("内容审定未覆盖时条目必须换掉", () => {
  const { service, clock } = makeService();
  const svc = new (Object.getPrototypeOf(service).constructor)({ clock });
  svc.registerTemplate(structuredClone(TEMPLATE));
  for (const item of TEMPLATE.items.filter((i) => i.itemId !== "heritage-tea")) {
    svc.approveContent({ itemId: item.itemId, approvalId: `appr-${item.itemId}-1`, approvedBy: "内容审定组", scope: { validFrom: "2027-02-01", validTo: "2027-02-20" } });
  }
  svc.declareBatch({ batchId: "batch-tea-bj", itemId: "heritage-tea", city: "北京", quantity: 50 });
  const report = makePlan(svc);
  const tea = itemOf(report, "heritage-tea");
  assert.equal(tea.status, "blocked");
  assert.ok(tea.reasons.includes("内容审定未覆盖本次适用范围"));
  assert.equal(tea.riskOwner.role, "duty_manager");
});

test("配额超出供应批次数量时条目必须换掉", () => {
  const { service } = makeService();
  const report = makePlan(service, { passengers: { F: 4, Y: 10000 } });
  const snack = itemOf(report, "snack-lotus");
  assert.equal(snack.status, "blocked");
  assert.ok(snack.reasons.includes("供应批次数量不足"));
});

test("跨午夜航班遵循计划起飞地当日生效的规则", () => {
  assert.equal(localDateAt("2027-02-05T16:30:00.000Z", "Asia/Shanghai"), "2027-02-06");
  assert.equal(localDateAt("2027-02-05T15:30:00.000Z", "Asia/Shanghai"), "2027-02-05");
  assert.equal(localDateAt("2027-02-06T07:00:00.000Z", "America/Los_Angeles"), "2027-02-05");

  const { service } = makeService();
  service.approveContent({
    itemId: "bc-greeting",
    approvalId: "appr-bc-greeting-2",
    approvedBy: "内容审定组",
    scope: { validFrom: "2027-02-06", validTo: "2027-02-20" },
  });
  const before = makePlan(service, { flightNumber: "CA1501", scheduledDeparture: "2027-02-05T15:30:00.000Z" });
  assert.equal(before.serviceDate, "2027-02-05");
  assert.equal(itemOf(before, "bc-greeting").evidence.approvalId, "appr-bc-greeting-1");
  const after = makePlan(service, { flightNumber: "CA1502", scheduledDeparture: "2027-02-05T16:30:00.000Z" });
  assert.equal(after.serviceDate, "2027-02-06");
  assert.equal(itemOf(after, "bc-greeting").evidence.approvalId, "appr-bc-greeting-2");
});

test("起飞地时区决定运行日期而非到达地或UTC日期", () => {
  const { service } = makeService();
  const report = makePlan(service, {
    flightNumber: "CA900",
    departureAirport: "LAX",
    arrivalAirport: "PEK",
    scheduledDeparture: "2027-02-06T07:00:00.000Z",
    lounge: null,
  });
  assert.equal(report.serviceDate, "2027-02-05");
});
