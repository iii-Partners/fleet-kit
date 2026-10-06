// @iii-partners/fleet-kit · delivery-proof
//
// Prove that the email or SMS a pillar really sent really arrived, with the right content and working links
// (epic iii-eye#527). Mailosaur by direct fetch, no SDK, zero dependencies; Node 18+.
//
//   import { generateEmail, waitForEmail, extractCode, assertLinksResolve, assertNoPlaceholders } from '@iii-partners/fleet-kit/delivery-proof';
//   const to = generateEmail('invite');                          // <prefix>-<ts>-<rand>@<MAILOSAUR_SERVER_ID>.mailosaur.net
//   await app.invite(to);                                        // the REAL flow, against the deployed pillar
//   const msg = await waitForEmail(to, { subject: 'invited' });  // long-polls Mailosaur; throws naming what it waited for
//   assertNoPlaceholders(msg);                                   // {{, undefined, null, TODO, [object Object], ...
//   await assertLinksResolve(msg, { skip: [/unsubscribe/] });    // every link answers 2xx and does not land on an error page
//   const code = extractCode(msg);                               // the 6-digit (or named-length) code
//
// Configuration: MAILOSAUR_API_KEY and MAILOSAUR_SERVER_ID in the environment, or configure({ apiKey, serverId }),
// or per call ({ apiKey, serverId }). Mailosaur is for testing OUR OWN sending only. It is never an identity:
// no account, subscription or login is registered to a Mailosaur inbox or number.

export const DEFAULT_BASE_URL = 'https://mailosaur.com/api';

export class DeliveryError extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'DeliveryError'; Object.assign(this, detail); }
}

const cfg = { apiKey: undefined, serverId: undefined, baseUrl: undefined, fetch: undefined };
const envVar = (name) => (globalThis.process && globalThis.process.env && globalThis.process.env[name]) || undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'utf8').toString('base64'));

/** Set module-wide defaults (apiKey, serverId, baseUrl, fetch). Returns the effective settings with the key masked. */
export function configure(opts = {}) {
  for (const k of Object.keys(cfg)) if (k in opts) cfg[k] = opts[k];
  return { serverId: cfg.serverId, baseUrl: cfg.baseUrl || DEFAULT_BASE_URL, apiKey: cfg.apiKey ? '(set)' : undefined };
}

