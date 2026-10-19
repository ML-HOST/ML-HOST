import { CreateWebWorkerMLCEngine } from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
import { frame, el, cloudPost } from './page.js';

const stripThink = (t) => t.replace(/<think>[\s\S]*?(<\/think>\s*|$)/, '');

// cfg: frame cfg minus loadLocal/runCloud, plus ids: {f16, f32} (WebLLM model ids) and extraBody.
export async function chatPage(cfg) {
  // One conversation per mode: switching starts fresh, so local turns never reach the cloud.
  let history = [];
  const thread = el('div', { className: 'chat' });

  const f = await frame({
    ...cfg,
    cloudLabel: 'Llama 3.2 1B on Cloudflare Workers AI',
    cloudNote: 'Cloud sends your messages to Llama 3.2 1B on Cloudflare Workers AI. We don\'t store them. On your device, nothing leaves your browser.',
    onMode(mode) {
      history = [];
      if (thread.childElementCount) {
        thread.append(el('p', { className: 'note', textContent: `New conversation (${mode === 'local' ? 'on your device' : 'on cloud'}). Earlier messages stay here and aren't sent.` }));
      }
    },
    async loadLocal(info, progress) {
      const worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
      let engine;
      try {
        engine = await CreateWebWorkerMLCEngine(worker, info.f16 ? cfg.ids.f16 : cfg.ids.f32, {
          initProgressCallback: (p) => progress(p.text),
        });
      } catch (err) {
        worker.terminate(); // free GPU memory before the visitor moves to cloud
        throw err;
      }
      return async ({ messages, show }) => {
        try {
          const chunks = await engine.chat.completions.create({
            messages, stream: true, stream_options: { include_usage: true }, extra_body: cfg.extraBody,
          });
          let text = '', tokensPerSec;
          for await (const c of chunks) {
            text += c.choices[0]?.delta?.content ?? '';
            show(stripThink(text));
            tokensPerSec = c.usage?.extra?.decode_tokens_per_s ?? tokensPerSec;
          }
          return { result: stripThink(text), tokensPerSec };
        } catch (err) {
          worker.terminate(); // the frame drops this runner on failure; a retry loads a fresh worker
          throw err;
        }
      };
    },
    async runCloud({ messages }) {
      const { text } = await cloudPost('/api/chat', JSON.stringify({ messages }), 'application/json');
      return { result: text };
    },
  });

  const input = el('textarea', { rows: 2, placeholder: 'Ask something…', required: true });
  const send = el('button', { textContent: 'Send' });
  const form = el('form', {}, input, send);
  f.app.append(thread, form);

  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    send.disabled = true;
    thread.append(el('p', { className: 'msg user', textContent: content }));
    const bubble = el('p', { className: 'msg bot', textContent: '…' });
    thread.append(bubble);
    const h = history; // a mode switch mid-reply replaces `history`; this turn stays in its own conversation
    h.push({ role: 'user', content });
    const reply = await f.run({ messages: h.slice(-20), show: (t) => { bubble.textContent = t; } });
    if (reply == null) {
      h.pop();
      bubble.remove();
    } else {
      bubble.textContent = reply;
      h.push({ role: 'assistant', content: reply });
    }
    send.disabled = false;
  };
}
