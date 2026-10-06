// The kit's own tests for the telemetry entry point. node --test; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createTelemetry, validate, redact, parseStack, costUsd, postHogTransport, findPrivacyViolations, REQUIRED_PROPS, AGENT_PROPS, CLASSES, SchemaError, PrivacyError, VERSION, SCHEMA } from '../telemetry/index.js';

const full = { venture_id: 'iii-partners', pillar: 'eye', actor_type: 'agent', actor_id: 'harness', run_id: 'r1', ticket: 'https://github.com/iii-Partners/iii-eye/issues/528', executor: 'e2b', env: 'test', class: 'health' };
const sink = () => { const sent = []; return { sent, transport: async (b) => { sent.push(...b); } }; };

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(SCHEMA, 'iii-telemetry-v1');
});

test('the constants are the standard', () => {
  assert.deepEqual([...REQUIRED_PROPS], ['venture_id', 'pillar', 'actor_type', 'actor_id', 'run_id', 'ticket', 'executor', 'env', 'class']);
  assert.deepEqual([...AGENT_PROPS], ['model', 'provider', 'tokens_in', 'tokens_out', 'cost_usd', 'duration_ms']);
  assert.deepEqual([...CLASSES], ['product', 'agent', 'error', 'health']);
});

test('a missing required property is refused by name', async () => {
  const t = createTelemetry({ transport: async () => {} });
  for (const k of REQUIRED_PROPS) {
    await assert.rejects(() => t.capture('health_run', { ...full, [k]: undefined }), (e) => e instanceof SchemaError && e.message.includes(k) && e.missing.includes(k), `missing ${k}`);
    await assert.rejects(() => t.capture('health_run', { ...full, [k]: '' }), SchemaError, `blank ${k}`);
  }
  assert.equal(t.pending(), 0);
});

test('an unknown class and a bad actor_type are refused', async () => {
  const t = createTelemetry({ transport: async () => {} });
  await assert.rejects(() => t.capture('x', { ...full, class: 'party' }), (e) => e instanceof SchemaError && /party/.test(e.message));
  await assert.rejects(() => t.capture('x', { ...full, actor_type: 'robot' }), (e) => e instanceof SchemaError && /actor_type/.test(e.message));
  await assert.rejects(() => t.capture('', full), SchemaError);
  await assert.rejects(() => t.capture('x', 'nope'), SchemaError);
});

test('an agent event needs the six agent properties, numeric and non-negative', async () => {
  const t = createTelemetry({ transport: async () => {} });
  await assert.rejects(() => t.capture('copilot_turn', { ...full, class: 'agent' }), (e) => e instanceof SchemaError && /model/.test(e.message) && /tokens_in/.test(e.message));
  const agent = { ...full, class: 'agent', model: 'claude-fable-5-1', provider: 'anthropic', tokens_in: 120, tokens_out: 40, cost_usd: 0.0012, duration_ms: 900 };
  await assert.rejects(() => t.capture('copilot_turn', { ...agent, tokens_in: '120' }), (e) => /tokens_in/.test(e.message));
  await assert.rejects(() => t.capture('copilot_turn', { ...agent, cost_usd: -1 }), (e) => /cost_usd/.test(e.message));
  await assert.rejects(() => t.capture('copilot_turn', { ...agent, duration_ms: NaN }), (e) => /duration_ms/.test(e.message));
  const item = await t.capture('copilot_turn', agent);
  assert.equal(item.properties.class, 'agent');
  assert.equal(item.properties.model, 'claude-fable-5-1');
});

test('defaults fill what the caller did not give; the event map supplies class', async () => {
  const { sent, transport } = sink();
  const t = createTelemetry({ transport, defaults: { venture_id: 'iii-partners', pillar: 'eye', env: 'test', executor: 'cloudflare-worker', actor_type: 'agent', actor_id: 'cron' }, events: { health_run: 'health' } });
  await t.capture('health_run', { run_id: 'h1', ticket: 'none', pillars_up: 7, venture_id: undefined });
  await t.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].properties.venture_id, 'iii-partners');
  assert.equal(sent[0].properties.class, 'health');
  assert.equal(sent[0].properties.pillars_up, 7);
  assert.equal(sent[0].distinct_id, 'cron');
  assert.equal(sent[0].properties.$process_person_profile, false);
});