function serverIdOf(opts = {}) {
  const id = opts.serverId || cfg.serverId || envVar('MAILOSAUR_SERVER_ID');
  if (!id) throw new DeliveryError('Mailosaur server not configured: set MAILOSAUR_SERVER_ID, or configure({ serverId }), or pass { serverId }');
  return id;
}
function settings(opts = {}) {
  const apiKey = opts.apiKey || cfg.apiKey || envVar('MAILOSAUR_API_KEY');
  if (!apiKey) throw new DeliveryError('Mailosaur not configured: set MAILOSAUR_API_KEY, or configure({ apiKey }), or pass { apiKey }');
  const f = opts.fetch || cfg.fetch || globalThis.fetch;
  if (typeof f !== 'function') throw new DeliveryError('no fetch implementation available');
  return { apiKey, serverId: serverIdOf(opts), baseUrl: String(opts.baseUrl || cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ''), fetch: f };
}
async function api(s, method, path, { query, body } = {}) {
  const url = new URL(s.baseUrl + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v instanceof Date ? v.toISOString() : String(v));
  const r = await s.fetch(url.toString(), { method, headers: { authorization: 'Basic ' + b64(s.apiKey + ':'), 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  return { status: r.status, ok: r.ok, json, text, headers: r.headers };
}

/** A fresh, unique address on the configured server: `<prefix>-<timestamp>-<random>@<serverId>.mailosaur.net`. */
export function generateEmail(prefix = 'test', opts = {}) {
  const serverId = serverIdOf(opts);
  const slug = String(prefix).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'test';
  return `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@${serverId}.mailosaur.net`;
}

const isMessage = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && ('html' in x || 'text' in x || 'subject' in x || 'from' in x);

/**
 * Long-poll Mailosaur for one message matching `criteria` ({ sentTo, sentFrom, subject, body, match }) the way the
 * official SDK does: POST /messages/search (one item, receivedAfter) until a hit, waiting the server's `x-ms-delay`
 * between polls, then GET the full message. Default receivedAfter: 5 minutes ago. Throws DeliveryError naming the
 * criteria, server and timeout when nothing arrives.
 */
export async function waitForMessage(criteria, opts = {}) {
  const s = settings(opts);
  const timeoutMs = opts.timeoutMs ?? 60000;
  const receivedAfter = opts.receivedAfter instanceof Date ? opts.receivedAfter : new Date(opts.receivedAfter || Date.now() - 5 * 60000);
  const start = Date.now();
  let poll = 0;
  for (;;) {
    const r = await api(s, 'POST', '/messages/search', { query: { server: s.serverId, page: 0, itemsPerPage: 1, receivedAfter }, body: criteria });
    if (!r.ok) throw new DeliveryError(`Mailosaur search on server ${s.serverId} -> ${r.status}: ${r.text.slice(0, 200)}`, { status: r.status });
    const items = (r.json && r.json.items) || [];
    if (items.length) {
      const full = await api(s, 'GET', `/messages/${items[0].id}`);
      if (!full.ok) throw new DeliveryError(`Mailosaur message ${items[0].id} -> ${full.status}: ${full.text.slice(0, 200)}`, { status: full.status });
      return decorate(full.json);
    }
    const pattern = String((r.headers && r.headers.get && r.headers.get('x-ms-delay')) || '1000').split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n >= 0);
    const delay = pattern.length ? pattern[Math.min(poll, pattern.length - 1)] : 1000;
    poll += 1;
    if (Date.now() - start + delay > timeoutMs) throw new DeliveryError(`no message matching ${JSON.stringify(criteria)} arrived on Mailosaur server ${s.serverId} within ${timeoutMs}ms (receivedAfter ${receivedAfter.toISOString()})`, { criteria, serverId: s.serverId, timeoutMs });
    await sleep(delay);
  }
}

/** Wait for the email sent to `sentTo` (optionally narrowed by subject / sentFrom / body). Returns the full Mailosaur message. */
export async function waitForEmail(sentTo, opts = {}) {
  if (!sentTo) throw new DeliveryError('waitForEmail needs the address the message was sent to');
  const { subject, sentFrom, body, match, ...rest } = opts;
  const criteria = { sentTo };
  if (subject) criteria.subject = subject;
  if (sentFrom) criteria.sentFrom = sentFrom;
  if (body) criteria.body = body;
  if (match) criteria.match = match;
  const m = await waitForMessage(criteria, rest);
  if (m.type && String(m.type).toLowerCase() !== 'email') throw new DeliveryError(`expected an email to ${sentTo}, got a ${m.type}`, { received: m });
  return m;
}

/**
 * Wait for the SMS sent to `phone` (E.164, the Mailosaur number that belongs to the server). Mailosaur has no API that
 * lists a server's numbers: take it from MAILOSAUR_PHONE_NUMBER (or pass it in). Returns the full message; the code is
 * `extractCode(msg)`.
 */
export async function waitForSms(phone, opts = {}) {
  const number = phone || envVar('MAILOSAUR_PHONE_NUMBER');
  if (!number) throw new DeliveryError('waitForSms needs the Mailosaur phone number the SMS was sent to (MAILOSAUR_PHONE_NUMBER)');
  const { body, match, ...rest } = opts;
  const criteria = { sentTo: number };
  if (body) criteria.body = body;
  if (match) criteria.match = match;
  const m = await waitForMessage(criteria, rest);
  if (m.type && String(m.type).toLowerCase() !== 'sms') throw new DeliveryError(`expected an SMS to ${number}, got a ${m.type}`, { received: m });
  return m;
}

function decorate(m) {
  if (!m || typeof m !== 'object') return m;
  const text = (m.text && m.text.body) || '';
  const html = (m.html && m.html.body) || '';
  m.bodyText = text || stripHtml(html);
  return m;
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n.toLowerCase()]);
}
function safeChar(n) { try { return String.fromCodePoint(n); } catch { return ''; } }

