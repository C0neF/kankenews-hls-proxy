const { setTimeout: sleep } = require('node:timers/promises');

const API_MIN_INTERVAL_MS = 1200;
const WAF_COOLDOWN_MS = 45000;

function createApiQueue({ now = Date.now, wait = sleep, intervalMs = API_MIN_INTERVAL_MS } = {}) {
  let lastStartedAt = -Infinity;
  let queue = Promise.resolve();
  let wafUntil = 0;

  const schedule = task => {
    const run = async () => {
      if (now() < wafUntil) {
        await wait(wafUntil - now());
      }
      const delay = Math.max(0, intervalMs - (now() - lastStartedAt));
      if (delay) await wait(delay);
      lastStartedAt = now();
      try {
        return await task();
      } catch (error) {
        if (error && (error.isWaf || /upstream WAF block/.test(String(error.message || '')))) {
          wafUntil = now() + WAF_COOLDOWN_MS;
        }
        throw error;
      }
    };
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  };

  schedule.isWafCooldown = () => now() < wafUntil;
  schedule.noteWaf = (ms = WAF_COOLDOWN_MS) => { wafUntil = Math.max(wafUntil, now() + ms); };
  return schedule;
}

module.exports = { createApiQueue, API_MIN_INTERVAL_MS, WAF_COOLDOWN_MS };
