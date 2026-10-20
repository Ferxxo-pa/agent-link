import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp, clientAddress } from '../server.mjs';

function raw(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data = text;
        try { data = JSON.parse(text); } catch { /* health and empty bodies stay text */ }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function listen(t, options) {
  const app = createApp(options);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return app.address().port;
}

test('client address uses the trusted proxy hop and ignores forged forwarding otherwise', () => {
  const headers = { 'x-forwarded-for': '1.1.1.1, 203.0.113.8', 'fly-client-ip': '198.51.100.10' };
  assert.equal(clientAddress('10.0.0.2', headers, true), '198.51.100.10');
  assert.equal(clientAddress('10.0.0.2', { 'x-forwarded-for': '1.1.1.1, 203.0.113.8' }, true), '203.0.113.8');
  assert.equal(clientAddress('10.0.0.2', headers, false), '10.0.0.2');
  assert.equal(clientAddress('10.0.0.2', { 'x-forwarded-for': 'not-an-ip' }, true), '10.0.0.2');
});

test('trusted HTTPS proxy accepts remote joining and rejects downgrade or a forged host', async t => {
  const port = await listen(t, { publicOrigin: 'https://rooms.example.com', trustedProxy: true });
  const common = { Host: 'rooms.example.com', 'X-Forwarded-Proto': 'https', Origin: 'https://rooms.example.com', 'Content-Type': 'application/json' };
  const health = await raw(port, { path: '/health', headers: { Host: '127.0.0.1:' + port, 'X-Forwarded-Proto': 'https' } });
  assert.equal(health.status, 200);
  const downgrade = await raw(port, { method: 'POST', path: '/api/session', headers: { ...common, 'X-Forwarded-Proto': 'http' }, body: JSON.stringify({ name: 'Alice' }) });
  assert.equal(downgrade.status, 403);
  const forged = await raw(port, { method: 'POST', path: '/api/session', headers: { ...common, Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' }, body: JSON.stringify({ name: 'Alice' }) });
  assert.equal(forged.status, 403);
  const created = await raw(port, { method: 'POST', path: '/api/session', headers: { ...common, 'Fly-Client-IP': '203.0.113.4' }, body: JSON.stringify({ name: 'Alice' }) });
  assert.equal(created.status, 200);
  assert.match(String(created.headers['set-cookie']), /Secure/);
  const cookie = String(created.headers['set-cookie']).split(';')[0];
  const csrf = created.data.csrf;
  const room = await raw(port, { method: 'POST', path: '/api/rooms', headers: { ...common, Cookie: cookie, 'X-CSRF-Token': csrf, 'Fly-Client-IP': '203.0.113.4' }, body: JSON.stringify({ title: 'Remote', agentName: 'Analyst' }) });
  assert.equal(room.status, 201);
  const guest = await raw(port, { method: 'POST', path: '/api/session', headers: { ...common, 'Fly-Client-IP': '203.0.113.5' }, body: JSON.stringify({ name: 'Bob' }) });
  const guestCookie = String(guest.headers['set-cookie']).split(';')[0];
  const joined = await raw(port, { method: 'POST', path: '/api/join', headers: { ...common, Cookie: guestCookie, 'X-CSRF-Token': guest.data.csrf, 'Fly-Client-IP': '203.0.113.5' }, body: JSON.stringify({ code: room.data.code, agentName: 'PM' }) });
  assert.equal(joined.status, 201);
  const view = await raw(port, { path: '/api/rooms/' + room.data.id, headers: { ...common, Cookie: cookie, 'Fly-Client-IP': '203.0.113.4' } });
  const waiting = view.data.participants.find(person => person.status === 'waiting');
  const admitted = await raw(port, { method: 'POST', path: '/api/rooms/' + room.data.id + '/admit', headers: { ...common, Cookie: cookie, 'X-CSRF-Token': csrf, 'Fly-Client-IP': '203.0.113.4' }, body: JSON.stringify({ memberId: waiting.id, accept: true }) });
  assert.equal(admitted.status, 200);
  const rewritten = await raw(port, { path: '/api/rooms/' + room.data.id, headers: { Host: 'internal.local', 'X-Forwarded-Host': 'rooms.example.com', 'X-Forwarded-Proto': 'https', Origin: 'https://rooms.example.com', Cookie: guestCookie } });
  assert.equal(rewritten.status, 200);
  assert.equal(rewritten.data.self.status, 'accepted');
});

test('session limits follow the forwarded client only when the proxy is trusted', async t => {
  async function burst(trusted, address) {
    const port = await listen(t, { publicOrigin: 'https://rooms.example.com', trustedProxy: trusted, rateLimit: 1000 });
    let blocked = 0;
    for (let index = 0; index < 21; index += 1) {
      const response = await raw(port, { method: 'POST', path: '/api/session', headers: { Host: 'rooms.example.com', 'X-Forwarded-Proto': 'https', Origin: 'https://rooms.example.com', 'Content-Type': 'application/json', 'X-Forwarded-For': address }, body: JSON.stringify({ name: 'Person ' + index }) });
      if (response.status === 429) blocked += 1;
    }
    return blocked;
  }
  assert.equal(await burst(true, '203.0.113.9'), 1);
  const port = await listen(t, { publicOrigin: 'https://rooms.example.com', trustedProxy: true, rateLimit: 1000 });
  const headers = { Host: 'rooms.example.com', 'X-Forwarded-Proto': 'https', Origin: 'https://rooms.example.com', 'Content-Type': 'application/json' };
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await raw(port, { method: 'POST', path: '/api/session', headers: { ...headers, 'X-Forwarded-For': '203.0.113.20' }, body: JSON.stringify({ name: 'A' + index }) })).status, 200);
  }
  assert.equal((await raw(port, { method: 'POST', path: '/api/session', headers: { ...headers, 'X-Forwarded-For': '203.0.113.20' }, body: JSON.stringify({ name: 'overflow' }) })).status, 429);
  assert.equal((await raw(port, { method: 'POST', path: '/api/session', headers: { ...headers, 'X-Forwarded-For': '203.0.113.21' }, body: JSON.stringify({ name: 'other' }) })).status, 200);
  const plain = await listen(t, { rateLimit: 1000 });
  let sawLimit = false;
  for (let index = 0; index < 21; index += 1) {
    const response = await raw(plain, { method: 'POST', path: '/api/session', headers: { Host: `127.0.0.1:${plain}`, Origin: `http://127.0.0.1:${plain}`, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.' + index }, body: JSON.stringify({ name: 'Local ' + index }) });
    if (response.status === 429) sawLimit = true;
  }
  assert.equal(sawLimit, true);
});
