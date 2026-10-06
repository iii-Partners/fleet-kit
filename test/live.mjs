// Live smoke for the two entry points against the real services. Runs only what the environment configures and says
// plainly what it skipped; exits 1 on any failure of what it did run. The fleet harness in iii-eye has its own, stricter
// checks (a missing input there is a red, never a skip); this script is for a developer or CI with the secrets in place.
//
//   POSTHOG_KEY                      a project write key: one event is sent through the default transport
//   POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID   the event is read back with HogQL (POSTHOG_API_HOST, default https://us.posthog.com)
//   MAILOSAUR_API_KEY + MAILOSAUR_SERVER_ID         the newest message on the server is fetched through waitForEmail and inspected
import { createTelemetry } from '../telemetry/index.js';
import { waitForEmail, listMessages, extractLinks, extractCode, serverInfo } from '../delivery-proof/index.js';

const env = process.env;
let failures = 0;
const fail = (m) => { failures++; console.error('FAIL ' + m); };
const skip = (m) => console.log('skip ' + m);
const ok = (m) => console.log('ok   ' + m);

async function posthog() {
  if (!env.POSTHOG_KEY) return skip('telemetry: POSTHOG_KEY not set');
  const runId = 'smoke-' + Date.now();
  const errors = [];
  const t = createTelemetry({ key: env.POSTHOG_KEY, host: env.POSTHOG_HOST, flushIntervalMs: 0, onError: (e) => errors.push(e), defaults: { venture_id: 'iii-partners', pillar: env.FLEET_PILLAR || 'fleet-kit', env: 'test', executor: 'fleet-kit-live', actor_type: 'agent', actor_id: 'fleet-kit-live' } });
  await t.capture('fleet_kit_smoke', { class: 'health', run_id: runId, ticket: 'https://github.com/iii-Partners/iii-eye/issues/528' });
  const r = await t.flush();
  if (r.failed) return fail(`telemetry: transport failed: ${errors.map((e) => e.message).join('; ')}`);
  ok(`telemetry: one fleet_kit_smoke event accepted by PostHog (run_id ${runId})`);
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return skip('telemetry read-back: POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set');
  const host = (env.POSTHOG_API_HOST || 'https://us.posthog.com').replace(/\/$/, '');
  const q = `select count(), any(properties.schema), any(properties.sent_at) from events where event = 'fleet_kit_smoke' and properties.run_id = '${runId}'`;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const res = await fetch(`${host}/api/projects/${env.POSTHOG_PROJECT_ID}/query/`, { method: 'POST', headers: { authorization: 'Bearer ' + env.POSTHOG_PERSONAL_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }) });
    if (!res.ok) return fail(`telemetry read-back: HogQL -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const row = (j.results || [])[0] || [0];
    if (+row[0] > 0) return ok(`telemetry read-back: HogQL found ${row[0]} event(s) with schema ${row[1]} after ${Math.round((Date.now() - (deadline - 300000)) / 1000)}s`);
    await new Promise((r2) => setTimeout(r2, 5000));
  }
  fail('telemetry read-back: the event did not appear in HogQL within 300s');
}

async function mailosaur() {
  if (!env.MAILOSAUR_API_KEY || !env.MAILOSAUR_SERVER_ID) return skip('delivery-proof: MAILOSAUR_API_KEY / MAILOSAUR_SERVER_ID not set');
  const info = await serverInfo();
  ok(`delivery-proof: server ${info.name} (${info.id}) answers`);
  const since = new Date(Date.now() - 90 * 86400000);
  const items = await listMessages({ receivedAfter: since, itemsPerPage: 1 });
  if (!items.length) return skip('delivery-proof: no message on the server in 90 days to read back');
  const to = (items[0].to && items[0].to[0] && (items[0].to[0].email || items[0].to[0].phone)) || '';
  const m = await waitForEmail(to, { timeoutMs: 15000, receivedAfter: since });
  ok(`delivery-proof: waitForEmail returned message ${m.id} (${m.type}) to a ${to.includes('@') ? 'mailosaur address' : 'number'}; ${extractLinks(m).length} link(s); code ${extractCode(m) ? 'found' : 'none'}; ${m.bodyText.length} chars of text`);
}

try { await posthog(); } catch (e) { fail('telemetry: ' + e.message); }
try { await mailosaur(); } catch (e) { fail('delivery-proof: ' + e.message); }
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('live smoke done');
