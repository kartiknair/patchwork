"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PARAMS, SynthParams } from "../../synth";

type Cursor = { x: number; y: number } | null;

type OtherPeer = {
  peerId: string;
  name: string;
  color: string;
  cursor: Cursor;
  chat: string | null;
};

type PresencePartial = {
  cursor?: Cursor;
  name?: string;
  color?: string;
  chat?: string | null;
};

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

type MatchboxRoomHandle = {
  tick(): unknown;
  set_cursor(x: number, y: number): void;
  clear_cursor(): void;
  set_name(name: string): void;
  set_color(color: string): void;
  send_chat(text: string): void;
  set_param(field: string, value: number | string): void;
  self_peer_id(): string;
  disconnect(): void;
};

type WasmEvent =
  | { type: "Connected"; self_peer_id: string }
  | { type: "Disconnected" }
  | { type: "PeerJoined"; peer_id: string; name: string; color: string }
  | { type: "PeerLeft"; peer_id: string }
  | { type: "PresenceChanged"; peers: WasmPeerPresence[] }
  | { type: "ParamsChanged"; params: Partial<SynthParams> }
  | { type: "Error"; message: string };

type WasmPeerPresence = {
  peer_id: string;
  name: string;
  color: string;
  cursor: Cursor;
  chat: string | null;
};

export function useMatchboxRoom(
  roomId: string,
  signalingUrl: string,
  initialName: string,
  initialColor: string,
) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [selfPeerId, setSelfPeerId] = useState<string | null>(null);
  const [others, setOthers] = useState<OtherPeer[]>([]);
  const [params, setParams] = useState<SynthParams>(DEFAULT_PARAMS);

  const roomRef = useRef<MatchboxRoomHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;

    (async () => {
      const mod = await import("@/app/wasm/patchwork-net/patchwork_net.js");
      await mod.default();
      if (cancelled) return;

      const iceServersJson = process.env.NEXT_PUBLIC_MATCHBOX_ICE_SERVERS;
      const room: MatchboxRoomHandle = new mod.MatchboxRoom(
        signalingUrl,
        roomId,
        initialName,
        initialColor,
        iceServersJson,
      );
      roomRef.current = room;

      const loop = () => {
        const events = room.tick() as WasmEvent[];
        for (const ev of events) {
          switch (ev.type) {
            case "Connected":
              setSelfPeerId(ev.self_peer_id);
              setStatus("connected");
              break;
            case "Disconnected":
              setStatus("disconnected");
              break;
            case "PeerJoined":
            case "PeerLeft":
              // presence list is fully replaced by the next PresenceChanged
              // event, which the Rust side always emits alongside these
              break;
            case "PresenceChanged":
              setOthers(
                ev.peers.map((p) => ({
                  peerId: p.peer_id,
                  name: p.name,
                  color: p.color,
                  cursor: p.cursor,
                  chat: p.chat,
                })),
              );
              break;
            case "ParamsChanged":
              setParams((prev) => ({ ...prev, ...ev.params }));
              break;
            case "Error":
              setStatus("error");
              break;
          }
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, signalingUrl]);

  const updateMyPresence = useMemo(
    () => (partial: PresencePartial) => {
      const room = roomRef.current;
      if (!room) return;
      if (partial.cursor !== undefined) {
        if (partial.cursor === null) room.clear_cursor();
        else room.set_cursor(partial.cursor.x, partial.cursor.y);
      }
      if (partial.name !== undefined) room.set_name(partial.name);
      if (partial.color !== undefined) room.set_color(partial.color);
      if (partial.chat !== undefined && partial.chat !== null) {
        room.send_chat(partial.chat);
      }
    },
    [],
  );

  const setParamsAndBroadcast = useMemo(
    () => (updater: SynthParams | ((prev: SynthParams) => SynthParams)) => {
      setParams((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        const room = roomRef.current;
        if (room) {
          for (const key of Object.keys(next) as (keyof SynthParams)[]) {
            if (next[key] !== prev[key]) {
              room.set_param(key, next[key] as number | string);
            }
          }
        }
        return next;
      });
    },
    [],
  );

  return {
    status,
    selfPeerId,
    others,
    params,
    setParams: setParamsAndBroadcast,
    updateMyPresence,
  };
}
