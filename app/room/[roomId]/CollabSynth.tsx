"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import {
  RoomProvider,
  useRoom,
  useOthers,
  useSelf,
  useUpdateMyPresence,
} from "../../../liveblocks.config";
import { SynthInner, SynthParams, DEFAULT_PARAMS } from "../../synth";

const MAX_USERS = 8;

const COLORS = [
  "#ff7ab8",
  "#7adfff",
  "#b8ff7a",
  "#ffd47a",
  "#ff8a72",
  "#c79bff",
  "#7ad3e0",
  "#82e6b0",
];

const NAMES = [
  "amber fox",
  "blue owl",
  "coral panda",
  "dusty crane",
  "emerald wolf",
  "fawn rabbit",
  "gold finch",
  "hazel hawk",
];

function readFromMap(yMap: Y.Map<unknown>): Partial<SynthParams> {
  if (yMap.size === 0) return {};
  return {
    waveform:
      (yMap.get("waveform") as OscillatorType) ?? DEFAULT_PARAMS.waveform,
    filterCutoff:
      (yMap.get("filterCutoff") as number) ?? DEFAULT_PARAMS.filterCutoff,
    filterRes: (yMap.get("filterRes") as number) ?? DEFAULT_PARAMS.filterRes,
    volume: (yMap.get("volume") as number) ?? DEFAULT_PARAMS.volume,
    ampA: (yMap.get("ampA") as number) ?? DEFAULT_PARAMS.ampA,
    ampD: (yMap.get("ampD") as number) ?? DEFAULT_PARAMS.ampD,
    ampS: (yMap.get("ampS") as number) ?? DEFAULT_PARAMS.ampS,
    ampR: (yMap.get("ampR") as number) ?? DEFAULT_PARAMS.ampR,
    filtA: (yMap.get("filtA") as number) ?? DEFAULT_PARAMS.filtA,
    filtD: (yMap.get("filtD") as number) ?? DEFAULT_PARAMS.filtD,
    filtS: (yMap.get("filtS") as number) ?? DEFAULT_PARAMS.filtS,
    filtR: (yMap.get("filtR") as number) ?? DEFAULT_PARAMS.filtR,
    filtEnvAmt: (yMap.get("filtEnvAmt") as number) ?? DEFAULT_PARAMS.filtEnvAmt,
    lfoRate: (yMap.get("lfoRate") as number) ?? DEFAULT_PARAMS.lfoRate,
    lfoDepth: (yMap.get("lfoDepth") as number) ?? DEFAULT_PARAMS.lfoDepth,
    lfoTarget:
      (yMap.get("lfoTarget") as "pitch" | "filter" | "none") ??
      DEFAULT_PARAMS.lfoTarget,
    octave: (yMap.get("octave") as number) ?? DEFAULT_PARAMS.octave,
  };
}

const LOCAL_ORIGIN = Symbol("local");

function writeToMap(yMap: Y.Map<unknown>, params: SynthParams) {
  const doc = yMap.doc;
  if (!doc) return;
  Y.transact(
    doc,
    () => {
      (Object.entries(params) as [string, unknown][]).forEach(([k, v]) => {
        if (yMap.get(k) !== v) yMap.set(k, v);
      });
    },
    LOCAL_ORIGIN,
  );
}

export default function CollabSynth({ roomId }: { roomId: string }) {
  const [identity, setIdentity] = useState<{ name: string } | null>(null);

  useEffect(() => {
    setIdentity({ name: NAMES[Math.floor(Math.random() * NAMES.length)] });
  }, []);

  if (!process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY?.startsWith("pk_")) {
    return (
      <div className="p-8 font-mono text-ink-2 text-xs">
        <p className="mb-3">
          <span className="text-ink font-semibold">
            Liveblocks not configured.
          </span>{" "}
          Add your public key to{" "}
          <code className="bg-panel-2 px-1 py-0.5 rounded text-ink border border-hair">
            .env.local
          </code>
          :
        </p>
        <pre className="bg-panel-2 border border-hair rounded p-3 text-ink-2 mb-3">
          NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY=pk_...
        </pre>
        <p>Get a free key at liveblocks.io, then restart the dev server.</p>
      </div>
    );
  }

  if (!identity) return null;

  return (
    <RoomProvider
      id={roomId}
      initialPresence={{
        cursor: null,
        name: identity.name,
        color: COLORS[0],
        chat: null,
      }}
    >
      <CollabSynthInner roomId={roomId} initialName={identity.name} />
    </RoomProvider>
  );
}

