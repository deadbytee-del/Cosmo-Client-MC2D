import { WebSocketServer } from 'ws';

/**
 * Minimal signaling relay for MultiHook's WebSocketSignaling transport.
 * It only ever forwards small JSON envelopes (room roster + SDP/ICE) so
 * peers can bootstrap a direct WebRTC connection — no game/entity traffic
 * ever passes through this server.
 *
 * Run with: node server/signaling-server.js
 * Configure the port with the PORT environment variable (default 8080).
 */
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const wss = new WebSocketServer({ port: PORT });

// roomId -> Map<peerId, WebSocket>
const rooms = new Map();

function roomPeers(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

wss.on('connection', (ws) => {
  let joinedRoom = null;
  let peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.kind === 'join') {
      joinedRoom = msg.room;
      peerId = msg.from;
      const peers = roomPeers(joinedRoom);

      ws.send(JSON.stringify({ kind: 'roster', peers: [...peers.keys()] }));

      for (const otherWs of peers.values()) {
        otherWs.send(JSON.stringify({ kind: 'peer-join', from: peerId }));
      }

      peers.set(peerId, ws);
      return;
    }

    if (msg.kind === 'signal' && joinedRoom) {
      const target = roomPeers(joinedRoom).get(msg.to);
      target?.send(JSON.stringify({ kind: 'signal', from: peerId, body: msg.body }));
    }
  });

  ws.on('close', () => {
    if (!joinedRoom || !peerId) return;
    const peers = roomPeers(joinedRoom);
    peers.delete(peerId);
    for (const otherWs of peers.values()) {
      otherWs.send(JSON.stringify({ kind: 'peer-leave', from: peerId }));
    }
    if (peers.size === 0) rooms.delete(joinedRoom);
  });
});

console.log(`MultiHook signaling server listening on ws://localhost:${PORT}`);
