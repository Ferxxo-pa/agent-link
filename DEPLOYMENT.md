# Single-instance deployment

Local development: `node server.mjs`, listening only at `127.0.0.1:8770`.

Run one process. SQLite and the in-process rate limiter are for a single process. Do not scale horizontally. Use a supervisor or the platform's restart policy so a crash comes back, and health-check `GET /health`. Expiry is enforced after restart as well as during requests.

Nothing in this repository deploys itself, opens firewall ports, configures DNS, buys a domain, or creates a paid subscription. The steps below are operator instructions. They were not executed from this repository.

The room server does not need `XAI_API_KEY` or `OPENAI_API_KEY`. Those belong on the machine that runs `host.mjs`.

## Environment

| Variable | Role |
| --- | --- |
| `HOST` | Bind address. `127.0.0.1` behind a same-machine proxy. `0.0.0.0` when the platform proxy connects over the machine network. |
| `PORT` | Listen port. Platforms usually inject this. |
| `PUBLIC_ORIGIN` | Exact public origin, such as `https://rooms.example.com`. Cookies are `Secure` when this is HTTPS. The browser Origin and the public Host must match it. |
| `TRUSTED_PROXY` | Set to `1` only when TLS terminates at a proxy that is the only client of the app port. Requires an `https` `PUBLIC_ORIGIN`. |
| `AGENT_LINK_DATA` | Directory for `rooms.sqlite`. Default is `.local/` next to the server. Mount a private persistent disk here. |

`TRUSTED_PROXY=1` requires `X-Forwarded-Proto: https` on API requests, honors `X-Forwarded-Host` when it equals the public host, and rates limits by `Fly-Client-IP` or the rightmost `X-Forwarded-For` address. `/health` accepts an internal Host header so the platform check can succeed. Direct access to the app port can forge those headers, so the port stays private. See SECURITY.md.

Keep the source directory read-only for the service account except the data directory, which must be private to that account. On Linux, use directory mode `0700` and umask `0077`. The server creates `AGENT_LINK_DATA` with mode `0700`. Use encrypted storage and define backup retention. The database itself does not encrypt messages. Deleting expired rows does not erase WAL files, snapshots, or backups.

## Same machine, Caddy

Set `PUBLIC_ORIGIN=https://YOUR-REAL-HOSTNAME`. You can leave `HOST=127.0.0.1` and leave `TRUSTED_PROXY` unset if Caddy preserves the public Host header; session and join limits then share the proxy's TCP address. Set `TRUSTED_PROXY=1` when you want per-client limits. Caddy sets `X-Forwarded-Proto`. Use a real trusted certificate. Never put agent keys in URLs or proxy logs.

```caddyfile
rooms.example.com {
    request_body {
        max_size 12KB
    }
    reverse_proxy 127.0.0.1:8770
}
```

Add proxy-level IP and connection limits for a public endpoint. The interface reports guest labels. Review SECURITY.md before exposing it.

## Fly.io

One machine, one volume, no autoscale. Example the operator can copy into `fly.toml` after review. This file is not in the repo, so a Fly GitHub integration will not pick it up from the source tree.

```toml
app = "agent-link"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  HOST = "0.0.0.0"
  PORT = "8080"
  TRUSTED_PROXY = "1"
  AGENT_LINK_DATA = "/data"
  # PUBLIC_ORIGIN = "https://agent-link.fly.dev"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health"
    interval = "15s"
    timeout = "2s"

[[mounts]]
  source = "agent_link_data"
  destination = "/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

```dockerfile
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.mjs client.mjs host.mjs provider.mjs mcp.mjs ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "server.mjs"]
```

Operator sequence, not run from this checkout:

```sh
fly volumes create agent_link_data --size 1 --region iad --count 1
fly secrets set PUBLIC_ORIGIN=https://YOUR-APP.fly.dev
fly scale count 1
fly deploy
```

Confirm `fly status` shows one machine. Fly's proxy sets `Fly-Client-IP`, `X-Forwarded-Proto`, and the public Host. Point `PUBLIC_ORIGIN` at the hostname Fly actually serves. Humans then open that HTTPS URL, and each `host.mjs` uses it as `AGENT_LINK_URL`.

## Render

One web service, one persistent disk, health check path `/health`. Start command `node server.mjs`. No build dependencies. Set:

```text
HOST=0.0.0.0
PUBLIC_ORIGIN=https://YOUR-SERVICE.onrender.com
TRUSTED_PROXY=1
AGENT_LINK_DATA=/data
```

Render injects `PORT`. Attach a disk mounted at `/data`. Set the instance count to 1 and leave autoscaling off. Render's proxy terminates TLS and sends `X-Forwarded-Proto`. The app port should not be published except through that proxy.

A free instance that sleeps will drop long polling hosts and in-memory rate-limit buckets. SQLite on the persistent disk survives sleep. Choose an always-on instance for a live room.

## After it is up

Check `https://YOUR-HOST/health` returns `{"ok":true}` with a valid certificate. Create a room in a browser, join from a second browser profile, and confirm the session cookie is `Secure`. Run `host.mjs` from each owner's machine with that HTTPS URL and a room key. Provider keys stay on those machines.

Do not put this in front of more than one app process. A second process would split SQLite writes and rate-limit state.
