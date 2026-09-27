import { EventEmitter } from './events.js';
import { reliabilityToDataChannelInit } from './packet.js';

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Wraps a single RTCPeerConnection to one remote peer: negotiation (using
 * the "perfect negotiation" pattern so glare never wedges the connection),
 * ICE/STUN/TURN handling, and named data channels for packet control.
 */
export class Peer extends EventEmitter {
  constructor(peerId, { iceServers = DEFAULT_ICE_SERVERS, polite = false, signal } = {}) {
    super();
    this.id = peerId;
    this.polite = polite;
    this._signal = signal; // (message) => void — forwards SDP/ICE to this peer's signaling channel
    this._channels = new Map();
    this._makingOffer = false;
    this._ignoreOffer = false;
    this.connectionState = 'new';

    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) this._signal?.({ kind: 'ice-candidate', candidate: event.candidate });
    };

    this.pc.onnegotiationneeded = async () => {
      try {
        this._makingOffer = true;
        const offer = await this.pc.createOffer();
        if (this.pc.signalingState !== 'stable') return;
        await this.pc.setLocalDescription(offer);
        this._signal?.({ kind: 'sdp', description: this.pc.localDescription });
      } catch (err) {
        this.emit('error', err);
      } finally {
        this._makingOffer = false;
      }
    };

    this.pc.onconnectionstatechange = () => {
      this.connectionState = this.pc.connectionState;
      this.emit('state', this.connectionState);
      if (this.connectionState === 'connected') this.emit('connected');
      if (['disconnected', 'failed', 'closed'].includes(this.connectionState)) {
        this.emit('disconnected', this.connectionState);
      }
    };

    this.pc.ondatachannel = (event) => {
      this._bindChannel(event.channel.label, event.channel);
    };
  }

  /** Creates (or returns) a named data channel with the given reliability options. */
  channel(name, reliabilityOptions) {
    const existing = this._channels.get(name);
    if (existing) return existing.dc;
    const dc = this.pc.createDataChannel(
      name,
      reliabilityToDataChannelInit(reliabilityOptions?.mode, reliabilityOptions)
    );
    return this._bindChannel(name, dc);
  }

  _bindChannel(name, dc) {
    dc.binaryType = 'arraybuffer';
    this._channels.set(name, { dc });
    dc.onopen = () => this.emit('channel-open', name);
    dc.onclose = () => this.emit('channel-close', name);
    dc.onerror = (e) => this.emit('error', e);
    dc.onmessage = (e) => this.emit('message', name, e.data);
    return dc;
  }

  send(channelName, raw) {
    const entry = this._channels.get(channelName);
    if (!entry || entry.dc.readyState !== 'open') return false;
    entry.dc.send(raw);
    return true;
  }

  /** Feeds an incoming SDP or ICE-candidate message from the remote peer's signaling. */
  async receiveSignal(message) {
    try {
      if (message.kind === 'sdp') {
        const description = message.description;
        const offerCollision =
          description.type === 'offer' && (this._makingOffer || this.pc.signalingState !== 'stable');

        this._ignoreOffer = !this.polite && offerCollision;
        if (this._ignoreOffer) return;

        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this._signal?.({ kind: 'sdp', description: this.pc.localDescription });
        }
      } else if (message.kind === 'ice-candidate' && message.candidate) {
        try {
          await this.pc.addIceCandidate(message.candidate);
        } catch (err) {
          if (!this._ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Round-trip time in milliseconds from the latest WebRTC stats, or null if unavailable. */
  async ping() {
    const stats = await this.pc.getStats();
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
        return report.currentRoundTripTime * 1000;
      }
    }
    return null;
  }

  close() {
    for (const { dc } of this._channels.values()) dc.close();
    this.pc.close();
    this.connectionState = 'closed';
  }
}
