// @iii-partners/fleet-kit · telemetry
//
// The one capture helper for the iii Partners Fleet Telemetry Standard
// (iii-eye: docs/standards/TELEMETRY-STANDARD.md). Zero dependencies; runs wherever `fetch` exists:
// Node 18+, Cloudflare Workers, browsers.
//
//   import { createTelemetry } from '@iii-partners/fleet-kit/telemetry';
//   const telemetry = createTelemetry({
//     key: env.POSTHOG_KEY,                                   // the pillar's project write key, a secret
//     defaults: { venture_id: 'iii-partners', pillar: 'eye', env: 'production', executor: 'cloudflare-worker' },
//   });
//   await telemetry.capture('health_run', { class: 'health', actor_type: 'agent', actor_id: 'cron', run_id, ticket: 'none', pillars_up: 7 });
//   ctx.waitUntil(telemetry.flush());                         // in a Worker: flush before the isolate goes away
//
// `capture` REFUSES an event that misses a required property, names an unknown class, or carries a key or a
// value that looks like personal data or a secret. It throws SchemaError / PrivacyError at the call site;
// nothing is corrected later in a query. `captureError` redacts instead of refusing, because an error must
// still be reported. `safeCapture` turns a refusal into `{ ok: false, error }` for paths that must not throw.

export const VERSION = '0.1.0';
export const SCHEMA = 'iii-telemetry-v1';
export const DEFAULT_HOST = 'https://us.i.posthog.com';

export const CLASSES = Object.freeze(['product', 'agent', 'error', 'health']);
export const ACTOR_TYPES = Object.freeze(['human', 'agent']);
export const ENVS = Object.freeze(['production', 'preview', 'development', 'test']);
export const REQUIRED_PROPS = Object.freeze(['venture_id', 'pillar', 'actor_type', 'actor_id', 'run_id', 'ticket', 'executor', 'env', 'class']);
export const STRING_PROPS = Object.freeze(['venture_id', 'pillar', 'actor_id', 'run_id', 'ticket', 'executor', 'env']);
export const AGENT_PROPS = Object.freeze(['model', 'provider', 'tokens_in', 'tokens_out', 'cost_usd', 'duration_ms']);
export const AGENT_NUMERIC_PROPS = Object.freeze(['tokens_in', 'tokens_out', 'cost_usd', 'duration_ms']);

// Section 4 of the standard: keys that never enter an event. Matched on the normalised key
// (lower case, `-` and spaces to `_`, a leading `$` removed). `tokens_in` / `tokens_out` are not tokens in
// this sense and are not matched.
export const FORBIDDEN_KEY_PATTERNS = Object.freeze([
  /(^|_)e_?mails?($|_)/,
  /(^|_)(phone|mobile|tel|telephone)(_|$)/,
  /^(body|html|text|message|message_body|subject|prompt|completion|content|transcript|raw)$/,
  /secret/,
  /passw(or)?d/,
  /api_?key/,
  /(^|_)token$/,
  /^(auth|authorization|auth_header|cookie|cookies|set_cookie|credential|credentials)$/,
  /^(ssn|social_security(_number)?|dob|date_of_birth|birth_?date|mrn|medical_record(_number)?)$/,
  /diagnos/,
  /^(street_|postal_|home_)?address(_line_?\d)?$/,
  /^(first|last|given|family|full|middle|legal)_?name$/,
]);

// Values that never enter an event, whatever the key: an email address, a bearer token, a provider key.
export const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: 'provider key', re: /\b(phc_|phx_|sk-ant-|sk-|sk_live_|sk_test_|rk_live_|ghp_|gho_|ghu_|github_pat_|xox[abpr]-|AKIA|AIza|SG\.)[A-Za-z0-9_\-.]{8,}/g },
]);

