// Shared page frame: device check, local/cloud buttons, "where is this running" label, events, errors.
import { checkDevice } from './check.js';
import { log } from './log.js';

export function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const COLAB = 'https://colab.research.google.com/github/ML-HOST/ML-HOST/blob/main/notebooks';

const MESSAGES = {
  oom: 'This model is too big for your device. Try the smaller version or run on cloud.',
  device_lost: 'Your GPU stopped responding. Try cloud, or reload the page.',
  download_failed: "Couldn't download the model. Check your connection, or try cloud.",
  cloud_cap: "This demo's free cloud runs are used up for today.",
  rate_limited: 'Too many cloud requests. Wait a minute and try again.',
  local_failed: 'Something went wrong running on your device. Try cloud.',
  cloud_failed: 'The cloud model failed. Try again in a bit.',
};

function errorCode(err, mode) {
  if (err?.code in MESSAGES) return err.code;
  const m = String(err?.message ?? err).toLowerCase();
  if (/out of memory|oom|allocat/.test(m)) return 'oom';
  if (/device.*lost|lost.*device/.test(m)) return 'device_lost';
  if (mode === 'local' && /failed to fetch|networkerror|load failed/.test(m)) return 'download_failed';
  return `${mode}_failed`;
}

export async function cloudPost(path, body, contentType) {
  const r = await fetch(path, { method: 'POST', body, headers: { 'content-type': contentType } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = data.error === 'cap' ? 'cloud_cap' : data.error === 'rate_limited' ? 'rate_limited' : 'cloud_failed';
    throw Object.assign(new Error(code), { code });
  }
  return data;
}

// cfg: { page, title, blurb, model: {sizeMB, mobileOk, smallerHref?}, cloudLabel, cloudNote,
//        loadLocal(info, progress) -> runner, runCloud: runner, onMode?(mode) }
// runner(input) -> { result, tokensPerSec? }
// Returns { app, status, run(input) -> result | null }. Put the page's own UI in `app`.
export async function frame(cfg) {
  const base = {};
  const ev = (type, fields) => log(cfg.page, type, { ...base, ...fields });
  ev('page_view');

  const verdict = el('p', { className: 'verdict', textContent: 'Checking your device…' });
  const localBtn = el('button', { textContent: 'Run on my device', disabled: true });
  const cloudBtn = el('button', { textContent: 'Run on cloud', className: 'secondary' });
  // Runs on Google's GPU in the visitor's own Google account; they chat inside Colab (its rules forbid driving it from our page).
  const colab = el('a', {
    className: 'button secondary', target: '_blank', rel: 'noopener', textContent: 'Run in my Google Colab',
    href: `${COLAB}/${cfg.page}.ipynb`, onclick: () => ev('colab_open'),
  });
  const where = el('p', { className: 'where', textContent: 'Not running yet' });
  const status = el('p', { className: 'status', role: 'status' });
  const app = el('section', { hidden: true });
  document.body.append(
    el('main', {},
      el('p', {}, el('a', { href: '/', textContent: '← all models' })),
      el('h1', { textContent: cfg.title }),
      el('p', { textContent: cfg.blurb }),
      verdict,
      el('div', { className: 'buttons' }, localBtn, cloudBtn, colab),
      el('p', { className: 'note', textContent: cfg.cloudNote }),
      el('p', { className: 'note', textContent: 'Google Colab opens a notebook that runs the same model on Google\'s free GPU in your own Google account, and can keep it in your Google Drive. You chat inside Colab.' }),
      where, status, app),
  );

  const info = await checkDevice(cfg.model);
  Object.assign(base, { device_class: info.deviceClass, webgpu: info.webgpu, gpu_vendor: info.gpuVendor, verdict: info.verdict });
  ev('check_done');
  verdict.textContent = info.reason;
  if (info.verdict === 'LOCAL_SMALLER') {
    verdict.append(' ', el('a', { href: cfg.model.smallerHref, textContent: 'Open the smaller model' }));
    localBtn.textContent = 'Try anyway on my device';
  }
  const canLocal = info.verdict !== 'CLOUD_ONLY';
  localBtn.disabled = !canLocal;

  let mode = null, runner = null, localRunner = null;
  const use = (m, fn) => {
    if (m !== mode) cfg.onMode?.(m);
    mode = m;
    runner = fn;
    where.textContent = m === 'local' ? 'Running on your device' : `Running on cloud (${cfg.cloudLabel})`;
    where.dataset.mode = m;
    localBtn.disabled = m === 'local' || !canLocal;
    cloudBtn.disabled = m === 'cloud';
    app.hidden = false;
  };

  const fail = (err, m) => {
    console.error(err);
    const code = errorCode(err, m);
    ev('error', { mode: m, error_code: code });
    status.textContent = MESSAGES[code] ?? MESSAGES[`${m}_failed`];
    if (m === 'local') { // offer cloud in one tap (FR21)
      localRunner = null;
      mode = runner = null;
      where.textContent = 'Stopped';
      where.dataset.mode = '';
      localBtn.disabled = !canLocal; // allow a retry without reloading
      cloudBtn.disabled = false;
    }
  };

  localBtn.onclick = async () => {
    if (localRunner) return use('local', localRunner);
    localBtn.disabled = cloudBtn.disabled = true;
    ev('load_start', { mode: 'local' });
    const t0 = performance.now();
    try {
      localRunner = await cfg.loadLocal(info, (text) => { status.textContent = text; });
      ev('load_done', { mode: 'local', load_ms: Math.round(performance.now() - t0) });
      status.textContent = '';
      use('local', localRunner);
    } catch (err) {
      fail(err, 'local');
    }
  };
  // FR12: say it at the moment of switching, not only in the standing note.
  cloudBtn.onclick = () => { status.textContent = cfg.cloudNote; use('cloud', cfg.runCloud); };

  return {
    app,
    status,
    async run(input) {
      if (!runner) { status.textContent = 'Pick "Run on my device" or "Run on cloud" first.'; return null; }
      const m = mode;
      if (m === 'cloud') ev('cloud_call', { mode: 'cloud' });
      try {
        const out = await runner(input);
        ev('run_done', { mode: m, tokens_per_sec: out.tokensPerSec });
        return out.result;
      } catch (err) {
        fail(err, m);
        return null;
      }
    },
  };
}
