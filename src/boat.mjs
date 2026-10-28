import { setTimeout as delay } from 'node:timers/promises';

const ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const SIZES = new Set(['small', 'default', 'large', 'xlarge']);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function validateId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Expected a Boat sandbox ID such as bx_23456789.');
  return id;
}

export function validateSize(size) {
  if (!SIZES.has(size)) throw new Error('Size must be small, default, large, or xlarge.');
  return size;
}

export class BoatError extends Error {
  constructor(message, { status = 0, code = 'protocol_error', requestId } = {}) {
    super(message);
    this.name = 'BoatError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function sandbox(value) {
  if (!value || typeof value !== 'object' || typeof value.state !== 'string' || !value.state) {
    throw new BoatError('Boat returned an invalid sandbox record.');
  }
  validateId(value.id);
  return { ...value, name: typeof value.name === 'string' ? value.name : value.id };
}

function apiRoot(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Boat API URL must use HTTPS. HTTP is allowed only on loopback for local verification.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Boat API URL must not contain credentials, a query, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/api/v1';
  if (url.pathname !== '/api/v1') throw new Error('Boat API URL must end in /api/v1.');
  return url.href.replace(/\/$/, '');
}

export class BoatClient {
  constructor({ apiKey, apiUrl = 'https://boat.dev/api/v1', org, requestTimeoutMs = 30000 }) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('Set BOAT_API_KEY or run setup --key-stdin to configure this plugin.');
    }
    if (/[\r\n\0]/.test(apiKey)) throw new Error('Boat API key contains invalid characters.');
    if (org !== undefined && (typeof org !== 'string' || !org.trim() || /[\r\n\0]/.test(org))) {
      throw new Error('Boat organization must be a nonempty name or ID.');
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('Invalid request timeout.');
    this.apiUrl = apiRoot(apiUrl);
    this.org = org;
    Object.defineProperty(this, 'apiKey', { value: apiKey, enumerable: false });
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async request(method, path, body, headers = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new Error('Expected a relative Boat API path.');
    }
    const url = new URL(this.apiUrl + path);
    const root = new URL(this.apiUrl);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname + '/')) {
      throw new Error('Request is outside the Boat API root.');
    }
    if (this.org) url.searchParams.set('org', this.org);
    const redact = value => String(value).replaceAll(this.apiKey, '[redacted]').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    let response;
    let data;
    try {
      response = await fetch(url, {
        method,
        headers: { ...headers, Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new BoatError('Boat response exceeded the size limit.');
        chunks.push(chunk);
      }
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new BoatError(`Boat returned invalid JSON with HTTP ${response.status}.`, { status: response.status });
      }
    } catch (error) {
      if (error instanceof BoatError) throw error;
      throw new BoatError(`Boat request failed. ${redact(error.message)}`, { code: 'network_error' });
    }
    if (!response.ok || data?.ok === false) {
      const code = typeof data?.code === 'string' ? data.code : data?.error?.code;
      const requestId = typeof data?.requestId === 'string' ? redact(data.requestId) : undefined;
      const message = data?.message ?? data?.error?.message ?? `HTTP ${response.status}`;
      throw new BoatError(`Boat ${response.status}${code ? ` ${redact(code)}` : ''}. ${redact(message)}${requestId ? ` Request ${requestId}.` : ''}`, {
        status: response.status,
        code: typeof code === 'string' ? redact(code) : 'http_error',
        requestId,
      });
    }
    if (data?.ok !== true || typeof data.type !== 'string') {
      throw new BoatError('Boat returned an invalid success envelope.', { status: response.status });
    }
    return data;
  }

  async pages(path, field, parse) {
    const rows = [];
    const cursors = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const data = await this.request('GET', `${path}?${query}`);
      if (!Array.isArray(data[field])) throw new BoatError(`Boat returned an invalid ${field} list.`);
      rows.push(...data[field].map(parse));
      const next = data.pageInfo?.nextCursor;
      if (next !== undefined && next !== null && typeof next !== 'string') {
        throw new BoatError('Boat returned an invalid pagination cursor.');
      }
      if (data.pageInfo?.hasMore === true && !next) throw new BoatError('Boat pagination omitted its next cursor.');
      cursor = next || null;
      if (cursor && cursors.has(cursor)) throw new BoatError('Boat pagination repeated a cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rows;
  }

  async list() {
    return this.pages('/sandboxes', 'sandboxes', sandbox);
  }

  async get(id) {
    validateId(id);
    const result = sandbox((await this.request('GET', `/sandboxes/${id}`)).sandbox);
    if (result.id !== id) throw new BoatError('Boat returned a different sandbox ID.');
    return result;
  }

  async wait(id, predicate, { timeoutMs = 300000, intervalMs = 1000 } = {}) {
    validateId(id);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(intervalMs) || intervalMs < 1) {
      throw new Error('Invalid lifecycle wait settings.');
    }
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      last = await this.get(id);
      if (predicate(last)) return last;
      if (['error', 'cancelled'].includes(last.state)) {
        throw new BoatError(`Sandbox ${id} entered ${last.state}. ${last.error ?? ''}`, { code: 'sandbox_failed' });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(intervalMs, remaining));
    } while (Date.now() <= deadline);
    throw new BoatError(`Timed out waiting for ${id}. Last state ${last?.state ?? 'unknown'}. The cloud operation may still be running.`, { code: 'operation_pending' });
  }

  async savedSnapshots() {
    return this.pages('/saved-snapshots', 'snapshots', value => {
      if (!value || typeof value.name !== 'string' || !['saving', 'ready', 'failed'].includes(value.status)) {
        throw new BoatError('Boat returned an invalid saved snapshot.');
      }
      return value;
    });
  }
}
