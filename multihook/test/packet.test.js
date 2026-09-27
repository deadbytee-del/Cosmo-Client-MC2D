import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePacket,
  decodePacket,
  SequenceGate,
  RateLimiter,
  PriorityQueue,
  reliabilityToDataChannelInit,
  ReliabilityMode,
} from '../src/packet.js';

test('encodePacket/decodePacket round-trip', () => {
  const raw = encodePacket('entity', { id: 'box-1', transform: { p: [1, 2, 3] } }, { channel: 'state', seq: 5 });
  const decoded = decodePacket(raw);
  assert.equal(decoded.type, 'entity');
  assert.equal(decoded.channel, 'state');
  assert.equal(decoded.seq, 5);
  assert.deepEqual(decoded.data, { id: 'box-1', transform: { p: [1, 2, 3] } });
});

test('decodePacket rejects malformed input', () => {
  assert.equal(decodePacket('not json'), null);
  assert.equal(decodePacket('{"foo":1}'), null);
  assert.equal(decodePacket(42), null);
});

test('SequenceGate drops stale and duplicate packets', () => {
  const gate = new SequenceGate();
  assert.equal(gate.accept('peerA:box', 1), true);
  assert.equal(gate.accept('peerA:box', 3), true);
  assert.equal(gate.accept('peerA:box', 2), false); // stale
  assert.equal(gate.accept('peerA:box', 3), false); // duplicate
  assert.equal(gate.accept('peerA:box', 4), true);
});

test('SequenceGate tracks independent keys separately', () => {
  const gate = new SequenceGate();
  assert.equal(gate.accept('a', 10), true);
  assert.equal(gate.accept('b', 1), true);
});

test('RateLimiter enforces packet and byte ceilings then refills', async () => {
  const limiter = new RateLimiter({ packetsPerSecond: 2, bytesPerSecond: 1000 });
  assert.equal(limiter.tryConsume(100), true);
  assert.equal(limiter.tryConsume(100), true);
  assert.equal(limiter.tryConsume(100), false); // packet budget exhausted
  await new Promise((r) => setTimeout(r, 550));
  assert.equal(limiter.tryConsume(100), true);
});

test('PriorityQueue pops highest priority first', () => {
  const q = new PriorityQueue();
  q.push('low', 0);
  q.push('urgent', 10);
  q.push('mid', 5);
  assert.equal(q.pop(), 'urgent');
  assert.equal(q.pop(), 'mid');
  assert.equal(q.pop(), 'low');
  assert.equal(q.size, 0);
});

test('reliabilityToDataChannelInit maps modes to RTCDataChannelInit', () => {
  assert.deepEqual(reliabilityToDataChannelInit(ReliabilityMode.RELIABLE_ORDERED), { ordered: true });
  assert.deepEqual(reliabilityToDataChannelInit(ReliabilityMode.RELIABLE_UNORDERED), { ordered: false });
  assert.deepEqual(reliabilityToDataChannelInit(ReliabilityMode.UNRELIABLE_ORDERED), {
    ordered: true,
    maxRetransmits: 0,
  });
  assert.deepEqual(reliabilityToDataChannelInit(ReliabilityMode.UNRELIABLE_UNORDERED, { maxPacketLifeTime: 100 }), {
    ordered: false,
    maxPacketLifeTime: 100,
  });
});
