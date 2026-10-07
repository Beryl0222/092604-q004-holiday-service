/**
 * 处理进程内 JSON 请求。
 *
 * 统一路由：action 选择服务方法，body 其余字段作为参数透传。
 * 所有写操作都由 Service 负责留痕；本层只做协议解析。
 */
import { Service } from "./service.js";

// 动作 -> 服务方法（参数为整个 body，方法按需取字段）
const ROUTES = {
  health: (s) => s.health(),
  register: (s, b) => s.register(String(b.recordId), String(b.ownerId)),
  find: (s, b) => s.find(String(b.recordId)),

  registerAirport: (s, b) => s.registerAirport(b),
  registerLounge: (s, b) => s.registerLounge(b),
  registerFlight: (s, b) => s.registerFlight(b),
  changeAircraft: (s, b) => s.changeAircraft(String(b.flightId), String(b.aircraftTypeId), b.options ?? {}),

  registerApproval: (s, b) => s.registerApproval(b),
  registerBatch: (s, b) => s.registerBatch(b),
  registerAllergenDeclaration: (s, b) => s.registerAllergenDeclaration(b),
  setQuota: (s, b) => s.setQuota(b),
  registerCatalogEntry: (s, b) => s.registerCatalogEntry(b),
  registerPackage: (s, b) => s.registerPackage(b),

  holdCityStock: (s, b) => s.holdCityStock(String(b.city), b.options ?? {}),
  releaseCityStock: (s, b) => s.releaseCityStock(String(b.city), b.options ?? {}),
  stopBatch: (s, b) => s.stopBatch(String(b.batchId), b.options ?? {}),

  buildFlightManifest: (s, b) => s.buildFlightManifest(b),
  buildLoungeManifest: (s, b) => s.buildLoungeManifest(b),
  refreshManifest: (s, b) => s.refreshManifest(String(b.manifestId), b.options ?? {}),
  proposeSubstitution: (s, b) => s.proposeSubstitution(b),

  reportLoad: (s, b) => s.reportLoad(b),
  reportSignoff: (s, b) => s.reportSignoff(b),
  resolveLoadConflict: (s, b) => s.resolveLoadConflict(b),
  recoverDispatch: (s) => s.recoverDispatch(),

  viewFlight: (s, b) => s.viewFlight(b),
  viewLounge: (s, b) => s.viewLounge(b),
};

export function handle(raw, service = new Service()) {
  const body = JSON.parse(raw);
  const route = ROUTES[body.action];
  if (!route) throw new Error(`不支持的请求动作: ${body.action}`);
  const result = route(service, body);
  return JSON.stringify(result);
}

export { Service };
