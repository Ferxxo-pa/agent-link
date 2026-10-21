# Agent Link: engineering and product handoff

Snapshot: October 21, 2026. This describes the standalone implementation started
October 19. Inspect current source and tests before relying on any historical result.
No credentials, personal account details, real transcripts, or private upstream
source are included in this handoff.

## Product intent

Two humans bring their own agents into a temporary shared room. Each human can
privately direct their own agent, observe shared exchanges, and decide which
incoming room messages their own agent is allowed to read. Joining should be as
simple as sharing a code and accepting the expected participant. The product is
MIT-licensed and intended to be self-hostable.
Provider compatibility depends on the interfaces the actual agent host supports.

Keep the UI direct: two agent characters with owner labels, a transcript, a
private/everyone composer, and one notification bell near the composer. The bell
contains admission, incoming-message review, and optional outgoing-draft actions.
The characters stay still. A dot appears only for a few seconds after a real
shared message (`message`, `approved-message`, or `approved-edited-message`),
timed from the server clock. Connector text says “No recent connector” until
that member’s key makes a request, then “Connector reports” plus the status the
connector sent. That status is self-reported. Do not substitute animation for
transport evidence or fabricate agent replies.

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
agent replies, shared human messages, per-human incoming review (approve, edit,
or reject before that human's agent can read the other party's room messages),
optional outgoing drafts, owner editing/approval/rejection, revocation, expiry,
polling, and SQLite persistence. HTTP SDK and local stdio MCP connectors are included.

Not implemented or not verified:

- Model invocation or an autonomous agent runner.
- A real two-model conversation through this standalone broker.
- Verified Grok Bot, Muse, or Dot host integrations.
- Verified accounts, SSO, account recovery, or cross-device account identity.
- Remote MCP HTTP transport and OAuth discovery.
- Public HTTPS deployment, distributed rate limits, or multi-instance operation.
- End-to-end encryption, payments, attachments, code execution, or billing.
- Independent security review or proof of prompt-injection immunity.

Publication history is the commits on `main`. This repository has no
`feat/secure-rooms` branch. An earlier note that named commit `91baebd` does
not match any commit in this tree. Consult Git remotes for publication status.

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
 external agent host                external agent host
 (not included)                     (not included)
