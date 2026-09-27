import test from 'node:test';
import assert from 'node:assert/strict';
import { EntitySync } from '../src/entity.js';

test('register/updateLocal/collectDirty round trip', () => {
  const sync = new EntitySync();
  sync.register('a', { transform: { p: [0, 0, 0], r: [0], s: [1, 1, 1] }, owner: 'local' });
  assert.equal(sync.collectDirty().length, 1); // registration marks dirty
  assert.equal(sync.collectDirty().length, 0); // cleared after collection

  sync.updateLocal('a', { p: [1, 0, 0], r: [0], s: [1, 1, 1] });
  const dirty = sync.collectDirty();
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0][0], 'a');
});

test('getRenderTransform interpolates 2D snapshots over time', () => {
  const sync = new EntitySync({ interpolationDelayMs: 50 });
  sync.register('a', { owner: 'remote' });
  const t0 = 1000;
  sync.applyRemote('a', { p: [0, 0, 0], r: [0], s: [1, 1, 1] }, t0);
  sync.applyRemote('a', { p: [10, 0, 0], r: [0], s: [1, 1, 1] }, t0 + 100);

  const result = sync.getRenderTransform('a', t0 + 100); // renderTime = t0+50 -> halfway
  assert.equal(result.p[0], 5);
});

test('getRenderTransform extrapolates past the newest snapshot within the limit', () => {
  const sync = new EntitySync({ interpolationDelayMs: 0, extrapolationLimitMs: 200 });
  sync.register('a', { owner: 'remote' });
  const t0 = 1000;
  sync.applyRemote('a', { p: [0, 0, 0], r: [0], s: [1, 1, 1] }, t0);
  sync.applyRemote('a', { p: [10, 0, 0], r: [0], s: [1, 1, 1] }, t0 + 100);

  const result = sync.getRenderTransform('a', t0 + 150); // 50ms past latest snapshot
  assert.ok(result.p[0] > 10); // extrapolated forward
});

test('local entities render their own authoritative transform, skipping interpolation', () => {
  const sync = new EntitySync();
  sync.register('a', { transform: { p: [3, 3, 3], r: [0], s: [1, 1, 1] }, owner: 'local' });
  const result = sync.getRenderTransform('a', Date.now());
  assert.deepEqual(result.p, [3, 3, 3]);
});

test('3D quaternion rotations slerp between snapshots', () => {
  const sync = new EntitySync({ interpolationDelayMs: 50 });
  sync.register('a', { owner: 'remote' });
  const t0 = 1000;
  sync.applyRemote('a', { p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }, t0);
  sync.applyRemote('a', { p: [0, 0, 0], r: [0, 0, 1, 0], s: [1, 1, 1] }, t0 + 100);

  const result = sync.getRenderTransform('a', t0 + 100);
  assert.equal(result.r.length, 4);
  const magnitude = Math.hypot(...result.r);
  assert.ok(Math.abs(magnitude - 1) < 1e-6); // slerp preserves unit length
});
