const { setTimeout: sleep } = require('node:timers/promises');

const API_MIN_INTERVAL_MS = 800;

function createApiQueue({ now = Date.now, wait = sleep, intervalMs = API_MIN_INTERVAL_MS } = {}) {
  let lastStartedAt = -Infinity;
  let queue = Promise.resolve();
  return task => {
    const run = async () => {
      const delay = Math.max(0, intervalMs - (now() - lastStartedAt));
      if (delay) await wait(delay);
      lastStartedAt = now();
      return task();
    };
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  };
}

module.exports = { createApiQueue };
