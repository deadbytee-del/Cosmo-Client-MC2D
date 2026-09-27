import * as THREE from 'three';
import { MultiHook, LocalSignaling } from '../../src/index.js';

const ROOM_ID = new URLSearchParams(location.search).get('room') || 'demo-room-3d';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 4, 8);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.2));
scene.add(new THREE.GridHelper(20, 20, 0x333344, 0x222233));

const meshes = new Map();
const colors = [0xe06c75, 0x61afef, 0x98c379];
for (let i = 0; i < 3; i++) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: colors[i] })
  );
  mesh.position.set((i - 1) * 2.5, 0.5, 0);
  scene.add(mesh);
  meshes.set(`cube-${i}`, mesh);
}

// LocalSignaling needs no server: it uses BroadcastChannel to bootstrap
// WebRTC between tabs of the same browser. Swap in WebSocketSignaling to
// connect real, separate clients (see multihook/server/signaling-server.js).
const mh = new MultiHook({ signaling: new LocalSignaling() });

for (const [id, mesh] of meshes) {
  mh.registerEntity(id, {
    owner: null,
    transform: { p: mesh.position.toArray(), r: mesh.quaternion.toArray(), s: mesh.scale.toArray() },
  });
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.5);
let dragging = null;

function setPointer(event) {
  pointer.x = (event.clientX / innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / innerHeight) * 2 + 1;
}

function intersectDragPoint() {
  raycaster.setFromCamera(pointer, camera);
  const point = new THREE.Vector3();
  raycaster.ray.intersectPlane(dragPlane, point);
  return point;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  setPointer(event);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...meshes.values()]);
  if (!hits.length) return;
  const entry = [...meshes].find(([, mesh]) => mesh === hits[0].object);
  if (entry && mh.grab(entry[0])) dragging = entry[0];
});

renderer.domElement.addEventListener('pointermove', (event) => {
  setPointer(event);
  if (!dragging) return;
  const point = intersectDragPoint();
  const mesh = meshes.get(dragging);
  mesh.position.set(point.x, 0.5, point.z);
  mh.hold(dragging, {
    p: mesh.position.toArray(),
    r: mesh.quaternion.toArray(),
    s: mesh.scale.toArray(),
  });
});

window.addEventListener('pointerup', () => {
  if (dragging) mh.release(dragging);
  dragging = null;
});

function animate() {
  for (const [id, mesh] of meshes) {
    const t = mh.getEntityTransform(id);
    if (t) {
      mesh.position.fromArray(t.p);
      mesh.quaternion.fromArray(t.r);
      mesh.scale.fromArray(t.s);
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

mh.connect(ROOM_ID).then(() => requestAnimationFrame(animate));
