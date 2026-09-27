import { EventEmitter } from './events.js';

const HOLD_TIMEOUT_MS = 4000; // ownership expires if not renewed by a hold heartbeat

/**
 * Object-interaction primitives layered on top of EntitySync ownership:
 * grab (take exclusive control), hold (renew control while manipulating),
 * release/throw (give it up, optionally with a hand-off velocity), and
 * post (a fire-and-forget broadcast unrelated to any entity). Ownership is
 * resolved the same way on every peer — no central authority is needed —
 * using a deterministic earliest-timestamp-wins rule with a peer-id tie
 * break, so all peers converge on the same owner even if two grabs race.
 */
export class InteractionManager extends EventEmitter {
  constructor({ entities, send, selfId }) {
    super();
    this.entities = entities;
    this._send = send; // (data) => void — broadcasts an interaction message to the room
    this.selfId = selfId;
    this._ownership = new Map(); // entityId -> { owner, since, lastHold }
  }

  _canGrab(entityId, requesterId, timestamp) {
    const current = this._ownership.get(entityId);
    if (!current) return true;
    if (current.owner === requesterId) return true;
    const expired = Date.now() - current.lastHold > HOLD_TIMEOUT_MS;
    if (expired) return true;
    return timestamp < current.since || (timestamp === current.since && requesterId < current.owner);
  }

  /** Attempt to take exclusive control of an entity (e.g. on pointer-down / pinch-start). */
  grab(entityId) {
    const timestamp = Date.now();
    if (!this._canGrab(entityId, this.selfId, timestamp)) {
      this.emit('grab-denied', entityId);
      return false;
    }
    this._applyGrab(entityId, this.selfId, timestamp);
    this._send({ type: 'grab', entityId, owner: this.selfId, timestamp });
    return true;
  }

  /** Heartbeat that keeps an already-grabbed entity locked while it's being manipulated. */
  hold(entityId, transform) {
    const current = this._ownership.get(entityId);
    if (!current || current.owner !== this.selfId) return false;
    current.lastHold = Date.now();
    if (transform) this.entities.updateLocal(entityId, transform);
    this._send({ type: 'hold', entityId, owner: this.selfId, timestamp: current.lastHold });
    return true;
  }

  /** Give up ownership, optionally leaving a velocity for the receiving app's physics. */
  release(entityId, { velocity } = {}) {
    const current = this._ownership.get(entityId);
    if (!current || current.owner !== this.selfId) return false;
    this._ownership.delete(entityId);
    this.entities.setOwner(entityId, null);
    this._send({ type: 'release', entityId, owner: this.selfId, velocity, timestamp: Date.now() });
    this.emit('release', entityId, { velocity, local: true });
    return true;
  }

  /** Convenience: release with a velocity handed off to every peer's physics/animation. */
  throw(entityId, velocity) {
    return this.release(entityId, { velocity });
  }

  /** Fire-and-forget broadcast unrelated to entity ownership (chat, score, custom events). */
  post(channel, data) {
    this._send({ type: 'post', channel, data, from: this.selfId, timestamp: Date.now() });
    this.emit('post', channel, data, { from: this.selfId, local: true });
  }

  /** Feed an interaction message received from a remote peer. */
  receive(fromPeerId, message) {
    switch (message.type) {
      case 'grab': {
        if (this._canGrab(message.entityId, message.owner, message.timestamp)) {
          this._applyGrab(message.entityId, message.owner, message.timestamp);
        }
        break;
      }
      case 'hold': {
        const current = this._ownership.get(message.entityId);
        if (current && current.owner === message.owner) current.lastHold = message.timestamp;
        break;
      }
      case 'release': {
        const current = this._ownership.get(message.entityId);
        if (current && current.owner === message.owner) {
          this._ownership.delete(message.entityId);
          this.entities.setOwner(message.entityId, null);
        }
        this.emit('release', message.entityId, { velocity: message.velocity, from: fromPeerId, local: false });
        break;
      }
      case 'post': {
        this.emit('post', message.channel, message.data, { from: message.from, local: false });
        break;
      }
      default:
        break;
    }
  }

  _applyGrab(entityId, owner, timestamp) {
    this._ownership.set(entityId, { owner, since: timestamp, lastHold: timestamp });
    this.entities.setOwner(entityId, owner === this.selfId ? 'local' : owner);
    this.emit('grab', entityId, owner);
  }

  isHeldByMe(entityId) {
    return this._ownership.get(entityId)?.owner === this.selfId;
  }

  ownerOf(entityId) {
    return this._ownership.get(entityId)?.owner ?? null;
  }
}
