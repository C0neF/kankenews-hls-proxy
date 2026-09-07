const assert = require('node:assert/strict');
const test = require('node:test');
const { isPlaylistUrl, isPlaylistContentType, rewritePlaylist } = require('../src/hls-playlist');
const { createPlaylistSegmentAuthorizer } = require('../src/segment-policy');

const origin = 'http://192.168.1.1:53535';
const root = 'https://ws-channels.kksmg.com/live/ylpd/index.m3u8?token=root';
const child = 'https://dynamic-node.100ycdn.com/live/ylpd/variant.m3u8?token=child';

test('master and child playlists retain a trusted signature chain for dynamic CDN media', () => {
  const authorizer = createPlaylistSegmentAuthorizer();
  const master = rewritePlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2245000\n${child}\n`, root, origin, authorizer);
  const childProxy = new URL(master.split('\n')[2]);
  assert.equal(childProxy.origin, origin);
  assert.equal(childProxy.searchParams.get('u'), child);
  assert.ok(authorizer.verify(child, childProxy.searchParams.get('sig')));
  const playlist = rewritePlaylist('#EXTM3U\n#EXTINF:4,\nmedia/1.ts?token=segment\n', child, origin, authorizer, childProxy.searchParams.get('sig'));
  const segmentProxy = new URL(playlist.split('\n')[2]);
  const segment = 'https://dynamic-node.100ycdn.com/live/ylpd/media/1.ts?token=segment';
  assert.equal(segmentProxy.searchParams.get('u'), segment);
  assert.ok(authorizer.verify(segment, segmentProxy.searchParams.get('sig')));
  assert.equal(authorizer.sign(segment, child, 'invalid'), null);
});

test('URI attributes for keys, maps and alternate playlists use the proxy', () => {
  const authorizer = createPlaylistSegmentAuthorizer();
  const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?token=k"\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="iframe.m3u8"\n#EXTINF:4,\n1.ts\n';
  const result = rewritePlaylist(input, root, origin, authorizer);
  const attributes = [...result.matchAll(/URI="([^"]+)"/g)].map(match => new URL(match[1]));
  assert.equal(attributes.length, 4);
  assert.deepEqual(attributes.map(url => url.searchParams.get('u')), [
    'https://ws-channels.kksmg.com/live/ylpd/key.bin?token=k',
    'https://ws-channels.kksmg.com/live/ylpd/init.mp4',
    'https://ws-channels.kksmg.com/live/ylpd/audio.m3u8',
    'https://ws-channels.kksmg.com/live/ylpd/iframe.m3u8',
  ]);
  assert.ok(attributes.every(url => url.origin === origin));
  assert.ok(result.includes('BYTERANGE="100@0"'));
});

test('embedded data keys remain intact and HTTPS segments retain their queries', () => {
  const authorizer = createPlaylistSegmentAuthorizer();
  const result = rewritePlaylist('#EXTM3U\r\n#EXT-X-KEY:METHOD=AES-128,URI="data:application/octet-stream;base64,YWJj"\r\n/live/1.ts?a=1&b=2\r\n', root, origin, authorizer);
  assert.ok(result.includes('URI="data:application/octet-stream;base64,YWJj"'));
  assert.equal(new URL(result.split('\n')[2]).searchParams.get('u'), 'https://ws-channels.kksmg.com/live/1.ts?a=1&b=2');
});

test('playlist URLs and content types are distinguishable from video segments', () => {
  assert.equal(isPlaylistUrl(child), true);
  assert.equal(isPlaylistUrl('https://example.test/1.ts?file=index.m3u8'), false);
  assert.equal(isPlaylistContentType('application/x-mpegurl'), true);
  assert.equal(isPlaylistContentType('application/vnd.apple.mpegurl; charset=utf-8'), true);
  assert.equal(isPlaylistContentType('video/mp2t'), false);
});
