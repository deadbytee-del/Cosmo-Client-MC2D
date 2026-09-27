import test from 'node:test';
import assert from 'node:assert/strict';
import { EntitySync } from '../src/entity.js';
import { InteractionManager } from '../src/interactions.js';

function makeManager(selfId, sent) {
  const entities = new EntitySync();
  entities.register('crate');
  const manager = new InteractionManager({ entities, selfId, send: (msg) => sent.push(msg) });
  return { entities, manager };
}

test('grab succeeds on an unowned entity and marks it local', () => {
  const sent = [];
  const { entities, manager } = makeManager('peer-a', sent);
  assert.equal(manager.grab('crate'), true);
  assert.equal(manager.isHeldByMe('crate'), true);
  assert.equal(entities.getOwner('crate'), 'local');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'grab');
});

test('a later remote grab is rejected once another peer already holds the entity', () => {
  const sent = [];
  const { manager } = makeManager('peer-a', sent);
  manager.grab('crate');
  manager.receive('peer-b', { type: 'grab', entityId: 'crate', owner: 'peer-b', timestamp: Date.now() + 50 });
  assert.equal(manager.ownerOf('crate'), 'peer-a');
});

test('release clears ownership and hand-off velocity reaches remote peers', () => {
  const sentA = [];
  const { manager: a } = makeManager('peer-a', sentA);
  a.grab('crate');

  const sentB = [];
  const { entities: entitiesB, manager: b } = makeManager('peer-b', sentB);
  b.receive('peer-a', sentA[0]); // b observes a's grab

  let releasedVelocity = null;
  b.on('release', (_id, info) => {
    releasedVelocity = info.velocity;
  });

  a.throw('crate', [5, 0, 0]);
  const releaseMsg = sentA[sentA.length - 1];
  assert.equal(releaseMsg.type, 'release');
  b.receive('peer-a', releaseMsg);

  assert.deepEqual(releasedVelocity, [5, 0, 0]);
  assert.equal(entitiesB.getOwner('crate'), null);
});

test('post broadcasts arbitrary events independent of entity ownership', () => {
  const sent = [];
  const { manager } = makeManager('peer-a', sent);
  let received = null;
  manager.on('post', (channel, data, info) => {
    received = { channel, data, info };
  });
  manager.post('chat', { text: 'hi' });
  assert.equal(sent[0].type, 'post');
  assert.deepEqual(received.data, { text: 'hi' });
  assert.equal(received.info.local, true);
});
