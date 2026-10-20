# Agent Link: engineering and product handoff

Snapshot: October 20, 2026. This describes the standalone implementation started
October 19. Inspect current source and tests before relying on any historical result.
No credentials, personal account details, real transcripts, or private upstream
source are included in this handoff.

## Product intent

Two humans bring their own agents into a temporary shared room. Each human can
privately direct their own agent, observe shared exchanges, and approve outgoing
agent text. Joining should be as simple as sharing a code and accepting the
expected participant. The product is MIT-licensed and intended to be self-hostable.
Provider compatibility depends on the interfaces the actual agent host supports.

Keep the UI direct: two agent characters with owner labels, a dot moving on real
shared events, a transcript, a private/everyone composer, and one notification bell
near the composer. The bell contains admission and message-review actions.
Do not substitute animation for transport evidence or fabricate agent replies.

The user previously explored a call metaphor and a scripted demo, then chose a
collaborative room. Real avatars and subscriptions were deferred. Preserve the
simple orange/blue characters rather than making avatar acquisition a dependency.

## History and scope

An earlier local viewer read Neurofolio Inbox/activity records. Those included
proposals, runs, and human decisions; they were not verified direct bot-to-bot chat.
An earlier Neurofolio messaging endpoint was drafted but never deployed.

This repository is a new independent implementation, not a copy of Neurofolio's
proprietary backend. There is no Supabase or Neurofolio dependency here.
The old viewer and scripted demo remain outside this repository as backups:

| Local address | Meaning |
| --- | --- |
| `http://127.0.0.1:8766/?demo=1` | Earlier scripted visualization |
| `http://127.0.0.1:8766/` | Earlier Neurofolio activity viewer |
| `http://127.0.0.1:8770/` | This standalone room broker and UI |

These addresses do not imply processes are currently running. Loopback is not
reachable from another person's device.

## Actual implementation status

Implemented: guest sessions, room creation, invite rotation, host admission,
two human-agent pairs, separate agent keys, private human instructions, private
agent replies, shared human messages, agent proposals, owner editing/approval/
rejection, optional automatic agent sharing, revocation, expiry, polling, and
SQLite persistence. HTTP SDK and local stdio MCP connectors are included.

Also implemented in this tree: `host.mjs`, a bounded runner that uses a room key,
calls one model adapter, and submits proposals. `provider.mjs` has a deterministic
offline adapter and an OpenAI-compatible chat-completions adapter aimed at
`https://api.x.ai/v1` when `XAI_API_KEY` is set (default model id `grok-4.7`,
overridable). The automated two-host test uses the offline adapter. It covers
approval, edit, rejection, automatic sharing, the consecutive-turn cap,
cancellation, and room close. `scripts/live-room.mjs` runs that flow when a
provider key is present. Trusted-proxy mode (`TRUSTED_PROXY=1`) accepts a
forwarded HTTPS origin for a single instance. The UI labels connected, thinking,
waiting for approval, error, and budget hit from server state.

Not implemented or not verified:

- A live call to xAI or any other provider from this checkout. The adapter was
  tested with a mock HTTP client. `grok-4.7` is the model id documented by xAI
  for chat completions as of October 10, 2026, not a result from a call made here.
- Verified Grok Bot, Muse, or Dot host integrations.
- Verified accounts, SSO, account recovery, or cross-device account identity.
- Remote MCP HTTP transport and OAuth discovery.
- An actual Fly.io or Render deployment. DEPLOYMENT.md describes one; it was not run.
- Distributed rate limits or multi-instance operation.
- End-to-end encryption, payments, attachments, code execution, or billing.
- Independent security review or proof of prompt-injection immunity.

The first implementation commit was `91baebd` on `feat/secure-rooms`. At that
point the repository was local only. Consult Git remotes and hosting state for
publication status rather than treating this historical note as current status.

## Components and trust boundaries

```text
Human A browser                     Human B browser
  cookie + CSRF                       cookie + CSRF
          \                           /
          HTTP room service (server.mjs)
             authorization + SQLite
          /                           \
Agent A connector                   Agent B connector
  own room-scoped bearer key          own room-scoped bearer key
          |                           |
 host.mjs (optional)               host.mjs (optional)
  model adapter, no tools            model adapter, no tools
```

The service is a message broker and permission boundary. It does not execute model
output. `host.mjs` is a separate process: it may call a model and then submit text
through the same agent API as any other connector. Connectors retain their
credentials outside model prompts. The broker cannot secure tools that another
application exposes to an agent. This host exposes none.

| File | Responsibility |
| --- | --- |
| `server.mjs` | HTTP routing, authentication, authorization, SQLite, limits, cleanup, trusted proxy |
| `client.mjs` | HTTP SDK, redirect refusal, timeouts, bounded polling |
| `host.mjs` | Bounded runner: inbox, private instructions, model call, proposals, limits |
| `provider.mjs` | Offline adapter and OpenAI-compatible chat-completions adapter |
| `scenario.mjs` | Shared two-host flow used by the test and `scripts/live-room.mjs` |
| `mcp.mjs` | JSON-RPC stdio lifecycle and four room tools |
| `public/ui.js` | Human interaction, polling, admission, review, connection setup |
| `public/style.css` | Minimal room UI and character/activity animation |
| `test/rooms.test.mjs` | HTTP boundary, persistence, and SDK tests |
| `test/host.test.mjs` | Two-host flow, budget, backoff, cancellation, prompt fencing |
| `test/proxy.test.mjs` | Trusted HTTPS proxy and forwarded client limits |
| `test/mcp.test.mjs` | MCP subprocess integration |

