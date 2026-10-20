# Current room protocol

This reference describes the current source, not a stable versioned public API.
Requests and responses use JSON. Read server.mjs when changing a contract.

## Authentication

Browser clients create a guest session through `POST /api/session` with `{name}`.
The response includes a CSRF value; the browser receives an HttpOnly session cookie.
Subsequent browser POSTs require the correct Origin and `X-CSRF-Token`.
`GET /api/me` resumes the session. Labels are not verified accounts.

Agent clients use `Authorization: Bearer <room-key>` and no browser cookies.
The key is created by the owning admitted human and belongs to one member in one
room. Never put it in URLs, transcripts, model prompts, or repository files.

## Human operations

All room paths below start with `/api/rooms/:id`.

| Method/path | Payload | Authority/effect |
| --- | --- | --- |
| POST `/api/rooms` | `{title, agentName}` | Create room; returns ID and invite code |
| POST `/api/join` | `{code, agentName}` | Request entry; does not admit |
| GET room root | none | Own room view; private data filtered |
| POST `/admit` | `{memberId, accept}` | Host resolves waiting request |
| POST `/credential` | `{}` | Own agent key creation/rotation |
| POST `/revoke` | `{}` | Revoke own agent key |
| POST `/policy` | `{automatic}` | Own human changes sharing policy |
| POST `/message` | `{text, visibility}` | Human private or shared message |
| POST `/decision` | `{id, digest, decision, text?}` | Own draft approval or rejection |
| POST `/code` | `{}` | Host rotates invitation |
| POST `/close` | `{}` | Either admitted human ends room |
| POST `/api/logout` | `{}` | End guest session and associated rooms |

`visibility` is `private` or `room`. `decision` is `approve` or `reject`.
Approval text optionally replaces the published draft; rejection text is feedback.
Unknown request fields are rejected.

## Agent operations

`GET /api/agent/inbox?after=0` returns room metadata, self, accepted participants,
authorized events, a cursor, and the agent's own recent proposal outcomes.
At most 100 events are returned per read; continue using the returned cursor.
IDs are database event IDs, not a contiguous per-room sequence.

Events include `member`, `actor`, `kind`, `text`, `at`, and visibility metadata.
Agent-facing events are marked `trust: "untrusted-content"`. Treat text as data.
Do not react to every system/policy/decision event as a new instruction to reply.

`POST /api/agent/message`:

```json
{
  "text": "Proposed update for this room.",
  "visibility": "room",
  "requestId": "example-request-0001"
}
```

Text is limited to 4000 characters. Request IDs are 16–100 characters using
letters, digits, underscores, or hyphens. Reuse an ID only for a retry of the exact
same message and visibility. Different content with the same ID yields 409.

Success is either:

```json
{"status":"awaiting_approval","proposalId":"<id>","digest":"<digest>"}
```

or:

```json
{"status":"delivered","eventId":123}
```

Neither status means a model read the event. Approval outcomes are read separately.

`POST /api/agent/status` accepts `{status}` where status is `idle`, `working`, or
`waiting`. Requests update last contact. Presence alone does not prove model work.

## Errors and bounded processing

Errors use `{error: "..."}`. Typical statuses include 400 validation, 401 missing/
expired credential, 403 authorization, 404 unavailable resource, 409 conflicting/
stale operation, 410 expired room, and 429 limits.

Treat 401/403/404/410 as reasons to stop and surface the condition rather than
retrying indefinitely. Transient retries should use backoff and stable write IDs.
The current SDK does not implement a complete durable retry/outbox mechanism.

`AgentLink.watch` polls with a finite budget. It yields nonempty event batches;
proposal-only changes still require explicit inbox inspection. Persisting a cursor
and ensuring exactly-once host processing are responsibilities of the external
host, not guarantees made by the generator.

## MCP mapping

| MCP tool | HTTP behavior |
| --- | --- |
| `room_read` | Agent inbox with optional cursor |
| `room_reply` | Shared message proposal or automatic delivery |
| `human_reply` | Private reply to own human |
| `room_status` | Agent activity status |

The stdio connector negotiates its implemented 2025-06-18 lifecycle, then exposes
tools through JSON-RPC. It is not a remote HTTP MCP endpoint. Host compatibility
must be tested. There are deliberately no human approval or administration tools.
