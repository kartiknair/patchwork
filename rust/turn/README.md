# TURN relay (coturn)

STUN alone (the ICE default - see `rust/signaling/README.md`) resolves most
home-NAT cases, but fails whenever:

- either peer is behind a symmetric NAT / carrier-grade NAT (common on
  cellular connections), or
- both peers are on the *same* LAN but the router doesn't support NAT
  hairpinning/loopback, which is common on consumer routers - this is why
  two tabs on one device can connect (it never leaves the loopback
  interface) while two separate devices on the same WiFi cannot.

A TURN relay fixes both: peers connect out to the TURN server's public IP
in both directions and it relays traffic between them, sidestepping NAT
entirely.

coturn is deployed on a plain **DigitalOcean droplet** (`patchwork-coturn`,
`s-1vcpu-512mb-10gb`, ~$4/mo), installed directly via `apt` and run under
systemd - no Docker, no PaaS.

## Why not Fly.io

This was tried first on Fly.io with a dedicated IPv4 (`fly ips allocate-v4
--dedicated`), and a basic TURN Allocate handshake did succeed from an
external machine. But a full relay<->relay test - two independent
allocations on the same coturn instance sending a TURN Send Indication at
each other's relayed address, simulating what two real ICE peers need -
never delivered the data either direction. Fly's dedicated IPv4 is routed
through an edge/anycast layer rather than bound directly to the VM's own
network interface, so the box can't hairpin a packet back to itself via its
own public IP - the same class of problem as the router NAT-hairpinning
issue this whole setup exists to solve, just one layer further out.

A plain VPS avoids this because the public IP is bound directly to the
droplet's network interface, so self-to-self routing via that IP works like
on any normal Linux box. The Dockerfile/`fly.toml`/`entrypoint.sh` in this
directory are left over from the Fly attempt and are no longer used.

## Deploying

```sh
doctl compute ssh-key import <key-name> --public-key-file ~/.ssh/<key>.pub
doctl compute droplet create patchwork-coturn \
  --region nyc3 \
  --size s-1vcpu-512mb-10gb \
  --image ubuntu-22-04-x64 \
  --ssh-keys <ssh-key-id> \
  --wait

ssh root@<droplet-ip> "apt-get update -qq && apt-get install -y -qq coturn"
```

Then write `/etc/turnserver.conf` on the droplet:

```
listening-port=3478
min-port=49160
max-port=49200

external-ip=<droplet-ip>

fingerprint
lt-cred-mech
realm=patchwork.turn

user=<username>:<random-password>

no-cli
no-tls
no-dtls
no-multicast-peers
```

```sh
systemctl enable coturn
systemctl restart coturn
```

`min-port`/`max-port` (49160-49200) bound the number of concurrent relayed
allocations (~40); DigitalOcean droplets have no firewall by default so
those ports (plus 3478/tcp+udp) are reachable without extra config - widen
the range if you need more concurrent relayed peers.

## Wiring into the app

Set `NEXT_PUBLIC_MATCHBOX_ICE_SERVERS` (see `.env.example`) to:

```json
[{"urls":["turn:<droplet-ip>:3478"],"username":"<username>","credential":"<random-password>"}]
```

Remember to set the same env var in the Vercel project settings for
production, not just `.env.local`.

## Verifying it actually works

A STUN/TURN server can be up and still fail to relay real traffic, so it's
worth confirming both of these before trusting it - see the scratch test
scripts used during initial setup for a template if you need to re-verify
after changing hosts/credentials:

1. **Basic reachability**: a STUN Binding Request, then a full TURN
   Allocate handshake with the long-term credentials, confirming the
   returned relayed address is real.
2. **Relay<->relay delivery** (the one that actually caught the Fly
   failure): two independent Allocate calls, a `CreatePermission` from
   each toward the other's relayed address, then a `Send Indication` from
   each - and confirm each side actually receives a `Data Indication` with
   the other's payload. This is the path real ICE connectivity checks need
   and the only test that exercises self-to-self routing through the
   server's own public IP.

Verified working 2026-07-07 on the DigitalOcean droplet: both directions of
the relay<->relay test succeeded.
