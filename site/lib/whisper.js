import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
import { frame, el, cloudPost } from './page.js';

const RATE = 16000;
const MAX_SECONDS = 55; // the cloud endpoint caps uploads at ~60 s

async function toSamples(blob) {
  const ctx = new AudioContext({ sampleRate: RATE });
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    return audio.getChannelData(0).slice(0, RATE * MAX_SECONDS);
  } finally {
    ctx.close();
  }
}

// 16-bit mono PCM WAV.
function wav(samples) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return view.buffer;
}

export async function whisperPage(cfg) {
  const f = await frame({
    ...cfg,
    cloudLabel: 'Whisper on Cloudflare Workers AI',
    cloudNote: 'Cloud sends your audio to Whisper on Cloudflare Workers AI. We don\'t store it. On your device, nothing leaves your browser.',
    async loadLocal(info, progress) {
      // ponytail: runs on the main thread; move to a worker if the UI stutters during transcription.
      const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-small', {
        device: 'webgpu',
        dtype: { encoder_model: info.f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' },
        progress_callback: (p) => p.status === 'progress' && progress(`Downloading ${p.file}: ${Math.round(p.progress)}%`),
      });
      return async (samples) => {
        try {
          return { result: (await asr(samples, { chunk_length_s: 30 })).text };
        } catch (err) {
          asr.dispose(); // the frame drops this runner on failure; free GPU memory
          throw err;
        }
      };
    },
    async runCloud(samples) {
      const { text } = await cloudPost('/api/transcribe', wav(samples), 'audio/wav');
      return { result: text };
    },
  });

  const recBtn = el('button', { type: 'button', textContent: 'Record' });
  const file = el('input', { type: 'file', accept: 'audio/*' });
  const out = el('p', { className: 'msg bot' });
  f.app.append(el('div', { className: 'buttons' }, recBtn, el('label', {}, 'or pick a file ', file)), out);

  async function transcribe(blob) {
    recBtn.disabled = file.disabled = true;
    out.textContent = 'Transcribing…';
    try {
      const text = await f.run(await toSamples(blob));
      out.textContent = text ?? '';
    } catch {
      out.textContent = '';
      f.status.textContent = "Couldn't read that audio. Try a different file.";
    }
    recBtn.disabled = file.disabled = false;
  }

  file.onchange = () => file.files[0] && transcribe(file.files[0]);

  let rec = null;
  recBtn.onclick = async () => {
    if (rec) return rec.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const parts = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => parts.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        rec = null;
        recBtn.textContent = 'Record';
        transcribe(new Blob(parts, { type: parts[0]?.type }));
      };
      rec.start();
      recBtn.textContent = 'Stop';
    } catch {
      f.status.textContent = 'Microphone access was blocked. You can pick an audio file instead.';
    }
  };
}
