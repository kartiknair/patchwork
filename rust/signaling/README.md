# Matchbox signaling server

Patchwork's multiplayer rooms are peer-to-peer (WebRTC data channels, full mesh).
The only server-side piece is a *signaling* server that introduces peers to each
other so they can negotiate a direct connection - once connected, no traffic
flows through it. This directory has no code of its own: `matchbox_server` is a
standalone, unmodified binary crate published by the
[matchbox project](https://github.com/johanhelsing/matchbox), installed directly.

## Run locally

```sh
cargo install matchbox_server --locked --version 0.14.0
matchbox_server --host 0.0.0.0 --port 3536
```

Point the app at it with, in `.env.local`:

```
NEXT_PUBLIC_MATCHBOX_SIGNALING_URL=ws://localhost:3536
```

## Deploying

The signaling server needs to run somewhere every client can reach over
`ws://`/`wss://`. A few options:

- **systemd unit** on a small VPS, e.g.:
  ```ini
  [Unit]
  Description=matchbox signaling server
  After=network.target

  [Service]
  ExecStart=/root/.cargo/bin/matchbox_server --host 0.0.0.0 --port 3536
  Restart=on-failure

  [Install]
  WantedBy=multi-user.target
  ```
  Put a TLS-terminating reverse proxy (nginx/Caddy) in front so browsers on
  `https://` pages can reach it over `wss://` (browsers block mixed-content
  `ws://` connections from an `https://` page).

- **Docker**, using a minimal Dockerfile since no official image is published:
  ```dockerfile
  FROM rust:1 AS build
  RUN cargo install matchbox_server --locked --version 0.14.0

  FROM debian:bookworm-slim
  COPY --from=build /usr/local/cargo/bin/matchbox_server /usr/local/bin/
  EXPOSE 3536
  CMD ["matchbox_server", "--host", "0.0.0.0", "--port", "3536"]
  ```

Once deployed, update `NEXT_PUBLIC_MATCHBOX_SIGNALING_URL` to the public
`wss://` address.

## NAT traversal (known gap)

`matchbox_server` only signals - it has no TURN relay. STUN (the default ICE
config) resolves most home-NAT cases but two peers behind symmetric NATs or
restrictive corporate firewalls may fail to establish a direct connection.
If that matters for your deployment, run a TURN server (e.g.
[coturn](https://github.com/coturn/coturn)) and set `NEXT_PUBLIC_MATCHBOX_ICE_SERVERS`
to point at it (see `.env.example`).