```

The service is a message broker and permission boundary. It does not execute model
output. Connectors retain their credentials outside model prompts. The external
host controls model invocation and unrelated tools; the broker cannot secure tools
that another application exposes to an agent.

| File | Responsibility |
| --- | --- |
| `server.mjs` | HTTP routing, authentication, authorization, SQLite, limits, cleanup |
| `client.mjs` | HTTP SDK, redirect refusal, timeouts, bounded polling |
| `mcp.mjs` | JSON-RPC stdio lifecycle and four room tools |
| `public/ui.js` | Human interaction, polling, admission, review, connection setup |
| `public/style.css` | Minimal room UI. Characters are static. The packet stays hidden until a real shared message |
| `test/rooms.test.mjs` | HTTP boundary, persistence, and SDK tests |
| `test/mcp.test.mjs` | MCP subprocess integration |

## Data and lifecycle

SQLite tables:

- `sessions`: guest identity, hashed session token, CSRF value, expiration.
- `rooms`: host identity, hashed invite code, title, expiration.
- `members`: room membership, owning session, agent/display labels, admission,
  incoming-review and outgoing-review switches, status, and last contact.
  Older files may still contain an unused `automatic` column. On first open it is
  copied into `outgoing_review` (the old default of review-before-send becomes
  outgoing review on). New members default to incoming review on and outgoing
  review off.
- `tokens`: hashed agent key, owning member, expiration.
- `events`: attributed room/private text and timestamps. This is the human transcript.
- `holds`: recipient-scoped incoming copies, digest, pending/resolved state, expiration.
- `releases`: per-agent inbox rows. The inbox cursor is a release id. A held message
  appears here only after that human approves it, which is why it can surface
  behind a cursor the agent has already consumed.
- `proposals`: owner-scoped outgoing draft, digest, pending/resolved state, expiration.
- `requests`: member-scoped request ID, payload digest, cached result for retries.

Room lifetime is one hour; guest sessions last four hours; pending holds and
outgoing drafts last five minutes. Agent keys expire with the room. Rotating a key
invalidates its predecessor. Ending a room revokes access for both parties. Logout
deletes the rooms associated with that guest session, not merely the browser cookie.

The invite code is a join request mechanism. Host approval is still necessary.
Guest labels are not verified identities: names may be copied. Pending guests can
see limited room/participant metadata, but not message history or drafts.

## Sharing and approval semantics

Human private text goes only to that member and its agent. It never waits for
approval. Shared human text is visible to accepted humans immediately. An agent's
private reply is delivered directly to its owner. An agent's shared reply is also
visible to accepted humans immediately, unless that human turned on outgoing review.
In that case it stays a private draft until the owner approves or rejects it.

Incoming review is on by default and is the gate in front of each agent. A room
message from the other human or the other agent is held until the receiving human
approves, edits, or rejects it. Approval gives that agent a copy. An edit changes
only that copy; the transcript keeps the original words, so the other side cannot
see the revision. Rejection withholds the text. The sender cannot see or decide
the hold. Own messages are released to one's own agent without this wait. Messages
that arrived before a guest was admitted are held for that guest when they join.

Turning incoming review off applies to messages that arrive afterward. Items
already waiting stay pending until approved, rejected, or expired. Turning it on
again does not pull back copies the agent already received.

Outgoing review stays available because incoming review does not stop an agent
from publishing private context into the room. It is off by default: the owner
asked for outgoing replies to stop requiring approval unless the human opts back
in. The two switches do not cross owners. If both are on, the sender's human
clears the draft first and the recipient's human still clears the agent's copy.
Changing a switch does not resolve items already waiting. The UI explains each
direction before a human removes that review.

An approval checks the owning human, room, digest, pending state, and expiry.
Publication or release, and resolution of the pending row, are transactional.
The other human cannot review that row.

An idempotency key protects retries of the same agent write; it does not imply that
another model read or understood the message. `delivered` means the transcript
accepted the text, not that the other agent can read it. A cached
`awaiting_approval` result can remain the retry result after an outgoing draft is
approved; consult inbox proposal outcomes.

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

The automated suite covers incoming review, edited agent-only copies, rejection,
the two per-human switches, legacy outgoing-review migration, concurrent admit
and draft decisions, loopback host checks, data-directory permissions, the MCP
connector, and a spawned two-person exchange. On October 21, 2026 that suite
was 22 tests. Rerun it and use the count it prints. The author of the incoming-review commit reported a local browser pass
that edited and approved an incoming room message, confirmed the transcript kept
the original wording, turned incoming review off, and saw the next room message
arrive with no hold. That report used a test connector with no model attached.
A separate October 21 two-profile browser check covered the earlier
outgoing-approval page and did not exercise incoming holds. A later headless
two-profile pass on this checkout confirmed the server-status header, the
two-person label, a static character, a hidden packet until a real shared
message, the connector placeholder, and one edited incoming release that left
the transcript unchanged. Neither check is a real two-model conversation.

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

1. Implement a bounded external agent runner or integrate a real host. Track
   cursors, avoid self-message echoes, process review outcomes, retry safely, and
   stop on expiration, revocation, cancellation, or budget exhaustion.
2. Keep provider keys in trusted host configuration. Separate private instructions
   from shared context. Do not pass every room event into a privileged system prompt.
3. Test two real instances end to end: private direction, incoming hold,
   edit/approval/rejection, incoming-review off, optional outgoing review,
   reconnect, and shutdown.
4. Verify each advertised provider interface. A generic MCP connector is not
   evidence that a closed agent product supports it.
5. Add verified identity and recovery before claiming verified human ownership.
6. Deploy a controlled single-instance HTTPS trial with restricted storage,
   operational monitoring, edge limits, and reviewed retention.
7. Obtain an independent security review before broad public multi-tenant use.

## Safe repository handoff

Only source, synthetic tests, and sanitized documentation belong in this repo.
Never upload `.local/`, SQLite files, credentials, browser cookies, exported
private conversations, original Drive documents, or private upstream code.
Keep runtime data out of Git history, archives, screenshots, and issue comments.
An ignore file does not remove secrets that were already committed.

Preserve the distinction between a tested local prototype, a remote service, and
a verified integration. Update this document when those milestones actually land.
