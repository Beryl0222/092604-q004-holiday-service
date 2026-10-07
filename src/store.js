/**
 * 存储层：基础登记记录、版本化文档与幂等事件日志。
 *
 * - 文档只追加修订，不覆盖历史：值班经理查看任意时点，得到的是当时生效的版本，
 *   而不是被后续修改覆盖的当前模板。
 * - 事件以 eventId 幂等：装载/签收的重复消息只处理一次。
 */
export class Store {
  constructor() {
    this.records = new Map();

    /** 文档修订：id -> [{ revision, createdAt, author, data }] */
    this.revisions = new Map();

    /** 事件日志：streamId(包/休息室) -> [event...] */
    this.events = new Map();

    /** 幂等索引：全局 eventId -> event */
    this.eventIndex = new Map();

    /** 任务状态：taskKey -> task（状态变迁同样进事件日志） */
    this.tasks = new Map();

    /** 派发出厂记录：dispatchId -> { taskKeys, at }，恢复时只续派未完成项 */
    this.dispatches = [];
  }

  // -- 基础登记（保留） -------------------------------------------------------

  add(record) {
    if (this.records.has(record.recordId)) {
      throw new Error("记录编号已存在");
    }
    this.records.set(record.recordId, structuredClone(record));
  }

  get(recordId) {
    const value = this.records.get(recordId);
    return value ? structuredClone(value) : null;
  }

  // -- 版本化文档 -------------------------------------------------------------

  /** 追加一次修订，返回修订号。doc 需含 docId；createdAt/author 可显式传入。 */
  putDocument({ docId, data, at, author }) {
    const list = this.revisions.get(docId) ?? [];
    const revision = list.length + 1;
    const rev = { revision, docId, createdAt: at, author: author ?? null, data: structuredClone(data) };
    list.push(rev);
    this.revisions.set(docId, list);
    return structuredClone(rev);
  }

  /** 当前最新修订。 */
  document(docId) {
    const list = this.revisions.get(docId);
    return list?.length ? structuredClone(list[list.length - 1]) : null;
  }

  /**
   * 某一时点可见的修订（createdAt <= instant 中最新一条）。
   * 值班经理事后查看某班航班，看到的是当时应备版本。
   */
  documentAt(docId, instant) {
    const list = this.revisions.get(docId);
    if (!list) return null;
    let visible = null;
    for (const rev of list) {
      if (rev.createdAt <= instant) visible = rev;
      else break;
    }
    return visible ? structuredClone(visible) : null;
  }

  revisionHistory(docId) {
    const list = this.revisions.get(docId);
    return list ? structuredClone(list) : [];
  }

  /** 列出全部文档编号，可按前缀过滤。 */
  documentIds(prefix) {
    const ids = [...this.revisions.keys()];
    return prefix ? ids.filter((id) => id.startsWith(prefix)) : ids;
  }

  // -- 幂等事件日志 -----------------------------------------------------------

  /**
   * 追加事件。同一 eventId 重复提交时返回首条记录并标记 duplicated=true，
   * 不产生任何副作用（重复装载/签收消息只处理一次）。
   */
  appendEvent(event) {
    const existing = this.eventIndex.get(event.eventId);
    if (existing) return { event: structuredClone(existing), duplicated: true };
    const stored = structuredClone(event);
    this.eventIndex.set(stored.eventId, stored);
    const stream = this.events.get(stored.streamId) ?? [];
    stream.push(stored);
    this.events.set(stored.streamId, stream);
    return { event: structuredClone(stored), duplicated: false };
  }

  eventLog(streamId) {
    const stream = this.events.get(streamId);
    return stream ? structuredClone(stream) : [];
  }

  // -- 任务与派发 -------------------------------------------------------------

  upsertTask(task) {
    const prev = this.tasks.get(task.taskKey);
    const merged = prev ? { ...prev, ...task } : { ...task };
    this.tasks.set(task.taskKey, merged);
    return structuredClone(merged);
  }

  getTask(taskKey) {
    const value = this.tasks.get(taskKey);
    return value ? structuredClone(value) : null;
  }

  listTasks(packageId) {
    return [...this.tasks.values()]
      .filter((t) => t.packageId === packageId)
      .map((t) => structuredClone(t));
  }

  recordDispatch(dispatch) {
    this.dispatches.push(structuredClone(dispatch));
  }

  /** 故障恢复：返回每个包仍未完成（pending/loaded 未签收）的任务，供系统继续派发。 */
  pendingDispatchItems() {
    const done = new Set([...this.tasks.values()].filter((t) => t.status === "done").map((t) => t.taskKey));
    const pending = new Map();
    for (const dispatch of this.dispatches) {
      for (const key of dispatch.taskKeys) {
        if (done.has(key) || pending.has(key)) continue;
        const task = this.tasks.get(key);
        if (task && task.status !== "cancelled") pending.set(key, structuredClone(task));
      }
    }
    return [...pending.values()];
  }
}
