import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../src/api.js";
import { OrchestrationService } from "../src/service.js";
import { FakeClock } from "./helpers.js";

test("健康检查返回正常状态", () => {
  const result = JSON.parse(handle('{"action":"health"}'));
  assert.equal(result.status, "ok");
});

test("未知动作被拒绝", () => {
  assert.throws(() => handle('{"action":"nope"}'), /不支持的请求动作/);
});

test("通过 JSON 边界完成登记、审定、计划与查询", () => {
  const service = new OrchestrationService({ clock: new FakeClock() });
  handle(JSON.stringify({
    action: "register_template",
    template: {
      templateId: "tpl-1",
      items: [{ itemId: "bc-1", category: "broadcast", name: "问候广播", stage: "inflight", needsSupply: false, appliesTo: {} }],
    },
  }), service);
  handle(JSON.stringify({ action: "approve_content", itemId: "bc-1", approvalId: "appr-1", approvedBy: "审定组", scope: {} }), service);
  const plan = JSON.parse(handle(JSON.stringify({
    action: "generate_plan",
    flightNumber: "CA1",
    route: "PEK-SHA",
    departureAirport: "PEK",
    scheduledDeparture: "2027-02-05T16:30:00.000Z",
    cabins: ["Y"],
    passengers: { Y: 1 },
  }), service));
  assert.equal(plan.serviceDate, "2027-02-06");
  assert.equal(plan.items[0].status, "ready");

  const report = JSON.parse(handle(JSON.stringify({ action: "flight_report", planId: "CA1@2027-02-06" }), service));
  assert.equal(report.items[0].evidence.approvalId, "appr-1");
});
