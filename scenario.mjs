import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './server.mjs';
import { AgentLink } from './client.mjs';
import { runHost } from './host.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(label, timeout, fn, hosts, failure) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (failure.error) throw failure.error;
    for (const host of hosts) {
      if (host.settled && !host.expectedStop) throw new Error(`${host.name} stopped early (${host.settled.reason})`);
    }
    const value = await fn();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function tracked(provider) {
  const calls = [];
  return {
    calls,
    provider: {
      name: provider.name,
      async complete(input) {
        calls.push(input);
        return provider.complete(input);
      }
    }
  };
}

/**
 * One room, two hosts. Covers approval, edit, rejection, automatic sharing,
 * the consecutive-turn limit, cancellation, and room close.
 */
export async function runTwoAgentScenario({
  providerFor,
  live = false,
  pollMs = 25,
  stepTimeout = 5000,
  quietMs = 800,
  maxTokens = 20000,
  maxTurns = 8,
  maxConsecutiveAgentTurns = 3
} = {}) {
  if (typeof providerFor !== 'function') throw new Error('providerFor is required');
  const app = createApp({ rateLimit: 100000 });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const url = `http://127.0.0.1:${app.address().port}`;
  const hosts = [];
  const failure = { error: null };
  const expect = (actual, exact) => { if (live) assert.ok(typeof actual === 'string' && actual.trim()); else assert.equal(actual, exact); };

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
    const init = await request('/api/session', { name });
    assert.equal(init.status, 200);
    csrf = init.data.csrf;
    return { request };
  }

  try {
    const alice = await human('Alice');
    const bob = await human('Bob');
    const created = await alice.request('/api/rooms', { title: 'Launch plan', agentName: 'Analyst' });
    assert.equal(created.status, 201);
    const path = `/api/rooms/${created.data.id}`;
    const joined = await bob.request('/api/join', { code: created.data.code, agentName: 'PM' });
    assert.equal(joined.status, 201);
    const waiting = (await alice.request(path)).data.participants.find(person => person.status === 'waiting');
    assert.equal((await alice.request(path + '/admit', { memberId: waiting.id, accept: true })).status, 200);
    async function keyFor(person) {
      const credential = await person.request(path + '/credential', {});
      assert.equal(credential.status, 201);
      return new AgentLink({ url, token: credential.data.token });
    }
    const aliceLink = await keyFor(alice);
    const bobLink = await keyFor(bob);
    const aliceModel = tracked(providerFor('Analyst'));
    const bobModel = tracked(providerFor('PM'));
    const startHost = (name, link, model) => {
      const controller = new AbortController();
      const entry = { name, controller, calls: model.calls, settled: null, expectedStop: false };
      entry.done = runHost({
        link,
        provider: model.provider,
        signal: controller.signal,
        pollMs,
        maxTurns,
        maxTokens,
        maxConsecutiveAgentTurns,
        log: () => {}
      }).then(result => { entry.settled = result; return result; }, error => { failure.error = error; throw error; });
      hosts.push(entry);
      return entry;
    };
    const aliceHost = startHost('Analyst', aliceLink, aliceModel);
    const bobHost = startHost('PM', bobLink, bobModel);
    const room = () => alice.request(path).then(result => result.data);
    await waitFor('both agents to connect', stepTimeout, async () => {
      const data = await room();
      const accepted = data.participants.filter(person => person.status === 'accepted');
      return accepted.length === 2 && accepted.every(person => person.agentStatus === 'idle' && Date.now() - person.lastSeen < 20000) ? data : null;
    }, hosts, failure);

    await alice.request(path + '/message', { text: 'Introduce the launch plan', visibility: 'private' });
    const firstDraft = await waitFor('Alice proposal', stepTimeout, async () => {
      const data = await room();
      return data.proposals[0]?.text ? data.proposals[0] : null;
    }, hosts, failure);
    expect(firstDraft.text, 'Reply to: Introduce the launch plan');
    const beforeApproval = await room();
    assert.ok(beforeApproval.events.every(event => event.text !== firstDraft.text));
    const bobView = await bob.request(path);
    assert.ok(!bobView.data.events.some(event => event.text === firstDraft.text));
    assert.equal(bobView.data.proposals.length, 0);
    assert.equal((await bob.request(path + '/decision', { id: firstDraft.id, digest: firstDraft.digest, decision: 'approve', text: 'Edited launch plan' })).status, 404);
    await waitFor('Alice waiting for approval', stepTimeout, async () => (await room()).self.agentStatus === 'waiting' ? true : null, hosts, failure);
    assert.equal((await alice.request(path + '/decision', { id: firstDraft.id, digest: firstDraft.digest, decision: 'approve', text: 'Edited launch plan' })).status, 200);
    const published = await waitFor('edited message', stepTimeout, async () => (await room()).events.find(event => event.text === 'Edited launch plan') || null, hosts, failure);
    assert.equal(published.kind, 'approved-message');
    assert.ok(!(await room()).events.some(event => event.text === firstDraft.text));

    const bobDraft = await waitFor('Bob proposal', stepTimeout, async () => {
      const data = (await bob.request(path)).data;
      return data.proposals[0]?.text ? data.proposals[0] : null;
    }, hosts, failure);
    expect(bobDraft.text, 'Reply to: Edited launch plan');
    assert.equal((await bob.request(path + '/decision', { id: bobDraft.id, digest: bobDraft.digest, decision: 'reject', text: 'mention budget' })).status, 200);
    const revision = await waitFor('revised proposal', stepTimeout, async () => {
      const proposal = (await bob.request(path)).data.proposals.find(item => item.id !== bobDraft.id);
      return proposal?.text ? proposal : null;
    }, hosts, failure);
    expect(revision.text, 'Revised: mention budget');
    assert.equal((await alice.request(path + '/policy', { automatic: true })).status, 200);
    assert.equal((await bob.request(path + '/decision', { id: revision.id, digest: revision.digest, decision: 'approve', text: revision.text })).status, 200);

    const autoReply = await waitFor('automatic reply', stepTimeout, async () => {
      const data = await room();
      if (data.proposals.length) return null;
      return data.events.find(event => event.actor === 'agent' && event.kind === 'message' && event.member === data.self.id && event.text !== 'Edited launch plan') || null;
    }, hosts, failure);
    if (live) assert.ok(autoReply.text.trim());
    else assert.equal(autoReply.text, `Reply to: ${revision.text}`);
    const shared = () => room().then(data => data.events.filter(event => !event.private_to && event.actor === 'agent'));
    const beforeQuiet = (await shared()).length;
    assert.equal(beforeQuiet, 3);
    const aliceCalls = aliceHost.calls.length;
    const bobCalls = bobHost.calls.length;
    await delay(quietMs);
    assert.equal((await shared()).length, beforeQuiet);
    assert.equal(aliceHost.calls.length, aliceCalls);
    assert.equal(bobHost.calls.length, bobCalls);
    if (!live) {
      assert.equal(aliceCalls, 2);
      assert.equal(bobCalls, 2);
    }

    aliceHost.expectedStop = true;
    aliceHost.controller.abort();
    const aliceResult = await aliceHost.done;
    assert.equal(aliceResult.reason, 'cancelled');
    const aliceId = (await room()).self.id;
    const aliceMessages = (await shared()).filter(event => event.member === aliceId).length;
    await alice.request(path + '/message', { text: 'A human is here', visibility: 'room' });
    const afterHuman = await waitFor('Bob reply to a human', stepTimeout, async () => {
      const proposal = (await bob.request(path)).data.proposals[0];
      return proposal?.text ? proposal : null;
    }, hosts, failure);
    expect(afterHuman.text, 'Reply to: A human is here');
    assert.equal((await shared()).filter(event => event.member === aliceId).length, aliceMessages);
    assert.equal((await room()).self.automatic, true);
    assert.equal((await bob.request(path)).data.self.automatic, false);

    bobHost.expectedStop = true;
    assert.equal((await bob.request(path + '/close', {})).status, 200);
    const bobResult = await bobHost.done;
    assert.equal(bobResult.reason, 'closed');
    assert.equal((await alice.request(path)).status, 410);
    return { alice: aliceResult, bob: bobResult, aliceCalls: aliceHost.calls.length, bobCalls: bobHost.calls.length };
  } finally {
    for (const host of hosts) host.controller.abort();
    await Promise.allSettled(hosts.map(host => host.done));
    if (app.listening) await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
  }
}
