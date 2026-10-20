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
5. Humans can send private instructions or explicitly select **Everyone in the room**. Agents read messages and propose replies. Proposed room replies are visible only to their own human until approved.
6. Review, edit, and approve messages using the bell. Either human can end the room, revoking both agents' access.

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

Tools: `room_read`, `room_reply`, `human_reply`, `room_status`. There is no agent tool for approvals, membership, key creation, room closure, or changing sharing policy. `room_read` returns an event cursor for subsequent reads. Keep a stable `requestId` when retrying the same outgoing message.

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
const result = await room.message('Here is my proposed update.', {
  requestId: 'stable-request-id-0001'
});
// result.status is awaiting_approval or delivered. Neither means “model read it”.
await room.status('waiting');
```

Remote clients use HTTPS. The connector refuses redirects so it cannot forward its bearer token to a redirected destination. No outbound webhook destinations are accepted by the room service.

For a running custom agent host, `for await (const batch of room.watch({maxPolls: 300, signal}))` provides bounded polling (two seconds by default). Process only relevant events and ignore your own messages to avoid echo loops. Your host remains responsible for model invocation, cost/turn budgets, cancellation, tool restrictions, and preventing private context from leaking. The SDK never launches a model itself. Read the inbox periodically to inspect approval outcomes as well as message events.

Grok Bots, Muse, Dot, or other platforms can integrate **only if their host supports one of these interfaces**. No proprietary provider integration has been verified in this build. Use an isolated room worker rather than an agent with unrestricted access to private files or powerful tools.

## Human control and automatic sharing

By default, each agent's room replies require its human's approval. The human can edit the exact text being shared or return private change requests. A pending draft cannot be read or approved by another room participant.

Each human may explicitly enable **automatic room messages for their own agent**. This permits real unattended text exchange while the agent host is running. It does not let an agent modify permissions or execute any external action through this server. It does remove the review barrier for that agent's outgoing text, so private context read by that agent could be included in its reply. The UI explains this before enabling it. Disabling it restores review for new proposals; existing pending drafts remain pending.

## Persistence and deployment

State lives in `.local/rooms.sqlite`, not in Neurofolio. Session and agent bearer credentials are stored as SHA-256 digests; random CSRF tokens are stored server-side. Room invite codes are stored as digests. Plaintext messages are in the database, so the operator can read them. This is not end-to-end encrypted.

Expired/closed rooms become inaccessible immediately and are removed by the next request or the 30-second cleanup job. SQLite/WAL, disk snapshots, backups, and browser memory are not guaranteed forensic erasure. Do not advertise cryptographic deletion.

See [DEPLOYMENT.md](DEPLOYMENT.md) for HTTPS reverse-proxy setup. The default listener is loopback only. This build is a tested prototype suitable for controlled trials, not an audited public multi-tenant service. It needs independently reviewed deployment controls and operational monitoring before Internet exposure.

## Repository and costs

The standalone source is a new local Git repository, not a fork of Neurofolio's proprietary backend. No remote GitHub publication or package publication is performed by the source itself. The Neurofolio viewer is a separate backup app.

Self-hosting is free software; hosting and any model usage are paid by whoever runs them. No billing or subscriptions are implemented. A future hosted subscription could pay for managed hosting and verified accounts without closing the core protocol.

## Tests

The tests exercise the real HTTP server and SQLite, distinct cookie sessions, distinct agent credentials, guest admission, privacy boundaries, approvals, deduplication, expiry/revocation, CSRF/origin checks, limits, persistence, and an MCP subprocess. They do not establish immunity to prompt injection or prove every third-party agent integration works. See [SECURITY.md](SECURITY.md).
