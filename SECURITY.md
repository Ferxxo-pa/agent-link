# Security model and remaining work

## What is enforced outside the model

- A room code is a request-to-join mechanism. An admitted host must approve the second human. Pending guests get metadata about accepted participants, not messages or drafts.
- A browser session owns one member identity. There is no client-controlled sender or owner field.
- An agent token belongs to exactly one admitted member and expires with that room. Rotation removes previous tokens. Either human can end the room. Tokens cannot approve, admit, close, create credentials, or change sharing policy.
- Every read filters private content by member identity. Human and agent writes enforce their own role, size, visibility, and review switches. Review switches are returned only on the caller's own member, not on other participants.
- Incoming review defaults to on. A room message from the other human or the other agent creates a hold that only the receiving human can list, approve, edit, or reject. Approval checks that human, the room, the content digest, expiration, and pending state, then writes a copy into that agent's inbox in the same transaction. An edit does not rewrite the shared transcript. Rejection records a private notice that does not include the withheld text. The sender cannot see the hold or learn the decision from this service.
- Outgoing review defaults to off. When a human turns it on, their agent's room reply stays a private draft. Draft approval checks the owner, room, content digest, expiration, and pending state. The human may edit the text that gets published. Publishing and resolving the draft occur in one database transaction. The other human still cannot see or approve that draft. After publication, the recipient's incoming review applies separately.
- Private messages between a human and their own agent never create a hold. Own room messages are released to that human's own agent without waiting.
- Stable outgoing agent request IDs are unique per agent member. Reusing an ID with different text fails. Delivery retries return the original result; an outgoing proposal's later outcome is available separately through inbox reads. `delivered` is not evidence that the other agent was allowed to read the event.
- Same-origin browser writes require a session CSRF token. Cookies are HttpOnly and SameSite=Strict, plus Secure when configured for HTTPS. Host/origin checks and no permissive CORS restrict browser cross-origin access.
- UI text is rendered through textContent, not interpreted HTML. A restrictive CSP blocks inline scripts, frames, and external resources.
- Per-session/per-agent rate limits, request sizes, room count, join count, message count, pending outgoing-draft count, and expiration bound single-process storage and request load. Pending incoming holds are bounded by the room message cap and expire with the same five-minute limit. Startup requires HTTPS configuration for non-loopback use.

## What is not claimed

Prompt injection cannot be eliminated by this service. Peer messages and tool results are untrusted. An external agent can still be manipulated into reasoning badly or misusing unrelated tools that its host gives it. Prefer a room-specific agent with no external tools or private credentials. Do not allow model output to become instructions for a privileged executor.

Incoming review is the default gate, and it protects the agent rather than the human. Both humans still see room text immediately, because the receiving human has to read it in order to approve it. Approved text remains untrusted data. `edited: true` means the receiving human changed the copy their agent reads; the original sender did not write that revision. Rejecting a hold does not unsend the transcript line.

Turning incoming review off removes that gate for later messages. It does not release messages already waiting, and it does not make prompt injection impossible. The other party's incoming review never stops your agent from putting private context into a room reply.

Outgoing review remains an optional, default-off control for that second leak. It is not required for the receiving-side gate to work. Leaving it off means an agent reply can reach the other human, and that human's agent if their incoming review is off, before the sending human has read it. Turning it on restores a private draft for the sender only. Neither switch is a guarantee of safe content. Any participant can manually disclose information they know. Approved text is attributed, not certified as truthful or harmless.

Guest sessions are not verified accounts. Display names can be copied. Confirm the expected guest outside the room before admitting them. There is no SSO, email verification, identity recovery, or cross-device account login. This is a deliberate prototype limit, not production identity assurance.

The operator and anyone with database/file access can read messages. Local HTTP is only suitable on loopback. Remote use requires HTTPS and a private application listener behind a correctly configured proxy. The service does not implement E2EE, attachments, arbitrary webhooks, payment execution, code execution, or tool execution. No raw provider credentials are needed by the broker.

## Before public multi-tenant hosting

Add verified identities and recovery, distributed edge rate limiting, abuse controls, retention/backup policy, monitored deployments, secure secret management, a reviewed container/host configuration, and a security review. Test TLS proxy configuration, cookie behavior, multiple instances, database failure, and client compatibility. The current SQLite/rate limiter is designed for one process. Browser sessions on one browser profile represent one human; use separate profiles/devices to test distinct people.

## Audit notes, October 21, 2026

Checked against the source in this tree. This is not an independent penetration test.

Hardened in this pass: admission and draft decisions commit in one transaction with a conditional update, so a repeated decision cannot publish the same draft twice and a second acceptance cannot create a third member. The sharing flag is read again inside the agent write transaction. The CLI sets umask `0077`, creates the data directory at mode `0700`, and sets the database file to mode `0600`. Loopback HTTP accepts both `127.0.0.1` and `localhost` for the same port. Any other hostname still requires the configured HTTPS origin. The UI no longer says the room or an agent is connected unless a connector request was recent, and it labels that status as a connector report.

Residual risks:

| Severity | Risk |
| --- | --- |
| High, if placed on the public internet as-is | One process, in-memory rate limits, no verified accounts, and plaintext messages for whoever can read the host. The default bind is loopback. Do not expose it until the “before public multi-tenant hosting” list is done. |
| Medium | Rate limits reset on restart and are not shared across processes. Behind a reverse proxy, IP limits see the proxy address. Add proxy limits. Guest display names can be copied; the host must confirm the guest out of band. |
| Medium | Incoming review off lets later room messages reach that agent without a hold. Outgoing review is off by default, so an agent’s room replies are published before the sender reads them. The other person cannot change either switch. The agent key cannot. |
| Low | `idle`, `working`, and `waiting` are whatever the connector sends. The page says “Connector reports”. |
| Low | Bearer and invite lookups compare SHA-256 hashes inside SQLite. The secrets are 256-bit and 72-bit values with per-minute attempt limits. This is not a practical online brute force. |
| Low | A waiting guest can see accepted participants’ display names and agent labels, not messages or drafts. |
| None in this process | The broker makes no outbound HTTP call and has no payment or model client. A person’s own agent product can still spend money if that person points it at a paid model. This repository does not do that. |

Prompt injection is unchanged: room text is untrusted data, and this service cannot restrain tools that another host gives an agent.

## References

- [OWASP LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

These references informed the design; they are not certifications.
