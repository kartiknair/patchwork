<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Multiplayer backend

Real-time sync (`app/room/[roomId]`) runs on a Rust/WebAssembly core in
`rust/patchwork-net`, not a hosted service. Requires `rustup target add
wasm32-unknown-unknown` and `cargo install wasm-pack` once locally; `npm run
dev`/`build` regenerate `app/wasm/patchwork-net/` (gitignored) via
`predev`/`prebuild`. See `rust/signaling/README.md` for the matchmaking
signaling server, `rust/turn/README.md` for the TURN relay needed for
cross-device NAT traversal, and README.md for the Vercel deployment caveat.
