// The kit's own tests for the delivery-proof entry point. node --test; the only servers are local ones started here
// (a fake Mailosaur for the polling protocol, a plain HTTP server for links). The kit itself is never stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configure, generateEmail, waitForEmail, waitForSms, waitForMessage, extractCode, extractLinks, assertLinksResolve, assertNoPlaceholders, assertSender, assertSubject, assertRecipient, assertContains, stripHtml, textOf, DeliveryError, PLACEHOLDER_PATTERNS } from '../delivery-proof/index.js';

function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: 'http://127.0.0.1:' + srv.address().port })));
}
const msgFixture = (over = {}) => ({
  id: 'm1', type: 'Email', server: 'abcd1234', subject: 'Your code is 482913', received: '2026-10-06T12:00:00Z',
  from: [{ email: 'no-reply@eye.iii.partners', name: 'EYE' }], to: [{ email: 'invite-1-x@abcd1234.mailosaur.net' }],
  html: { body: '<html><style>.a{color:red}</style><body><p>Hi Scott,</p><p>Your code is <b>482913</b>. <a href="https://eye.iii.partners/x?y=1&amp;z=2">Open</a></p></body></html>', links: [{ href: 'https://eye.iii.partners/x?y=1&z=2', text: 'Open' }], codes: [{ value: '482913' }] },
  text: { body: 'Hi Scott, your code is 482913. Open https://eye.iii.partners/x?y=1&z=2 or https://example.com/plain.', links: [{ href: 'https://eye.iii.partners/x?y=1&z=2' }, { href: 'https://example.com/plain' }], codes: [{ value: '482913' }] },
  ...over,
});

test('generateEmail: unique, on the configured server, slugged prefix; refuses without a server id', () => {
  delete process.env.MAILOSAUR_SERVER_ID;
  configure({ serverId: undefined, apiKey: undefined, baseUrl: undefined });
  assert.throws(() => generateEmail('x'), (e) => e instanceof DeliveryError && /MAILOSAUR_SERVER_ID/.test(e.message));
  const a = generateEmail('Invite Flow', { serverId: 'abcd1234' });
  const b = generateEmail('Invite Flow', { serverId: 'abcd1234' });
  assert.match(a, /^invite-flow-\d+-[a-z0-9]+@abcd1234\.mailosaur\.net$/);
  assert.notEqual(a, b);
  process.env.MAILOSAUR_SERVER_ID = 'envserv1';
  assert.match(generateEmail(), /^test-\d+-[a-z0-9]+@envserv1\.mailosaur\.net$/);
  delete process.env.MAILOSAUR_SERVER_ID;
});

