const { COMMON_HEADERS } = require('./http-headers');
const { toApiUrl, getRelayBase, DIRECT_API_BASE } = require('./relay');

const KAPI_BASE = getRelayBase() ? toApiUrl('') : DIRECT_API_BASE;

function describeError(error) {
  const message = String(error?.message || error).split(/\r?\n/, 1)[0];
  const code = error?.cause?.code || error?.code;
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

function isWafText(text) {
  return /WAF拦截页面|waf-attack-feedback/i.test(String(text || ''));
}

function parseApiResponse(status, text) {
  if (status < 200 || status >= 300) {
    const waf = status === 403 && isWafText(text);
    const error = new Error(`API HTTP ${status}${waf ? ' (upstream WAF block)' : ''}`);
    if (waf) error.isWaf = true;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API returned non-JSON content (HTTP ${status})`);
  }
}

function createBrowserApi({ page, requestContext, log = () => {}, pageAvailable = true, baseUrl }) {
  let activeUrl;
  let networkFailure;
  let wafUntil = 0;
  page.on('requestfailed', request => {
    if (request.url() === activeUrl) networkFailure = request.failure()?.errorText;
  });

  const noteWaf = () => { wafUntil = Date.now() + 45000; };

  return async (endpoint, params, signedHeaders) => {
    if (Date.now() < wafUntil) {
      const error = new Error('API skipped during WAF cooldown (upstream WAF block)');
      error.isWaf = true;
      throw error;
    }
    let url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(endpoint)) {
      url = new URL(endpoint);
      const allowedOrigin = baseUrl ? new URL(baseUrl).origin : new URL(toApiUrl("/")).origin;
      if (url.origin !== allowedOrigin) throw new Error("API endpoint must use the configured origin");
    } else {
      const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
      url = baseUrl ? new URL(path, baseUrl) : new URL(toApiUrl(path));
      if (baseUrl && url.origin !== new URL(baseUrl).origin) throw new Error("API endpoint must use the configured origin");
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers = Object.fromEntries(Object.entries({
      ...signedHeaders, Accept: 'application/json, text/plain, */*',
    }).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));

    let pageError = 'live page unavailable';
    if (pageAvailable) {
      activeUrl = url.href;
      networkFailure = null;
      try {
        const response = await page.evaluate(async ({ url, headers }) => {
          let uuid = '';
          try { uuid = localStorage.getItem('uuid') || ''; } catch {}
          const response = await fetch(url, {
            headers: { ...headers, 'M-Uuid': uuid },
            redirect: 'manual',
            signal: AbortSignal.timeout(12000),
          });
          return { status: response.status, text: await response.text() };
        }, { url: url.href, headers });
        return parseApiResponse(response.status, response.text);
      } catch (error) {
        if (error && error.isWaf) noteWaf();
        pageError = `${networkFailure ? `${networkFailure}: ` : ''}${describeError(error)}`;
        log(`Page API request failed (${pageError}); trying direct HTTP request.`);
      } finally {
        activeUrl = null;
      }
    }

    // Equivalent to the userscript's GM request fallback: no page CORS/CSP restrictions,
    // while retaining the browser context's cookies and the proxy's User-Agent.
    let uuid = '';
    if (pageAvailable) {
      uuid = await page.evaluate(() => {
        try { return localStorage.getItem('uuid') || ''; } catch { return ''; }
      }).catch(() => '');
    }
    let response;
    try {
      response = await requestContext.get(url.href, {
        headers: { ...headers, ...COMMON_HEADERS, 'M-Uuid': uuid },
        timeout: 15000,
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      return parseApiResponse(response.status(), await response.text());
    } catch (error) {
      if (error && (error.isWaf || isWafText(error.message))) noteWaf();
      const wrapped = new Error(`API request failed (page: ${pageError}; direct: ${describeError(error)})`);
      if (error && error.isWaf) wrapped.isWaf = true;
      throw wrapped;
    } finally {
      if (response) await response.dispose().catch(() => {});
    }
  };
}

module.exports = { createBrowserApi, describeError, isWafText };
