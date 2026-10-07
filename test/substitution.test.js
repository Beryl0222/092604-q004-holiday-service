import assert from "node:assert/strict";
import test from "node:test";

import { makePlan, makeService, itemOf } from "./helpers.js";

function prepareSubstitution(service, scope = { routes: ["PEK-SHA"], validFrom: "2027-02-01", validTo: "2027-02-20" }) {
  service.approveContent({ itemId: "snack-riceball", approvalId: "appr-riceball-1", approvedBy: "内容审定组", scope });
  service.declareBatch({ batchId: "batch-riceball-bj", itemId: "snack-riceball", city: "北京", quantity: 500, allergens: ["gluten"] });
}

test("替代品凭自身审定与批次上岗，替代依据留痕", () => {
  const { service } = makeService();
  makePlan(service);
  prepareSubstitution(service);
  service.issueHold({ holdId: "hold-1", scope: { batchId: "batch-lotus-bj" }, reason: "莲蓉酥批次停用", issuedBy: "品控" });

  const item = service.applySubstitution({
    planId: "CA1501@2027-02-06",
    itemId: "snack-lotus",
    substituteItemId: "snack-riceball",
    basis: "莲蓉酥批次停用，改用八宝饭团",
    appliedBy: "值班经理A",
  });

  assert.equal(item.status, "substituted");
  assert.equal(item.substitution.substituteItemId, "snack-riceball");
  assert.equal(item.substitution.approvalId, "appr-riceball-1");
  assert.deepEqual(item.substitution.batchIds, ["batch-riceball-bj"]);
  assert.equal(item.substitution.basis, "莲蓉酥批次停用，改用八宝饭团");
  assert.equal(service.flightReport("CA1501@2027-02-06").residualRisks.length, 0);
});

test("替代品未覆盖本次适用范围时不得沿用原批准", () => {
  const { service } = makeService();
  makePlan(service);
  prepareSubstitution(service, { routes: ["PEK-CTU"], validFrom: "2027-02-01", validTo: "2027-02-20" });
  service.issueHold({ holdId: "hold-1", scope: { batchId: "batch-lotus-bj" }, reason: "批次停用", issuedBy: "品控" });

  assert.throws(
    () =>
      service.applySubstitution({
        planId: "CA1501@2027-02-06",
        itemId: "snack-lotus",
        substituteItemId: "snack-riceball",
        basis: "批次停用",
        appliedBy: "值班经理A",
      }),
    /不能沿用原批准/,
  );
  assert.equal(itemOf(service.flightReport("CA1501@2027-02-06"), "snack-lotus").status, "withdrawn");
});

test("替代品类别必须与原条目一致", () => {
  const { service } = makeService();
  makePlan(service);
  service.approveContent({ itemId: "craft-lantern", approvalId: "appr-lantern-1", approvedBy: "内容审定组", scope: { validFrom: "2027-02-01", validTo: "2027-02-20" } });
  service.declareBatch({ batchId: "batch-lantern-bj", itemId: "craft-lantern", city: "北京", quantity: 100 });
  service.issueHold({ holdId: "hold-1", scope: { batchId: "batch-lotus-bj" }, reason: "批次停用", issuedBy: "品控" });

  assert.throws(
    () =>
      service.applySubstitution({
        planId: "CA1501@2027-02-06",
        itemId: "snack-lotus",
        substituteItemId: "craft-lantern",
        basis: "批次停用",
        appliedBy: "值班经理A",
      }),
    /类别/,
  );
});

test("替代必须记录替代依据", () => {
  const { service } = makeService();
  makePlan(service);
  prepareSubstitution(service);
  service.issueHold({ holdId: "hold-1", scope: { batchId: "batch-lotus-bj" }, reason: "批次停用", issuedBy: "品控" });
  assert.throws(
    () =>
      service.applySubstitution({
        planId: "CA1501@2027-02-06",
        itemId: "snack-lotus",
        substituteItemId: "snack-riceball",
        basis: "",
        appliedBy: "值班经理A",
      }),
    /替代依据/,
  );
});
