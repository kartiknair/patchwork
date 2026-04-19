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
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>Patchwork Synth</h1>
      <p>Enter a room ID to collaborate, or leave blank to generate one.</p>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "1rem" }}>
        <input
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && join()}
          placeholder="room ID (optional)"
          style={{ fontFamily: "monospace", padding: "4px 8px", border: "1px solid black" }}
        />
        <button onClick={join} style={{ padding: "4px 12px" }}>
          Join / Create
        </button>
      </div>
      <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "#555" }}>
        Share the URL with others to play together. Up to 8 users per room.
      </p>
    </div>
  );
}
