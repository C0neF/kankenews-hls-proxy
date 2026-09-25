const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('proxy status, playlist availability and healthcheck agree on source expiry', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-server-lifetime-'));
  const segmentDir = path.join(dataDir, 'segments');
  const cacheFile = path.join(dataDir, 'm3u8-cache-10.json');
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = {
    ...process.env, PORT: String(port), CHANNEL_ID: '10', EXPOSE_RAW_URL: '0',
    CACHE_FILE: path.join(dataDir, 'm3u8-cache.json'), SEG_CACHE_DIR: segmentDir,
  };
  const child = spawn(process.execPath, ['src/vps-server.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill();
    await exited;
    await fs.unlink(cacheFile).catch(() => {});
    await fs.rmdir(segmentDir).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(dataDir);
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Proxy startup timed out: ${output}`)), 10000);
    const done = error => { clearTimeout(timeout); error ? reject(error) : resolve(); };
    child.once('error', done);
    child.once('exit', code => done(new Error(`Proxy exited with ${code}: ${output}`)));
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('HLS Proxy running on port')) done();
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const now = Math.floor(Date.now() / 1000);
  const root = 'https://volc-stream.kksmg.com/live/wxty/index.m3u8';
  const cases = [
    { name: 'expired CDN parameter in a legacy cache', url: `${root}?expires=${now - 60}`, exp: now + 3600, capturedAt: now, usable: false },
    { name: 'unknown expiry older than twenty minutes', url: root, exp: null, capturedAt: now - 1260, usable: false },
    { name: 'fresh address without expiry', url: root, exp: null, capturedAt: now, usable: true },
    { name: 'short-lived address outside the safety margin', url: root, exp: now + 50, capturedAt: now, usable: true },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      await fs.writeFile(cacheFile, JSON.stringify({ channelId: '10', url: item.url, exp: item.exp, capturedAt: item.capturedAt }));
      const status = await (await fetch(`${origin}/status`)).json();
      assert.equal(status.hasUrl, true);
      assert.equal(status.usable, item.usable);
      assert.equal(status.secondsLeft > 0, item.usable);
      const address = await (await fetch(`${origin}/url`)).json();
      assert.equal(address.usable, item.usable);
      assert.equal(address.m3u8, null);
      const playlist = await (await fetch(`${origin}/wx.m3u`)).text();
      assert.equal(playlist.includes('五星体育 [待刷新]'), !item.usable);
      const healthCode = await new Promise((resolve, reject) => {
        execFile(process.execPath, ['src/healthcheck.js'], { env, windowsHide: true, timeout: 8000 }, error => {
          if (error && typeof error.code !== 'number') return reject(error);
          resolve(error?.code ?? 0);
        });
      });
      assert.equal(healthCode, item.usable ? 0 : 1);
      if (!item.usable) {
        const response = await fetch(`${origin}/?id=10`);
        assert.equal(response.status, 503);
        assert.match(await response.text(), /expired/);
      }
    });
  }
});
