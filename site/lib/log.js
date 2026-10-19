// Anonymous events. The Worker drops anything that isn't a known field (cloud/src/worker.js cleanEvent).
const session_id = crypto.randomUUID();

export function log(page, type, fields = {}) {
  fetch('/api/events', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fields, page, type, session_id }),
  }).catch(() => {}); // losing an event is fine
}
