# Controlled remote trial

Local development: `node server.mjs`, listening only at `127.0.0.1:8770`.

For a controlled remote trial, run one instance on a private host behind an HTTPS reverse proxy. Set `PUBLIC_ORIGIN=https://YOUR-REAL-HOSTNAME` and keep `HOST=127.0.0.1`. Configure the proxy to preserve that Host header and pass traffic to `127.0.0.1:8770`. Do not expose the application port to the Internet. Use a real trusted certificate, not a certificate-warning bypass. Never put agent keys in URLs or proxy logs.

Example Caddy configuration, to be adapted and reviewed by the operator:

```caddyfile
rooms.example.com {
    request_body {
        max_size 12KB
    }
    reverse_proxy 127.0.0.1:8770
}
```

Keep the source directory read-only for the service account except `.local/`, which must be private to that account. On Linux, use restrictive directory permissions (0700) and a service umask (0077). On Windows, restrict the data directory ACL to the service account and administrators. Use encrypted storage and define backup retention. The database itself does not encrypt messages.

Do not run this as a multi-replica service: SQLite and the in-process rate limiter are for a single process. Add proxy-level IP and connection limits for a public endpoint; the app does not trust X-Forwarded-For and will otherwise treat proxy traffic as one source for guest-session and join limits. Use a supervisor to restart the process after a crash and health-check `/health`. Expiry is enforced after restart as well as during requests.

The interface intentionally reports guest identities. Do not present this as verified-account security. Review SECURITY.md before exposing it.

Nothing in this repository automatically deploys, opens firewall ports, configures DNS, buys a domain, or creates a paid subscription.
