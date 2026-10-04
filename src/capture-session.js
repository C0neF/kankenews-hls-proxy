const DEFAULT_SESSION_IDLE_MS = 30000;

function sessionHealthy(session) {
  if (!session) return false;
  if (typeof session.isHealthy === 'function') return session.isHealthy();
  return true;
}

/**
 * Shared capture session: one CDP connection and one navigated page reused by
 * every channel capture, so a capture round behaves like a single viewer
 * instead of reloading the live page once per channel. The session closes
 * itself after `idleMs` without use and is rebuilt when the browser or page
 * dies. `open()` must return { isHealthy, close, ... } for its own session.
 */
function createSessionManager({ open, idleMs = DEFAULT_SESSION_IDLE_MS, log = () => {} }) {
  let session = null;
  let opening = null;
  let holders = 0;
  let closeTimer = null;

  async function destroy(current) {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (session === current) session = null;
    try {
      await current.close();
    } catch (error) {
      log(`Session close failed: ${error && error.message || error}`);
    }
  }

  async function acquire() {
    if (sessionHealthy(session)) {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      holders += 1;
      return session;
    }
    if (session) await destroy(session);
    if (opening) {
      session = await opening;
    } else {
      opening = open();
      try {
        session = await opening;
      } finally {
        opening = null;
      }
    }
    if (!sessionHealthy(session)) throw new Error('capture session is unhealthy right after open');
    holders += 1;
    return session;
  }

  function release(acquired) {
    if (!acquired || session !== acquired) return;
    holders = Math.max(0, holders - 1);
    if (holders > 0 || idleMs < 0) return;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (session && holders <= 0) destroy(session);
    }, idleMs);
    // Do not keep the process alive just to close an idle session.
    if (typeof closeTimer.unref === 'function') closeTimer.unref();
  }

  // Drop a session that failed mid-capture so the next acquire starts fresh.
  async function discard(acquired) {
    if (acquired && session === acquired) await destroy(acquired);
  }

  async function close() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    holders = 0;
    if (session) await destroy(session);
  }

  return { acquire, release, discard, close, isOpen: () => session != null };
}

module.exports = { createSessionManager, DEFAULT_SESSION_IDLE_MS };
