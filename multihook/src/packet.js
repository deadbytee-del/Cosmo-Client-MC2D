/**
 * Packet control primitives: reliability-mode -> RTCDataChannelInit mapping,
 * a compact JSON envelope with sequence numbers, a staleness gate for
 * unreliable/unordered state channels, a token-bucket rate limiter, and a
 * priority send queue.
 */

export const ReliabilityMode = Object.freeze({
  RELIABLE_ORDERED: 'reliable-ordered',
  RELIABLE_UNORDERED: 'reliable-unordered',
  UNRELIABLE_ORDERED: 'unreliable-ordered',
  UNRELIABLE_UNORDERED: 'unreliable-unordered',
});

/** Maps a MultiHook reliability mode to the options RTCPeerConnection.createDataChannel expects. */
export function reliabilityToDataChannelInit(mode, { maxRetransmits, maxPacketLifeTime } = {}) {
  switch (mode) {
    case ReliabilityMode.RELIABLE_ORDERED:
      return { ordered: true };
    case ReliabilityMode.RELIABLE_UNORDERED:
      return { ordered: false };
    case ReliabilityMode.UNRELIABLE_ORDERED:
      return { ordered: true, maxRetransmits: maxRetransmits ?? 0 };
    case ReliabilityMode.UNRELIABLE_UNORDERED:
      return maxPacketLifeTime !== undefined
        ? { ordered: false, maxPacketLifeTime }
        : { ordered: false, maxRetransmits: maxRetransmits ?? 0 };
    default:
      throw new Error(`Unknown reliability mode: ${mode}`);
  }
}

let packetSeq = 0;
export function nextSequence() {
  packetSeq = (packetSeq + 1) % Number.MAX_SAFE_INTEGER;
  return packetSeq;
}

export function encodePacket(type, data, { channel = 'default', seq } = {}) {
  return JSON.stringify({
    t: type,
    c: channel,
    s: seq ?? nextSequence(),
    ts: Date.now(),
    d: data,
  });
}

export function decodePacket(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p !== 'object' || p === null || !('t' in p)) return null;
    return { type: p.t, channel: p.c ?? 'default', seq: p.s, timestamp: p.ts, data: p.d };
  } catch {
    return null;
  }
}

/**
 * Drops stale/duplicate packets per key (e.g. `${peerId}:${entityId}`) on
 * unreliable/unordered channels, where only the newest snapshot matters.
 */
export class SequenceGate {
  constructor() {
    this._last = new Map();
  }

  accept(key, seq) {
    const last = this._last.get(key);
    if (last !== undefined && seq <= last) return false;
    this._last.set(key, seq);
    return true;
  }

  reset(key) {
    this._last.delete(key);
  }
}

/** Token-bucket limiter so a busy scene can't flood a data channel. */
export class RateLimiter {
  constructor({ packetsPerSecond = 60, bytesPerSecond = 262144 } = {}) {
    this.packetCapacity = packetsPerSecond;
    this.byteCapacity = bytesPerSecond;
    this._packetTokens = packetsPerSecond;
    this._byteTokens = bytesPerSecond;
    this._lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    if (elapsed <= 0) return;
    this._packetTokens = Math.min(this.packetCapacity, this._packetTokens + elapsed * this.packetCapacity);
    this._byteTokens = Math.min(this.byteCapacity, this._byteTokens + elapsed * this.byteCapacity);
    this._lastRefill = now;
  }

  tryConsume(byteSize) {
    this._refill();
    if (this._packetTokens < 1 || this._byteTokens < byteSize) return false;
    this._packetTokens -= 1;
    this._byteTokens -= byteSize;
    return true;
  }
}

/** Higher-priority items (e.g. grab/release) pop before routine state snapshots. */
export class PriorityQueue {
  constructor() {
    this._items = [];
  }

  push(item, priority = 0) {
    this._items.push({ item, priority });
    this._items.sort((a, b) => b.priority - a.priority);
  }

  pop() {
    return this._items.shift()?.item;
  }

  get size() {
    return this._items.length;
  }
}
