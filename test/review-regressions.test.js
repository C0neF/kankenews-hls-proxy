const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('capture script uses shared signing helpers and no undefined channelId fallback', () => {
  const source = fs.readFileSync('src/vps-capture.js', 'utf8');

  assert.match(source, /require\(['"]\.\/signing['"]\)/);
  assert.doesNotMatch(source, /function decodeUrl/);
  assert.doesNotMatch(source, /channelInfo\.name \|\| channelId/);
});

test('README and compose commands use the GitHub repository image and service names', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');

  assert.match(readme, /ghcr\.io\/c0nef\/kankenews-hls-proxy/);
  assert.match(readme, /github\.com\/c0nef\/kankenews-hls-proxy\.git/);
  assert.match(compose, /ghcr\.io\/c0nef\/kankenews-hls-proxy/);
  assert.match(readme, /docker compose exec kk-proxy node src\/vps-capture\.js/);
});

test('Docker defaults capture every channel listed in the playlist', () => {
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const entrypoint = fs.readFileSync('docker-entrypoint.sh', 'utf8');
  const expectedChannelIds = '1,2,4,5,9,10,11,12';

  assert.match(compose, new RegExp(`CHANNEL_IDS=\\$\\{CHANNEL_IDS:-${expectedChannelIds}\\}`));
  assert.match(entrypoint, new RegExp(`CHANNEL_IDS=\\$\\{CHANNEL_IDS:-${expectedChannelIds}\\}`));
});

test('Docker container listens on port 53535 internally', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const entrypoint = fs.readFileSync('docker-entrypoint.sh', 'utf8');
  const readme = fs.readFileSync('README.md', 'utf8');
  const server = fs.readFileSync('src/vps-server.js', 'utf8');
  const healthcheck = fs.readFileSync('src/healthcheck.js', 'utf8');

  assert.match(dockerfile, /^ENV PORT=53535$/m);
  assert.match(dockerfile, /^EXPOSE 53535$/m);
  assert.match(compose, /"\$\{PORT:-53535\}:53535"/);
  assert.match(compose, /PORT=53535/);
  assert.doesNotMatch(entrypoint, /PORT:-3000/);
  assert.match(server, /process\.env\.PORT \|\| 53535/);
  assert.match(healthcheck, /process\.env\.PORT \|\| 53535/);
  assert.match(readme, /-p 53535:53535/);
  assert.match(readme, /`PORT` \| `53535`/);
});

test('Docker healthcheck does not depend on missing curl', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');

  assert.doesNotMatch(compose, /"curl"/);
  assert.doesNotMatch(dockerfile, /^\s*curl\s*$/m);
});

test('package has a reproducible install lockfile', () => {
  assert.equal(fs.existsSync('package-lock.json'), true);
});
