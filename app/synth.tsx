"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { buildSF2 } from "./sf2";

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function fmt(n: number, d = 2) {
  return Number(n).toFixed(d);
}

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

function noteNameToMidi(note: string): number {
  const m = note.match(/^([A-G]#?)(\d+)$/);
  if (!m) return -1;
  const s = NOTE_NAMES.indexOf(m[1]);
  return s === -1 ? -1 : (parseInt(m[2]) + 1) * 12 + s;
}

function keyToNote(key: string, octave: number): string {
  const s = KEY_TO_SEMITONE[key];
  return s === undefined
    ? ""
    : NOTE_NAMES[s % 12] + (octave + Math.floor(s / 12));
}

const KEY_TO_SEMITONE: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
};

export interface SynthParams {
  waveform: OscillatorType;
  filterCutoff: number;
  filterRes: number;
  volume: number;
  ampA: number;
  ampD: number;
  ampS: number;
  ampR: number;
  filtA: number;
  filtD: number;
  filtS: number;
  filtR: number;
  filtEnvAmt: number;
  lfoRate: number;
  lfoDepth: number;
  lfoTarget: "pitch" | "filter" | "none";
  octave: number;
}

export const DEFAULT_PARAMS: SynthParams = {
  waveform: "sawtooth",
  filterCutoff: 2000,
  filterRes: 1,
  volume: 0.7,
  ampA: 0.01,
  ampD: 0.2,
  ampS: 0.7,
  ampR: 0.3,
  filtA: 0.01,
  filtD: 0.3,
  filtS: 0.5,
  filtR: 0.5,
  filtEnvAmt: 3000,
  lfoRate: 5,
  lfoDepth: 20,
  lfoTarget: "none",
  octave: 4,
};

interface Voice {
  osc: OscillatorNode;
  ampEnv: GainNode;
}

function midiToFreq(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function encodeWav(f32: Float32Array, sampleRate: number): ArrayBuffer {
  let peak = 0;
  for (let i = 0; i < f32.length; i++) peak = Math.max(peak, Math.abs(f32[i]));
  const scale = peak > 0.0001 ? 32767 / peak : 32767;
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) i16[i] = Math.round(f32[i] * scale);
  const dataBytes = i16.byteLength;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const enc = (s: string, off: number) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  enc("RIFF", 0);
  dv.setUint32(4, 36 + dataBytes, true);
  enc("WAVE", 8);
  enc("fmt ", 12);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  enc("data", 36);
  dv.setUint32(40, dataBytes, true);
  new Uint8Array(buf, 44).set(new Uint8Array(i16.buffer));
  return buf;
}

function useCanvas(
  draw: (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
  ) => void,
  deps: React.DependencyList,
) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(1, Math.floor(r.width * dpr));
      cv.height = Math.max(1, Math.floor(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    let last = performance.now(),
      tAcc = 0,
      raf = 0;
    const loop = (now: number) => {
      tAcc += (now - last) / 1000;
      last = now;
      const ctx = cv.getContext("2d")!;
      ctx.save();
      ctx.scale(dpr, dpr);
      const w = cv.width / dpr,
        h = cv.height / dpr;
      ctx.clearRect(0, 0, w, h);
      draw(ctx, w, h, tAcc);
      ctx.restore();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

function waveSample(shape: string, phase: number, pw = 0.5) {
  const p = phase - Math.floor(phase);
  if (shape === "sine") return Math.sin(p * Math.PI * 2);
  if (shape === "triangle") return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
  if (shape === "sawtooth" || shape === "saw") return 2 * p - 1;
  if (shape === "square") return p < pw ? 1 : -1;
  return 0;
}

function Panel({
  title,
  index,
  color,
  right,
  children,
  style,
}: {
  title: string;
  index?: string;
  color?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="bg-panel border border-hair rounded-md relative h-full"
      style={style}
    >
      <div className="absolute inset-0 rounded-md pointer-events-none shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]" />
      <div className="flex items-center justify-between px-3 pt-2.5 pb-2 border-b border-hair">
        <div className="flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full shadow-[0_0_8px_currentColor]"
            style={{ background: color, color }}
          />
          <span className="text-[10px] tracking-[0.18em] uppercase text-ink-2">
            {title}
          </span>
          {index && (
            <span className="text-[9px] tracking-[0.18em] text-ink-4">
              {index}
            </span>
          )}
        </div>
        <div>{right}</div>
      </div>
      {children}
    </div>
  );
}

function Knob({
  value,
  min = 0,
  max = 1,
  step = 0.001,
  onChange,
  label,
  color = "#fff",
  display,
  size = 44,
  peerActive = false,
  dataKey,
  onActiveChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  color?: string;
  display?: (v: number) => string;
  size?: number;
  peerActive?: boolean;
  dataKey?: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const [drag, setDrag] = useState(false);
  const startY = useRef(0);
  const startV = useRef(0);
  const active = drag || peerActive;

  const norm = (value - min) / (max - min);
  const ang = lerp(-135, 135, norm);
  const r = size / 2 - 4;
  const cx = size / 2;
  const cy = size / 2;

  const arcPath = useMemo(() => {
    const s = (-135 * Math.PI) / 180;
    const e = (ang * Math.PI) / 180;
    const x1 = cx + r * Math.cos(s);
    const y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e);
    const y2 = cy + r * Math.sin(e);
    return `M ${x1} ${y1} A ${r} ${r} 0 ${e - s > Math.PI ? 1 : 0} 1 ${x2} ${y2}`;
  }, [ang, r, cx, cy]);

  const tickAng = ((-135 + 270 * norm) * Math.PI) / 180;

  function beginDrag(clientY: number) {
    setDrag(true);
    startY.current = clientY;
    startV.current = value;
    onActiveChange?.(true);
  }

  function applyDrag(clientY: number) {
    let next =
      startV.current + ((startY.current - clientY) / 140) * (max - min);
    next = clamp(next, min, max);
    if (step) next = Math.round(next / step) * step;
    onChange(next);
  }

  function onDown(e: React.MouseEvent) {
    e.preventDefault();
    beginDrag(e.clientY);
    const move = (ev: MouseEvent) => applyDrag(ev.clientY);
    const up = () => {
      setDrag(false);
      onActiveChange?.(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function onTouchStart(e: React.TouchEvent) {
    beginDrag(e.touches[0].clientY);
    const move = (ev: TouchEvent) => {
      ev.preventDefault();
      applyDrag(ev.touches[0].clientY);
    };
    const end = () => {
      setDrag(false);
      onActiveChange?.(false);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    };
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    let next = value - Math.sign(e.deltaY) * (max - min) * 0.02;
    next = clamp(next, min, max);
    if (step) next = Math.round(next / step) * step;
    onChange(next);
  }

  return (
    <div
      className="flex flex-col items-center gap-1.5 select-none cursor-ns-resize relative"
      style={{ touchAction: "none" }}
      onMouseDown={onDown}
      onTouchStart={onTouchStart}
      onWheel={onWheel}
      data-knob={dataKey}
    >
      <div style={{ width: size, height: size }} className="relative">
        <svg width={size} height={size}>
          <path
            d={`M ${cx + r * Math.cos((-135 * Math.PI) / 180)} ${cy + r * Math.sin((-135 * Math.PI) / 180)} A ${r} ${r} 0 1 1 ${cx + r * Math.cos((135 * Math.PI) / 180)} ${cy + r * Math.sin((135 * Math.PI) / 180)}`}
            stroke="#22262c"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={arcPath}
            stroke={color}
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            style={{
              filter: active ? `drop-shadow(0 0 6px ${color})` : "none",
            }}
          />
          <circle
            cx={cx}
            cy={cy}
            r={r - 6}
            fill="#0a0907"
            stroke="#1c1812"
            strokeWidth="1"
          />
          <line
            x1={cx + (r - 10) * Math.cos(tickAng)}
            y1={cy + (r - 10) * Math.sin(tickAng)}
            x2={cx + (r - 4) * Math.cos(tickAng)}
            y2={cy + (r - 4) * Math.sin(tickAng)}
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        {peerActive && (
          <div
            className="absolute -inset-0.75 rounded-lg pointer-events-none border border-current opacity-60 animate-[ghost-ring_600ms_ease-out_forwards]"
            style={{ color }}
          />
        )}
      </div>
      <div
        className={`text-[9px] tracking-[0.16em] uppercase ${active ? "text-ink" : "text-ink-3"}`}
      >
        {label}
      </div>
      <div
        className={`text-[10px] tabular-nums ${active ? "text-ink" : "text-ink-2"}`}
      >
        {display ? display(value) : fmt(value)}
      </div>
    </div>
  );
}

function Seg({
  options,
  value,
  onChange,
  dataKey,
}: {
  options: { v: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  dataKey?: string;
}) {
  return (
    <div
      className="inline-flex border border-hair rounded overflow-hidden bg-panel-2"
      data-seg={dataKey}
    >
      {options.map((o) => (
        <button
          key={o.v}
          className={`border-r border-hair last:border-r-0 px-2.5 py-1.5 font-mono text-[10px] tracking-[0.12em] uppercase cursor-pointer transition-colors ${value === o.v ? "bg-white/4 text-ink" : "bg-transparent text-ink-3"}`}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Pill({
  on,
  color,
  label,
  onClick,
  dataKey,
}: {
  on: boolean;
  color?: string;
  label: string;
  onClick: () => void;
  dataKey?: string;
}) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full font-mono text-[9px] tracking-[0.16em] uppercase cursor-pointer bg-panel-2 transition-colors ${on ? "border border-hair-2 text-ink" : "border border-hair text-ink-3"}`}
      style={{ color: on ? color : undefined }}
      onClick={onClick}
      data-pill={dataKey}
    >
      <span
        className="w-1.25 h-1.25 rounded-full"
        style={{
          background: on ? color : "var(--ink-4)",
          boxShadow: on ? `0 0 6px ${color}` : "none",
        }}
      />
      {label}
    </button>
  );
}

function Readout({ value, unit }: { value: string; unit: string }) {
  return (
    <span className="font-display italic text-[26px] leading-none tracking-tight text-ink">
      {value}
      <span className="font-mono not-italic text-[10px] text-ink-3 tracking-[0.16em] uppercase ml-1">
        {unit}
      </span>
    </span>
  );
}

function Viz({
  height,
  children,
}: {
  height: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="viz-bg relative border-t border-b border-hair overflow-hidden"
      style={{ height }}
    >
      {children}
    </div>
  );
}

function VizCorner({
  pos,
  children,
  style,
}: {
  pos: "tl" | "tr" | "bl" | "br";
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const cls = {
    tl: "top-1.5 left-2",
    tr: "top-1.5 right-2",
    bl: "bottom-1.5 left-2",
    br: "bottom-1.5 right-2",
  }[pos];
  return (
    <span
      className={`absolute ${cls} text-[9px] tracking-[0.12em] text-ink-4 uppercase pointer-events-none`}
      style={style}
    >
      {children}
    </span>
  );
}

function WaveformViz({ waveform, color }: { waveform: string; color: string }) {
  const ref = useCanvas(
    (ctx, w, h, t) => {
      const g = "rgba(255,255,255,0.04)";
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      for (let x = 0; x <= w; x += w / 8) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += h / 4) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      const amp = h * 0.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let i = 0; i <= w; i++) {
        const y = h / 2 - waveSample(waveform, (i / w) * 3 + t * 0.6) * amp;
        i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    },
    [waveform],
  );
  return <canvas ref={ref} className="block w-full h-full" />;
}

function FilterViz({
  cutoff,
  resonance,
  color,
}: {
  cutoff: number;
  resonance: number;
  color: string;
}) {
  const ref = useCanvas(
    (ctx, w, h) => {
      const g = "rgba(255,255,255,0.04)";
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      for (let x = 0; x <= w; x += w / 10) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += h / 4) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const cutNorm =
        (Math.log10(cutoff) - Math.log10(20)) /
        (Math.log10(20000) - Math.log10(20));
      const res = clamp((resonance - 0.1) / 19.9, 0, 1);
      const resp = (x: number) => {
        const dist = x - cutNorm;
        const peak = Math.exp(-Math.pow((x - cutNorm) / 0.04, 2)) * res * 0.6;
        return clamp(1 / (1 + Math.exp(dist * 22)) + peak, 0, 1.2);
      };

      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i <= w; i++)
        ctx.lineTo(i, h - resp(i / w) * h * 0.85 - h * 0.05);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = color + "14";
      ctx.fill();

      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let i = 0; i <= w; i++) {
        const py = h - resp(i / w) * h * 0.85 - h * 0.05;
        i === 0 ? ctx.moveTo(i, py) : ctx.lineTo(i, py);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = color + "80";
      ctx.setLineDash([2, 4]);
      const cx = cutNorm * w;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.stroke();
      ctx.setLineDash([]);
    },
    [cutoff, resonance],
  );
  return <canvas ref={ref} className="block w-full h-full" />;
}

function EnvViz({
  a,
  d,
  s,
  r,
  color,
  envTrigger,
}: {
  a: number;
  d: number;
  s: number;
  r: number;
  color: string;
  envTrigger: React.MutableRefObject<{ on: number; off: number }>;
}) {
  const ref = useCanvas(
    (ctx, w, h) => {
      const g = "rgba(255,255,255,0.04)";
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      for (let x = 0; x <= w; x += w / 8) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += h / 4) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const hold = 0.6,
        total = a + d + hold + r + 0.05;
      const xA = (a / total) * w,
        xD = ((a + d) / total) * w,
        xS = ((a + d + hold) / total) * w,
        xR = ((a + d + hold + r) / total) * w;
      const top = h * 0.1,
        bot = h * 0.92,
        susY = lerp(bot, top, s);

      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(0, bot);
      ctx.lineTo(xA, top);
      ctx.lineTo(xD, susY);
      ctx.lineTo(xS, susY);
      ctx.lineTo(xR, bot);
      ctx.closePath();
      ctx.fillStyle = color + "18";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, bot);
      ctx.lineTo(xA, top);
      ctx.lineTo(xD, susY);
      ctx.lineTo(xS, susY);
      ctx.lineTo(xR, bot);
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.font = "9px JetBrains Mono,monospace";
      ctx.fillText("A", 4, h - 4);
      if (xD > xA + 8) ctx.fillText("D", xA + 4, h - 4);
      if (xS > xD + 8) ctx.fillText("S", xD + 4, h - 4);
      if (xR > xS + 8) ctx.fillText("R", xS + 4, h - 4);

      // Playhead driven by actual note events
      const { on, off } = envTrigger.current;
      if (on === 0) return;

      const now = performance.now();
      const sinceOn = (now - on) / 1000;
      const released = off > on;
      const sinceOff = released ? (now - off) / 1000 : null;

      let phx: number;
      if (sinceOff === null) {
        // Note held: advance through A→D, then pin at sustain
        if (sinceOn < a) phx = (sinceOn / a) * xA;
        else if (sinceOn < a + d) phx = lerp(xA, xD, (sinceOn - a) / d);
        else phx = xD;
      } else {
        // Note released: jump to start of release segment and advance through R
        if (sinceOff >= r) return; // release complete, hide playhead
        phx = lerp(xS, xR, sinceOff / r);
      }

      let dotY: number;
      if (phx <= xA) dotY = lerp(bot, top, phx / (xA || 1));
      else if (phx <= xD) dotY = lerp(top, susY, (phx - xA) / (xD - xA || 1));
      else if (phx <= xS) dotY = susY;
      else dotY = lerp(susY, bot, (phx - xS) / (xR - xS || 1));

      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(phx, 0);
      ctx.lineTo(phx, h);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(phx, dotY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    },
    [a, d, s, r],
  );
  return <canvas ref={ref} className="block w-full h-full" />;
}

function LfoViz({
  rate,
  depth,
  target,
  color,
}: {
  rate: number;
  depth: number;
  target: string;
  color: string;
}) {
  const ref = useCanvas(
    (ctx, w, h, t) => {
      const g = "rgba(255,255,255,0.04)";
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      for (let x = 0; x <= w; x += w / 12) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += h / 4) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      const rn = (rate - 0.1) / 19.9,
        dn = depth / 1200;
      const speed = 0.4 + rn * 4,
        cycles = 0.5 + rn * 5,
        amp = h * 0.36 * dn;
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let i = 0; i <= w; i++) {
        const y =
          h / 2 - waveSample("sine", (i / w) * cycles + t * speed) * amp;
        i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      const phx = ((t * 0.5) % 1) * w;
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(phx, 0);
      ctx.lineTo(phx, h);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "9px JetBrains Mono,monospace";
      ctx.fillText(
        target === "pitch"
          ? "→ PITCH"
          : target === "filter"
            ? "→ FILTER"
            : "UNROUTED",
        w - 80,
        14,
      );
    },
    [rate, depth, target],
  );
  return <canvas ref={ref} className="block w-full h-full" />;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isMobile;
}

interface KeyDef {
  note: string;
  type: "white" | "black";
  whiteIdx: number;
}

function buildKeys(startOct: number, octaves: number): KeyDef[] {
  const whites = ["C", "D", "E", "F", "G", "A", "B"];
  const blacks: Record<string, string> = {
    C: "C#",
    D: "D#",
    F: "F#",
    G: "G#",
    A: "A#",
  };
  const keys: KeyDef[] = [];
  let wi = 0;
  for (let o = 0; o < octaves; o++) {
    const oct = startOct + o;
    for (let i = 0; i < whites.length; i++) {
      keys.push({ note: `${whites[i]}${oct}`, type: "white", whiteIdx: wi });
      if (blacks[whites[i]])
        keys.push({
          note: `${blacks[whites[i]]}${oct}`,
          type: "black",
          whiteIdx: wi,
        });
      wi++;
    }
  }
  keys.push({ note: `C${startOct + octaves}`, type: "white", whiteIdx: wi });
  return keys;
}

function PianoKeyboard({
  down,
  peerDown,
  onDown,
  onUp,
  octave,
}: {
  down: Set<string>;
  peerDown: Record<string, { id: string; name: string; color: string }>;
  onDown: (n: string) => void;
  onUp: (n: string) => void;
  octave: number;
}) {
  const isMobile = useIsMobile();
  const octaves = isMobile ? 1 : 3;
  const startOct = isMobile ? octave : octave - 1;
  const keys = useMemo(() => buildKeys(startOct, octaves), [startOct, octaves]);
  const whiteCount = keys.filter((k) => k.type === "white").length;
  const containerRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1000);

  useEffect(() => {
    const update = () => {
      if (containerRef.current)
        setW(containerRef.current.getBoundingClientRect().width);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const wW = w / whiteCount,
    bW = wW * 0.6;
  const wH = 140,
    bH = 88;

  const legends: Record<string, string> = {};
  Object.entries(KEY_TO_SEMITONE).forEach(([k, s]) => {
    legends[NOTE_NAMES[s % 12] + (octave + Math.floor(s / 12))] =
      k.toUpperCase();
  });

  return (
    <div
      ref={containerRef}
      className="relative select-none"
      style={{ height: wH, touchAction: "none" }}
    >
      {keys.map((k) => {
        const isDown = down.has(k.note);
        const peer = peerDown[k.note];
        const x =
          k.type === "white" ? k.whiteIdx * wW : k.whiteIdx * wW + wW - bW / 2;
        const peerStyle = peer
          ? {
              background:
                k.type === "white"
                  ? `linear-gradient(180deg, ${peer.color}55, ${peer.color}11)`
                  : `linear-gradient(180deg, ${peer.color}aa, ${peer.color}22)`,
              boxShadow: `inset 0 0 24px ${peer.color}33, 0 0 22px ${peer.color}55`,
            }
          : {};
        return (
          <div
            key={k.note}
            className={`piano-key ${k.type}${isDown ? " down" : ""}`}
            style={{
              left: x,
              width: k.type === "white" ? wW : bW,
              height: k.type === "white" ? wH : bH,
              ...peerStyle,
            }}
            data-note={k.note}
            onPointerDown={() => onDown(k.note)}
            onPointerUp={() => onUp(k.note)}
            onPointerLeave={() => onUp(k.note)}
            onPointerCancel={() => onUp(k.note)}
          >
            {k.type === "white" && (
              <span className="absolute bottom-2 left-0 right-0 text-center text-[9px] text-ink-4 tracking-[0.04em] pointer-events-none">
                {legends[k.note] ?? ""}
              </span>
            )}
            {peer && (
              <div
                className="absolute left-0 right-0 text-center text-[9px] pointer-events-none"
                style={{
                  bottom: k.type === "white" ? 26 : 14,
                  color: peer.color,
                  textShadow: `0 0 6px ${peer.color}`,
                }}
              >
                {peer.name}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SynthInner({
  params,
  setParams,
  peerDown = {},
  onKnobActivity,
  onNoteActivity,
}: {
  params: SynthParams;
  setParams: React.Dispatch<React.SetStateAction<SynthParams>>;
  peerDown?: Record<string, { id: string; name: string; color: string }>;
  onKnobActivity?: (label: string | null) => void;
  onNoteActivity?: (note: string, active: boolean) => void;
}) {
  const ctxRef = useRef<AudioContext | null>(null);
  const filterRef = useRef<BiquadFilterNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const lfoRef = useRef<OscillatorNode | null>(null);
  const lfoGainRef = useRef<GainNode | null>(null);
  const voicesRef = useRef<Map<string, Voice>>(new Map());
  const pressedRef = useRef<Set<string>>(new Set());
  const paramsRef = useRef(params);
  const envTriggerRef = useRef<{ on: number; off: number }>({ on: 0, off: 0 });
  const [activeNotes, setActiveNotes] = useState<Set<string>>(new Set());

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    if (!filterRef.current) return;
    if (voicesRef.current.size === 0)
      filterRef.current.frequency.value = params.filterCutoff;
    filterRef.current.Q.value = params.filterRes;
  }, [params.filterCutoff, params.filterRes]);

  useEffect(() => {
    if (masterGainRef.current)
      masterGainRef.current.gain.value = params.volume * 0.15;
  }, [params.volume]);
  useEffect(() => {
    if (lfoRef.current) lfoRef.current.frequency.value = params.lfoRate;
  }, [params.lfoRate]);
  useEffect(() => {
    if (lfoGainRef.current) lfoGainRef.current.gain.value = params.lfoDepth;
  }, [params.lfoDepth]);
  useEffect(() => {
    voicesRef.current.forEach((v) => {
      v.osc.type = params.waveform;
    });
  }, [params.waveform]);

  useEffect(() => {
    if (!lfoGainRef.current) return;
    try {
      lfoGainRef.current.disconnect();
    } catch {
      /* ok */
    }
    if (params.lfoTarget === "filter" && filterRef.current)
      lfoGainRef.current.connect(filterRef.current.frequency);
  }, [params.lfoTarget]);

  const initAudio = useCallback(() => {
    if (ctxRef.current) return;
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = paramsRef.current.filterCutoff;
    filter.Q.value = paramsRef.current.filterRes;
    filterRef.current = filter;
    const master = ctx.createGain();
    master.gain.value = paramsRef.current.volume * 0.15;
    masterGainRef.current = master;
    filter.connect(master);
    master.connect(ctx.destination);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = paramsRef.current.lfoRate;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = paramsRef.current.lfoDepth;
    lfo.connect(lfoGain);
    lfoRef.current = lfo;
    lfoGainRef.current = lfoGain;
    lfo.start();
    if (paramsRef.current.lfoTarget === "filter")
      lfoGain.connect(filter.frequency);
  }, []);

  const noteOn = useCallback(
    (note: string) => {
      if (voicesRef.current.has(note)) return;
      const p = paramsRef.current,
        ctx = ctxRef.current;
      if (!ctx || !filterRef.current) return;
      const midi = noteNameToMidi(note);
      if (midi < 0) return;
      const now = ctx.currentTime,
        freq = midiToFreq(midi);
      const osc = ctx.createOscillator();
      osc.type = p.waveform;
      osc.frequency.value = freq;
      if (p.lfoTarget === "pitch" && lfoGainRef.current)
        lfoGainRef.current.connect(osc.detune);
      const ampEnv = ctx.createGain();
      const a = Math.max(p.ampA, 0.001),
        d = Math.max(p.ampD, 0.001);
      ampEnv.gain.setValueAtTime(0, now);
      ampEnv.gain.linearRampToValueAtTime(1, now + a);
      ampEnv.gain.linearRampToValueAtTime(p.ampS, now + a + d);
      osc.connect(ampEnv);
      ampEnv.connect(filterRef.current);
      osc.start(now);
      const base = p.filterCutoff,
        fa = Math.max(p.filtA, 0.001),
        fd = Math.max(p.filtD, 0.001);
      filterRef.current.frequency.cancelScheduledValues(now);
      filterRef.current.frequency.setValueAtTime(base, now);
      filterRef.current.frequency.linearRampToValueAtTime(
        base + p.filtEnvAmt,
        now + fa,
      );
      filterRef.current.frequency.linearRampToValueAtTime(
        base + p.filtEnvAmt * p.filtS,
        now + fa + fd,
      );
      voicesRef.current.set(note, { osc, ampEnv });
      envTriggerRef.current = { on: performance.now(), off: 0 };
      onNoteActivity?.(note, true);
    },
    [onNoteActivity],
  );

  const noteOff = useCallback(
    (note: string) => {
      const voice = voicesRef.current.get(note),
        ctx = ctxRef.current;
      if (!voice || !ctx) return;
      const p = paramsRef.current,
        now = ctx.currentTime;
      const ar = Math.max(p.ampR, 0.001),
        fr = Math.max(p.filtR, 0.001);
      voice.ampEnv.gain.cancelScheduledValues(now);
      voice.ampEnv.gain.setValueAtTime(voice.ampEnv.gain.value, now);
      voice.ampEnv.gain.linearRampToValueAtTime(0, now + ar);
      voice.osc.stop(now + ar + 0.01);
      if (filterRef.current) {
        filterRef.current.frequency.cancelScheduledValues(now);
        filterRef.current.frequency.setValueAtTime(
          filterRef.current.frequency.value,
          now,
        );
        filterRef.current.frequency.linearRampToValueAtTime(
          p.filterCutoff,
          now + fr,
        );
      }
      voicesRef.current.delete(note);
      envTriggerRef.current.off = performance.now();
      onNoteActivity?.(note, false);
    },
    [onNoteActivity],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.repeat ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      const key = e.key.toLowerCase();
      if (key === "z") {
        setParams((p) => ({ ...p, octave: Math.max(0, p.octave - 1) }));
        return;
      }
      if (key === "x") {
        setParams((p) => ({ ...p, octave: Math.min(8, p.octave + 1) }));
        return;
      }
      if (key in KEY_TO_SEMITONE && !pressedRef.current.has(key)) {
        pressedRef.current.add(key);
        const note = keyToNote(key, paramsRef.current.octave);
        if (note) {
          setActiveNotes((p) => new Set([...p, note]));
          initAudio();
          noteOn(note);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (pressedRef.current.has(key)) {
        pressedRef.current.delete(key);
        const note = keyToNote(key, paramsRef.current.octave);
        if (note) {
          setActiveNotes((p) => {
            const n = new Set(p);
            n.delete(note);
            return n;
          });
          noteOff(note);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [initAudio, noteOn, noteOff, setParams]);

  useEffect(
    () => () => {
      ctxRef.current?.close();
    },
    [],
  );

  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const SAMPLE_RATE = 44100,
    SUSTAIN_DUR = 2.0;
  const MIDI_NOTES = [12, 24, 36, 48, 60, 72, 84, 96, 108, 120];
  const NOTE_NAMES_EXP = [
    "C",
    "Cs",
    "D",
    "Ds",
    "E",
    "F",
    "Fs",
    "G",
    "Gs",
    "A",
    "As",
    "B",
  ];

  const renderSamples = async (
    onProgress: (i: number, total: number) => void,
  ) => {
    const p = paramsRef.current;
    const samples: { midi: number; name: string; data: Float32Array }[] = [];
    for (let i = 0; i < MIDI_NOTES.length; i++) {
      const midi = MIDI_NOTES[i];
      onProgress(i, MIDI_NOTES.length);
      await new Promise<void>((r) => setTimeout(r, 0));
      const a = Math.max(p.ampA, 0.001),
        d = Math.max(p.ampD, 0.001),
        r = Math.max(p.ampR, 0.001);
      const fa = Math.max(p.filtA, 0.001),
        fd = Math.max(p.filtD, 0.001),
        fr = Math.max(p.filtR, 0.001);
      const nOff = a + d + SUSTAIN_DUR,
        dur = nOff + r + 0.05;
      const ctx = new OfflineAudioContext(
        1,
        Math.ceil(dur * SAMPLE_RATE),
        SAMPLE_RATE,
      );
      const osc = ctx.createOscillator();
      osc.type = p.waveform;
      osc.frequency.value = midiToFreq(midi);
      const ampEnv = ctx.createGain();
      ampEnv.gain.setValueAtTime(0, 0);
      ampEnv.gain.linearRampToValueAtTime(1, a);
      ampEnv.gain.linearRampToValueAtTime(p.ampS, a + d);
      ampEnv.gain.setValueAtTime(p.ampS, nOff);
      ampEnv.gain.linearRampToValueAtTime(0, nOff + r);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(p.filterCutoff, 0);
      filter.frequency.linearRampToValueAtTime(
        p.filterCutoff + p.filtEnvAmt,
        fa,
      );
      filter.frequency.linearRampToValueAtTime(
        p.filterCutoff + p.filtEnvAmt * p.filtS,
        fa + fd,
      );
      filter.frequency.setValueAtTime(
        p.filterCutoff + p.filtEnvAmt * p.filtS,
        nOff,
      );
      filter.frequency.linearRampToValueAtTime(p.filterCutoff, nOff + fr);
      filter.Q.value = p.filterRes;
      const master = ctx.createGain();
      master.gain.value = p.volume * 0.15;
      osc.connect(ampEnv);
      ampEnv.connect(filter);
      filter.connect(master);
      master.connect(ctx.destination);
      osc.start(0);
      osc.stop(dur);
      const rendered = await ctx.startRendering();
      samples.push({
        midi,
        name: NOTE_NAMES_EXP[midi % 12] + Math.floor(midi / 12 - 1),
        data: rendered.getChannelData(0),
      });
    }
    return samples;
  };

  const exportSFZ = async () => {
    const zip = new JSZip();
    const samples = await renderSamples((i, total) =>
      setExportStatus(`Rendering ${i + 1}/${total}…`),
    );
    setExportStatus("Building SFZ…");
    await new Promise<void>((r) => setTimeout(r, 0));
    const sfz = ["// Jamboree Synth export", ""];
    for (let i = 0; i < samples.length; i++) {
      const { midi, name, data } = samples[i];
      const lo = i === 0 ? 0 : Math.floor((samples[i - 1].midi + midi) / 2) + 1;
      const hi =
        i === samples.length - 1
          ? 127
          : Math.floor((midi + samples[i + 1].midi) / 2);
      zip.file(name + ".wav", encodeWav(data, SAMPLE_RATE));
      sfz.push(
        "<region>",
        `sample=${name}.wav`,
        `pitch_keycenter=${midi}`,
        `lokey=${lo}`,
        `hikey=${hi}`,
        "",
      );
    }
    zip.file("patch.sfz", sfz.join("\n"));
    setExportStatus("Compressing…");
    await new Promise<void>((r) => setTimeout(r, 0));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "jamboree.zip";
    a.click();
    URL.revokeObjectURL(url);
    setExportStatus(null);
  };

  const exportSF2 = async () => {
    const samples = await renderSamples((i, total) =>
      setExportStatus(`Rendering ${i + 1}/${total}…`),
    );
    setExportStatus("Building SF2…");
    await new Promise<void>((r) => setTimeout(r, 0));
    const sf2 = buildSF2(
      samples.map((s) => ({ midi: s.midi, data: s.data })),
      SAMPLE_RATE,
      "Jamboree Synth",
    );
    const blob = new Blob([sf2], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "jamboree.sf2";
    a.click();
    URL.revokeObjectURL(url);
    setExportStatus(null);
  };

  const set =
    <K extends keyof SynthParams>(key: K) =>
    (v: SynthParams[K]) =>
      setParams((p) => ({ ...p, [key]: v }));

  const C_OSC = "#f0c674",
    C_FLT = "#7ad3e0",
    C_AMP = "#82e6b0",
    C_ENV = "#c79bff",
    C_LFO = "#ff8a72";

  return (
    <div className="max-w-500 md:w-[80%] w-full mx-auto px-4 md:px-7 pt-4.5 pb-7 grid grid-cols-1 md:grid-cols-12 gap-3.5">
      {/* Oscillator */}
      <div className="md:col-span-4">
        <Panel
          title="Oscillator"
          index="01 / OSC"
          color={C_OSC}
          right={
            <span className="text-[10px] tracking-[0.14em] uppercase text-ink-3">
              {params.waveform.toUpperCase()}
            </span>
          }
        >
          <div className="px-3 py-2.5 flex justify-between items-center">
            <Seg
              options={[
                { v: "sine", label: "Sine" },
                { v: "triangle", label: "Tri" },
                { v: "sawtooth", label: "Saw" },
                { v: "square", label: "Sq" },
              ]}
              value={params.waveform}
              onChange={(v) =>
                setParams((p) => ({ ...p, waveform: v as OscillatorType }))
              }
            />
          </div>
          <Viz height={120}>
            <WaveformViz waveform={params.waveform} color={C_OSC} />
            <VizCorner pos="tl">WAVEFORM</VizCorner>
            <VizCorner pos="br" style={{ color: C_OSC }}>
              ● LIVE
            </VizCorner>
          </Viz>
          <div className="flex gap-3.5 p-3 flex-wrap">
            <Knob
              label="Level"
              value={params.volume}
              min={0}
              max={1}
              onChange={set("volume") as (v: number) => void}
              color={C_OSC}
              display={(v) => `${fmt(v * 100, 0)} %`}
              onActiveChange={(a) => onKnobActivity?.(a ? "Osc Level" : null)}
            />
          </div>
        </Panel>
      </div>

      {/* Filter */}
      <div className="md:col-span-4">
        <Panel
          title="Filter"
          index="02 / FLT"
          color={C_FLT}
          right={<Readout value={fmt(params.filterCutoff, 0)} unit="Hz" />}
        >
          <Viz height={140}>
            <FilterViz
              cutoff={params.filterCutoff}
              resonance={params.filterRes}
              color={C_FLT}
            />
            <VizCorner pos="tl">FREQ RESPONSE</VizCorner>
            <VizCorner pos="tr">20 Hz · 20 kHz</VizCorner>
            <VizCorner pos="br" style={{ color: C_FLT }}>
              ● LP
            </VizCorner>
          </Viz>
          <div className="flex gap-3.5 p-3 flex-wrap">
            <Knob
              label="Cutoff"
              value={params.filterCutoff}
              min={20}
              max={20000}
              step={10}
              onChange={set("filterCutoff") as (v: number) => void}
              color={C_FLT}
              display={(v) => `${fmt(v, 0)} Hz`}
              onActiveChange={(a) =>
                onKnobActivity?.(a ? "Filter Cutoff" : null)
              }
            />
            <Knob
              label="Reso"
              value={params.filterRes}
              min={0.1}
              max={20}
              step={0.1}
              onChange={set("filterRes") as (v: number) => void}
              color={C_FLT}
              display={(v) => fmt(v, 1)}
              onActiveChange={(a) => onKnobActivity?.(a ? "Filter Reso" : null)}
            />
            <Knob
              label="Env Amt"
              value={params.filtEnvAmt}
              min={0}
              max={15000}
              step={10}
              onChange={set("filtEnvAmt") as (v: number) => void}
              color={C_FLT}
              display={(v) => `${fmt(v, 0)} Hz`}
              onActiveChange={(a) =>
                onKnobActivity?.(a ? "Filter Env Amt" : null)
              }
            />
          </div>
        </Panel>
      </div>

      {/* Amp Envelope */}
      <div className="md:col-span-4">
        <Panel
          title="Amp Envelope"
          index="03 / VCA"
          color={C_AMP}
          right={
            <span className="text-[10px] tracking-[0.14em] uppercase text-ink-3">
              VCA
            </span>
          }
        >
          <Viz height={160}>
            <EnvViz
              a={params.ampA}
              d={params.ampD}
              s={params.ampS}
              r={params.ampR}
              color={C_AMP}
              envTrigger={envTriggerRef}
            />
            <VizCorner pos="tl">ADSR</VizCorner>
            <VizCorner pos="tr">
              {fmt(params.ampA + params.ampD + params.ampR, 2)} s
            </VizCorner>
          </Viz>
          <div className="flex gap-3.5 p-3 flex-wrap">
            <Knob
              label="Attack"
              value={params.ampA}
              min={0.001}
              max={2}
              step={0.001}
              onChange={set("ampA") as (v: number) => void}
              color={C_AMP}
              display={(v) => `${fmt(v * 1000, 0)} ms`}
              onActiveChange={(a) => onKnobActivity?.(a ? "Amp Attack" : null)}
            />
            <Knob
              label="Decay"
              value={params.ampD}
              min={0.001}
              max={2}
              step={0.001}
              onChange={set("ampD") as (v: number) => void}
              color={C_AMP}
              display={(v) => `${fmt(v * 1000, 0)} ms`}
              onActiveChange={(a) => onKnobActivity?.(a ? "Amp Decay" : null)}
            />
            <Knob
              label="Sustain"
              value={params.ampS}
              min={0}
              max={1}
              step={0.01}
              onChange={set("ampS") as (v: number) => void}
              color={C_AMP}
              display={(v) => `${fmt(v * 100, 0)} %`}
              onActiveChange={(a) => onKnobActivity?.(a ? "Amp Sustain" : null)}
            />
            <Knob
              label="Release"
              value={params.ampR}
              min={0.001}
              max={3}
              step={0.001}
              onChange={set("ampR") as (v: number) => void}
              color={C_AMP}
              display={(v) => `${fmt(v * 1000, 0)} ms`}
              onActiveChange={(a) => onKnobActivity?.(a ? "Amp Release" : null)}
            />
          </div>
        </Panel>
      </div>

      {/* Filter Envelope */}
      <div className="md:col-span-4">
        <Panel
          title="Filter Envelope"
          index="04 / VCF·ENV"
          color={C_ENV}
          right={
            <span className="text-[10px] tracking-[0.14em] uppercase text-ink-3">
              → Cutoff
            </span>
          }
        >
          <Viz height={160}>
            <EnvViz
              a={params.filtA}
              d={params.filtD}
              s={params.filtS}
              r={params.filtR}
              color={C_ENV}
              envTrigger={envTriggerRef}
            />
            <VizCorner pos="tl">ADSR</VizCorner>
            <VizCorner pos="tr">
              {fmt(params.filtA + params.filtD + params.filtR, 2)} s
            </VizCorner>
          </Viz>
          <div className="flex gap-3.5 p-3 flex-wrap">
            <Knob
              label="Attack"
              value={params.filtA}
              min={0.001}
              max={2}
              step={0.001}
              onChange={set("filtA") as (v: number) => void}
              color={C_ENV}
              display={(v) => `${fmt(v * 1000, 0)} ms`}
              onActiveChange={(a) =>
                onKnobActivity?.(a ? "Filter Env Attack" : null)
              }
            />
            <Knob
              label="Decay"
              value={params.filtD}
              min={0.001}
              max={2}
              step={0.001}
              onChange={set("filtD") as (v: number) => void}
              color={C_ENV}
              display={(v) => `${fmt(v * 1000, 0)} ms`}
              onActiveChange={(a) =>
                onKnobActivity?.(a ? "Filter Env Decay" : null)
              }
            />
            <Knob
              label="Sustain"
              value={params.filtS}
              min={0}
              max={1}
              step={0.01}
              onChange={set("filtS") as (v: number) => void}
              color={C_ENV}
              display={(v) => `${fmt(v * 100, 0)} %`}
              onActiveChange={(a) =>
                onKnobActivity?.(a ? "Filter Env Sustain" : null)
              }
            />
            <Knob
              label="Release"
              value={params.filtR}
              min={0.001}
              max={3}
              step={0.001}
              onChange={set("filtR") as (v: number) => void}
              color={C_ENV}
              display={(v) => `${fmt(v * 1000, 0)} ms`}
              onActiveChange={(a) =>
                onKnobActivity?.(a ? "Filter Env Release" : null)
              }
            />
          </div>
        </Panel>
      </div>

      {/* LFO */}
      <div className="md:col-span-8">
        <Panel
          title="LFO"
          index="05 / LFO"
          color={C_LFO}
          right={
            <div className="flex gap-1.5">
              <Pill
                on={params.lfoTarget === "pitch"}
                color={C_OSC}
                label="→ Pitch"
                onClick={() =>
                  setParams((p) => ({
                    ...p,
                    lfoTarget: p.lfoTarget === "pitch" ? "none" : "pitch",
                  }))
                }
              />
              <Pill
                on={params.lfoTarget === "filter"}
                color={C_FLT}
                label="→ Filter"
                onClick={() =>
                  setParams((p) => ({
                    ...p,
                    lfoTarget: p.lfoTarget === "filter" ? "none" : "filter",
                  }))
                }
              />
            </div>
          }
        >
          <div className="px-3 pt-2.5 flex justify-end">
            <Readout value={fmt(params.lfoRate, 2)} unit="Hz" />
          </div>
          <Viz height={130}>
            <LfoViz
              rate={params.lfoRate}
              depth={params.lfoDepth}
              target={params.lfoTarget}
              color={C_LFO}
            />
            <VizCorner pos="tl">LFO</VizCorner>
            <VizCorner pos="br" style={{ color: C_LFO }}>
              ●{" "}
              {params.lfoTarget === "pitch"
                ? "MOD PITCH"
                : params.lfoTarget === "filter"
                  ? "MOD CUTOFF"
                  : "UNROUTED"}
            </VizCorner>
          </Viz>
          <div className="flex gap-3.5 p-3 flex-wrap">
            <Knob
              label="Rate"
              value={params.lfoRate}
              min={0.1}
              max={20}
              step={0.1}
              onChange={set("lfoRate") as (v: number) => void}
              color={C_LFO}
              display={(v) => `${fmt(v, 2)} Hz`}
              onActiveChange={(a) => onKnobActivity?.(a ? "LFO Rate" : null)}
            />
            <Knob
              label="Depth"
              value={params.lfoDepth}
              min={0}
              max={1200}
              step={1}
              onChange={set("lfoDepth") as (v: number) => void}
              color={C_LFO}
              display={(v) => `${fmt(v, 0)}`}
              onActiveChange={(a) => onKnobActivity?.(a ? "LFO Depth" : null)}
            />
          </div>
        </Panel>
      </div>

      {/* Keyboard */}
      <div className="md:col-span-12">
        <Panel
          title="Keyboard"
          index="06 / KBD"
          color="#fff"
          right={
            <div className="flex items-center gap-2">
              <span className="text-[10px] tracking-[0.14em] uppercase text-ink-3">
                OCT {params.octave}
                <span className="hidden md:inline"> · Z↓ X↑</span>
              </span>
              <div className="flex gap-1 md:hidden">
                <button
                  className="border border-hair rounded bg-panel-2 text-ink-3 px-2 py-1 font-mono text-[10px] leading-none cursor-pointer"
                  onClick={() =>
                    setParams((p) => ({
                      ...p,
                      octave: Math.max(0, p.octave - 1),
                    }))
                  }
                  aria-label="Octave down"
                >
                  −
                </button>
                <button
                  className="border border-hair rounded bg-panel-2 text-ink-3 px-2 py-1 font-mono text-[10px] leading-none cursor-pointer"
                  onClick={() =>
                    setParams((p) => ({
                      ...p,
                      octave: Math.min(8, p.octave + 1),
                    }))
                  }
                  aria-label="Octave up"
                >
                  +
                </button>
              </div>
            </div>
          }
        >
          <div className="p-3">
            <PianoKeyboard
              down={activeNotes}
              peerDown={peerDown}
              octave={params.octave}
              onDown={(note) => {
                if (voicesRef.current.has(note)) return;
                setActiveNotes((p) => new Set([...p, note]));
                initAudio();
                noteOn(note);
              }}
              onUp={(note) => {
                setActiveNotes((p) => {
                  const n = new Set(p);
                  n.delete(note);
                  return n;
                });
                noteOff(note);
              }}
            />
            <div className="flex justify-between mt-2.5 text-ink-3 text-[10px] tracking-[0.14em] uppercase">
              <span className="md:hidden">Tap · hold to sustain</span>
              <span className="hidden md:inline">Hold key · sustain note</span>
              <span className="hidden md:inline">
                A–K white · W E T Y U sharps
              </span>
            </div>
          </div>
        </Panel>
      </div>

      {/* Export */}
      <div className="md:col-span-12 flex gap-2 items-center pt-1">
        {exportStatus ? (
          <span className="text-[10px] tracking-[0.14em] uppercase text-ink-2">
            {exportStatus}
          </span>
        ) : (
          <>
            <Pill on color={C_AMP} label="Export SFZ" onClick={exportSFZ} />
            <Pill on color={C_FLT} label="Export SF2" onClick={exportSF2} />
          </>
        )}
      </div>
    </div>
  );
}

export default function Synth() {
  const [params, setParams] = useState<SynthParams>(DEFAULT_PARAMS);
  return <SynthInner params={params} setParams={setParams} />;
}