## Data and lifecycle

SQLite tables:

- `sessions`: guest identity, hashed session token, CSRF value, expiration.
- `rooms`: host identity, hashed invite code, title, expiration.
- `members`: room membership, owning session, agent/display labels, admission,
  automatic-sharing preference, status, and last contact.
- `tokens`: hashed agent key, owning member, expiration.
- `events`: attributed room/private text and timestamps.
- `proposals`: owner-scoped draft, digest, pending/resolved state, expiration.
- `requests`: member-scoped request ID, payload digest, cached result for retries.

Room lifetime is one hour; guest sessions last four hours; pending proposals last
five minutes. Agent keys expire with the room. Rotating a key invalidates its
predecessor. Ending a room revokes access for both parties. Logout deletes the
rooms associated with that guest session, not merely the browser cookie.

The invite code is a join request mechanism. Host approval is still necessary.
Guest labels are not verified identities: names may be copied. Pending guests can
see limited room/participant metadata, but not message history or drafts.

## Sharing and approval semantics

Human private text goes only to that member and its agent. Shared human text is
visible to accepted participants. An agent's private reply is delivered directly
to its owner. By default, its shared reply becomes a private draft.

An approval checks owner, room, digest, pending state, and expiry. The human may
explicitly edit the final text. Publication and draft resolution are transactional.
Rejection creates private feedback. The other human cannot review that draft.

Only the owning human can enable automatic sharing. This bypasses draft review for
new shared messages from their agent. Existing drafts remain pending. This is an
intentional information-sharing tradeoff: the agent can include private context
in an automatic reply. The UI explains this before opt-in.

An idempotency key protects retries of the same agent write; it does not imply that
another model read or understood the message. A cached `awaiting_approval` result
can remain the retry result after approval; consult inbox proposal outcomes.

## Security properties and limits

Human cookies are HttpOnly and SameSite=Strict; HTTPS configuration adds Secure.
Browser writes enforce Origin and CSRF. Agent requests use separate bearer keys
and reject browser cookies. The server checks Host and Origin, validates fields
and lengths, limits request volume/storage, and renders text without interpreting
HTML. Keys and invite codes are stored as hashes.

The database stores message text and CSRF values in plaintext. The operator can
read messages. Deleting expired rows does not guarantee erasure of WAL files,
backups, browser memory, or disk snapshots.

Prompt injection is not solved by input filtering or the phrase "untrusted data."
Authorization is enforced outside the model, but a compromised agent can still
make bad content choices or misuse unrelated host tools. Use a room-specific agent
with minimal permissions and only context authorized for the collaboration.

See SECURITY.md for the full boundary and DEPLOYMENT.md for hosting requirements.

## Testing evidence

The initial full run passed 14 automated tests. Later runs add the two-host
offline scenario, budget, backoff, cancellation, prompt fencing, and trusted-proxy
checks. A manual browser/API check also created two distinct human sessions,
admitted the peer, submitted an agent message, approved it, and observed it in
the shared transcript. The offline hosts call the deterministic adapter, not a
live provider. A live provider run still has to be recorded where a key exists.

Rerun the suite for the current checkout:

```sh
node --test test/*.test.mjs
```

The persistence test creates temporary files using the OS temp directory. In a
sandbox where that directory is not writable, point TEMP/TMP to a writable test
directory for the test process. Do not weaken application security to fix a
test-environment filesystem error.

Use independent browser profiles for two humans. One browser profile shares one
session. Use fresh rooms and keys; historical test credentials expire.

## Next implementation milestones

1. A bounded runner now ships as `host.mjs`. It tracks a cursor, skips its own
   messages, handles approval and rejection, backs off on reconnect, and stops on
   close, cancellation, turn limit, or token budget. The offline two-host test
   covers that flow. A live provider call from this checkout is still unverified.
2. Provider keys stay in the host environment. Owner instructions and peer
   messages are separate fenced blocks. The fence is not injection immunity.
3. Verify a live two-model run with `node scripts/live-room.mjs` wherever a key
   is available. Record the provider, model id, and that the run actually happened.
4. Verify each advertised provider interface. A chat-completions adapter is not
   evidence that Grok Bot, Muse, or Dot can join a room.
5. Add verified identity and recovery before claiming verified human ownership.
6. Deploy the single-instance HTTPS trial described in DEPLOYMENT.md and verify
   TLS, cookies, health checks, and the persistent disk. Documentation is not a deployment.
7. Obtain an independent security review before broad public multi-tenant use.

## Safe repository handoff

Only source, synthetic tests, and sanitized documentation belong in this repo.
Never upload `.local/`, SQLite files, credentials, browser cookies, exported
private conversations, original Drive documents, or private upstream code.
Keep runtime data out of Git history, archives, screenshots, and issue comments.
An ignore file does not remove secrets that were already committed.

Preserve the distinction between a tested local prototype, a remote service, and
a verified integration. Update this document when those milestones actually land.
