# MultiHook

Real-time, peer-to-peer multiplayer for 2D and 3D web apps. MultiHook handles
WebRTC connection setup (STUN/TURN, ICE, signaling), packet control
(reliable/unreliable channels, sequencing, rate limiting), entity transform
sync with interpolation, and grab/hold/release/post interaction primitives —
so a frontend developer can add real multiplayer to a canvas, WebGL, or
three.js scene without hand-rolling WebRTC.

No bundler required: everything is plain ES modules you can import directly
in the browser.

## Why peer-to-peer

Game/entity traffic travels directly between browsers over WebRTC data
channels. A tiny signaling server (or no server at all, for local testing)
is only used to exchange connection setup messages — offers, answers, and
ICE candidates — before the direct link is established. Once connected,
none of your gameplay data passes through any server.

## Install

This package has no runtime dependencies for the browser-side library.
Copy or `git subtree`/npm-link the `multihook/` folder into your project, or
reference it directly:

```js
import { MultiHook, WebSocketSignaling } from './multihook/src/index.js';
```

The optional reference signaling server needs `ws`:

```sh
cd multihook
npm install
npm run signaling-server   # ws://localhost:8080
```

## Quick start

```js
import { MultiHook, WebSocketSignaling } from './multihook/src/index.js';

const mh = new MultiHook({
  signaling: new WebSocketSignaling('wss://your-signaling-host'),
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // add a TURN server for clients behind restrictive NATs/firewalls:
    // { urls: 'turn:your-turn-host:3478', username: '...', credential: '...' },
  ],
});

await mh.connect('room-42');

// Register a 2D or 3D object for network sync.
mh.registerEntity('crate-1', {
  transform: { p: [0, 0, 0], r: [0], s: [1, 1, 1] }, // position, rotation, scale
});

// Interaction primitives.
mh.grab('crate-1');                       // take exclusive control
mh.hold('crate-1', { p: [1, 0, 0], r: [0], s: [1, 1, 1] }); // renew control + move it
mh.release('crate-1');                    // let go
mh.throw('crate-1', [3, 0, 0]);           // release with a hand-off velocity
mh.post('chat', { text: 'hello room' });  // broadcast anything, unrelated to entities

// Read back the smoothed position/rotation/scale to render every frame.
const t = mh.getEntityTransform('crate-1');
```

Try the runnable examples in `examples/2d-canvas` and `examples/3d-three`
(open `index.html` from a local static server in two browser tabs — they
use `LocalSignaling`, which needs no server for same-browser testing).

## Concepts

### Connection types (`ConnectionType`)

- `P2P_MESH` (default) — every peer connects directly to every other peer.
  Lowest latency, best for small rooms (roughly ≤8 peers).
- `P2P_STAR` — every peer connects only to a single elected host, which
  relays traffic. Fewer total connections, adds one hop of latency; better
  for larger rooms.

```js
import { MultiHook, ConnectionType } from './multihook/src/index.js';
const mh = new MultiHook({ signaling, connectionType: ConnectionType.P2P_STAR });
```

Host election is deterministic (lowest peer ID in the room) and exposed via
`mh.isHost` and the `'host'` event.

### Signaling transports

Signaling only ever moves small SDP/ICE JSON envelopes — never gameplay
data. Pick one:

- **`WebSocketSignaling(url)`** — talks to a real server. Ship the included
  `server/signaling-server.js` (Node + `ws`) or implement the same tiny
  protocol on your own backend.
- **`LocalSignaling()`** — uses `BroadcastChannel`, no server at all. Great
  for developing/demoing multiplayer across tabs on one machine.
- **`ManualSignaling()`** — emits `'outgoing'` events with plain objects you
  move out-of-band (copy/paste, QR code, chat message) for a single
  no-server P2P link between two peers. Feed replies back with `.receive()`.

Implement `SignalingTransport` yourself to plug in anything else (e.g. an
existing app server, Firebase, etc).

### STUN / TURN

