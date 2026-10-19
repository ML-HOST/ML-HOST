// Run: node cloud/test.mjs
import assert from 'node:assert/strict';
import { cleanEvent } from './src/worker.js';
import { decide } from '../site/lib/check.js';

// Privacy: free-form text never survives the event filter (TRD FR30).
const dirty = cleanEvent({
  page: 'qwen', type: 'run_done', mode: 'local', prompt: 'my secret', output: 'reply', ip: '1.2.3.4',
  error_code: 'my secret prompt text', gpu_vendor: 'nvidia', load_ms: 1200, webgpu: true,
});
assert.equal(JSON.stringify(dirty).includes('secret'), false);
assert.equal(dirty.error_code, null);
assert.equal(dirty.gpu_vendor, 'nvidia');
assert.equal(dirty.webgpu, 1);
assert.equal(dirty.load_ms, 1200);
assert.equal('prompt' in dirty || 'ip' in dirty, false);
assert.equal(cleanEvent({ page: 'other', type: 'run_done' }), null);
assert.equal(cleanEvent({ page: 'qwen', type: 'hack' }), null);
assert.equal(cleanEvent({ page: 'llama', type: 'colab_open' }).type, 'colab_open');
assert.equal(cleanEvent({ page: 'qwen', type: 'error', load_ms: -1, verdict: 'X' }).load_ms, null);

// Device check rules (try.md + TRD FR15).
const qwen = { sizeMB: 350, mobileOk: true };
const llama = { sizeMB: 700, mobileOk: false, smallerHref: '/qwen' };
const whisper = { sizeMB: 400, mobileOk: false };
const laptop = { webgpu: true, mobile: false, freeMB: 50_000 };
assert.equal(decide({ ...laptop, webgpu: false }, qwen).verdict, 'CLOUD_ONLY');
assert.equal(decide({ ...laptop, freeMB: 500 }, qwen).verdict, 'CLOUD_ONLY'); // < 1.5x size
assert.equal(decide({ ...laptop, freeMB: null }, qwen).verdict, 'LOCAL'); // unknown storage: don't block
assert.equal(decide(laptop, llama).verdict, 'LOCAL');
assert.equal(decide({ ...laptop, mobile: true }, qwen).verdict, 'LOCAL');
assert.equal(decide({ ...laptop, mobile: true }, llama).verdict, 'LOCAL_SMALLER');
assert.equal(decide({ ...laptop, mobile: true }, whisper).verdict, 'CLOUD_ONLY');

console.log('ok');
