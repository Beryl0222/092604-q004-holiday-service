import assert from "node:assert/strict";
import test from "node:test";

import { makePlan, makeService, itemOf } from "./helpers.js";

test("装载与签收的重复消息只处理一次", () => {
  const { service } = makeService();
  makePlan(service);

  const first = service.reportLoad({ messageId: "m-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", quantity: 154, loadedBy: "装载组" });
  const again = service.reportLoad({ messageId: "m-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", quantity: 154, loadedBy: "装载组" });
  assert.equal(first.status, "recorded");
  assert.equal(again.duplicate, true);

  service.reportSignoff({ messageId: "s-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", signedBy: "乘务长", role: "乘务", quantity: 154 });
  const dupSignoff = service.reportSignoff({ messageId: "s-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", signedBy: "乘务长", role: "乘务", quantity: 154 });
  assert.equal(dupSignoff.duplicate, true);

  const item = itemOf(service.flightReport("CA1501@2027-02-06"), "snack-lotus");
  assert.equal(item.loads.length, 1);
  assert.equal(item.signoff.signedBy, "乘务长");
});

test("同一消息编号携带不同内容视为冲突，交独立岗位核对", () => {
  const { service } = makeService();
  makePlan(service);
  service.reportLoad({ messageId: "m-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", quantity: 154, loadedBy: "装载组" });

  const conflict = service.reportLoad({ messageId: "m-1", planId: "CA1501@2027-02-06", itemId: "snack-lotus", quantity: 999, loadedBy: "装载组" });
  assert.equal(conflict.status, "conflict");

  const item = itemOf(service.flightReport("CA1501@2027-02-06"), "snack-lotus");
  assert.equal(item.loads.length, 1);
  assert.equal(item.loads[0].quantity, 154);

  const queue = service.conflictQueue().open;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, "message_payload_mismatch");
  service.resolveConflict({ conflictId: queue[0].conflictId, reviewerId: "独立核对岗", decision: "keep_first", note: "以首次上报为准" });
  assert.equal(service.conflictQueue().open.length, 0);
});

test("已撤回条目不可装载或签收", () => {
  const { service } = makeService();
  makePlan(service);
  service.issueHold({ holdId: "hold-1", scope: { batchId: "batch-lotus-bj" }, reason: "批次停用", issuedBy: "品控" });
  assert.throws(
    () => service.reportLoad({ messageId: "m-9", planId: "CA1501@2027-02-06", itemId: "snack-lotus", quantity: 1, loadedBy: "装载组" }),
    /不可装载/,
  );
});
