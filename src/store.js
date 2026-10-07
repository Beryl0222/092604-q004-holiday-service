/** 仅追加的事件存储：全部留痕与故障恢复的唯一事实来源。 */
export class EventStore {
  constructor(events = []) {
    this.events = events.map((e) => structuredClone(e));
  }

  append(type, payload, at) {
    const event = { seq: this.events.length + 1, type, at, ...structuredClone(payload) };
    this.events.push(event);
    return structuredClone(event);
  }

  all() {
    return this.events.map((e) => structuredClone(e));
  }

  serialize() {
    return JSON.stringify(this.events);
  }

  static restore(raw) {
    return new EventStore(JSON.parse(raw));
  }
}
