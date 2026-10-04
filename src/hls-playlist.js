function isPlaylistUrl(rawUrl) {
  try { return /\.m3u8$/i.test(new URL(rawUrl).pathname); } catch { return false; }
}

function isPlaylistContentType(contentType) {
  return /^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)(?:;|$)/i.test(contentType || '');
}

function unwrapRelayUri(uri) {
  if (!uri || typeof uri !== 'string') return uri;
  const marker = '/p/hls/?u=';
  const idx = uri.indexOf(marker);
  if (idx === -1) return uri;
  try {
    return decodeURIComponent(uri.slice(idx + marker.length));
  } catch (e) {
    return uri;
  }
}

function rewritePlaylist(body, playlistUrl, origin, authorizer, parentSignature) {
  const rewriteUri = rawUri => {
    const uri = unwrapRelayUri(rawUri);
    let url;
    try { url = new URL(uri, playlistUrl); } catch { return uri; }
    if (!['http:', 'https:'].includes(url.protocol)) return uri;
    const signature = authorizer.sign(url.href, playlistUrl, parentSignature);
    return `${origin}/seg?u=${encodeURIComponent(url.href)}${signature ? `&sig=${signature}` : ''}`;
  };
  return body.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/\bURI="([^"]+)"/g, (_, uri) => `URI="${rewriteUri(uri)}"`);
    }
    return rewriteUri(trimmed);
  }).join('\n');
}

module.exports = { isPlaylistUrl, isPlaylistContentType, rewritePlaylist };
