import { setTimeout as delay } from 'node:timers/promises';

export class ApiError extends Error {
  constructor(status, body, { url, method } = {}) {
    super(ApiError.describe(status, body));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.method = method;
  }

  static describe(status, body) {
    const upstream =
      body?.error?.message || body?.message || (typeof body === 'string' ? body.slice(0, 300) : '');
    const hints = {
      400: 'Bad request — check the field names, or you may be calling the wrong endpoint for this model.',
      401: 'Unauthorized — the API key is wrong, expired, or was copied with whitespace.',
      402: 'Insufficient balance — top up the account.',
      403: 'Forbidden — this key may not be allowed to use this model.',
      404: 'Not found — check the base URL (OpenAI-compatible needs /v1, Anthropic-compatible must NOT have /v1).',
      408: 'Timed out — lower resolution/quality, or switch to the async endpoint.',
      429: 'Rate limited — back off and retry.',
      500: 'Upstream error — retry.',
      502: 'Upstream error — retry.',
      503: 'Upstream unavailable — retry.',
    };
    return `HTTP ${status}. ${hints[status] || 'Request failed.'}${upstream ? ` Upstream said: ${upstream}` : ''}`;
  }

  /** Errors that are worth retrying. Everything else is a client mistake. */
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * Node's global fetch (undici) does NOT read HTTP_PROXY / HTTPS_PROXY. On a machine where
 * those are set because direct egress is blocked, every request dies as a bare
 * "fetch failed" with no hint at all. Say what is actually wrong.
 */
export function explainNetworkError(err, url) {
  const isNetworkFailure =
    err instanceof TypeError || /fetch failed/i.test(String(err?.message ?? ''));
  if (!isNetworkFailure) return err;

  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  const cause = err?.cause?.code ? ` (${err.cause.code})` : '';

  if (proxy) {
    const e = new Error(
      `Cannot reach ${url}${cause}.
` +
        `  A proxy is configured (${proxy}) but Node's fetch ignores HTTP_PROXY/HTTPS_PROXY,
` +
        `  so this request went out directly and was refused. Either:
` +
        `    - run Node 24+ with NODE_USE_ENV_PROXY=1, or
` +
        `    - npm i -g undici and start node with a ProxyAgent dispatcher, or
` +
        `    - unset the proxy variables if direct egress works.`
    );
    e.code = 'EPROXYIGNORED';
    return e;
  }
  const e = new Error(`Cannot reach ${url}${cause}. Check DNS, firewall and VPN settings.`);
  e.code = 'ENETWORK';
  return e;
}

export class Client {
  constructor({ key, baseUrl, anthropicBaseUrl, timeout = 120_000, retries = 2, debug = false }) {
    this.key = key;
    this.baseUrl = baseUrl;
    this.anthropicBaseUrl = anthropicBaseUrl;
    this.timeout = timeout;
    this.retries = retries;
    this.debug = debug;
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'apimaster-cli',
      ...extra,
    };
  }

  /**
   * Single request. Returns { data, status, headers, ms }.
   * Never retries on its own — `withRetry` decides that, so callers can measure clean latency.
   */
  async raw(pathOrUrl, { method = 'GET', body, headers, timeout, base } = {}) {
    const root = base ?? this.baseUrl;
    const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : `${root}${pathOrUrl}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout ?? this.timeout);
    const started = performance.now();
    try {
      if (this.debug) console.error(`→ ${method} ${url}`);
      const res = await fetch(url, {
        method,
        headers: this.headers(headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      const ms = performance.now() - started;
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (this.debug) console.error(`← ${res.status} in ${Math.round(ms)}ms`);
      if (!res.ok) throw new ApiError(res.status, data, { url, method });
      return { data, status: res.status, headers: res.headers, ms };
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error(`Request timed out after ${timeout ?? this.timeout}ms: ${method} ${url}`);
        e.code = 'ETIMEDOUT';
        throw e;
      }
      throw explainNetworkError(err, url);
    } finally {
      clearTimeout(t);
    }
  }

  async withRetry(fn, { retries = this.retries } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof ApiError ? err.retryable : err.code === 'ETIMEDOUT';
        if (!retryable || attempt === retries) throw err;
        await delay(400 * 2 ** attempt + Math.random() * 200);
      }
    }
    throw lastErr;
  }

  listModels() {
    return this.withRetry(() => this.raw('/models'));
  }

  chat(body, opts = {}) {
    return this.raw('/chat/completions', { method: 'POST', body, ...opts });
  }

  /** Anthropic Messages protocol — different base (no /v1) and different auth header. */
  anthropicMessages(body, opts = {}) {
    return this.raw('/v1/messages', {
      method: 'POST',
      base: this.anthropicBaseUrl,
      body,
      headers: { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      ...opts,
    });
  }

  images(body, { async: isAsync = false, ...opts } = {}) {
    return this.raw(isAsync ? '/images/generations/async' : '/images/generations', {
      method: 'POST',
      body,
      ...opts,
    });
  }

  imageTask(taskId, model) {
    const q = model ? `?model=${encodeURIComponent(model)}` : '';
    return this.raw(`/tasks/${encodeURIComponent(taskId)}${q}`);
  }

  videoSubmit(body, opts = {}) {
    return this.raw('/videos/generations', { method: 'POST', body, ...opts });
  }

  videoStatus(taskId) {
    return this.raw(`/videos/${encodeURIComponent(taskId)}`);
  }

  videoContentUrl(taskId) {
    return `${this.baseUrl}/videos/${encodeURIComponent(taskId)}/content`;
  }
}

/**
 * Pull the assistant text out of a /responses payload.
 * The API may emit a `reasoning` item before the `message` item, so never index output[0].
 */
export function extractResponsesText(payload) {
  const items = payload?.output || [];
  const message = items.find((item) => item.type === 'message');
  const part = message?.content?.find((p) => p.type === 'output_text');
  return part?.text ?? null;
}

export function extractChatText(payload) {
  return payload?.choices?.[0]?.message?.content ?? null;
}

/**
 * Most models on a modern gateway are reasoning models: they spend completion tokens on
 * hidden reasoning before emitting any visible text. With a small `max_tokens` the whole
 * budget goes to reasoning and `content` comes back as an empty string — which looks
 * exactly like a broken model unless you check `reasoning_tokens`.
 *
 * Measured: glm-5.3-flash spent 59 of 64 tokens reasoning and returned ""; at 256 it
 * answered correctly. Every probe in this CLI has to account for that.
 */
export function describeCompletion(payload) {
  const text = extractChatText(payload) ?? '';
  const usage = payload?.usage ?? null;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const finishReason = payload?.choices?.[0]?.finish_reason ?? null;
  return {
    text,
    usage,
    reasoningTokens,
    finishReason,
    // Empty output plus reasoning that consumed (nearly) the whole budget.
    budgetExhaustedByReasoning:
      text.trim() === '' && reasoningTokens > 0 && reasoningTokens >= completionTokens * 0.8,
  };
}