/** Visible text of an HTML body: no style/script/comments/tags, entities decoded, whitespace collapsed. */
export function stripHtml(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** The readable text of a message (subject, text body, visible HTML text) or of a string (HTML stripped when it has tags). */
export function textOf(input) {
  if (isMessage(input)) return [input.subject || '', (input.text && input.text.body) || '', stripHtml((input.html && input.html.body) || '')].filter(Boolean).join('\n');
  const s = String(input ?? '');
  return /<[a-z][\s\S]*>/i.test(s) ? stripHtml(s) : s;
}

/**
 * Every http(s) link in a message or a string, deduped, in order. For HTML: every `href` plus bare URLs in the VISIBLE text
 * (never the DOCTYPE, `xmlns` or CSS `url()` addresses that live only in the markup); for plain text: bare URLs. For a
 * Mailosaur message, Mailosaur's own parsed links come first.
 */
export function extractLinks(input) {
  const out = [];
  const add = (u) => {
    if (!u) return;
    let v = decodeEntities(String(u).trim()).replace(/[.,;:!?)\]]+$/, '');
    if (!/^https?:\/\//i.test(v)) return;
    if (!out.includes(v)) out.push(v);
  };
  const BARE = /https?:\/\/[^\s"'<>()[\]]+/gi;
  const scanText = (s) => { if (!s) return; for (const m of String(s).matchAll(BARE)) add(m[0]); };
  const scanMarkup = (html) => {
    if (!html) return;
    for (const m of String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
    scanText(stripHtml(html));
  };
  if (isMessage(input)) {
    for (const l of (input.html && input.html.links) || []) add(l && l.href);
    for (const l of (input.text && input.text.links) || []) add(l && l.href);
    scanMarkup(input.html && input.html.body);
    scanText(input.text && input.text.body);
  } else {
    const s = String(input ?? '');
    if (/<[a-z!][\s\S]*>/i.test(s)) scanMarkup(s); else scanText(s);
  }
  return out;
}

/**
 * The verification code in a message or a string: Mailosaur's parsed codes first, then a 6-digit code (or `length` digits),
 * then "verification code is X", "code: X". Returns the code as a string, or null.
 */
export function extractCode(input, { length } = {}) {
  const want = length ? new RegExp(`^\\d{${length}}$`) : null;
  if (isMessage(input)) {
    const codes = [...((input.html && input.html.codes) || []), ...((input.text && input.text.codes) || [])].map((c) => c && c.value).filter(Boolean).map(String);
    const hit = want ? codes.find((c) => want.test(c)) : codes[0];
    if (hit) return hit;
  }
  const text = textOf(input);
  const patterns = [
    length ? new RegExp(`\\b(\\d{${length}})\\b`) : /\b(\d{6})\b/,
    /\bverification\s+code\s+(?:is\s*)?:?\s*([A-Za-z0-9]{4,8})\b/i,
    /\bcode\s*(?:is|:)\s*([A-Za-z0-9]{4,8})\b/i,
    /\b(?:one[- ]time|OTP|passcode|security code|PIN)\D{0,24}?(\d{4,8})\b/i,
  ];
  for (const re of patterns) { const m = text.match(re); if (m) return m[1]; }
  return null;
}

/** The ways a template leaks into a real message. `structural` patterns are also checked in the raw HTML (attributes, hrefs). */
export const PLACEHOLDER_PATTERNS = Object.freeze([
  { name: 'mustache {{ }}', re: /\{\{|\}\}/, structural: true },
  { name: 'template tag {% %} / <% %>', re: /\{%|%\}|<%|%>/, structural: true },
  { name: 'js template ${ }', re: /\$\{[^}]*\}/, structural: true },
  { name: '[object Object]', re: /\[object Object\]/, structural: true },
  { name: 'undefined', re: /\bundefined\b/ },
  { name: 'null', re: /\bnull\b/ },
  { name: 'NaN', re: /\bNaN\b/ },
  { name: 'Invalid Date', re: /\bInvalid Date\b/ },
  { name: 'TODO', re: /\bTODO\b/ },
  { name: 'TBD', re: /\bTBD\b/ },
  { name: 'FIXME', re: /\bFIXME\b/ },
  { name: 'lorem ipsum', re: /\blorem ipsum\b/i },
]);

/**
 * Throw DeliveryError if any placeholder pattern appears in the message's subject, text body, visible HTML text or any
 * link URL (or in the string given); the structural patterns ({{, [object Object], ...) are also checked in the raw HTML. `allow` names patterns to skip (e.g. 'TBD'); `extra` adds strings or RegExps of your own.
 */
export function assertNoPlaceholders(input, { allow = [], extra = [] } = {}) {
  const patterns = [
    ...PLACEHOLDER_PATTERNS.filter((p) => !allow.includes(p.name)),
    ...extra.map((e) => (e instanceof RegExp ? { name: String(e), re: e, structural: true } : { name: String(e), re: new RegExp(String(e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), structural: true })),
  ];
  const texts = [];
  if (isMessage(input)) {
    texts.push({ where: 'subject', text: input.subject || '', raw: true });
    texts.push({ where: 'text body', text: (input.text && input.text.body) || '', raw: true });
    const html = (input.html && input.html.body) || '';
    texts.push({ where: 'html text', text: stripHtml(html), raw: false });
    texts.push({ where: 'html source', text: html, raw: false, structuralOnly: true });
    texts.push({ where: 'links', text: extractLinks(input).join('\n'), raw: true });
  } else {
    const s = String(input ?? '');
    const hasTags = /<[a-z][\s\S]*>/i.test(s);
    texts.push({ where: 'text', text: hasTags ? stripHtml(s) : s, raw: true });
    if (hasTags) { texts.push({ where: 'html source', text: s, structuralOnly: true }); texts.push({ where: 'links', text: extractLinks(s).join('\n'), raw: true }); }
  }
  const hits = [];
  for (const p of patterns) {
    for (const t of texts) {
      if (t.structuralOnly && !p.structural) continue;
      const re = new RegExp(p.re.source, p.re.flags.replace('g', ''));
      const m = re.exec(t.text);
      if (!m) continue;
      const at = m.index;
      const ctx = t.text.slice(Math.max(0, at - 30), at + m[0].length + 30).replace(/\s+/g, ' ');
      hits.push({ name: p.name, where: t.where, match: m[0], context: ctx });
    }
  }
  if (hits.length) throw new DeliveryError(`placeholder text in message: ${hits.map((h) => `${h.name} in ${h.where} ("...${h.context}...")`).join('; ')}`, { hits });
}

/**
 * Fetch every link (GET, redirects followed) and throw DeliveryError naming each one that fails: a non-2xx final status,
 * a network error that repeats (`retries`, default one retry), a 429/503 that persists through `laterAttempts` (default 3,
 * waiting Retry-After or 5 s, 10 s, capped at `retryAfterCapMs`; any other status is final at once), or a redirect that
 * lands on an error-looking URL. Use `concurrency: 1` against a rate-limited host. `skip` (strings or RegExps) excludes links that
 * must not be consumed by a probe (one-time magic links, unsubscribe). Resolves [{ url, status, final, redirected, ok }].
 */
export async function assertLinksResolve(input, { skip = [], timeoutMs = 10000, fetch: f = globalThis.fetch, concurrency = 4, errorPagePattern = /\/(error|not-?found|404|expired|invalid|unavailable)(\/|\?|#|$)/i, allowStatus = [], retries = 1, laterAttempts = 3, retryAfterCapMs = 15000 } = {}) {
  const links = extractLinks(input).filter((l) => !skip.some((s) => (s instanceof RegExp ? s.test(l) : l.includes(String(s)))));
  const results = [];
  let i = 0;
  async function worker() {
    while (i < links.length) {
      const url = links[i++];
      for (let attempt = 0; ; attempt++) {
        try {
          const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
          const r = await f(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': 'iii-partners fleet-kit delivery-proof', accept: '*/*' }, signal });
          try { if (r.body && typeof r.body.cancel === 'function') await r.body.cancel(); } catch { /* ignore */ }
          const final = r.url || url;
          // 429 / 503 mean "later", not "broken": wait Retry-After (capped) and try again; persistent, they fail by status.
          if ((r.status === 429 || r.status === 503) && attempt < Math.max(retries, laterAttempts - 1)) { const ra = Number(r.headers && r.headers.get && r.headers.get('retry-after')); await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000 * (attempt + 1), retryAfterCapMs)); continue; }
          const ok = ((r.status >= 200 && r.status < 300) || allowStatus.includes(r.status)) && !(r.redirected && errorPagePattern.test(final));
          results.push({ url, status: r.status, final, redirected: !!r.redirected, ok, attempts: attempt + 1, reason: ok ? undefined : (r.status >= 200 && r.status < 300 ? `redirected to an error page ${final}` : `${r.status}${attempt ? ` after ${attempt + 1} attempt(s)` : ''}`) });
          break;
        } catch (e) {
          // A network-level failure (reset, DNS, timeout) is not a broken link until it happens twice; a status is never retried.
          if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
          const cause = e && e.cause && (e.cause.code || e.cause.message);
          results.push({ url, status: 0, final: url, redirected: false, ok: false, attempts: attempt + 1, reason: `${(e && e.message) || String(e)}${cause ? ` (${cause})` : ''} after ${attempt + 1} attempt(s)` });
          break;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, links.length)) }, worker));
  const bad = results.filter((r) => !r.ok);
  if (bad.length) throw new DeliveryError(`${bad.length} link(s) did not resolve: ${bad.map((b) => `${b.url} -> ${b.reason}`).join('; ')}`, { results });
  return results;
}

/** Sender checks: email (exact, case-insensitive), name (contains) or domain (the part after @). Throws DeliveryError. */
export function assertSender(message, { email, name, domain } = {}) {
  const from = (message && message.from && message.from[0]) || {};
  if (email && String(from.email || '').toLowerCase() !== String(email).toLowerCase()) throw new DeliveryError(`expected sender ${email}, got ${from.email || '(none)'}`);
  if (domain && !String(from.email || '').toLowerCase().endsWith('@' + String(domain).toLowerCase())) throw new DeliveryError(`expected sender domain ${domain}, got ${from.email || '(none)'}`);
  if (name && !String(from.name || '').includes(name)) throw new DeliveryError(`expected sender name to include "${name}", got "${from.name || ''}"`);
}
/** Throws unless the subject contains `includes` (string, case-insensitive) or matches it (RegExp). */
export function assertSubject(message, includes) {
  const subject = (message && message.subject) || '';
  const ok = includes instanceof RegExp ? includes.test(subject) : subject.toLowerCase().includes(String(includes).toLowerCase());
  if (!ok) throw new DeliveryError(`expected subject to include "${includes}", got "${subject}"`);
}
/** Throws unless the message was addressed to `email` (or, for SMS, to `phone`). */
export function assertRecipient(message, addr) {
  const to = ((message && message.to) || []).map((t) => String(t.email || t.phone || '').toLowerCase());
  if (!to.includes(String(addr).toLowerCase())) throw new DeliveryError(`expected recipient ${addr}, got ${to.join(', ') || '(none)'}`);
}
/** Throws unless the readable text of the message contains `text` (case-insensitive) or matches it (RegExp). */
export function assertContains(message, text) {
  const body = textOf(message);
  const ok = text instanceof RegExp ? text.test(body) : body.toLowerCase().includes(String(text).toLowerCase());
  if (!ok) throw new DeliveryError(`expected message to contain "${text}"; first 300 chars: ${body.slice(0, 300)}`);
}

/** Delete one message (DELETE /messages/:id). */
export async function deleteMessage(id, opts = {}) {
  const s = settings(opts);
  const r = await api(s, 'DELETE', `/messages/${id}`);
  if (!r.ok && r.status !== 204) throw new DeliveryError(`Mailosaur delete ${id} -> ${r.status}: ${r.text.slice(0, 200)}`);
}
/** Delete every message on the server (DELETE /messages?server=). Use in teardown; never on a shared server mid-run. */
export async function deleteAllMessages(opts = {}) {
  const s = settings(opts);
  const r = await api(s, 'DELETE', '/messages', { query: { server: s.serverId } });
  if (!r.ok && r.status !== 204) throw new DeliveryError(`Mailosaur delete all on ${s.serverId} -> ${r.status}: ${r.text.slice(0, 200)}`);
}
/** The server record (GET /servers/:id). */
export async function serverInfo(opts = {}) {
  const s = settings(opts);
  const r = await api(s, 'GET', `/servers/${s.serverId}`);
  if (!r.ok) throw new DeliveryError(`Mailosaur server ${s.serverId} -> ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json;
}
/** Recent messages on the server (GET /messages?server=), newest first. */
export async function listMessages(opts = {}) {
  const s = settings(opts);
  const r = await api(s, 'GET', '/messages', { query: { server: s.serverId, page: 0, itemsPerPage: opts.itemsPerPage || 20, receivedAfter: opts.receivedAfter } });
  if (!r.ok) throw new DeliveryError(`Mailosaur list on ${s.serverId} -> ${r.status}: ${r.text.slice(0, 200)}`);
  return (r.json && r.json.items) || [];
}
