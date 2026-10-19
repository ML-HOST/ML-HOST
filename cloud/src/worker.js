const CHAT_MODEL = '@cf/meta/llama-3.2-1b-instruct';
const ASR_MODEL = '@cf/openai/whisper';
const MAX_AUDIO_BYTES = 2_000_000; // ~60 s of 16 kHz 16-bit mono WAV
const MAX_CHAT_CHARS = 8000;

const ENUMS = {
  page: ['qwen', 'llama', 'whisper'],
  type: ['page_view', 'check_done', 'load_start', 'load_done', 'run_done', 'error', 'cloud_call', 'colab_open'],
  device_class: ['mobile', 'desktop'],
  verdict: ['LOCAL', 'LOCAL_SMALLER', 'CLOUD_ONLY'],
  mode: ['local', 'cloud'],
};
const CODE = /^[a-z0-9_-]{1,40}$/;
const UUID = /^[0-9a-f-]{36}$/;

// Trust boundary: keep only known fields with known shapes, so nothing free-form
// (prompt text, outputs) can ever land in the table.
export function cleanEvent(e) {
  if (!e || typeof e !== 'object') return null;
  if (!ENUMS.page.includes(e.page) || !ENUMS.type.includes(e.type)) return null;
  const pick = (k) => (ENUMS[k].includes(e[k]) ? e[k] : null);
  const code = (v) => (typeof v === 'string' && CODE.test(v) ? v : null);
  const num = (v) => (Number.isFinite(v) && v >= 0 && v < 1e7 ? v : null);
  return {
    session_id: typeof e.session_id === 'string' && UUID.test(e.session_id) ? e.session_id : null,
    page: e.page,
    type: e.type,
    device_class: pick('device_class'),
    webgpu: typeof e.webgpu === 'boolean' ? Number(e.webgpu) : null,
    gpu_vendor: code(e.gpu_vendor),
    verdict: pick('verdict'),
    mode: pick('mode'),
    load_ms: num(e.load_ms),
    tokens_per_sec: num(e.tokens_per_sec),
    error_code: code(e.error_code),
  };
}

const COLS = Object.keys(cleanEvent({ page: 'qwen', type: 'error' }));
const INSERT = `INSERT INTO events (${COLS}) VALUES (${COLS.map(() => '?')})`;

const json = (body, status = 200) => Response.json(body, { status });

async function events(req, env) {
  const body = await req.json().catch(() => null);
  const rows = (Array.isArray(body) ? body : [body]).slice(0, 50).map(cleanEvent).filter(Boolean);
  if (rows.length) await env.DB.batch(rows.map((r) => env.DB.prepare(INSERT).bind(...COLS.map((c) => r[c]))));
  return new Response(null, { status: 204 });
}

// Returns an error Response if this cloud call must be refused.
async function refuse(req, env) {
  const { success } = await env.PER_IP.limit({ key: req.headers.get('cf-connecting-ip') ?? 'unknown' });
  if (!success) return json({ error: 'rate_limited' }, 429);
  const day = new Date().toISOString().slice(0, 10);
  const { n } = await env.DB.prepare(
    'INSERT INTO usage (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1 RETURNING n',
  ).bind(day).first();
  if (n > Number(env.DAILY_CAP)) return json({ error: 'cap' }, 429);
}

async function chat(req, env) {
  const { messages } = (await req.json().catch(() => null)) ?? {};
  const ok = Array.isArray(messages) && messages.length > 0 && messages.length <= 20
    && messages.every((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
    && messages.reduce((n, m) => n + m.content.length, 0) <= MAX_CHAT_CHARS;
  if (!ok) return json({ error: 'bad_request' }, 400);
  const no = await refuse(req, env);
  if (no) return no;
  const r = await env.AI.run(CHAT_MODEL, {
    messages: messages.map(({ role, content }) => ({ role, content })),
    max_tokens: 512,
  });
  return json({ text: r.response });
}

async function transcribe(req, env) {
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_AUDIO_BYTES) return json({ error: 'bad_request' }, 400);
  const no = await refuse(req, env);
  if (no) return no;
  const r = await env.AI.run(ASR_MODEL, { audio: [...new Uint8Array(buf)] });
  return json({ text: r.text });
}

const CLOUD = { '/api/chat': chat, '/api/transcribe': transcribe };

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (pathname === '/api/events') return events(req, env);
    const handler = CLOUD[pathname];
    if (!handler) return json({ error: 'not_found' }, 404);
    try {
      return await handler(req, env);
    } catch (err) {
      console.error(pathname, err?.message); // never the request body
      return json({ error: 'provider_failed' }, 502);
    }
  },
};
