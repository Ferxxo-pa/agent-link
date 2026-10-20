# Security model and remaining work

## What is enforced outside the model

- A room code is a request-to-join mechanism. An admitted host must approve the second human. Pending guests get metadata about accepted participants, not messages or drafts.
- A browser session owns one member identity. There is no client-controlled sender or owner field.
- An agent token belongs to exactly one admitted member and expires with that room. Rotation removes previous tokens. Either human can end the room. Tokens cannot approve, admit, close, create credentials, or change sharing policy.
- Every read filters private content by member identity. Human and agent writes enforce their own role, size, visibility, and sharing policy.
- Draft approval checks the owner, room, content digest, expiration, and pending state. The human may explicitly edit the outgoing text. Publishing and resolving the proposal occur in one database transaction.
- Stable outgoing agent request IDs are unique per agent member. Reusing an ID with different text fails. Delivery retries return the original result; proposal outcome is available separately through inbox reads.
- Same-origin browser writes require a session CSRF token. Cookies are HttpOnly and SameSite=Strict, plus Secure when configured for HTTPS. Host/origin checks and no permissive CORS restrict browser cross-origin access.
- UI text is rendered through textContent, not interpreted HTML. A restrictive CSP blocks inline scripts, frames, and external resources.
- Per-session/per-agent rate limits, request sizes, room count, join count, message count, pending proposal count, and expiration bound single-process storage and request load. Startup requires HTTPS configuration for non-loopback use.

## What is not claimed

Prompt injection cannot be eliminated by this service. Peer messages and tool results are untrusted. An external agent can still be manipulated into reasoning badly or misusing unrelated tools that its host gives it. Prefer a room-specific agent with no external tools or private credentials. Do not allow model output to become instructions for a privileged executor.

Automatic sharing is an explicit removal of the outgoing review barrier, not a guarantee of safe content. Any participant can manually disclose information they know. Approved text is attributed, not certified as truthful or harmless.

Guest sessions are not verified accounts. Display names can be copied. Confirm the expected guest outside the room before admitting them. There is no SSO, email verification, identity recovery, or cross-device account login. This is a deliberate prototype limit, not production identity assurance.

The operator and anyone with database/file access can read messages. Local HTTP is only suitable on loopback. Remote use requires HTTPS and a private application listener behind a correctly configured proxy. The service does not implement E2EE, attachments, arbitrary webhooks, payment execution, code execution, or tool execution. No raw provider credentials are needed by the broker.

## Before public multi-tenant hosting

Add verified identities and recovery, distributed edge rate limiting, abuse controls, retention/backup policy, monitored deployments, secure secret management, a reviewed container/host configuration, and a security review. Test TLS proxy configuration, cookie behavior, multiple instances, database failure, and client compatibility. The current SQLite/rate limiter is designed for one process. Browser sessions on one browser profile represent one human; use separate profiles/devices to test distinct people.

## References

- [OWASP LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

These references informed the design; they are not certifications.
