import { EventEmitter } from './events.js';

/**
 * Signaling only moves small JSON envelopes (room roster + SDP/ICE) to
 * bootstrap a direct WebRTC connection. All game/entity traffic afterwards
 * flows peer-to-peer over data channels, never through a signaling
 * transport. Implement this contract to plug in your own transport.
 */
export class SignalingTransport extends EventEmitter {
  async connect(_roomId, _selfId) {
    throw new Error('connect() not implemented');
  }
  send(_toPeerId, _body) {
    throw new Error('send() not implemented');
  }
  disconnect() {}
}

/** WebSocket signaling against a small relay server (see server/signaling-server.js). */
export class WebSocketSignaling extends SignalingTransport {
  constructor(url) {
    super();
    this.url = url;
    this._ws = null;
  }

  connect(roomId, selfId) {
    return new Promise((resolve, reject) => {
      this.roomId = roomId;
      this.selfId = selfId;
      const ws = new WebSocket(this.url);
      this._ws = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ room: roomId, from: selfId, kind: 'join' }));
        resolve();
      };
      ws.onerror = (err) => reject(err);
      ws.onclose = () => this.emit('disconnected');
      ws.onmessage = (event) => {
        let envelope;
        try {
          envelope = JSON.parse(event.data);
        } catch {
          return;
        }
        if (envelope.kind === 'roster') this.emit('roster', envelope.peers ?? []);
        else if (envelope.kind === 'peer-join') this.emit('peer-join', envelope.from);
        else if (envelope.kind === 'peer-leave') this.emit('peer-leave', envelope.from);
        else if (envelope.kind === 'signal') this.emit('signal', envelope.from, envelope.body);
      };
    });
  }

  send(toPeerId, body) {
    this._ws?.send(JSON.stringify({ room: this.roomId, from: this.selfId, to: toPeerId, kind: 'signal', body }));
  }

  disconnect() {
    this._ws?.close();
    this._ws = null;
  }
}

/**
 * BroadcastChannel signaling for same-browser, multi-tab local development —
 * no server required. Great for quickly testing a room across a few tabs.
 */
export class LocalSignaling extends SignalingTransport {
  connect(roomId, selfId) {
    this.roomId = roomId;
    this.selfId = selfId;
    this._bc = new BroadcastChannel(`multihook:${roomId}`);
    this._bc.onmessage = (event) => {
      const envelope = event.data;
      if (envelope.from === this.selfId) return;
      if (envelope.kind === 'signal' && envelope.to !== this.selfId) return;
      if (envelope.kind === 'signal') this.emit('signal', envelope.from, envelope.body);
      else if (envelope.kind === 'hello') this.emit('peer-join', envelope.from);
      else if (envelope.kind === 'bye') this.emit('peer-leave', envelope.from);
    };
    this._bc.postMessage({ kind: 'hello', from: selfId });
    return Promise.resolve();
  }

  send(toPeerId, body) {
    this._bc?.postMessage({ kind: 'signal', from: this.selfId, to: toPeerId, body });
  }

  disconnect() {
    this._bc?.postMessage({ kind: 'bye', from: this.selfId });
    this._bc?.close();
    this._bc = null;
  }
}

/**
 * Manual/no-server signaling: SDP+ICE surface as plain objects for the app
 * to move out-of-band (copy/paste, QR code, chat message...). Useful for a
 * one-off direct link between exactly two peers with no signaling server.
 */
export class ManualSignaling extends SignalingTransport {
  connect(roomId, selfId) {
    this.roomId = roomId;
    this.selfId = selfId;
    return Promise.resolve();
  }

  send(toPeerId, body) {
    this.emit('outgoing', { to: toPeerId, from: this.selfId, body });
  }

  /** Call with a payload received out-of-band from the remote peer. */
  receive(fromPeerId, body) {
    this.emit('signal', fromPeerId, body);
  }
}
