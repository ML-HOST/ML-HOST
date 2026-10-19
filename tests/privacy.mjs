// Local-mode privacy test (TRD §4 Privacy, §8): in local mode no request may carry the prompt or the reply,
// and switching to cloud afterwards must not send the earlier local conversation.
// Drives real Chrome over the DevTools protocol, watching the page AND its workers (WebLLM fetches from a worker).
//
// Local run needs the Worker running (from the repo root):
//   npx wrangler d1 execute locallink-try --local -c cloud/wrangler.localtest.toml --file cloud/schema.sql
//   npx wrangler dev -c cloud/wrangler.localtest.toml --port 8787
// Run: node tests/privacy.mjs [page]    page = qwen (default) | llama
// Env: BASE (default http://127.0.0.1:8787), CHROME (path), HEADED=1 to watch it.
// Also run it against the deployed URL: the HF Referer block (site/_headers) only shows up there.
// That makes one real cloud call (counts toward DAILY_CAP) and writes test events to the live D1.
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const PAGE = process.argv[2] ?? 'qwen';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = fileURLToPath(new URL('./.chrome-profile', import.meta.url)); // keeps the model cached between runs
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE);
const MARKER = `zq${randomBytes(6).toString('hex')}`; // local-mode prompt: must never leave
const MARKER_B = `zc${randomBytes(6).toString('hex')}`; // cloud-mode prompt: only /api/chat may carry it
const LOAD_TIMEOUT_MS = 20 * 60_000; // first run downloads the model

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Chrome + minimal CDP client ---
const launch = () => {
  const proc = spawn(CHROME, [
    ...(process.env.HEADED ? [] : ['--headless=new']),
    '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--enable-unsafe-webgpu',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ]);
  return new Promise((res, rej) => {
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\S+)/);
      if (m) res({ proc, wsUrl: m[1] });
    });
    proc.on('exit', () => rej(new Error(`Chrome exited:\n${err}`)));
  });
};
// A previous run's Chrome can hold the profile for a few seconds after closing (ProcessSingleton), so retry.
let chrome, wsUrl;
for (let attempt = 1; !chrome; attempt++) {
  try {
    ({ proc: chrome, wsUrl } = await launch());
  } catch (err) {
    if (attempt === 5 || !/ProcessSingleton/.test(err.message)) throw err;
    await sleep(3000);
  }
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));

let nextId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result);
  } else listeners.forEach((fn) => fn(msg));
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++nextId;
  pending.set(id, { res, rej, method });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

