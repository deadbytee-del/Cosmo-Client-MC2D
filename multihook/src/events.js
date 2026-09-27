/** Minimal typed event emitter shared by every MultiHook class. */
export class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[MultiHook] listener for "${event}" threw:`, err);
      }
    }
  }

  removeAllListeners(event) {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
  }
}
