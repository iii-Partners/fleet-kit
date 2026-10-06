# @iii-partners/fleet-kit

Two small helpers every iii Partners pillar uses, so the fleet proves the same two things the same way:

- **`telemetry`**: capture events to the pillar's PostHog project on the one fleet schema (the [Fleet Telemetry Standard](https://github.com/iii-Partners/iii-eye/blob/main/docs/standards/TELEMETRY-STANDARD.md), epic iii-eye#528). An event that misses a required property, or carries personal data or a secret, is refused at the call site.
- **`delivery-proof`**: prove that the email or SMS the pillar really sent really arrived (Mailosaur), with the right content, working links and no placeholder text (epic iii-eye#527).

Zero dependencies. ESM. Node 18+, Cloudflare Workers, browsers.

```sh
npm install github:iii-Partners/fleet-kit#v0.1.1
```

## telemetry

```js
import { createTelemetry } from '@iii-partners/fleet-kit/telemetry';

const telemetry = createTelemetry({
  key: env.POSTHOG_KEY,                                   // the pillar's project write key, from secrets
  defaults: { venture_id: 'iii-partners', pillar: 'eye', env: 'production', executor: 'cloudflare-worker' },
  events: { health_run: 'health', copilot_turn: 'agent', approval: 'product' },   // event name -> class, so callers need not repeat it
});

// health
await telemetry.capture('health_run', { actor_type: 'agent', actor_id: 'cron', run_id: 'h-20261006-1200', ticket: 'none', pillars_up: 7 });

// agent: the six agent properties are required when class is agent
await telemetry.capture('copilot_turn', {
  actor_type: 'agent', actor_id: 'chief-of-staff', run_id: requestId, ticket: 'https://github.com/iii-Partners/iii-eye/issues/531',
  model: 'claude-fable-5-1', provider: 'anthropic', tokens_in: usage.input_tokens, tokens_out: usage.output_tokens,
  cost_usd: costUsd(usage.input_tokens, usage.output_tokens, RATE_FROM_PRICE_LIST), duration_ms: Date.now() - t0,
});

// error: always PostHog's $exception (so Error Tracking sees it) with error_kind naming the failure; message and stack redacted
await telemetry.captureError(err, { error_kind: 'job_failed', actor_type: 'agent', actor_id: 'provision', run_id, ticket: 'none' });

// in a Worker, flush before the isolate goes away
ctx.waitUntil(telemetry.flush());
```

What it enforces, from the standard:

| rule | behaviour |
|---|---|
| required on every event: `venture_id`, `pillar`, `actor_type` (`human`/`agent`), `actor_id`, `run_id`, `ticket` (issue URL or `none`), `executor`, `env`, `class` | missing or blank: `SchemaError` naming the properties |
| `class` is one of `product`, `agent`, `error`, `health` | otherwise `SchemaError` |
| class `agent` also needs `model`, `provider`, `tokens_in`, `tokens_out`, `cost_usd`, `duration_ms` (numbers, finite, not negative) | otherwise `SchemaError` |
| no personal data, secrets or message bodies: forbidden keys (`email`, `phone`, `body`, `subject`, `token`, `password`, `api_key`, `authorization`, `cookie`, `dob`, `address`, `first_name`, ...) and forbidden values (anything that looks like an email address, a bearer token or a provider key) | `PrivacyError` naming the path. `captureError` redacts instead |
| stamped by the kit | `sent_at`, `schema` (`iii-telemetry-v1`), `$lib`, `$lib_version`; `$process_person_profile: false` unless `personProfiles: true` and the actor is human |

Other options: `transport(batch)` to replace PostHog (tests, other sinks), `dryRun` (validate, send nothing), `batchSize` (default 20), `flushIntervalMs` (default 2000; `0` = flush only on `flush()` or a full batch), `distinctId`, `onError`. `safeCapture` returns `{ ok, error }` instead of throwing. `validate`, `redact`, `parseStack`, `costUsd` and the constants (`REQUIRED_PROPS`, `AGENT_PROPS`, `CLASSES`) are exported for harness checks.

The transport is PostHog's batch endpoint (`POST https://us.i.posthog.com/batch/`, the route the official SDKs use) with one retry on a network error or 5xx. The pillar's write key is a secret (`POSTHOG_KEY`); the key that reads projects lives only in EYE and the harness.

## delivery-proof

Mailosaur by direct `fetch`, following the official SDK's protocol (`POST /api/messages/search` long-poll honouring `x-ms-delay`, then `GET /api/messages/:id`). Configure with `MAILOSAUR_API_KEY` and `MAILOSAUR_SERVER_ID` in the environment, or `configure({ apiKey, serverId })`, or per call.

**One email test** (node:test; Playwright or Vitest read the same):

```js
import { test } from 'node:test';
import { generateEmail, waitForEmail, assertSender, assertSubject, assertContains, assertNoPlaceholders, assertLinksResolve, extractLinks } from '@iii-partners/fleet-kit/delivery-proof';

test('the tenant invite arrives and works', async () => {
  const to = generateEmail('invite');                                     // invite-<ts>-<rand>@<server>.mailosaur.net
  await fetch(`${BASE_URL}/api/admin/tenant/invite`, { method: 'POST', headers: AUTH, body: JSON.stringify({ email: to }) });   // the real flow, deployed
  const msg = await waitForEmail(to, { subject: 'invited', timeoutMs: 60000 });
  assertSender(msg, { domain: 'iii.partners' });
  assertSubject(msg, 'You have been invited');
  assertContains(msg, 'Accept the invitation');
  assertNoPlaceholders(msg);                                              // {{, undefined, null, NaN, TODO, [object Object], ...
  await assertLinksResolve(msg, { skip: [/unsubscribe/] });               // every link answers 2xx and does not land on an error page
  const accept = extractLinks(msg).find((l) => l.includes('/invitation'));
  // ... drive `accept` with Playwright if the test continues into the product
});
```

**One SMS test**. Mailosaur has no API that lists a server's phone numbers, so the number comes from `MAILOSAUR_PHONE_NUMBER` (E.164), set from the Mailosaur dashboard once.

```js
import { waitForSms, extractCode, assertNoPlaceholders } from '@iii-partners/fleet-kit/delivery-proof';

test('the login code arrives by SMS', async () => {
  const phone = process.env.MAILOSAUR_PHONE_NUMBER;
  await fetch(`${BASE_URL}/api/auth/sms`, { method: 'POST', body: JSON.stringify({ phone }) });   // the real send through Twilio
  const sms = await waitForSms(phone, { timeoutMs: 60000 });
  assertNoPlaceholders(sms);
  const code = extractCode(sms, { length: 6 });
  if (!code) throw new Error('no 6-digit code in the SMS');
  // ... use `code` in the login flow
});
```

Also exported: `waitForMessage(criteria)`, `extractCode(input, { length })`, `extractLinks(input)`, `textOf`, `stripHtml`, `assertRecipient`, `deleteMessage`, `deleteAllMessages`, `listMessages`, `serverInfo`, `PLACEHOLDER_PATTERNS`, `DeliveryError`. Every assert throws `DeliveryError` with the evidence (`hits`, `results`).

**Rules.** Mailosaur is for testing our own sending only. It is never an identity: no LLM subscription, provider account or login is registered to a Mailosaur inbox or number, and Mailosaur inboxes never receive customer data outside a test fixture. One-time links (magic logins) are consumed by a probe: pass them in `skip` and drive them in the test instead.

## Tests

```sh
npm test            # the kit's own tests: schema, privacy, batching, transport, placeholders, codes, links, the Mailosaur protocol (local servers only)
npm run test:live   # optional: one real PostHog event (POSTHOG_KEY, read back with POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID) and one real Mailosaur read (MAILOSAUR_API_KEY + MAILOSAUR_SERVER_ID)
```

PostHog accepts a batch in under a second but a quiet project can take a few minutes to show the event in HogQL (about three minutes seen on 2026-10-06); the live script waits up to five. Harness checks that read an event back should allow the same.

## Versions

Pillars pin a tag: `github:iii-Partners/fleet-kit#v0.1.1`. A change to the schema bumps the kit's minor version and the standard's version together; the `schema` property on every event says which rule it was written under.

- **v0.1.1** (2026-10-06): `extractLinks` no longer counts DOCTYPE, `xmlns` or CSS `url()` addresses that live only in the markup (hrefs plus bare URLs in the visible text); `assertLinksResolve` retries a network-level failure once (a status is never retried) and names the cause. Found by EYE's first live invite proof.
- **v0.1.0** (2026-10-06): first release. `telemetry` (createTelemetry, validate, redact, parseStack, costUsd, postHogTransport) and `delivery-proof` (generateEmail, waitForEmail, waitForSms, waitForMessage, extractCode, extractLinks, assertLinksResolve, assertNoPlaceholders, assertSender, assertSubject, assertRecipient, assertContains, deleteMessage, deleteAllMessages, listMessages, serverInfo).
