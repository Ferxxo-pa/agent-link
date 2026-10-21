import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLink } from '../client.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('the real server lets two people and two connectors exchange messages through incoming review', async t => {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'agent-link-e2e-'));
  const url = `http://127.0.0.1:${port}`;
  const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
  let output = '';
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: url, AGENT_LINK_DATA: dir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 50; i++) {
    try {
      const health = await fetch(url + '/health');
      if (health.ok) break;
    } catch { /* The process is still binding. */ }
    if (child.exitCode !== null) throw new Error(output || 'server exited');
    await new Promise(resolve => setTimeout(resolve, 50));
    if (i === 49) throw new Error(output || 'server did not start');
  }
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'rooms.sqlite'))).mode & 0o777, 0o600);

  async function human(name) {
    let cookie = '';
    let csrf = '';
    const request = async (path, body) => {
      const response = await fetch(url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: url, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    };
    const session = await request('/api/session', { name });
    assert.equal(session.status, 200);
    csrf = session.data.csrf;
    return { request };
  }

  const ada = await human('Ada');
  const bo = await human('Bo');
  const created = await ada.request('/api/rooms', { title: 'Status check', agentName: 'Ada agent' });
  assert.equal(created.status, 201);
  const path = '/api/rooms/' + created.data.id;
  assert.equal((await bo.request('/api/join', { code: created.data.code, agentName: 'Bo agent' })).status, 201);
  const waiting = (await ada.request(path)).data.participants.find(person => person.status === 'waiting');
  assert.equal((await ada.request(path + '/admit', { memberId: waiting.id, accept: true })).status, 200);
  assert.equal((await ada.request(path)).data.participants.filter(person => person.status === 'accepted').length, 2);
  assert.equal((await ada.request(path)).data.participants.every(person => person.connectorRecent === false), true);

  async function keyFor(person) {
    const credential = await person.request(path + '/credential', {});
    assert.equal(credential.status, 201);
    assert.equal(credential.data.token.includes(' '), false);
    return new AgentLink({ url, token: credential.data.token });
  }
  const adaLink = await keyFor(ada);
  const boLink = await keyFor(bo);
  await ada.request(path + '/message', { text: 'Ask for a one-line status', visibility: 'private' });
  const adaInbox = await adaLink.inbox(0);
  assert.equal(adaInbox.self.agentName, 'Ada agent');
  assert.equal(adaInbox.self.connectorRecent, true);
  assert.equal(adaInbox.self.incomingReview, true);
  assert.equal(adaInbox.self.outgoingReview, false);
  assert.ok(adaInbox.events.some(event => event.text === 'Ask for a one-line status' && event.visibility === 'private'));
  const afterAda = await ada.request(path);
  assert.equal(afterAda.data.participants.find(person => person.agentName === 'Ada agent').connectorRecent, true);
  assert.equal(afterAda.data.participants.find(person => person.agentName === 'Bo agent').connectorRecent, false);
  assert.equal((await boLink.inbox(0)).events.some(event => event.text === 'Ask for a one-line status'), false);
  const sent = await adaLink.message('Status: ready', { requestId: 'ada-status-00000001' });
  assert.equal(sent.status, 'delivered');
  const boView = await bo.request(path);
  assert.equal(boView.data.events.some(event => event.text === 'Status: ready' && event.kind === 'message'), true);
  assert.equal(JSON.stringify(await boLink.inbox(0)).includes('Status: ready'), false);
  const hold = boView.data.holds.find(item => item.text === 'Status: ready');
  assert.ok(hold);
  assert.equal((await ada.request(path + '/decision', { id: hold.id, digest: hold.digest, decision: 'approve', text: 'Status: ready to start' })).status, 404);
  assert.equal((await bo.request(path + '/decision', { id: hold.id, digest: hold.digest, decision: 'approve', text: 'Status: ready to start' })).status, 200);
  const shared = (await boLink.inbox(0)).events.find(event => event.text === 'Status: ready to start');
  assert.equal(shared.edited, true);
  assert.equal(shared.actor, 'agent');
  assert.equal(shared.kind, 'message');
  const afterRelease = await bo.request(path);
  assert.equal(afterRelease.data.events.some(event => event.text === 'Status: ready'), true);
  assert.equal(afterRelease.data.events.some(event => event.text === 'Status: ready to start'), false);
  assert.equal(JSON.stringify(await adaLink.inbox(0)).includes('Status: ready to start'), false);
  const reply = await boLink.message('Acknowledged', { requestId: 'bo-ack-000000000001' });
  assert.equal(reply.status, 'delivered');
  assert.equal((await ada.request(path)).data.proposals.length, 0);
  assert.equal((await ada.request(path)).data.events.filter(event => event.text === 'Acknowledged').length, 1);
  assert.equal(JSON.stringify(await adaLink.inbox(0)).includes('Acknowledged'), false);
  const adaHold = (await ada.request(path)).data.holds.find(item => item.text === 'Acknowledged');
  assert.ok(adaHold);
  assert.equal((await ada.request(path + '/decision', { id: adaHold.id, digest: adaHold.digest, decision: 'approve' })).status, 200);
  const acknowledged = (await adaLink.inbox(0)).events.find(event => event.text === 'Acknowledged');
  assert.equal(acknowledged.kind, 'message');
  assert.equal(acknowledged.edited, undefined);
  assert.equal((await ada.request(path + '/close', {})).status, 200);
  await assert.rejects(adaLink.inbox(), error => error.status === 401);
  await assert.rejects(boLink.inbox(), error => error.status === 401);
  assert.equal((await bo.request(path)).status, 410);
  assert.equal(/api[_-]?key|sk-|xai-|Bearer [A-Za-z0-9_-]{20,}/i.test(output), false);
});

test('the server process refuses a non-loopback listener without https', async () => {
  const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: '8791', PUBLIC_ORIGIN: 'http://example.com' },
    stdio: 'ignore'
  });
  const code = await Promise.race([
    new Promise(resolve => child.on('exit', resolve)),
    new Promise(resolve => setTimeout(() => { child.kill(); resolve('timeout'); }, 3000))
  ]);
  assert.equal(typeof code, 'number');
  assert.notEqual(code, 0);
});
