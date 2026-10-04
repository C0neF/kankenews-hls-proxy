const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionManager } = require('../src/capture-session');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness() {
  const opened = [];
  let seq = 0;
  const open = async () => {
    const state = { dead: false, closed: false };
    const session = {
      id: ++seq,
      state,
      isHealthy: () => !state.dead && !state.closed,
      close: async () => { state.closed = true; },
    };
    opened.push(session);
    return session;
  };
  return { open, opened };
}

test('captures reuse one session until it goes idle', async () => {
  const { open, opened } = harness();
  const manager = createSessionManager({ open, idleMs: 25 });

  const first = await manager.acquire();
  const second = await manager.acquire();
  assert.equal(first, second);
  assert.equal(opened.length, 1);

  manager.release(first);
  const third = await manager.acquire();
  assert.equal(third, first);
  manager.release(third);
  manager.release(second);
  assert.ok(manager.isOpen());

  await sleep(60);
  assert.equal(manager.isOpen(), false);
  assert.equal(first.state.closed, true);

  const fourth = await manager.acquire();
  assert.equal(opened.length, 2);
  assert.notEqual(fourth, first);
  await manager.close();
  assert.equal(fourth.state.closed, true);
});

test('a dead browser or page is rebuilt on the next acquire', async () => {
  const { open, opened } = harness();
  const manager = createSessionManager({ open, idleMs: 60000 });
  const first = await manager.acquire();
  first.state.dead = true;
  const second = await manager.acquire();
  assert.notEqual(second, first);
  assert.equal(first.state.closed, true);
  assert.equal(opened.length, 2);
  manager.release(second);
  await manager.close();
  assert.equal(second.state.closed, true);
});

test('discard drops the session immediately so the next acquire starts fresh', async () => {
  const { open, opened } = harness();
  const manager = createSessionManager({ open, idleMs: 60000 });
  const first = await manager.acquire();
  await manager.discard(first);
  assert.equal(manager.isOpen(), false);
  assert.equal(first.state.closed, true);
  const second = await manager.acquire();
  assert.notEqual(second, first);
  manager.release(second);
  await manager.close();
});

test('concurrent acquires share a single open', async () => {
  const { open, opened } = harness();
  let releaseOpen;
  const gatedOpen = async () => {
    await new Promise(resolve => { releaseOpen = resolve; });
    return open();
  };
  const manager = createSessionManager({ open: gatedOpen, idleMs: 60000 });
  const pending = [manager.acquire(), manager.acquire()];
  await sleep(5);
  releaseOpen();
  const [first, second] = await Promise.all(pending);
  assert.equal(first, second);
  assert.equal(opened.length, 1);
  manager.release(first);
  manager.release(second);
  await manager.close();
});
