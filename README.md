This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Multiplayer backend

Room presence and synth-parameter sync run on a Rust core compiled to
WebAssembly, using [matchbox](https://github.com/johanhelsing/matchbox) for
peer-to-peer WebRTC networking (full mesh, no app server holds state). See
`rust/patchwork-net` for the crate and `rust/signaling/README.md` for how to
run the signaling server.

One-time local setup:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
```

`npm run dev`/`npm run build` automatically run `wasm-pack build` first (see
the `predev`/`prebuild` scripts in `package.json`) to regenerate
`app/wasm/patchwork-net/` from the Rust source - that directory is gitignored,
not committed.

You'll also need a running `matchbox_server` and
`NEXT_PUBLIC_MATCHBOX_SIGNALING_URL` set in `.env.local` (see `.env.example`
and `rust/signaling/README.md`) for rooms to sync between browser tabs.

Cross-device connections additionally need a TURN relay
(`NEXT_PUBLIC_MATCHBOX_ICE_SERVERS` in `.env.example`) - STUN alone isn't
enough for peers on different networks, or even the same LAN if the router
doesn't support NAT hairpinning. See `rust/turn/README.md`.

**Deploying to Vercel**: the standard Vercel build image has no Rust/cargo, so
the `prebuild` wasm step will fail out of the box. Either override the Vercel
install command to install `rustup`/`wasm-pack` first, commit the generated
`app/wasm/patchwork-net/` output and drop the prebuild hook, or deploy to a
Docker-based host with Rust preinstalled instead.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