test('a complete event is transported once with every required prop, sent_at, schema and lib stamps', async () => {
  const { sent, transport } = sink();
  const t = createTelemetry({ transport });
  const item = await t.capture('health_run', full);
  assert.equal(t.pending(), 1);
  const r = await t.flush();
  assert.deepEqual(r, { sent: 1, failed: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'health_run');
  assert.equal(sent[0].uuid, item.uuid);
  for (const p of REQUIRED_PROPS) assert.ok(p in sent[0].properties, p);
  assert.match(sent[0].properties.sent_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(sent[0].properties.schema, 'iii-telemetry-v1');
  assert.equal(sent[0].properties.$lib, 'fleet-kit');
  assert.equal(sent[0].properties.$lib_version, VERSION);
  assert.equal(sent[0].timestamp, sent[0].properties.sent_at);
  assert.deepEqual(await t.flush(), { sent: 0, failed: 0 });
});

test('batching: a full batch flushes itself; the interval flushes a partial one', async () => {
  const calls = [];
  const t = createTelemetry({ transport: async (b) => { calls.push(b.length); }, batchSize: 2, flushIntervalMs: 30 });
  await t.capture('a', full);
  await t.capture('b', full);
  assert.deepEqual(calls, [2]);
  await t.capture('c', full);
  assert.equal(t.pending(), 1);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(calls, [2, 1]);
  assert.equal(t.pending(), 0);
});

test('a transport failure is reported to onError and counted, never thrown into the caller', async () => {
  const errors = [];
  const t = createTelemetry({ transport: async () => { throw new Error('boom'); }, onError: (e, b) => errors.push([e.message, b.length]) });
  await t.capture('health_run', full);
  const r = await t.flush();
  assert.equal(r.sent, 0);
  assert.equal(r.failed, 1);
  assert.equal(r.error.message, 'boom');
  assert.deepEqual(errors, [['boom', 1]]);
});

test('privacy: forbidden keys and values are refused, naming the path; tokens_in is not a token', () => {
  const bad = [
    [{ email: 'a@b.co' }, 'email'], [{ user_email: 'x' }, 'user_email'], [{ phone_number: '1' }, 'phone_number'], [{ body: 'hi' }, 'body'],
    [{ subject: 'x' }, 'subject'], [{ api_key: 'x' }, 'api_key'], [{ token: 'x' }, 'token'], [{ access_token: 'x' }, 'access_token'],
    [{ 'client-secret': 'x' }, 'client-secret'], [{ password: 'x' }, 'password'], [{ authorization: 'x' }, 'authorization'], [{ cookie: 'x' }, 'cookie'],
    [{ dob: '1' }, 'dob'], [{ first_name: 'x' }, 'first_name'], [{ address: 'x' }, 'address'], [{ diagnosis: 'x' }, 'diagnosis'],
    [{ nested: { contact: { email: 'x' } } }, 'nested.contact.email'],
  ];
  for (const [props, path] of bad) {
    assert.throws(() => validate('x', { ...full, ...props }), (e) => e instanceof PrivacyError && e.violations.some((v) => v.path === path && v.reason === 'forbidden key'), `key ${path}`);
  }
  assert.throws(() => validate('x', { ...full, recipient: 'someone@example.com' }), (e) => e instanceof PrivacyError && /recipient/.test(e.message) && /email address/.test(e.message));
  assert.throws(() => validate('x', { ...full, note: 'Authorization: Bearer abcdefghijklmnop' }), (e) => e instanceof PrivacyError && /bearer token/.test(e.message));
  assert.throws(() => validate('x', { ...full, note: 'key phc_abcdefghijklmnopqrstuvwxyz' }), (e) => e instanceof PrivacyError && /provider key/.test(e.message));
  assert.throws(() => validate('x', { ...full, note: 'sk-ant-api03-abcdefghijklmnop' }), PrivacyError);
  const ok = validate('copilot_turn', { ...full, class: 'agent', model: 'claude-fable-5-1', provider: 'anthropic', tokens_in: 1, tokens_out: 2, cost_usd: 0, duration_ms: 3, task: 'task-12345678', duty_name: 'Weekly digest', $exception_message: 'fine' });
  assert.equal(ok.tokens_in, 1);
  assert.deepEqual(findPrivacyViolations({ tokens_in: 1, tokens_out: 2, ticket: 'https://github.com/iii-Partners/iii-eye/issues/1' }), []);
});

test('redact replaces emails, bearer tokens and provider keys and leaves the rest', () => {
  const s = redact('mail scott@example.com with Bearer abcdefghijklmnop and phc_abcdefghijklmnopqrstuvwxyz, ticket #12');
  assert.ok(!/example\.com/.test(s) && !/abcdefghijklmnop/.test(s), s);
  assert.match(s, /\[redacted:email-address\]/);
  assert.match(s, /\[redacted:bearer-token\]/);
  assert.match(s, /\[redacted:provider-key\]/);
  assert.match(s, /ticket #12$/);
});

test('captureError reports $exception (class error) with error_kind, a redacted message and raw frames; never throws', async () => {
  const { sent, transport } = sink();
  const t = createTelemetry({ transport, defaults: { ...full } });
  const err = new TypeError('cannot reach scott@example.com with token phc_abcdefghijklmnopqrstuvwxyz');
  const r = await t.captureError(err, { error_kind: 'job_failed', ticket: 'none' });
  assert.equal(r.ok, true, r.error && r.error.message);
  await t.flush();
  assert.equal(sent.length, 1);
  const p = sent[0].properties;
  assert.equal(sent[0].event, '$exception');
  assert.equal(p.class, 'error');
  assert.equal(p.error_kind, 'job_failed');
  assert.equal(p.$exception_type, 'TypeError');
  assert.ok(!/example\.com|abcdefghijklmnop/.test(p.$exception_message), p.$exception_message);
  assert.equal(p.$exception_list[0].type, 'TypeError');
  assert.equal(p.$exception_list[0].stacktrace.type, 'raw');
  assert.ok(p.$exception_list[0].stacktrace.frames.length > 0);
  assert.equal(p.$exception_list[0].mechanism.handled, true);
  assert.equal(p.ticket, 'none');
  const r2 = await t.captureError('plain string failure');
  assert.equal(r2.ok, true);
  const bare = createTelemetry({ transport, onError: () => {} });
  const r3 = await bare.captureError(new Error('x'));
  assert.equal(r3.ok, false);
  assert.ok(r3.error instanceof SchemaError);
});

test('safeCapture turns a refusal into { ok: false, error } and reports it', async () => {
  const errors = [];
  const t = createTelemetry({ transport: async () => {}, onError: (e) => errors.push(e) });
  const r = await t.safeCapture('x', { ...full, venture_id: undefined });
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof SchemaError);
  assert.equal(errors.length, 1);
  const r2 = await t.safeCapture('x', full);
  assert.equal(r2.ok, true);
});

test('parseStack yields oldest-first frames with in_app set', () => {
  const stack = 'Error: x\n    at inner (/app/src/a.js:10:5)\n    at outer (/app/node_modules/lib/b.js:20:7)\n    at /app/src/c.js:30:9';
  const frames = parseStack(stack);
  assert.equal(frames.length, 3);
  assert.equal(frames[2].function, 'inner');
  assert.equal(frames[2].lineno, 10);
  assert.equal(frames[1].in_app, false);
  assert.equal(frames[0].function, '<anonymous>');
  assert.deepEqual(parseStack(undefined), []);
});

test('costUsd prices tokens at the given list rate', () => {
  assert.equal(costUsd(1_000_000, 0, { input_per_million: 3, output_per_million: 15 }), 3);
  assert.equal(costUsd(1000, 2000, { input_per_million: 3, output_per_million: 15 }), 0.033);
  assert.throws(() => costUsd(1, 1, {}), SchemaError);
  assert.throws(() => costUsd(-1, 1, { input_per_million: 1, output_per_million: 1 }), SchemaError);
});

test('createTelemetry needs a key, a transport or dryRun; dryRun validates and sends nothing', async () => {
  assert.throws(() => createTelemetry({}), (e) => e instanceof SchemaError && /POSTHOG_KEY/.test(e.message));
  assert.throws(() => createTelemetry({ transport: async () => {}, batchSize: 0 }), SchemaError);
  const t = createTelemetry({ dryRun: true });
  await t.capture('health_run', full);
  assert.deepEqual(await t.flush(), { sent: 1, failed: 0 });
});

test('postHogTransport posts {api_key, sent_at, batch} to /batch/, retries a 5xx once, gives up on a 4xx', async () => {
  const seen = [];
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      if (mode === 'flaky' && seen.length === 1) { res.writeHead(503); res.end('busy'); return; }
      if (mode === 'reject') { res.writeHead(401); res.end('{"detail":"bad key"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"Ok"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const host = 'http://127.0.0.1:' + srv.address().port;
  try {
    const t = createTelemetry({ key: 'phc_test', host, flushIntervalMs: 0 });
    await t.capture('health_run', full);
    assert.deepEqual(await t.flush(), { sent: 1, failed: 0 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/batch/');
    assert.equal(seen[0].body.api_key, 'phc_test');
    assert.match(seen[0].body.sent_at, /^\d{4}-/);
    assert.equal(seen[0].body.batch.length, 1);
    assert.equal(seen[0].body.batch[0].event, 'health_run');
    assert.equal(seen[0].body.batch[0].distinct_id, 'harness');
    assert.equal(seen[0].body.batch[0].properties.venture_id, 'iii-partners');
    assert.ok(seen[0].body.batch[0].uuid);

    seen.length = 0; mode = 'flaky';
    const send = postHogTransport({ key: 'k', host, retries: 1 });
    await send([{ uuid: 'u', event: 'e', distinct_id: 'd', properties: {}, timestamp: 't' }]);
    assert.equal(seen.length, 2, 'one retry after the 503');

    seen.length = 0; mode = 'reject';
    const errors = [];
    const t2 = createTelemetry({ key: 'k', host, flushIntervalMs: 0, onError: (e) => errors.push(e) });
    await t2.capture('health_run', full);
    const r = await t2.flush();
    assert.equal(r.failed, 1);
    assert.equal(seen.length, 1, 'a 401 is final');
    assert.match(errors[0].message, /401/);
  } finally { srv.close(); }
});
