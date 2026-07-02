"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

export const COLORS = [
  "#ff7ab8",
  "#7adfff",
  "#b8ff7a",
  "#ffd47a",
  "#ff8a72",
  "#c79bff",
  "#7ad3e0",
  "#82e6b0",
];

export const NAMES = [
  "amber fox",
  "blue owl",
  "coral panda",
  "dusty crane",
  "emerald wolf",
  "fawn rabbit",
  "gold finch",
  "hazel hawk",
];

// WASM does fetch()/instantiate at init time, which must never run during the
// server render pass - "use client" alone doesn't skip that, only ssr:false does.
const CollabSynthInner = dynamic(() => import("./CollabSynthInner"), {
  ssr: false,
  loading: () => (
    <div className="p-8 font-mono text-ink-2 text-xs">Connecting…</div>
  ),
});

export default function CollabSynth({ roomId }: { roomId: string }) {
  const [identity, setIdentity] = useState<{
    name: string;
    color: string;
  } | null>(null);

  useEffect(() => {
    setIdentity({
      name: NAMES[Math.floor(Math.random() * NAMES.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    });
  }, []);

  const signalingUrl = process.env.NEXT_PUBLIC_MATCHBOX_SIGNALING_URL;

  if (!signalingUrl) {
    return (
      <div className="p-8 font-mono text-ink-2 text-xs">
        <p className="mb-3">
          <span className="text-ink font-semibold">
            Matchbox signaling not configured.
          </span>{" "}
          Add your self-hosted signaling server URL to{" "}
          <code className="bg-panel-2 px-1 py-0.5 rounded text-ink border border-hair">
            .env.local
          </code>
          :
        </p>
        <pre className="bg-panel-2 border border-hair rounded p-3 text-ink-2 mb-3">
          NEXT_PUBLIC_MATCHBOX_SIGNALING_URL=wss://your-host:3536
        </pre>
        <p>
          See{" "}
          <code className="bg-panel-2 px-1 py-0.5 rounded text-ink border border-hair">
            rust/signaling/README.md
          </code>{" "}
          for how to run one, then restart the dev server.
        </p>
      </div>
    );
  }

  if (!identity) return null;

  return (
    <CollabSynthInner
      roomId={roomId}
      signalingUrl={signalingUrl}
      initialName={identity.name}
      initialColor={identity.color}
    />
  );
}
