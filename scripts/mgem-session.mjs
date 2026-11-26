#!/usr/bin/env node
/**
 * MorphoGem Clean-Room AI Session CLI
 *
 * Usage:
 *   node scripts/mgem-session.mjs begin <origin> <requestId>
 *   node scripts/mgem-session.mjs progress <origin> <requestId> "<message>"
 *   node scripts/mgem-session.mjs complete <origin> <requestId>
 *   node scripts/mgem-session.mjs fail <origin> <requestId> "<reason>"
 */

async function postJson(origin, endpoint, payload) {
  const base = String(origin || '').replace(/\/+$/, '');
  const url = `${base}${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Error(data.error || `HTTP ${res.status} calling ${endpoint}`);
  }
  return data;
}

async function main() {
  const [action, origin, requestId, ...rest] = process.argv.slice(2);
  const message = rest.join(' ').trim();

  if (!action || !origin || !requestId) {
    throw Error(
      'Usage: node scripts/mgem-session.mjs <begin|progress|complete|fail> <http://127.0.0.1:PORT> <requestId> [message]'
    );
  }

  if (action === 'begin') {
    const out = await postJson(origin, '/api/session/begin', {id: requestId});
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (action === 'progress') {
    const out = await postJson(origin, '/api/session/progress', {id: requestId, message});
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (action === 'complete') {
    const out = await postJson(origin, '/api/session/complete', {id: requestId});
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (action === 'fail') {
    const out = await postJson(origin, '/api/session/fail', {id: requestId, reason: message || 'Aborted by agent'});
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  throw Error(`Unknown action: ${action}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exitCode = 1;
});
