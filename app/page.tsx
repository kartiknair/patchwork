"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");

  const join = () => {
    const id = roomId.trim() || randomId();
    router.push(`/room/${id}`);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 md:px-7 py-3 md:py-4.5 border-b border-hair">
        <div className="flex items-baseline gap-3">
          <span
            className="w-3.5 h-3.5 rounded-full inline-block"
            style={{
              background:
                "radial-gradient(circle at 35% 35%, oklch(0.85 0.18 80), oklch(0.55 0.18 25))",
              boxShadow: "0 0 14px rgba(255,180,80,0.45)",
            }}
          />
          <span className="font-display italic text-[22px] text-ink">
            Jamboree
          </span>
          <span className="text-[10px] tracking-[0.2em] uppercase text-ink-3">
            // multiplayer synth
          </span>
        </div>
      </div>

      {/* Hero */}
      <div className="flex-1 flex items-center justify-center px-7">
        <div className="max-w-sm w-full flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="font-display italic text-[40px] leading-none text-ink">
              Jam together.
            </h1>
            <p className="text-ink-3 text-[11px] tracking-widest leading-relaxed">
              Enter a room ID to join a session, or leave blank to generate one.
              Share the URL to play together.
            </p>
          </div>

          <div className="bg-panel border border-hair rounded-md p-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] tracking-[0.18em] uppercase text-ink-3">
                Room ID
              </label>
              <input
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && join()}
                placeholder="leave blank to generate"
                className="bg-panel-2 border border-hair rounded px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-4 outline-none focus:border-hair-2 transition-colors"
              />
            </div>
            <button
              onClick={join}
              className="w-full py-2.5 rounded font-mono text-[10px] tracking-[0.14em] uppercase text-ink-4 bg-hair hover:bg-hair-2 transition-colors cursor-pointer border-0"
            >
              Join / Create Room
            </button>
          </div>

          <div className="flex gap-4 text-[9px] tracking-[0.14em] uppercase text-ink-4">
            <span className="flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-c-osc" />
              Oscillator
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-c-filter" />
              Filter
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-c-amp" />
              Envelope
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-c-lfo" />
              LFO
            </span>
          </div>
        </div>
      </div>
      <div className="flex justify-between items-center text-ink-4 text-[9px] tracking-[0.18em] uppercase px-7 py-4 border-t border-hair">
        <span>Jamboree · 0.1.0</span>
        <span>Up to 8 users per room</span>
      </div>
    </div>
  );
}
