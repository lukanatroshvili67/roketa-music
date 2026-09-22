import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Queue, LoopMode } from '../src/queue/Queue.js';
import { Track } from '../src/music/Track.js';

const t = (id) => new Track({ videoId: id.padEnd(11, '_'), title: id, duration: 100 });
const ids = (list) => list.map((x) => x.title);
const filled = (n, opts) => {
  const q = new Queue(opts);
  q.add(Array.from({ length: n }, (_, i) => t(`t${i + 1}`)));
  return q;
};

describe('Queue basics', () => {
  test('add, next, and exhaustion', () => {
    const q = filled(3);
    assert.equal(q.next().title, 't1');
    assert.equal(q.next().title, 't2');
    assert.equal(q.next().title, 't3');
    assert.equal(q.next(), null);
    assert.equal(q.current, null);
    assert.deepEqual(ids(q.history), ['t1', 't2', 't3']);
  });

  test('add at front (play next)', () => {
    const q = filled(2);
    q.add(t('urgent'), { position: 'next' });
    assert.deepEqual(ids(q.upcoming), ['urgent', 't1', 't2']);
  });

  test('max size is enforced and overflow reported', () => {
    const q = new Queue({ maxSize: 3 });
    const res = q.add([t('a'), t('b'), t('c'), t('d'), t('e')]);
    assert.equal(res.added.length, 3);
    assert.equal(res.overflow, 2);
  });

  test('duplicates rejected when disabled (including current and within one batch)', () => {
    const q = new Queue({ allowDuplicates: false });
    q.add(t('a'));
    q.next();
    const res = q.add([t('a'), t('b'), t('b'), t('c')]);
    assert.deepEqual(ids(res.added), ['b', 'c']);
    assert.equal(res.duplicates, 2);
  });

  test('duplicates allowed by default', () => {
    const q = new Queue();
    const res = q.add([t('a'), t('a')]);
    assert.equal(res.added.length, 2);
  });

  test('remove / removeRange / move with validation', () => {
    const q = filled(6);
    assert.equal(q.remove(2).title, 't2');
    assert.deepEqual(ids(q.removeRange(4, 2)), ['t3', 't4', 't5']);
    assert.deepEqual(ids(q.upcoming), ['t1', 't6']);
    q.move(2, 1);
    assert.deepEqual(ids(q.upcoming), ['t6', 't1']);
    assert.throws(() => q.remove(0), RangeError);
    assert.throws(() => q.remove(3), RangeError);
    assert.throws(() => q.move(1, 5), RangeError);
    assert.throws(() => new Queue().remove(1), /empty/);
  });

  test('clear keeps current, reset clears everything', () => {
    const q = filled(3);
    q.next();
    assert.equal(q.clear(), 2);
    assert.equal(q.current.title, 't1');
    q.reset();
    assert.equal(q.current, null);
    assert.equal(q.history.length, 0);
  });

  test('dedupe keeps first occurrence and treats current as seen', () => {
    const q = new Queue();
    q.add([t('a'), t('b'), t('a'), t('c'), t('b')]);
    q.next(); // current = a
    assert.equal(q.dedupe(), 2); // upcoming b, a, c, b → b, c
    assert.deepEqual(ids(q.upcoming), ['b', 'c']);
  });

  test('history is bounded', () => {
    const q = filled(10, { historySize: 3 });
    for (let i = 0; i < 11; i++) q.next();
    assert.deepEqual(ids(q.history), ['t8', 't9', 't10']);
  });

  test('jump moves skipped tracks to history', () => {
    const q = filled(5);
    q.next(); // t1
    assert.equal(q.jump(3).title, 't4');
    assert.deepEqual(ids(q.history), ['t1', 't2', 't3']);
    assert.deepEqual(ids(q.upcoming), ['t5']);
  });
});

describe('Queue previous', () => {
  test('previous puts current back at the front', () => {
    const q = filled(3);
    q.next();
    q.next(); // current t2
    assert.equal(q.previous().title, 't1');
    assert.deepEqual(ids(q.upcoming), ['t2', 't3']);
    assert.equal(q.previous(), null);
  });

  test('previous after the queue ended', () => {
    const q = filled(1);
    q.next();
    q.next(); // ended
    assert.equal(q.previous().title, 't1');
    assert.equal(q.current.title, 't1');
  });

  test('previous in loop-queue mode does not leave a duplicate at the end', () => {
    const q = filled(3, { loopMode: LoopMode.QUEUE });
    q.next(); // t1
    q.next(); // t2; t1 appended
    assert.deepEqual(ids(q.upcoming), ['t3', 't1']);
    q.previous(); // back to t1
    assert.equal(q.current.title, 't1');
    assert.deepEqual(ids(q.upcoming), ['t2', 't3']);
  });
});

describe('Loop modes', () => {
  test('loop track repeats current on natural end, but a forced skip advances', () => {
    const q = filled(2, { loopMode: LoopMode.TRACK });
    q.next();
    assert.equal(q.next().title, 't1');
    assert.equal(q.next().title, 't1');
    assert.equal(q.next({ forced: true }).title, 't2');
    assert.equal(q.next().title, 't2');
  });

  test('loop queue cycles forever', () => {
    const q = filled(3, { loopMode: LoopMode.QUEUE });
    const seen = [];
    for (let i = 0; i < 7; i++) seen.push(q.next().title);
    assert.deepEqual(seen, ['t1', 't2', 't3', 't1', 't2', 't3', 't1']);
    assert.equal(q.size, 2);
  });

  test('loop queue with one track keeps replaying it', () => {
    const q = filled(1, { loopMode: LoopMode.QUEUE });
    assert.equal(q.next().title, 't1');
    assert.equal(q.next().title, 't1');
    assert.equal(q.next({ forced: true }).title, 't1');
  });

  test('failed tracks are dropped even in loop modes', () => {
    for (const mode of [LoopMode.TRACK, LoopMode.QUEUE]) {
      const q = filled(2, { loopMode: mode });
      q.next();
      assert.equal(q.next({ dropCurrent: true }).title, 't2');
      assert.ok(!q.upcoming.some((x) => x.title === 't1'), `t1 re-queued in ${mode}`);
      assert.ok(!q.history.some((x) => x.title === 't1'), `failed track in history in ${mode}`);
    }
  });

  test('cycleLoopMode goes off → track → queue → off and rejects invalid', () => {
    const q = new Queue();
    assert.equal(q.cycleLoopMode(), 'track');
    assert.equal(q.cycleLoopMode(), 'queue');
    assert.equal(q.cycleLoopMode(), 'off');
    assert.throws(() => q.setLoopMode('bogus'), RangeError);
  });
});

describe('Shuffle', () => {
  test('is a permutation and never touches the current track', () => {
    const q = filled(50);
    q.next();
    const before = ids(q.upcoming).sort();
    q.shuffle();
    assert.deepEqual(ids(q.upcoming).sort(), before);
    assert.equal(q.current.title, 't1');
  });

  test('actually reorders and is roughly uniform', () => {
    // Position of element "t1" over many shuffles of 4 items should be ~uniform (25% each).
    const counts = [0, 0, 0, 0];
    const runs = 20000;
    for (let i = 0; i < runs; i++) {
      const q = filled(4);
      q.shuffle();
      counts[q.upcoming.findIndex((x) => x.title === 't1')]++;
    }
    for (const c of counts) assert.ok(Math.abs(c / runs - 0.25) < 0.02, `non-uniform distribution: ${counts}`);
  });
});
