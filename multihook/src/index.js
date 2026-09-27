import { Room } from './room.js';
import { ConnectionType } from './connection-type.js';
import { EntitySync } from './entity.js';
import { InteractionManager } from './interactions.js';
import { EventEmitter } from './events.js';
import {
  ReliabilityMode,
  encodePacket,
  decodePacket,
  SequenceGate,
  RateLimiter,
  PriorityQueue,
} from './packet.js';
import { SignalingTransport, WebSocketSignaling, LocalSignaling, ManualSignaling } from './signaling.js';

const CHANNELS = {
  RELIABLE: 'mh-reliable',
  STATE: 'mh-state',
};

/**
 * MultiHook — real-time peer-to-peer multiplayer for 2D and 3D web apps.
 *
 * ```js
 * import { MultiHook, WebSocketSignaling } from 'multihook';
 *
 * const mh = new MultiHook({ signaling: new WebSocketSignaling('wss://your-signaling-host') });
 * await mh.connect('room-42');
 *
 * mh.registerEntity('crate-1', { transform: { p: [0, 0, 0], r: [0], s: [1, 1, 1] } });
 * mh.grab('crate-1');
 * mh.hold('crate-1', { p: [1, 0, 0], r: [0], s: [1, 1, 1] });
 * mh.release('crate-1');
 * mh.post('chat', { text: 'hi' });
 * ```
 */
export class MultiHook extends EventEmitter {
  constructor({
    signaling,
    iceServers,
    connectionType = ConnectionType.P2P_MESH,
    selfId,
    tickRate = 20,
    interpolationDelayMs = 100,
    rateLimit = { packetsPerSecond: 60, bytesPerSecond: 262144 },
  } = {}) {
    super();
    this.room = new Room({ signaling, iceServers, connectionType, selfId });
    this.entities = new EntitySync({ interpolationDelayMs });
    this.interactions = new InteractionManager({
      entities: this.entities,
      selfId: this.room.selfId,
      send: (data) => this._sendReliable(data),
    });
    this._gate = new SequenceGate();
    this._rateLimiter = new RateLimiter(rateLimit);
    this._tickMs = 1000 / tickRate;
    this._tickHandle = null;

    this.room.on('peer-join', (peer) => this._bindPeer(peer));
    this.room.on('peer-connected', (peer) => this.emit('peer-connected', peer.id));
    this.room.on('peer-disconnected', (peer) => this.emit('peer-disconnected', peer.id));
    this.room.on('peer-leave', (peerId) => this.emit('peer-leave', peerId));
    this.room.on('host', (hostId) => this.emit('host', hostId));
    this.room.on('error', (err) => this.emit('error', err));

    this.interactions.on('grab', (id, owner) => this.emit('grab', id, owner));
    this.interactions.on('grab-denied', (id) => this.emit('grab-denied', id));
    this.interactions.on('release', (id, info) => this.emit('release', id, info));
    this.interactions.on('post', (channel, data, info) => this.emit('post', channel, data, info));
  }

  get selfId() {
    return this.room.selfId;
  }

  get isHost() {
    return this.room.isHost;
  }

  get peers() {
    return [...this.room.peers.keys()];
  }

  async connect(roomId) {
    await this.room.join(roomId);
    this._startTicking();
    this.emit('connected', this.selfId);
  }

  disconnect() {
    this._stopTicking();
    this.room.leave();
    this.emit('disconnected');
  }

  _bindPeer(peer) {
    peer.channel(CHANNELS.RELIABLE, { mode: ReliabilityMode.RELIABLE_ORDERED });
    peer.channel(CHANNELS.STATE, { mode: ReliabilityMode.UNRELIABLE_UNORDERED, maxRetransmits: 0 });
    peer.on('message', (channelName, raw) => this._onMessage(peer, channelName, raw));
  }

  _onMessage(peer, channelName, raw) {
    const packet = decodePacket(raw);
    if (!packet) return;

    if (channelName === CHANNELS.STATE && packet.type === 'entity') {
      const gateKey = `${peer.id}:${packet.data.id}`;
      if (!this._gate.accept(gateKey, packet.seq)) return;
      this.entities.applyRemote(packet.data.id, packet.data.transform, packet.timestamp);
      return;
    }

    if (channelName === CHANNELS.RELIABLE) {
      this.interactions.receive(peer.id, packet.data);
      this.emit('message', peer.id, packet.data);
    }
  }

  /** Register a 2D or 3D entity for network sync. See EntitySync.register. */
  registerEntity(id, options) {
    return this.entities.register(id, options);
  }

  unregisterEntity(id) {
    this.entities.unregister(id);
  }

  /** Move a locally-owned entity; the change is flushed on the next network tick. */
  updateEntity(id, transform) {
    this.entities.updateLocal(id, transform);
  }

  /** Smoothed transform to draw this frame for any registered entity. */
  getEntityTransform(id, now) {
    return this.entities.getRenderTransform(id, now);
  }

  /** Take exclusive control of an entity. Returns false if another peer already holds it. */
  grab(entityId) {
    return this.interactions.grab(entityId);
  }

  /** Renew ownership while manipulating an entity you've grabbed, optionally moving it too. */
  hold(entityId, transform) {
    return this.interactions.hold(entityId, transform);
  }

  /** Give up ownership of an entity you hold, optionally with a hand-off velocity. */
  release(entityId, options) {
    return this.interactions.release(entityId, options);
  }

  /** Release an entity with a velocity for every peer's physics/animation to pick up. */
  throw(entityId, velocity) {
    return this.interactions.throw(entityId, velocity);
  }

  /** Broadcast an arbitrary event to the room, independent of entity ownership. */
  post(channel, data) {
    return this.interactions.post(channel, data);
  }

  _sendReliable(data) {
    const raw = encodePacket('interaction', data, { channel: CHANNELS.RELIABLE });
    this.room.broadcast(CHANNELS.RELIABLE, raw);
  }

  _startTicking() {
    this._tickHandle = setInterval(() => this._tick(), this._tickMs);
  }

  _stopTicking() {
    if (this._tickHandle) clearInterval(this._tickHandle);
    this._tickHandle = null;
  }

  _tick() {
    const dirty = this.entities.collectDirty();
    for (const [id, transform] of dirty) {
      const raw = encodePacket('entity', { id, transform }, { channel: CHANNELS.STATE });
      if (!this._rateLimiter.tryConsume(raw.length)) continue;
      this.room.broadcast(CHANNELS.STATE, raw);
    }
  }
}

export {
  ConnectionType,
  ReliabilityMode,
  Room,
  EntitySync,
  InteractionManager,
  SignalingTransport,
  WebSocketSignaling,
  LocalSignaling,
  ManualSignaling,
  PriorityQueue,
  RateLimiter,
  SequenceGate,
};
