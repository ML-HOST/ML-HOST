// Device check (try.md "The device check, simply"; TRD FR15). Rough rules, no benchmark yet.

// Pure rules so they can be tested without a browser.
// facts: { webgpu, mobile, freeMB }   model: { sizeMB, mobileOk, smallerHref? }
export function decide(facts, model) {
  if (!facts.webgpu) {
    return { verdict: 'CLOUD_ONLY', reason: "Your browser can't run models locally. You can still try it on cloud." };
  }
  if (facts.freeMB != null && facts.freeMB < model.sizeMB * 1.5) {
    return { verdict: 'CLOUD_ONLY', reason: `Not enough free storage for the ${model.sizeMB} MB download. Try it on cloud.` };
  }
  if (facts.mobile && !model.mobileOk) {
    return model.smallerHref
      ? { verdict: 'LOCAL_SMALLER', reason: 'This model is likely too big for a phone. The smaller one should run fine.' }
      : { verdict: 'CLOUD_ONLY', reason: 'This model is too big for a phone. Try it on cloud.' };
  }
  const speed = facts.mobile ? 'a few words a second' : 'roughly reading speed or faster';
  return { verdict: 'LOCAL', reason: `Should run on your device: ${model.sizeMB} MB one-time download, ${speed}.` };
}

export async function checkDevice(model) {
  const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const freeMB = est?.quota ? (est.quota - (est.usage ?? 0)) / 1e6 : null;
  const facts = { webgpu: !!adapter, mobile, freeMB };
  return {
    ...decide(facts, model),
    webgpu: facts.webgpu,
    deviceClass: mobile ? 'mobile' : 'desktop',
    gpuVendor: adapter?.info?.vendor?.toLowerCase() || null,
    f16: !!adapter?.features.has('shader-f16'),
  };
}