Pass `iceServers` to `MultiHook` (forwarded to every `RTCPeerConnection`).
STUN alone (the default: Google's public STUN servers) is enough for most
peers; add a TURN server to also support clients behind symmetric NATs or
locked-down firewalls where a direct path can't be found.

### Packet control

Two data channels are opened automatically per peer:

- **Reliable, ordered** — interactions (`grab`/`hold`/`release`/`post`) and
  any custom messages you send through `mh.post()`.
- **Unreliable, unordered** — entity transform snapshots, sent at a fixed
  tick rate (`tickRate`, default 20/s). Late/duplicate snapshots are
  dropped by a per-entity sequence gate; only the newest state matters for
  fast-moving objects, so we don't spend bandwidth retransmitting stale
  positions.

An outgoing token-bucket rate limiter (`rateLimit: { packetsPerSecond,
bytesPerSecond }`) caps how much a busy scene can push down the state
channel, so one laggy client (or a scene with hundreds of dirty entities)
can't flood the connection.

Lower-level building blocks (`ReliabilityMode`, `SequenceGate`,
`RateLimiter`, `PriorityQueue`, `encodePacket`/`decodePacket`) are exported
from `src/packet.js` if you want to open your own custom channels for
game-specific protocols.

### Entity sync (2D and 3D)

A transform is `{ p, r, s }`:

- `p`: position — `[x, y]` or `[x, y, z]`
- `r`: rotation — `[angleRadians]` for 2D, or a quaternion `[x, y, z, w]` for 3D
- `s`: scale — `[sx, sy]` or `[sx, sy, sz]`

Remote updates are buffered and smoothed: `getEntityTransform` interpolates
between the two most recent snapshots (with a small delay, default 100ms,
to always have two points to interpolate between) and linearly
extrapolates a short distance past the newest snapshot if the network goes
quiet, so movement looks smooth instead of stuttering to each raw update.
3D rotations are interpolated with quaternion slerp.

### Interactions: grab / hold / release / post / throw

These are the primitives for "pick this up, drag it, let go of it" that
come up constantly in multiplayer 2D/3D scenes:

- **`grab(id)`** — request exclusive control. Returns `false` if another
  peer already holds it. Ownership conflicts (two peers grabbing at once)
  resolve identically on every peer with no central authority: earliest
  timestamp wins, ties broken by peer ID.
- **`hold(id, transform?)`** — heartbeat that renews your ownership (a grab
  expires after 4s without a hold, so a disconnected peer can't lock an
  object forever) and optionally moves the entity in the same call.
- **`release(id, { velocity? })`** — give it up; `velocity` is handed to
  every peer's `'release'` event for their own physics/animation to apply.
- **`throw(id, velocity)`** — shorthand for `release(id, { velocity })`.
- **`post(channel, data)`** — fire-and-forget broadcast with no entity or
  ownership involved at all: chat messages, score updates, custom game
  events.

```js
mh.on('grab', (id, owner) => console.log(owner, 'grabbed', id));
mh.on('grab-denied', (id) => console.log('someone else has', id));
mh.on('release', (id, { velocity, from, local }) => { /* apply velocity */ });
mh.on('post', (channel, data, { from, local }) => { /* handle event */ });
```

## API reference

### `new MultiHook(options)`

| option | default | description |
| --- | --- | --- |
| `signaling` | required | a `SignalingTransport` instance |
| `iceServers` | Google STUN | passed to every `RTCPeerConnection` |
| `connectionType` | `ConnectionType.P2P_MESH` | `P2P_MESH` or `P2P_STAR` |
| `selfId` | random UUID | your peer ID in the room |
| `tickRate` | `20` | entity state updates per second |
| `interpolationDelayMs` | `100` | render delay for smoother interpolation |
| `rateLimit` | `{ packetsPerSecond: 60, bytesPerSecond: 262144 }` | outgoing state-channel cap |

### Methods

`connect(roomId)` · `disconnect()` · `registerEntity(id, opts)` ·
`unregisterEntity(id)` · `updateEntity(id, transform)` ·
`getEntityTransform(id, now?)` · `grab(id)` · `hold(id, transform?)` ·
`release(id, opts?)` · `throw(id, velocity)` · `post(channel, data)`

### Properties

`selfId` · `isHost` · `peers` (array of connected peer IDs)

### Events

`connected` · `disconnected` · `peer-connected(peerId)` ·
`peer-disconnected(peerId)` · `peer-leave(peerId)` · `host(hostId)` ·
`grab(id, owner)` · `grab-denied(id)` · `release(id, info)` ·
`post(channel, data, info)` · `message(peerId, data)` · `error(err)`

## Testing

Pure-logic modules (packet control, entity interpolation, interaction
ownership rules) have unit tests that run under Node, no browser needed:

```sh
cd multihook
npm test
```

`Peer`/`Room`/the signaling transports depend on browser APIs
(`RTCPeerConnection`, `WebSocket`, `BroadcastChannel`) and are exercised via
the runnable examples instead.

## Project layout

```
multihook/
  src/            the library (import this)
  server/          reference WebSocket signaling relay (Node + ws)
  examples/        2D canvas and 3D (three.js) drag/grab demos
  test/            Node-runnable unit tests for packet/entity/interaction logic
```
