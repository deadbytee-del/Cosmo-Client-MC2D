import { EventEmitter } from './events.js';

const HISTORY_SIZE = 4;

/**
 * Replicates 2D/3D transforms across peers. A transform is
 * `{ p: [x,y] | [x,y,z], r: [angle] | [x,y,z,w], s: [sx,sy] | [sx,sy,sz] }`
 * (position, rotation — a single angle in radians for 2D or a quaternion
 * for 3D — and scale). Remote snapshots are buffered so
 * `getRenderTransform` can interpolate (and, past the newest snapshot,
 * briefly extrapolate) for smooth motion regardless of network jitter.
 */
export class EntitySync extends EventEmitter {
  constructor({ interpolationDelayMs = 100, extrapolationLimitMs = 250 } = {}) {
    super();
    this.interpolationDelayMs = interpolationDelayMs;
    this.extrapolationLimitMs = extrapolationLimitMs;
    this._entities = new Map();
  }

  register(id, { transform, owner = null } = {}) {
    this._entities.set(id, {
      owner,
      local: transform ?? { p: [0, 0, 0], r: [0], s: [1, 1, 1] },
      history: [],
      dirty: true,
    });
    this.emit('register', id);
    return this._entities.get(id);
  }

  unregister(id) {
    this._entities.delete(id);
    this.emit('unregister', id);
  }

  has(id) {
    return this._entities.has(id);
  }

  setOwner(id, owner) {
    const e = this._entities.get(id);
    if (e) e.owner = owner;
  }

  getOwner(id) {
    return this._entities.get(id)?.owner ?? null;
  }

  /** Moves a locally-owned entity; queued for the next network flush. */
  updateLocal(id, transform) {
    const e = this._entities.get(id);
    if (!e) return;
    e.local = transform;
    e.dirty = true;
  }

  /** Records a transform snapshot received from a remote peer. */
  applyRemote(id, transform, timestamp = Date.now()) {
    let e = this._entities.get(id);
    if (!e) e = this.register(id, { transform });
    e.history.push({ transform, timestamp });
    if (e.history.length > HISTORY_SIZE) e.history.shift();
    this.emit('remote-update', id, transform);
  }

  /** Local entities dirtied since the last call, for the network flush. */
  collectDirty() {
    const out = [];
    for (const [id, e] of this._entities) {
      if (e.dirty) {
        out.push([id, e.local]);
        e.dirty = false;
      }
    }
    return out;
  }

  /**
   * Transform to render right now: interpolates between the two buffered
   * snapshots straddling (now - interpolationDelay), or linearly
   * extrapolates past the newest snapshot up to extrapolationLimitMs.
   */
  getRenderTransform(id, now = Date.now()) {
    const e = this._entities.get(id);
    if (!e) return null;
    if (e.owner === 'local' || e.history.length === 0) return e.local;

    const renderTime = now - this.interpolationDelayMs;
    const history = e.history;

    if (renderTime <= history[0].timestamp) return history[0].transform;

    for (let i = 0; i < history.length - 1; i++) {
      const a = history[i];
      const b = history[i + 1];
      if (renderTime >= a.timestamp && renderTime <= b.timestamp) {
        const t = (renderTime - a.timestamp) / Math.max(1, b.timestamp - a.timestamp);
        return lerpTransform(a.transform, b.transform, t);
      }
    }

    const latest = history[history.length - 1];
    const prev = history[history.length - 2] ?? latest;
    const dt = Math.max(1, latest.timestamp - prev.timestamp);
    const overshoot = Math.min(renderTime - latest.timestamp, this.extrapolationLimitMs);
    const t = 1 + overshoot / dt;
    return lerpTransform(prev.transform, latest.transform, t);
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpVec(a, b, t) {
  return a.map((v, i) => lerp(v, b[i] ?? v, t));
}

function lerpTransform(a, b, t) {
  const rotation = a.r.length === 4 ? slerpQuat(a.r, b.r, t) : [lerp(a.r[0], b.r[0], t)];
  return {
    p: lerpVec(a.p, b.p, t),
    r: rotation,
    s: lerpVec(a.s, b.s, t),
  };
}

function slerpQuat(a, b, t) {
  let [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    ax = -ax; ay = -ay; az = -az; aw = -aw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return [lerp(ax, bx, t), lerp(ay, by, t), lerp(az, bz, t), lerp(aw, bw, t)];
  }
  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (dot * Math.sin(theta)) / sinTheta0;
  const s1 = Math.sin(theta) / sinTheta0;
  return [ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1];
}
