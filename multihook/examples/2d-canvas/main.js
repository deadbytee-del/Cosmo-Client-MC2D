import { MultiHook, LocalSignaling } from '../../src/index.js';

const ROOM_ID = new URLSearchParams(location.search).get('room') || 'demo-room';
document.getElementById('room').textContent = ROOM_ID;

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

const boxes = new Map([
  ['box-1', { color: '#e06c75', x: 160, y: 160 }],
  ['box-2', { color: '#61afef', x: 400, y: 260 }],
  ['box-3', { color: '#98c379', x: 620, y: 380 }],
]);

// LocalSignaling needs no server: it uses BroadcastChannel to bootstrap
// WebRTC between tabs of the same browser. Swap in WebSocketSignaling to
// connect real, separate clients (see multihook/server/signaling-server.js).
const mh = new MultiHook({ signaling: new LocalSignaling() });

for (const [id, box] of boxes) {
  mh.registerEntity(id, {
    owner: null,
    transform: { p: [box.x, box.y, 0], r: [0], s: [1, 1, 1] },
  });
}

const peersEl = document.getElementById('peers');
mh.on('peer-connected', () => (peersEl.textContent = mh.peers.length));
mh.on('peer-leave', () => (peersEl.textContent = mh.peers.length));

let dragging = null;

canvas.addEventListener('pointerdown', (event) => {
  const [x, y] = pointerPos(event);
  for (const [id, box] of boxes) {
    if (Math.hypot(x - box.x, y - box.y) < 40 && mh.grab(id)) {
      dragging = id;
      break;
    }
  }
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const [x, y] = pointerPos(event);
  const box = boxes.get(dragging);
  box.x = x;
  box.y = y;
  mh.hold(dragging, { p: [x, y, 0], r: [0], s: [1, 1, 1] });
});

window.addEventListener('pointerup', () => {
  if (dragging) mh.release(dragging);
  dragging = null;
});

function pointerPos(event) {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function frame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const [id, box] of boxes) {
    const t = mh.getEntityTransform(id);
    if (t) {
      box.x = t.p[0];
      box.y = t.p[1];
    }
    ctx.fillStyle = mh.interactions.isHeldByMe(id) ? '#ffd479' : box.color;
    ctx.beginPath();
    ctx.arc(box.x, box.y, 32, 0, Math.PI * 2);
    ctx.fill();
  }
  requestAnimationFrame(frame);
}

mh.connect(ROOM_ID).then(() => requestAnimationFrame(frame));
