import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { OrchestrationService } from "../src/service.js";
import { makePlan, makeService } from "./helpers.js";

test("故障恢复后继续派发未完成清单且不重复派发", () => {
  const { service, clock } = makeService();
  makePlan(service);

  const before = service.pendingChecklist().pending;
  assert.equal(before.length, 4);

  const first = service.resumeDispatch();
  assert.equal(first.issued.length, 4);
  assert.equal(service.resumeDispatch().issued.length, 0);

  // 模拟故障：从序列化的事件日志重建服务
  const restored = new OrchestrationService({ store: EventStore.restore(service.store.serialize()), clock });
  assert.equal(restored.pendingChecklist().pending.length, 0);
  assert.equal(restored.resumeDispatch().issued.length, 0);
});

test("恢复后撤回条目不再出现在待派发清单中", () => {
  const { service, clock } = makeService();
  makePlan(service);
  service.issueHold({ holdId: "hold-1", scope: { batchId: "batch-lotus-bj" }, reason: "批次停用", issuedBy: "品控" });

  const restored = new OrchestrationService({ store: EventStore.restore(service.store.serialize()), clock });
  const pending = restored.pendingChecklist().pending;
  assert.equal(pending.length, 3);
  assert.ok(!pending.some((p) => p.itemId === "snack-lotus"));
  const issued = restored.resumeDispatch().issued;
  assert.equal(issued.length, 3);
  assert.ok(!issued.some((k) => k.includes("snack-lotus")));
});