export class SchemaError extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'SchemaError'; Object.assign(this, detail); }
}
export class PrivacyError extends SchemaError {
  constructor(message, detail = {}) { super(message, detail); this.name = 'PrivacyError'; }
}

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const normaliseKey = (k) => String(k).toLowerCase().replace(/^\$/, '').replace(/[-\s]+/g, '_');

/** Every key or value in `obj` that section 4 forbids, as [{ path, reason }]. Walks nested objects and arrays four levels deep. */
export function findPrivacyViolations(obj, path = '', depth = 0) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const here = path ? `${path}.${k}` : k;
    const nk = normaliseKey(k);
    if (FORBIDDEN_KEY_PATTERNS.some((re) => re.test(nk))) { out.push({ path: here, reason: 'forbidden key' }); continue; }
    if (typeof v === 'string') {
      for (const { name, re } of FORBIDDEN_VALUE_PATTERNS) { re.lastIndex = 0; if (re.test(v)) { out.push({ path: here, reason: `value looks like an ${name}` }); break; } }
    } else if (v && typeof v === 'object' && depth < 4) {
      out.push(...findPrivacyViolations(v, here, depth + 1));
    }
  }
  return out;
}

/** Replace anything that looks like an email address, a bearer token or a provider key with `[redacted:<what>]`. */
export function redact(str) {
  let s = String(str ?? '');
  for (const { name, re } of FORBIDDEN_VALUE_PATTERNS) s = s.replace(re, `[redacted:${name.replace(/\s+/g, '-')}]`);
  return s;
}

/**
 * Validate `props` for `event` against the standard and return the full property set (defaults merged, `class`
 * resolved). Throws SchemaError (missing or wrong-typed properties, unknown class) or PrivacyError (forbidden key or value).
 * `options.defaults` fill properties the caller did not give (an `undefined` value counts as not given);
 * `options.events` maps an event name to its class so callers need not repeat it.
 */
export function validate(event, props = {}, options = {}) {
  if (typeof event !== 'string' || !event.trim()) throw new SchemaError('event name must be a non-empty string', { event });
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new SchemaError(`event "${event}": properties must be an object`, { event });
  const given = {};
  for (const [k, v] of Object.entries(props)) if (v !== undefined) given[k] = v;
  const p = { ...(options.defaults || {}), ...given };
  if (isBlank(p.class) && options.events && options.events[event]) p.class = options.events[event];
  const missing = REQUIRED_PROPS.filter((k) => isBlank(p[k]));
  if (missing.length) throw new SchemaError(`event "${event}" is missing required properties: ${missing.join(', ')}`, { event, missing });
  if (!CLASSES.includes(p.class)) throw new SchemaError(`event "${event}": unknown class "${p.class}"; expected one of ${CLASSES.join(', ')}`, { event, class: p.class });
  if (!ACTOR_TYPES.includes(p.actor_type)) throw new SchemaError(`event "${event}": actor_type must be one of ${ACTOR_TYPES.join(', ')}, got "${p.actor_type}"`, { event, actor_type: p.actor_type });
  for (const k of STRING_PROPS) if (typeof p[k] !== 'string') throw new SchemaError(`event "${event}": ${k} must be a string, got ${typeof p[k]}`, { event, key: k });
  if (p.class === 'agent') {
    const miss = AGENT_PROPS.filter((k) => isBlank(p[k]));
    if (miss.length) throw new SchemaError(`event "${event}" is class agent and is missing agent properties: ${miss.join(', ')}`, { event, missing: miss });
    for (const k of AGENT_NUMERIC_PROPS) if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0) throw new SchemaError(`event "${event}": ${k} must be a finite number >= 0, got ${JSON.stringify(p[k])}`, { event, key: k });
    for (const k of ['model', 'provider']) if (typeof p[k] !== 'string') throw new SchemaError(`event "${event}": ${k} must be a string`, { event, key: k });
  }
  const violations = findPrivacyViolations(p);
  if (violations.length) throw new PrivacyError(`event "${event}" carries data that never enters an event: ${violations.map((v) => `${v.path} (${v.reason})`).join(', ')}`, { event, violations });
  return p;
}