test('assertNoPlaceholders rejects every way a template leaks and passes clean copy', () => {
  const bad = ['Hi {{first_name}}, welcome', 'Hello undefined, your code is 123', 'Your plan: [object Object]', 'TODO: write subject', 'Dear null', 'Total: NaN', 'Starts Invalid Date', 'Price ${price}', '<p>Hi {% name %}</p>', 'Lorem ipsum dolor', 'Agenda TBD', 'FIXME later'];
  for (const b of bad) assert.throws(() => assertNoPlaceholders(b), (e) => e instanceof DeliveryError && e.hits.length > 0, 'must reject: ' + JSON.stringify(b));
  assertNoPlaceholders('Hi Scott, welcome to EYE. Your code is 482913.');
  assertNoPlaceholders('<p>Annulled contracts are nullified</p>');
  assertNoPlaceholders('Agenda TBD', { allow: ['TBD'] });
  assert.throws(() => assertNoPlaceholders('Dear ACME_PLACEHOLDER', { extra: ['ACME_PLACEHOLDER'] }), DeliveryError);
  assert.throws(() => assertNoPlaceholders('see {{{x}}}', { allow: PLACEHOLDER_PATTERNS.map((p) => p.name), extra: [/\{\{\{/] }), DeliveryError);
  const e = (() => { try { assertNoPlaceholders(msgFixture({ subject: 'Hello {{name}}' })); } catch (err) { return err; } })();
  assert.ok(e instanceof DeliveryError);
  assert.match(e.message, /mustache .* in subject/);
  assert.throws(() => assertNoPlaceholders(msgFixture({ html: { body: '<a href="https://x.y/?u=undefined">x</a>' } })), (e2) => /undefined/.test(e2.message) && /links/.test(e2.message), 'link urls are checked for leaked values');
  assert.throws(() => assertNoPlaceholders(msgFixture({ html: { body: '<a href="https://x.y/{{token}}">open</a>' } })), (e2) => /mustache/.test(e2.message) && /html source/.test(e2.message), 'structural patterns are checked in the raw html');
  assertNoPlaceholders(msgFixture());
});

test('extractCode: Mailosaur codes first, then 6 digits, named length, "code is", "code:"', () => {
  assert.equal(extractCode(msgFixture()), '482913');
  assert.equal(extractCode(msgFixture({ html: { codes: [{ value: '1234' }, { value: '98765432' }] }, text: { codes: [] } }), { length: 8 }), '98765432');
  assert.equal(extractCode('Your verification code is 482913. It expires in 10 minutes.'), '482913');
  assert.equal(extractCode('Use code 1234 to continue', { length: 4 }), '1234');
  assert.equal(extractCode('Your verification code is AB7K9Q.'), 'AB7K9Q');
  assert.equal(extractCode('Code: X9Y8Z7'), 'X9Y8Z7');
  assert.equal(extractCode('Your one-time passcode is 55443.'), '55443');
  assert.equal(extractCode('<p>Your code is <b>713501</b></p>'), '713501');
  assert.equal(extractCode('no code here'), null);
});

test('extractLinks: href and bare links, entities decoded, deduped, http(s) only, trailing punctuation dropped', () => {
  const links = extractLinks('<a href="https://eye.iii.partners/x?y=1&amp;z=2">open</a> and https://example.com/plain. Also mailto:a@b.co and tel:123 and https://eye.iii.partners/x?y=1&z=2');
  assert.deepEqual(links, ['https://eye.iii.partners/x?y=1&z=2', 'https://example.com/plain']);
  assert.deepEqual(extractLinks(msgFixture()), ['https://eye.iii.partners/x?y=1&z=2', 'https://example.com/plain']);
  assert.deepEqual(extractLinks(''), []);
  assert.deepEqual(extractLinks(null), []);
  const xhtml = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><style>.h{background:url(https://cdn.example.com/bg.png)}</style></head><body><a href="https://eye.iii.partners/accept">Accept</a><p>or copy https://eye.iii.partners/accept into your browser</p><img src="https://cdn.example.com/logo.png"></body></html>';
  assert.deepEqual(extractLinks(xhtml), ['https://eye.iii.partners/accept'], 'DOCTYPE, xmlns, css url() and img src are not links');
  assert.deepEqual(extractLinks(msgFixture({ html: { body: xhtml } })), ['https://eye.iii.partners/x?y=1&z=2', 'https://example.com/plain', 'https://eye.iii.partners/accept']);
});

test('stripHtml and textOf give the visible text', () => {
  assert.equal(stripHtml('<style>.a{}</style><p>Hi&nbsp;<b>there</b> &amp; you</p><br>next'), 'Hi there & you\nnext');
  assert.match(textOf(msgFixture()), /^Your code is 482913\nHi Scott, your code is 482913/);
  assert.equal(textOf('plain'), 'plain');
});

test('assert helpers: sender, subject, recipient, contains', () => {
  const m = msgFixture();
  assertSender(m, { email: 'NO-REPLY@eye.iii.partners', domain: 'eye.iii.partners', name: 'EYE' });
  assert.throws(() => assertSender(m, { email: 'x@y.z' }), DeliveryError);
  assert.throws(() => assertSender(m, { domain: 'example.com' }), DeliveryError);
  assertSubject(m, 'your code');
  assertSubject(m, /^Your code is \d{6}$/);
  assert.throws(() => assertSubject(m, 'invoice'), DeliveryError);
  assertRecipient(m, 'invite-1-x@abcd1234.mailosaur.net');
  assert.throws(() => assertRecipient(m, 'other@abcd1234.mailosaur.net'), DeliveryError);
  assertContains(m, 'hi scott');
  assert.throws(() => assertContains(m, 'goodbye'), DeliveryError);
});

test('assertLinksResolve: 200 and a redirect to 200 pass; a 404, a network error and a redirect to an error page fail by name; skip works', async () => {
  const { srv, base } = await listen((req, res) => {
    if (req.url === '/flaky') { if (!global.__flaky) { global.__flaky = 1; req.socket.destroy(); return; } res.writeHead(200); res.end('recovered'); return; }
    if (req.url === '/ok') { res.writeHead(200); res.end('fine'); } else if (req.url === '/moved') { res.writeHead(302, { location: '/ok' }); res.end(); } else if (req.url === '/gone') { res.writeHead(302, { location: '/error?code=expired' }); res.end(); } else if (req.url.startsWith('/error')) { res.writeHead(200); res.end('sorry'); } else { res.writeHead(404); res.end('nope'); }
  });
  try {
    const good = await assertLinksResolve(`<a href="${base}/ok">a</a> <a href="${base}/moved">b</a>`);
    assert.equal(good.length, 2);
    assert.ok(good.every((r) => r.ok));
    assert.equal(good[1].redirected, true);
    await assert.rejects(() => assertLinksResolve(`<a href="${base}/ok">a</a> <a href="${base}/missing">b</a>`), (e) => e instanceof DeliveryError && /missing/.test(e.message) && /404/.test(e.message) && e.results.length === 2);
    await assert.rejects(() => assertLinksResolve(`${base}/gone`), (e) => /redirected to an error page/.test(e.message));
    await assert.rejects(() => assertLinksResolve('http://127.0.0.1:9/dead', { timeoutMs: 2000 }), (e) => e instanceof DeliveryError && /dead/.test(e.message) && /after 2 attempt/.test(e.message));
    const flaky = await assertLinksResolve(`${base}/flaky`);
    assert.equal(flaky[0].attempts, 2, 'a reset connection is retried once and then passes');
    await assert.rejects(() => assertLinksResolve('http://127.0.0.1:9/dead2', { timeoutMs: 2000, retries: 0 }), (e) => /after 1 attempt/.test(e.message), 'retries: 0 fails on the first network error');
    const skipped = await assertLinksResolve(`<a href="${base}/ok">a</a> <a href="${base}/unsubscribe/x">u</a>`, { skip: [/unsubscribe/] });
    assert.equal(skipped.length, 1);
    assert.deepEqual(await assertLinksResolve('no links here'), []);
  } finally { srv.close(); }
});

test('waitForEmail long-polls /messages/search the way Mailosaur specifies, honours x-ms-delay, then fetches the full message', async () => {
  const calls = [];
  const { srv, base } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, base);
      calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.method === 'POST' && u.pathname === '/api/messages/search') {
        const n = calls.filter((c) => c.path === '/api/messages/search').length;
        if (n < 3) { res.writeHead(200, { 'content-type': 'application/json', 'x-ms-delay': '10,20' }); res.end(JSON.stringify({ items: [] })); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: [{ id: 'm1', summary: 'x' }] })); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/messages/m1') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(msgFixture())); return; }
      res.writeHead(404); res.end('{}');
    });
  });
  try {
    configure({ apiKey: 'key-123', serverId: 'abcd1234', baseUrl: base + '/api' });
    const since = new Date('2026-10-06T11:55:00Z');
    const m = await waitForEmail('invite-1-x@abcd1234.mailosaur.net', { subject: 'code', timeoutMs: 5000, receivedAfter: since });
    assert.equal(m.id, 'm1');
    assert.equal(m.bodyText, msgFixture().text.body);
    const searches = calls.filter((c) => c.path === '/api/messages/search');
    assert.equal(searches.length, 3, 'two empty polls then a hit');
    assert.deepEqual(searches[0].query, { server: 'abcd1234', page: '0', itemsPerPage: '1', receivedAfter: since.toISOString() });
    assert.deepEqual(searches[0].body, { sentTo: 'invite-1-x@abcd1234.mailosaur.net', subject: 'code' });
    assert.equal(searches[0].auth, 'Basic ' + Buffer.from('key-123:').toString('base64'));
    assert.equal(calls[calls.length - 1].path, '/api/messages/m1');
    assert.equal(calls[calls.length - 1].method, 'GET');
  } finally { srv.close(); configure({ apiKey: undefined, serverId: undefined, baseUrl: undefined }); }
});

