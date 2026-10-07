/** 处理进程内 JSON 请求。 */
import { OrchestrationService } from "./service.js";

export function handle(raw, service = new OrchestrationService()) {
  const body = JSON.parse(raw);
  let result;
  switch (body.action) {
    case "health": result = service.health(); break;
    case "register_template": result = service.registerTemplate(body.template); break;
    case "approve_content": result = service.approveContent(body); break;
    case "declare_batch": result = service.declareBatch(body.batch); break;
    case "generate_plan": result = service.generatePlan(body); break;
    case "issue_hold": result = service.issueHold(body); break;
    case "apply_substitution": result = service.applySubstitution(body); break;
    case "report_load": result = service.reportLoad(body); break;
    case "report_signoff": result = service.reportSignoff(body); break;
    case "record_handover": result = service.recordHandover(body); break;
    case "resolve_conflict": result = service.resolveConflict(body); break;
    case "resume_dispatch": result = service.resumeDispatch(); break;
    case "pending_checklist": result = service.pendingChecklist(); break;
    case "flight_report": result = service.flightReport(body.planId, body.asOf ?? null); break;
    case "lounge_report": result = service.loungeReport(body.loungeId, body.asOf ?? null); break;
    case "conflict_queue": result = service.conflictQueue(); break;
    default: throw new Error("不支持的请求动作");
  }
  return JSON.stringify(result);
}
