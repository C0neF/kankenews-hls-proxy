const { setTimeout: sleep } = require('node:timers/promises');

const DEFAULT_API_MIN_INTERVAL_MS = 1200;
const WAF_COOLDOWN_MS = 45000;

function positiveMs(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function envMs(name, fallback) {
  return positiveMs(Number(process.env[name])) ?? fallback;
}

function createApiQueue({
  now = Date.now, wait = sleep,
  intervalMs = envMs('API_MIN_INTERVAL_MS', DEFAULT_API_MIN_INTERVAL_MS),
  jitterMs = envMs('API_JITTER_MS', 0),
} = {}) {
  let lastStartedAt = -Infinity;
  let queue = Promise.resolve();
  let wafUntil = 0;

  const schedule = task => {
    const run = async () => {
      if (now() < wafUntil) {
        await wait(wafUntil - now());
      }
      // Extra random spacing keeps a fixed request cadence from standing out.
      const jitter = jitterMs > 0 ? Math.round(Math.random() * jitterMs) : 0;
      const delay = Math.max(0, intervalMs + jitter - (now() - lastStartedAt));
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

module.exports = { createApiQueue, API_MIN_INTERVAL_MS: DEFAULT_API_MIN_INTERVAL_MS, WAF_COOLDOWN_MS };