/** Parse a V8 stack into PostHog raw frames, oldest first (the last frame is where it threw). */
export function parseStack(stack, { platform = 'node', max = 50 } = {}) {
  const frames = [];
  for (const line of String(stack || '').split('\n')) {
    const m = line.match(/^\s*at\s+(?:(.*?)\s+\()?(?:(.+?):(\d+):(\d+))\)?\s*$/);
    if (!m) continue;
    const filename = redact(m[2]);
    frames.push({ platform, filename, function: m[1] || '<anonymous>', lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|node:internal|^node:/.test(filename) });
    if (frames.length >= max) break;
  }
  return frames.reverse();
}

/** Dollars for a call, from the provider's public list price: `rate = { input_per_million, output_per_million }` in USD. */
export function costUsd(tokensIn, tokensOut, rate) {
  if (!rate || typeof rate.input_per_million !== 'number' || typeof rate.output_per_million !== 'number') throw new SchemaError('costUsd needs rate { input_per_million, output_per_million } in USD from the provider\'s published price list');
  for (const [k, v] of [['tokens_in', tokensIn], ['tokens_out', tokensOut]]) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new SchemaError(`costUsd: ${k} must be a finite number >= 0`);
  return Math.round(((tokensIn * rate.input_per_million + tokensOut * rate.output_per_million) / 1e6) * 1e6) / 1e6;
}

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
}

/**
 * The default transport: PostHog's batch capture endpoint (`POST <host>/batch/`, the same route the official SDKs use),
 * body `{ api_key, sent_at, batch: [{ uuid, event, distinct_id, properties, timestamp }] }`. One retry on a network
 * error or a 5xx/429; a 4xx other than 408/429 is final. Throws on failure so the caller's `onError` sees it.
 */
export function postHogTransport({ key, host = DEFAULT_HOST, path = '/batch/', fetch: f = globalThis.fetch, timeoutMs = 10000, retries = 1 } = {}) {
  if (!key) throw new SchemaError('postHogTransport needs the project write key (POSTHOG_KEY)');
  if (typeof f !== 'function') throw new SchemaError('postHogTransport needs a fetch implementation');
  const url = String(host).replace(/\/$/, '') + path;
  return async function send(batch) {
    const body = JSON.stringify({ api_key: key, sent_at: new Date().toISOString(), batch: batch.map(({ uuid: id, event, distinct_id, properties, timestamp }) => ({ uuid: id, event, distinct_id, properties, timestamp })) });
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
        const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
        if (r.ok) return { status: r.status, events: batch.length };
        const text = await r.text().catch(() => '');
        last = new Error(`PostHog ${path} -> ${r.status} ${text.slice(0, 200)}`.trim());
        last.status = r.status;
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) break;
      } catch (e) { last = e; }
      if (attempt < retries) await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
    throw last;
  };
}

function defaultOnError(err, batch) {
  try { console.error(`[fleet-kit telemetry] ${(err && err.message) || err}${batch && batch.length ? ` (${batch.length} event(s) not sent)` : ''}`); } catch { /* nothing to do */ }
}

/**
 * Build a telemetry client.
 *   key              the pillar's PostHog project write key (required unless `transport` or `dryRun` is given)
 *   host             PostHog ingest host, default https://us.i.posthog.com
 *   defaults         properties stamped on every event when the caller does not give them (venture_id, pillar, env, executor, ...)
 *   events           { event_name: class } so callers need not repeat `class`
 *   transport        async (batch) => void; replaces the PostHog transport (tests, other sinks)
 *   dryRun           validate everything, send nothing
 *   batchSize        flush when this many events are queued (default 20)
 *   flushIntervalMs  flush this long after the first queued event (default 2000; 0 = only on flush() or a full batch)
 *   personProfiles   create PostHog person profiles for human actors' events (default false: every event is anonymous)
 *   distinctId       string or (event, props) => string; default the event's actor_id
 *   onError          (error, batch) => void; default console.error. Never throws into the caller.
 */
