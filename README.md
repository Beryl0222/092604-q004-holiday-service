# 节日航班服务包编排

节日主题航班临时换机型或调整时，编排服务按**运行日期、起飞机场、航线、舱位与休息室条件**解析出该航班的现场可执行版本，让值班经理立刻回答三件事：哪些照常提供、哪些必须换掉、剩余风险谁承担。

## 能力

- **现场可执行版本**：`generate_plan` 将模板解析为不可变的航班计划，每个条目带状态（ready / excluded / blocked）与证据（审定编号、批次、过敏原声明、配额、计划数量）。
- **全程留痕**：内容审定、供应批次、过敏原声明、配额、替代依据、签收责任、责任交接均以事件追加保存。
- **范围化停用**：`issue_hold` 必须限定类别、批次或城市。某城市缺货不连带其他地点已确认安全的物料；食品批次停用不误伤广播等无批次条目；停用命中已签收物料时不自动撤回，交独立岗位核对。
- **替代核对**：替代品必须自身持有覆盖本次适用范围（航线、机场、舱位、日期）的审定与可用批次，不得沿用原批准；类别必须一致，替代依据必填。
- **幂等**：装载与签收消息按消息编号只处理一次；同号不同内容视为冲突，交独立岗位核对。
- **跨午夜**：以计划起飞地当地日期选择当日生效的规则与模板。
- **故障恢复**：事件日志可序列化；恢复后 `resume_dispatch` 继续派发未完成清单，派发键确定，不重复派发。
- **时点快照**：`flight_report` / `lounge_report` 来自事件投影，支持 `asOf` 查询当时应备、实际签收、替代理由与责任交接，不受后续模板修改覆盖。

## 目录

- `src/domain.js` 纯领域规则：当地日期、适用范围、计划解析、停用匹配、替代核对。
- `src/store.js` 仅追加的事件存储，支持序列化与恢复。
- `src/service.js` 命令入口、事件留痕与时点投影查询。
- `src/api.js` 进程内 JSON 请求边界。
- `src/cli.js` 标准输入入口。
- `test/` 按关注点拆分的行为测试。

## 主要动作

`register_template` / `approve_content` / `declare_batch` / `generate_plan` / `issue_hold` / `apply_substitution` / `report_load` / `report_signoff` / `record_handover` / `resolve_conflict` / `resume_dispatch` / `pending_checklist` / `flight_report` / `lounge_report` / `conflict_queue`。

## 运行

运行测试：`npm test`

检查构建：`npm run build`

本地冒烟：`printf '%s' '{"action":"health"}' | npm run cli --silent`

项目只使用 Node.js 内置能力，运行期间不连接其他服务。
