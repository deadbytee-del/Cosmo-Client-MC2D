import { EventEmitter } from './events.js';
import { Peer } from './peer.js';
import { ConnectionType } from './connection-type.js';

/** Orchestrates signaling + one Peer per remote connection for a single room. */
export class Room extends EventEmitter {
  constructor({ signaling, iceServers, connectionType = ConnectionType.P2P_MESH, selfId } = {}) {
    super();
    if (!signaling) throw new Error('Room requires a signaling transport');
    this.signaling = signaling;
    this.iceServers = iceServers;
    this.connectionType = connectionType;
    this.selfId = selfId ?? randomId();
    this.peers = new Map();
    this.hostId = null;
  }

  get isHost() {
    return this.hostId === this.selfId;
  }

  _shouldConnectTo(peerId) {
    if (this.connectionType === ConnectionType.P2P_MESH) return true;
    return this.isHost || peerId === this.hostId;
  }

  async join(roomId) {
    this.roomId = roomId;
    this.signaling.on('roster', (peerIds) => this._onRoster(peerIds));
    this.signaling.on('peer-join', (peerId) => this._onPeerJoin(peerId));
    this.signaling.on('peer-leave', (peerId) => this._onPeerLeave(peerId));
    this.signaling.on('signal', (peerId, body) => this._onSignal(peerId, body));
    await this.signaling.connect(roomId, this.selfId);
    this.emit('joined', this.selfId);
  }

  _onRoster(peerIds) {
    const all = [...peerIds, this.selfId].sort();
    this.hostId = all[0];
    this.emit('host', this.hostId);
    for (const peerId of peerIds) {
      if (this._shouldConnectTo(peerId)) this._ensurePeer(peerId);
    }
  }

  _onPeerJoin(peerId) {
    if (this.hostId && this._shouldConnectTo(peerId)) this._ensurePeer(peerId);
  }

  _onPeerLeave(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.close();
      this.peers.delete(peerId);
      this.emit('peer-leave', peerId);
    }
    if (peerId === this.hostId) {
      const remaining = [...this.peers.keys(), this.selfId].sort();
      this.hostId = remaining[0];
      this.emit('host', this.hostId);
    }
  }

  _ensurePeer(peerId) {
    if (peerId === this.selfId) return null;
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const polite = this.selfId > peerId; // deterministic, glare-free role split
    const peer = new Peer(peerId, {
      iceServers: this.iceServers,
      polite,
      signal: (body) => this.signaling.send(peerId, body),
    });
    peer.on('connected', () => this.emit('peer-connected', peer));
    peer.on('disconnected', () => this.emit('peer-disconnected', peer));
    peer.on('message', (channel, raw) => this.emit('message', peer, channel, raw));
    peer.on('error', (err) => this.emit('error', err, peer));
    this.peers.set(peerId, peer);
    this.emit('peer-join', peer);
    return peer;
  }

  _onSignal(peerId, body) {
    this._ensurePeer(peerId)?.receiveSignal(body);
  }

  /** Opens (or reuses) a named channel with every currently connected peer. */
  channel(name, reliabilityOptions) {
    for (const peer of this.peers.values()) peer.channel(name, reliabilityOptions);
  }

  broadcast(channelName, raw, { except } = {}) {
    let sent = 0;
    for (const [peerId, peer] of this.peers) {
      if (peerId === except) continue;
      if (peer.send(channelName, raw)) sent++;
    }
    return sent;
  }

  send(peerId, channelName, raw) {
    return this.peers.get(peerId)?.send(channelName, raw) ?? false;
  }

  leave() {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.signaling.disconnect();
    this.emit('left');
  }
}

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