// --- record every request from the page and its workers ---
const requests = []; // { url, method, body }
const consoleLines = [];
let pageSession;
const sessionsByTarget = new Map();
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
listeners.push(async ({ method, params, sessionId }) => {
  if (method === 'Target.attachedToTarget') {
    const s = params.sessionId;
    sessionsByTarget.set(params.targetInfo.targetId, s);
    await send('Network.enable', {}, s).catch(() => {});
    await send('Runtime.enable', {}, s).catch(() => {});
    await send('Target.setAutoAttach', autoAttach, s).catch(() => {}); // nested workers
    await send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {});
  } else if (method === 'Network.requestWillBeSent') {
    const { request, requestId } = params;
    const entry = { url: request.url, method: request.method, body: request.postData ?? '' };
    requests.push(entry);
    if (request.hasPostData && !request.postData) {
      const r = await send('Network.getRequestPostData', { requestId }, sessionId).catch(() => null);
      entry.body = r?.postData ?? '[unreadable body]';
    }
  } else if (method === 'Network.webSocketFrameSent') {
    requests.push({ url: 'websocket', method: 'WS', body: params.response.payloadData });
  } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
    consoleLines.push(params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (method === 'Runtime.exceptionThrown') {
    consoleLines.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  }
});
await send('Target.setAutoAttach', autoAttach);
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
while (!(pageSession = sessionsByTarget.get(targetId))) await sleep(50);

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, pageSession);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, timeoutMs, what) => {
  const end = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < end) {
    if (await evaluate(expression).catch(() => false)) return;
    const status = await evaluate(`document.querySelector('.status')?.textContent ?? ''`).catch(() => '');
    if (status && status !== lastStatus) console.log(`  … ${status}`);
    lastStatus = status;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const btn = (label) => `[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(label)}))`;

// --- the run ---
const failures = [];
let reply = '', switchedAt = null;
try {
  console.log(`Opening ${BASE}/${PAGE}, marker ${MARKER}`);
  await send('Page.navigate', { url: `${BASE}/${PAGE}` }, pageSession);
  await waitFor(`(document.querySelector('.verdict')?.textContent ?? 'Checking your device…') !== 'Checking your device…'`, 30_000, 'device check');
  const verdict = await evaluate(`document.querySelector('.verdict').textContent`);
  console.log(`Device check: ${verdict}`);
  if (await evaluate(`${btn('on my device')}.disabled`)) throw new Error(`local mode not offered: ${verdict}`);

  await evaluate(`${btn('on my device')}.click()`);
  await waitFor(`document.querySelector('.where')?.dataset.mode === 'local' || document.querySelector('.where')?.textContent === 'Stopped'`,
    LOAD_TIMEOUT_MS, 'model load');
  if (await evaluate(`document.querySelector('.where').textContent`) === 'Stopped') {
    throw new Error(`local load failed: ${await evaluate(`document.querySelector('.status').textContent`)}`);
  }
  console.log('Model loaded, sending prompt');

  await evaluate(`(() => {
    document.querySelector('textarea').value = 'Repeat this code exactly, nothing else: ${MARKER}';
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(`!${btn('Send')}.disabled`, 5 * 60_000, 'reply');
  reply = await evaluate(`[...document.querySelectorAll('.msg.bot')].at(-1)?.textContent ?? ''`);
  console.log(`Reply: ${JSON.stringify(reply.slice(0, 200))}`);
  if (!reply.trim()) failures.push('local model produced no reply');
  await sleep(3000); // let keepalive event posts go out

  // Switch to cloud: the new conversation must not carry the local one (chat.js onMode).
  // Locally /api/chat answers 502 (no AI binding) or 429 (DAILY_CAP=2); the request body is what we check.
  switchedAt = requests.length;
  await evaluate(`${btn('on cloud')}.click()`);
  await waitFor(`document.querySelector('.where')?.dataset.mode === 'cloud'`, 10_000, 'cloud mode');
  console.log(`Switched to cloud, sending marker ${MARKER_B}`);
  await evaluate(`(() => {
    document.querySelector('textarea').value = 'Cloud turn: ${MARKER_B}';
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(`!${btn('Send')}.disabled`, 60_000, 'cloud reply');
  await sleep(3000);
} catch (err) {
  failures.push(err.message);
}

// --- assertions ---
const has = (r, s) => [r.url, r.body].some((x) => x.includes(s) || x.includes(encodeURIComponent(s)));
for (const r of requests.filter((r) => has(r, MARKER))) failures.push(`PRIVACY LEAK: ${r.method} ${r.url} carries the local prompt`);
if (reply && reply.length > 20) { // a distinctive slice of the model's own reply must not leave either
  const slice = reply.slice(0, 40);
  for (const r of requests.filter((r) => r.body.includes(slice))) failures.push(`PRIVACY LEAK: ${r.method} ${r.url} carries local reply text`);
}
const ours = requests.filter((r) => r.url.startsWith(BASE) && r.method !== 'GET');
const path = (r) => new URL(r.url).pathname;
const localPhase = ours.filter((r) => requests.indexOf(r) < (switchedAt ?? Infinity));
for (const r of localPhase.filter((r) => path(r) !== '/api/events')) failures.push(`unexpected call in local mode: ${r.method} ${r.url}`);
if (switchedAt != null) {
  const chats = ours.filter((r) => requests.indexOf(r) >= switchedAt && path(r) === '/api/chat');
  if (!chats.some((r) => r.body.includes(MARKER_B))) failures.push('cloud turn never reached /api/chat');
  for (const r of requests.filter((r) => has(r, MARKER_B) && path(r) !== '/api/chat')) failures.push(`PRIVACY LEAK: ${r.method} ${r.url} carries the cloud prompt`);
}

const sessionIds = new Set(ours.flatMap((r) => [].concat(JSON.parse(r.body || 'null') ?? []).map((e) => e?.session_id)).filter((s) => /^[0-9a-f-]{36}$/.test(s ?? '')));
if (sessionIds.size !== 1) failures.push(`expected one session_id in /api/events, saw ${sessionIds.size}`);
else {
  const [sid] = sessionIds;
  const where = LOCAL ? '--local -c cloud/wrangler.localtest.toml' : '--remote'; // remote uses the root wrangler.toml
  const out = execSync(`npx wrangler d1 execute locallink-try ${where} --json --command "SELECT type FROM events WHERE session_id = '${sid}'"`,
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const types = new Set(JSON.parse(out)[0].results.map((r) => r.type));
  console.log(`D1 events for ${sid}: ${[...types].join(', ')}`);
  for (const t of ['page_view', 'check_done', 'load_start', 'load_done', 'run_done', 'cloud_call']) if (!types.has(t)) failures.push(`missing ${t} event in D1`);
}

const hosts = [...new Set(requests.map((r) => { try { return new URL(r.url).host; } catch { return r.url; } }))];
console.log(`${requests.length} requests to: ${hosts.join(', ')}`);
if (failures.length) {
  if (consoleLines.length) console.log(`Console errors:\n  ${consoleLines.slice(-10).join('\n  ')}`);
  console.log(`FAIL\n- ${failures.join('\n- ')}`);
} else console.log('PASS: local prompt and reply never left the browser (not even after switching to cloud); cloud prompt went only to /api/chat');

// Wait for a full exit: leftover child processes keep the profile's CacheStorage locked and break the next run.
const exited = new Promise((r) => chrome.once('exit', r));
// Browser.close's reply can be lost when the socket drops first, so never await it alone.
// (kill() alone leaves child processes on Windows.)
send('Browser.close').catch(() => chrome.kill());
await Promise.race([exited, sleep(10_000)]);
await sleep(1000);
process.exit(failures.length ? 1 : 0);