function CollabSynthInner({
  roomId,
  initialName,
}: {
  roomId: string;
  initialName: string;
}) {
  const room = useRoom();
  const others = useOthers();
  const self = useSelf();
  const updateMyPresence = useUpdateMyPresence();

  const [params, setParams] = useState<SynthParams>(DEFAULT_PARAMS);
  const yMapRef = useRef<Y.Map<unknown> | null>(null);

  const [chatInput, setChatInput] = useState<string | null>(null);
  const chatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [name, setName] = useState(initialName);
  const [editingName, setEditingName] = useState(false);
  const [color, setColor] = useState(COLORS[0]);

  useEffect(() => {
    if (self?.connectionId === undefined) return;
    const c = COLORS[self.connectionId % COLORS.length];
    setColor(c);
    updateMyPresence({ color: c });
  }, [self?.connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const provider = getYjsProviderForRoom(room);
    const yDoc = provider.getYDoc();
    const yMap = yDoc.getMap<unknown>("synthParams");
    yMapRef.current = yMap;
    const observer = (event: Y.YMapEvent<unknown>) => {
      if (event.transaction.origin === LOCAL_ORIGIN) return;
      setParams((prev) => {
        const incoming = readFromMap(yMap);
        if (Object.keys(incoming).length === 0) return prev;
        const next = { ...prev, ...incoming };
        for (const k of Object.keys(next) as (keyof SynthParams)[]) {
          if (next[k] !== prev[k]) return next;
        }
        return prev;
      });
    };
    yMap.observe(observer);
    const initial = readFromMap(yMap);
    if (Object.keys(initial).length > 0)
      setParams((prev) => ({ ...prev, ...initial }));
    return () => yMap.unobserve(observer);
  }, [room]);

  useEffect(() => {
    if (yMapRef.current) writeToMap(yMapRef.current, params);
  }, [params]);

  useEffect(() => {
    const onMove = (e: MouseEvent) =>
      updateMyPresence({ cursor: { x: e.clientX, y: e.clientY } });
    const onLeave = () => updateMyPresence({ cursor: null });
    window.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, [updateMyPresence]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === "/" && chatInput === null) {
        e.preventDefault();
        setChatInput("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chatInput]);

  const commitName = useCallback(
    (value: string) => {
      const trimmed = value.trim() || initialName;
      setName(trimmed);
      setEditingName(false);
      updateMyPresence({ name: trimmed });
    },
    [initialName, updateMyPresence],
  );

  const pickColor = useCallback(
    (value: string) => {
      setColor(value);
      updateMyPresence({ color: value });
    },
    [updateMyPresence],
  );

  const submitChat = useCallback(() => {
    const msg = chatInput?.trim() ?? "";
    setChatInput(null);
    if (!msg) return;
    updateMyPresence({ chat: msg });
    if (chatTimeoutRef.current) clearTimeout(chatTimeoutRef.current);
    chatTimeoutRef.current = setTimeout(
      () => updateMyPresence({ chat: null }),
      5000,
    );
  }, [chatInput, updateMyPresence]);

  if (others.length >= MAX_USERS) {
    return (
      <div className="p-8 font-mono text-ink-2 text-xs">
        Room <strong className="text-ink">{roomId}</strong> is full ({MAX_USERS}{" "}
        users max).
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col gap-15">
      {/* Top bar */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between px-4 md:px-7 py-3 md:py-4.5 border-b border-hair">
        <div className="flex items-baseline gap-2.5">
          <span
            className="w-3.5 h-3.5 rounded-full inline-block"
            style={{
              background:
                "radial-gradient(circle at 35% 35%, oklch(0.85 0.18 80), oklch(0.55 0.18 25))",
              boxShadow: "0 0 14px rgba(255,180,80,0.45)",
            }}
          />
          <span className="font-display italic text-[22px] text-ink">
            Patchwork
          </span>
          <span className="text-[10px] tracking-[0.2em] uppercase text-ink-3">
            // multiplayer synth
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:gap-3.5 text-ink-3 text-[10px] tracking-[0.14em] uppercase">
          <span>Room</span>
          <span className="text-ink border border-hair px-2 py-1 rounded bg-panel-2">
            {roomId}
          </span>

          <span className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full animate-[pulse-dot_1.6s_ease-in-out_infinite]"
              style={{
                background: "var(--c-amp)",
                boxShadow: "0 0 8px var(--c-amp)",
              }}
            />
            Live · {others.length + 1} jamming
          </span>

          {/* Peer chips */}
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.75 rounded-full border border-hair bg-panel-2 text-ink-2 text-[10px] tracking-[0.06em] normal-case">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ background: color }}
              />
              {editingName ? (
                <input
                  autoFocus
                  defaultValue={name}
                  className="bg-transparent border-0 outline-none font-mono text-[10px] text-ink w-20"
                  onBlur={(e) => commitName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      commitName((e.target as HTMLInputElement).value);
                    if (e.key === "Escape") setEditingName(false);
                  }}
                />
              ) : (
                <button
                  onClick={() => setEditingName(true)}
                  className="bg-transparent border-0 cursor-pointer text-ink-2 font-mono text-[10px]"
                >
                  {name} ✎
                </button>
              )}
            </span>
            {others.map((other) => (
              <span
                key={other.connectionId}
                className="inline-flex items-center gap-1.5 px-2 py-0.75 rounded-full border border-hair bg-panel-2 text-ink-2 text-[10px] tracking-[0.06em] normal-case"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: other.presence.color || "#888" }}
                />
                {other.presence.name}
              </span>
            ))}
          </div>

          {/* Color picker */}
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => pickColor(c)}
                className="w-3.5 h-3.5 rounded-full cursor-pointer border-0 p-0"
                style={{
                  background: c,
                  outline:
                    c === color ? "2px solid rgba(255,255,255,0.6)" : "none",
                  outlineOffset: 2,
                }}
              />
            ))}
          </div>

          <span className="hidden md:inline text-ink-4">
            Press <kbd className="border border-hair px-1 rounded">/</kbd> to
            chat
          </span>
        </div>
      </div>

      <SynthInner params={params} setParams={setParams} />

      <div className="flex mt-auto justify-between items-center text-ink-4 text-[9px] tracking-[0.18em] uppercase px-7 py-2 border-t border-hair">
        <span>Patchwork · Jam Engine</span>
        <span>
          signal flow → osc → filter → amp · lfo modulates {params.lfoTarget}
        </span>
      </div>

      {/* Remote cursors */}
      <div className="fixed inset-0 pointer-events-none z-100">
        {others.map((other) => {
          const cursor = other.presence.cursor;
          if (!cursor) return null;
          const c = other.presence.color || "#888";
          return (
            <div
              key={other.connectionId}
              className="absolute"
              style={{
                left: cursor.x,
                top: cursor.y,
                transform: "translate(-2px, -2px)",
                transition: "left 80ms linear, top 80ms linear",
              }}
            >
              <svg
                width="20"
                height="22"
                viewBox="0 0 20 22"
                style={{
                  display: "block",
                  filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))",
                }}
              >
                <path
                  d="M2 2 L2 18 L7 14 L10 21 L13 19 L10 12 L17 12 Z"
                  fill={c}
                  stroke="#0a0b0d"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
              <div
                className="inline-block px-1.75 py-0.5 rounded font-mono text-[10px] font-semibold tracking-[0.04em] whitespace-nowrap mt-0.5"
                style={{
                  background: c,
                  color: "#0a0b0d",
                  transform: "translateX(10px)",
                }}
              >
                {other.presence.name}
              </div>
              {other.presence.chat && (
                <div
                  className="inline-block px-1.5 py-0.5 rounded text-[9px] font-mono bg-black/60 border border-hair-2 whitespace-nowrap tracking-[0.08em] uppercase mt-0.5"
                  style={{
                    color: c,
                    borderColor: c + "55",
                    transform: "translateX(10px)",
                  }}
                >
                  &ldquo;{other.presence.chat}&rdquo;
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Slash chat input */}
      {chatInput !== null && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-200 flex gap-2 items-center bg-panel border border-hair rounded px-3 py-1.5">
          <span className="text-ink-3">/</span>
          <input
            autoFocus
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitChat();
              }
              if (e.key === "Escape") setChatInput(null);
            }}
            placeholder="say something…"
            className="bg-transparent border-0 outline-none font-mono text-xs text-ink placeholder:text-ink-4 min-w-55"
          />
          <button
            onClick={submitChat}
            className="font-mono text-[10px] tracking-widest uppercase text-ink-3 hover:text-ink cursor-pointer bg-transparent border-0"
          >
            send
          </button>
        </div>
      )}
    </div>
  );
}
