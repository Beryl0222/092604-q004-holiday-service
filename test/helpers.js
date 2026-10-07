import { OrchestrationService } from "../src/service.js";

export class FakeClock {
  constructor(start = "2027-02-01T00:00:00.000Z") {
    this.t = start;
  }

  now() {
    return this.t;
  }

  set(iso) {
    this.t = iso;
  }
}

export const TEMPLATE = {
  templateId: "tpl-spring-2027",
  theme: "春节",
  validFrom: "2027-02-01",
  validTo: "2027-02-20",
  items: [
    {
      itemId: "bc-greeting",
      category: "broadcast",
      name: "春节问候广播",
      stage: "inflight",
      needsSupply: false,
      appliesTo: { routes: null, cabins: null, airports: null },
    },
    {
      itemId: "snack-lotus",
      category: "snack",
      name: "莲蓉酥",
      stage: "inflight",
      needsSupply: true,
      appliesTo: { routes: null, cabins: null, airports: null },
      quota: { perCabin: { F: 1, C: 1, Y: 1 }, unit: "份" },
    },
    {
      itemId: "craft-papercut",
      category: "craft",
      name: "剪纸手作包",
      stage: "ground_lounge",
      needsSupply: true,
      appliesTo: { routes: null, cabins: ["F", "C"], airports: null },
      lounge: { required: true, minTier: "B" },
      quota: { perCabin: { F: 1, C: 1 }, unit: "套" },
    },
    {
      itemId: "heritage-tea",
      category: "heritage",
      name: "非遗茶艺体验",
      stage: "ground_lounge",
      needsSupply: true,
      appliesTo: { routes: null, cabins: ["F"], airports: null },
      lounge: { required: true, minTier: "A" },
      quota: { perCabin: { F: 1 }, unit: "场" },
    },
  ],
};

export const SUBSTITUTE_TEMPLATE = {
  templateId: "tpl-substitutes",
  usage: "substitution",
  items: [
    {
      itemId: "snack-riceball",
      category: "snack",
      name: "八宝饭团",
      stage: "inflight",
      needsSupply: true,
      appliesTo: { routes: null, cabins: null, airports: null },
      quota: { perCabin: { F: 1, C: 1, Y: 1 }, unit: "份" },
    },
    {
      itemId: "craft-lantern",
      category: "craft",
      name: "灯笼手作包",
      stage: "ground_lounge",
      needsSupply: true,
      appliesTo: { routes: null, cabins: null, airports: null },
      quota: { perCabin: { F: 1, C: 1 }, unit: "套" },
    },
  ],
};

export const BATCHES = [
  { batchId: "batch-lotus-bj", itemId: "snack-lotus", city: "北京", quantity: 500, allergens: ["gluten", "egg"] },
  { batchId: "batch-lotus-sh", itemId: "snack-lotus", city: "上海", quantity: 300, allergens: ["gluten"] },
  { batchId: "batch-craft-bj", itemId: "craft-papercut", city: "北京", quantity: 100 },
  { batchId: "batch-tea-bj", itemId: "heritage-tea", city: "北京", quantity: 50 },
];

export const PLAN_INPUT = {
  flightNumber: "CA1501",
  route: "PEK-SHA",
  departureAirport: "PEK",
  arrivalAirport: "SHA",
  scheduledDeparture: "2027-02-05T16:30:00.000Z",
  cabins: ["F", "Y"],
  lounge: { loungeId: "L-PEK-A", tier: "A" },
  passengers: { F: 4, Y: 150 },
};

export function makeService(clock = new FakeClock()) {
  const service = new OrchestrationService({ clock });
  service.registerTemplate(structuredClone(TEMPLATE));
  service.registerTemplate(structuredClone(SUBSTITUTE_TEMPLATE));
  for (const item of TEMPLATE.items) {
    service.approveContent({
      itemId: item.itemId,
      approvalId: `appr-${item.itemId}-1`,
      approvedBy: "内容审定组",
      scope: { validFrom: "2027-02-01", validTo: "2027-02-20" },
    });
  }
  for (const batch of BATCHES) service.declareBatch(structuredClone(batch));
  return { service, clock };
}

export function makePlan(service, overrides = {}) {
  return service.generatePlan({ ...structuredClone(PLAN_INPUT), ...overrides });
}

export function itemOf(report, itemId) {
  return report.items.find((i) => i.itemId === itemId);
}