export function createTelemetry(options = {}) {
  const { key, host = DEFAULT_HOST, defaults = {}, events = {}, batchSize = 20, flushIntervalMs = 2000, personProfiles = false, distinctId, onError = defaultOnError, dryRun = false, now = () => new Date(), timeoutMs } = options;
  if (!(Number.isInteger(batchSize) && batchSize >= 1)) throw new SchemaError('createTelemetry: batchSize must be an integer >= 1');
  let transport = options.transport;
  if (typeof transport !== 'function') {
    if (dryRun) transport = async () => {};
    else transport = postHogTransport({ key, host, fetch: options.fetch, timeoutMs });
  }
  let queue = [];
  let timer = null;
  let flushing = null;

  function build(event, props) {
    const p = validate(event, props, { defaults, events });
    const sentAt = now().toISOString();
    const properties = { ...p, sent_at: sentAt, schema: SCHEMA, $lib: 'fleet-kit', $lib_version: VERSION };
    if (!(p.actor_type === 'human' && personProfiles)) properties.$process_person_profile = false;
    const did = typeof distinctId === 'function' ? distinctId(event, p) : (distinctId || p.actor_id);
    return { uuid: uuid(), event, distinct_id: String(did), timestamp: sentAt, properties };
  }

  async function enqueue(item) {
    queue.push(item);
    if (queue.length >= batchSize) { await flush(); return item; }
    if (flushIntervalMs > 0 && !timer) {
      timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushIntervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return item;
  }

  /** Validate and queue one event. Resolves to the queued { uuid, event, distinct_id, properties, timestamp }. Throws SchemaError / PrivacyError. */
  async function capture(event, props) { return enqueue(build(event, props)); }

  /** Like capture, but a refusal becomes { ok: false, error } (reported to onError) instead of a throw. */
  async function safeCapture(event, props) {
    try { const item = await capture(event, props); return { ok: true, item }; } catch (error) { try { onError(error, []); } catch { /* ignore */ } return { ok: false, error }; }
  }

  /**
   * Report an error as PostHog's `$exception` (class error) so Error Tracking sees it, with `error_kind` naming the
   * failure (`job_failed`, `unhandled_error`, ... default the error's name). Message and stack are redacted, never refused.
   * Never throws; resolves { ok, item | error }.
   */
  async function captureError(err, props = {}) {
    const e = err instanceof Error ? err : new Error(String(err));
    const { error_kind, handled, ...rest } = props || {};
    const kind = error_kind || e.name || 'Error';
    const message = redact(e.message || String(e)).slice(0, 2000);
    const frames = parseStack(e.stack);
    const p = {
      ...rest,
      class: 'error',
      error_kind: kind,
      $exception_type: e.name || 'Error',
      $exception_message: message,
      $exception_level: 'error',
      $exception_list: [{ type: e.name || 'Error', value: message, mechanism: { handled: handled !== false, synthetic: false }, stacktrace: { type: 'raw', frames } }],
    };
    return safeCapture('$exception', p);
  }

  /** Send everything queued. Resolves { sent, failed, error? }; never throws. */
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (flushing) await flushing;
    const batch = queue;
    queue = [];
    if (!batch.length) return { sent: 0, failed: 0 };
    flushing = (async () => {
      try { await transport(batch); return { sent: batch.length, failed: 0 }; } catch (error) { try { onError(error, batch); } catch { /* ignore */ } return { sent: 0, failed: batch.length, error }; }
    })();
    try { return await flushing; } finally { flushing = null; }
  }

  return { capture, safeCapture, captureError, flush, close: flush, pending: () => queue.length, defaults: Object.freeze({ ...defaults }), VERSION, SCHEMA };
}