test('waitForEmail gives up at the timeout naming criteria, server and window; waitForSms wants an SMS', async () => {
  let n = 0;
  const { srv, base } = await listen((req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname === '/api/messages/search') { n++; res.writeHead(200, { 'content-type': 'application/json', 'x-ms-delay': '20' }); res.end(JSON.stringify(n < 100 && u.searchParams.get('server') === 'smsserv1' ? { items: [{ id: 'e1' }] } : { items: [] })); return; }
    if (u.pathname === '/api/messages/e1') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(msgFixture({ id: 'e1', type: 'Email' }))); return; }
    res.writeHead(500); res.end('oops');
  });
  try {
    await assert.rejects(() => waitForEmail('nobody@abcd1234.mailosaur.net', { timeoutMs: 100, apiKey: 'k', serverId: 'abcd1234', baseUrl: base + '/api' }), (e) => e instanceof DeliveryError && /nobody@abcd1234/.test(e.message) && /abcd1234/.test(e.message) && /100ms/.test(e.message));
    assert.ok(n >= 2 && n <= 6, 'polled a few times within 100ms at 20ms delay: ' + n);
    await assert.rejects(() => waitForSms('+15555550100', { timeoutMs: 1000, apiKey: 'k', serverId: 'smsserv1', baseUrl: base + '/api' }), (e) => e instanceof DeliveryError && /expected an SMS/.test(e.message));
    delete process.env.MAILOSAUR_PHONE_NUMBER;
    await assert.rejects(() => waitForSms(undefined, { apiKey: 'k', serverId: 'smsserv1', baseUrl: base + '/api' }), (e) => /MAILOSAUR_PHONE_NUMBER/.test(e.message));
    await assert.rejects(() => waitForMessage({ sentTo: 'x' }, { apiKey: 'k', serverId: 'boom', baseUrl: base + '/api/nope' }), (e) => /-> 500/.test(e.message));
    await assert.rejects(() => waitForEmail('x@y.z', { serverId: 's', baseUrl: base + '/api' }), (e) => /MAILOSAUR_API_KEY/.test(e.message));
  } finally { srv.close(); }
});
