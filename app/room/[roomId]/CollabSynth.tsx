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
  "#ff4444",
  "#ff9900",
  "#ffdd00",
  "#44cc55",
  "#4488ff",
  "#cc44ff",
  "#ff44aa",
  "#22ddcc",
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
      <div style={{ padding: "2rem", fontFamily: "monospace" }}>
        <p>
          <strong>Liveblocks not configured.</strong> Add your public key to{" "}
          <code>.env.local</code>:
        </p>
        <pre style={{ background: "#f4f4f4", padding: "0.5rem" }}>
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

  // Assign color by connectionId so successive joiners cycle through the palette
  useEffect(() => {
    if (self?.connectionId === undefined) return;
    const c = COLORS[self.connectionId % COLORS.length];
    setColor(c);
    updateMyPresence({ color: c });
  }, [self?.connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set up Yjs sync
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
    // Apply any pre-existing state already in the room
    const initial = readFromMap(yMap);
    if (Object.keys(initial).length > 0)
      setParams((prev) => ({ ...prev, ...initial }));

    return () => yMap.unobserve(observer);
  }, [room]);

  // Push local param changes to Yjs
  useEffect(() => {
    if (yMapRef.current) writeToMap(yMapRef.current, params);
  }, [params]);

  // Cursor tracking
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      updateMyPresence({ cursor: { x: e.clientX, y: e.clientY } });
    };
    const onLeave = () => updateMyPresence({ cursor: null });
    window.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, [updateMyPresence]);

  // Slash chat keyboard handler
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
    chatTimeoutRef.current = setTimeout(() => {
      updateMyPresence({ chat: null });
    }, 5000);
  }, [chatInput, updateMyPresence]);

  if (others.length >= MAX_USERS) {
    return (
      <div style={{ padding: "2rem", fontFamily: "monospace" }}>
        Room <strong>{roomId}</strong> is full ({MAX_USERS} users max).
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          padding: "0.5rem 1rem",
          fontFamily: "monospace",
          fontSize: "0.8rem",
          borderBottom: "1px solid #ddd",
          display: "flex",
          gap: "1rem",
          alignItems: "center",
        }}
      >
        <span>
          Room: <strong>{roomId}</strong>
        </span>
        <span>
          {others.length + 1} user{others.length !== 0 ? "s" : ""}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          You:{" "}
          {editingName ? (
            <input
              autoFocus
              defaultValue={name}
              style={{
                fontFamily: "monospace",
                fontSize: "0.8rem",
                border: "1px solid #aaa",
                padding: "1px 4px",
              }}
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
              style={{
                fontFamily: "monospace",
                fontSize: "0.8rem",
                background: "none",
                border: "1px solid #ccc",
                padding: "1px 6px",
                cursor: "pointer",
              }}
            >
              {name} ✎
            </button>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => pickColor(c)}
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: c,
                padding: 0,
                cursor: "pointer",
                border: "none",
                outline: c === color ? "2px solid white" : "none",
                outlineOffset: 2,
              }}
            />
          ))}
        </span>
        <span style={{ color: "#888" }}>
          Press <kbd>/</kbd> to chat
        </span>
      </div>

      <SynthInner params={params} setParams={setParams} />

      {/* Remote cursors */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 100,
        }}
      >
        {others.map((other) => {
          const cursor = other.presence.cursor;
          if (!cursor) return null;
          const c = other.presence.color || "#888";
          return (
            <div
              key={other.connectionId}
              style={{
                position: "absolute",
                left: cursor.x,
                top: cursor.y,
                transform: "translate(-2px, -2px)",
                transition: "left 80ms linear, top 80ms linear",
              }}
            >
              {/* Arrow cursor */}
              <svg
                width="14"
                height="18"
                viewBox="0 0 14 18"
                style={{ display: "block" }}
              >
                <path
                  d="M0 0 L0 14 L4 10 L7 16 L9 15 L6 9 L11 9 Z"
                  fill={c}
                  stroke="white"
                  strokeWidth="1"
                />
              </svg>
              <div
                style={{
                  marginLeft: 14,
                  marginTop: -14,
                  background: c,
                  color: "white",
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 3,
                  whiteSpace: "nowrap",
                  maxWidth: 200,
                }}
              >
                {other.presence.name}
                {other.presence.chat && (
                  <div style={{ fontStyle: "italic", marginTop: 2 }}>
                    &ldquo;{other.presence.chat}&rdquo;
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Slash chat input */}
      {chatInput !== null && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 200,
            display: "flex",
            gap: "0.5rem",
            background: "white",
            border: "1px solid black",
            padding: "6px 10px",
            fontFamily: "monospace",
          }}
        >
          <span style={{ color: "#888" }}>/</span>
          <input
            autoFocus
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitChat();
              }
              if (e.key === "Escape") {
                setChatInput(null);
              }
            }}
            placeholder="say something…"
            style={{
              border: "none",
              outline: "none",
              fontFamily: "monospace",
              minWidth: 220,
            }}
          />
          <button onClick={submitChat} style={{ fontFamily: "monospace" }}>
            send
          </button>
        </div>
      )}
    </div>
  );
}
