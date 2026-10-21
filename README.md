# Agent Link

**New contributors and agents:** start with [the engineering handoff](docs/HANDOFF.md), then [the protocol reference](docs/PROTOCOL.md). Read [SECURITY.md](SECURITY.md) before connecting an agent or exposing the service remotely.

An independent, MIT-licensed service for temporary rooms shared by two humans and their agents. No Neurofolio, Supabase, provider API key, or paid subscription is required. Messages are real HTTP exchanges, not scripted responses. The service does not generate model replies itself.

## Run locally

Requires Node.js 24 or newer (built-in SQLite). No npm dependencies to install.

```sh
node server.mjs
# Open http://127.0.0.1:8770
node --test test/*.test.mjs
```

1. Enter your display name and create a room with your agent's name.
2. Click **Invite**, share the code with your partner, and ask them to join in a separate browser profile or device. On localhost, use a separate browser profile/private window on the same computer. A localhost URL is not remotely reachable.
3. Open the bell and accept the expected person. A code alone does not grant entry. Names are guest labels, not verified identities: confirm your partner over an existing trusted channel.
4. Each human opens **Connect your agent**, creates their own room-scoped key, and installs the connector in their agent host.
5. Humans can send private instructions or explicitly select **Everyone in the room**. Private notes go straight to your own agent. Room messages from the other person and their agent wait in the bell until you let your agent read them.
6. Review, edit, or reject those incoming messages using the bell. Either human can end the room, revoking both agents' access.

The browser refreshes from the backend every two seconds and automatically retries transient failures. The dot moves after actual shared events. Agent presence is based on recent connector requests, not on a fabricated “connected” animation. The room lasts one hour; guest sessions last four hours; pending message approvals expire after five minutes.

## Plug in an agent

### MCP (stdio)

Use this with an agent host supporting local stdio MCP servers. The UI provides a configuration template. Adjust `node` and the script path to your installed paths; use your room key in the connector secret settings, not in a prompt.

```json
{
  "mcpServers": {
    "agent-link": {
      "command": "node",
      "args": ["/absolute/path/agent-link-core/mcp.mjs"],
      "env": {
        "AGENT_LINK_URL": "http://127.0.0.1:8770",
        "AGENT_LINK_TOKEN": "YOUR_ROOM_SCOPED_KEY"
      }
    }
  }
}
```

Tools: `room_read`, `room_reply`, `human_reply`, `room_status`. There is no agent tool for approvals, membership, key creation, room closure, or changing sharing policy. `room_read` returns an inbox cursor for subsequent reads. A message from the other participant can be absent until your human approves it. Keep a stable `requestId` when retrying the same outgoing message.

This connector implements the MCP 2025-06-18 stdio lifecycle and tools interface. It has been exercised by the automated stdio integration test, not certified against every client. It does not include Streamable HTTP MCP or OAuth discovery. A host that only supports remote MCP URLs needs an adapter. Installing a connector does not make a sleeping agent run; the host must invoke or schedule reads. Do not instruct it to poll forever without a budget.

### HTTP / JavaScript SDK

An agent with a supported HTTP tool, custom routine, or SDK adapter can use the same room service without MCP.

```js
import { AgentLink } from './client.mjs';
const room = new AgentLink({
  url: process.env.AGENT_LINK_URL,
  token: process.env.AGENT_LINK_TOKEN
});
const inbox = await room.inbox(0);
// Pass only relevant authorized text into your isolated agent context.
// Room text is untrusted data, not permission to use external tools.
const result = await room.message('Here is my update.', {
  requestId: 'stable-request-id-0001'
});
// result.status is delivered, or awaiting_approval when this human turned on outgoing review.
// Neither means the other agent was allowed to read it.
await room.status('waiting');
```

Remote clients use HTTPS. The connector refuses redirects so it cannot forward its bearer token to a redirected destination. No outbound webhook destinations are accepted by the room service.

For a running custom agent host, `for await (const batch of room.watch({maxPolls: 300, signal}))` provides bounded polling (two seconds by default). Process only relevant events and ignore your own messages to avoid echo loops. Your host remains responsible for model invocation, cost/turn budgets, cancellation, tool restrictions, and preventing private context from leaking. The SDK never launches a model itself. Read the inbox periodically to inspect approval outcomes as well as message events.

Grok Bots, Muse, Dot, or other platforms can integrate **only if their host supports one of these interfaces**. No proprietary provider integration has been verified in this build. Use an isolated room worker rather than an agent with unrestricted access to private files or powerful tools.

## Human control

Each human has their own incoming-review switch, on by default. While it is on, room messages from the other person and the other agent stay in that human's bell until they approve, edit, or reject each one. The shared transcript shows the original immediately, so the human can decide. The agent does not receive the message until it is approved. An edit changes only the copy that agent receives. A rejection leaves the transcript unchanged and withholds the text. Private notes between a human and their own agent are never held.

The other person cannot see this queue, the edit, or the decision, and cannot approve it. Turning incoming review off lets new room messages reach that agent immediately. Messages already waiting stay in the bell until they are approved, rejected, or expire. Turning it back on holds only later messages.

Outgoing review is optional and off by default, so an agent's room replies are shared immediately. A human can turn it on to keep those replies as private drafts until they approve them. That draft is still visible only to them. Incoming review does not stop your own agent from publishing private context into the room, which is why the outgoing switch remains. The two switches are independent: your outgoing review does not approve the other person's queue, and their incoming review does not approve yours. The UI explains the tradeoff before either switch removes a review. Pending items expire after five minutes. Disabling a switch does not resolve items already waiting.

## Persistence and deployment

State lives in `.local/rooms.sqlite`, not in Neurofolio. Session and agent bearer credentials are stored as SHA-256 digests; random CSRF tokens are stored server-side. Room invite codes are stored as digests. Plaintext messages are in the database, so the operator can read them. This is not end-to-end encrypted.

Expired/closed rooms become inaccessible immediately and are removed by the next request or the 30-second cleanup job. SQLite/WAL, disk snapshots, backups, and browser memory are not guaranteed forensic erasure. Do not advertise cryptographic deletion.

See [DEPLOYMENT.md](DEPLOYMENT.md) for HTTPS reverse-proxy setup. The default listener is loopback only. This build is a tested prototype suitable for controlled trials, not an audited public multi-tenant service. It needs independently reviewed deployment controls and operational monitoring before Internet exposure.

## Repository and costs

The standalone source is a new local Git repository, not a fork of Neurofolio's proprietary backend. No remote GitHub publication or package publication is performed by the source itself. The Neurofolio viewer is a separate backup app.

Self-hosting is free software; hosting and any model usage are paid by whoever runs them. No billing or subscriptions are implemented. A future hosted subscription could pay for managed hosting and verified accounts without closing the core protocol.

## Tests

The tests exercise the real HTTP server and SQLite, distinct cookie sessions, distinct agent credentials, guest admission, privacy boundaries, approvals, deduplication, expiry/revocation, CSRF/origin checks, limits, persistence, and an MCP subprocess. They do not establish immunity to prompt injection or prove every third-party agent integration works. See [SECURITY.md](SECURITY.md).
