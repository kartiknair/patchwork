"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  KnobHeadless,
  KnobHeadlessLabel,
  KnobHeadlessOutput,
  useKnobKeyboardControls,
} from "react-knob-headless";
import JSZip from "jszip";
import { buildSF2 } from "./sf2";

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

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

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

function Knob({
  label,
  value,
  min,
  max,
  step,
  displayFn,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayFn: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const knobId = useId();
  const labelId = useId();
  const value01 = (value - min) / (max - min);
  const angle = value01 * 290 - 145;

  const keyboardHandlers = useKnobKeyboardControls({
    valueRaw: value,
    valueMin: min,
    valueMax: max,
    step,
    stepLarger: step * 10,
    onValueRawChange: onChange,
  });

  return (
    <div className="w-16 flex flex-col gap-0.5 justify-center items-center text-xs select-none outline-none focus-within:outline-1 focus-within:outline-offset-4 focus-within:outline-stone-300">
      <KnobHeadlessLabel id={labelId}>{label}</KnobHeadlessLabel>
      <KnobHeadless
        id={knobId}
        aria-labelledby={labelId}
        className="relative w-16 h-16 outline-none"
        valueMin={min}
        valueMax={max}
        valueRaw={value}
        valueRawRoundFn={(v) => v}
        valueRawDisplayFn={displayFn}
        dragSensitivity={0.006}
        includeIntoTabOrder
        onValueRawChange={onChange}
        {...keyboardHandlers}
      >
        <div className="absolute h-full w-full rounded-full bg-stone-300">
          <div
            className="absolute h-full w-full"
            style={{ rotate: `${angle}deg` }}
          >
            <div className="absolute left-1/2 top-0 h-1/2 w-0.5 -translate-x-1/2 rounded-sm bg-stone-950" />
          </div>
        </div>
      </KnobHeadless>
      <KnobHeadlessOutput htmlFor={knobId}>
        {displayFn(value)}
      </KnobHeadlessOutput>
    </div>
  );
}

export function SynthInner({
  params,
  setParams,
}: {
  params: SynthParams;
  setParams: React.Dispatch<React.SetStateAction<SynthParams>>;
}) {
  const ctxRef = useRef<AudioContext | null>(null);
  const filterRef = useRef<BiquadFilterNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const lfoRef = useRef<OscillatorNode | null>(null);
  const lfoGainRef = useRef<GainNode | null>(null);
  const voicesRef = useRef<Map<string, Voice>>(new Map());
  const pressedRef = useRef<Set<string>>(new Set());
  const paramsRef = useRef(params);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    if (!filterRef.current || !ctxRef.current) return;
    if (voicesRef.current.size === 0) {
      filterRef.current.frequency.value = params.filterCutoff;
    }
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
    const lfoGain = lfoGainRef.current;
    try {
      lfoGain.disconnect();
    } catch {
      /* not connected */
    }
    if (params.lfoTarget === "filter" && filterRef.current) {
      lfoGain.connect(filterRef.current.frequency);
    }
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

    if (paramsRef.current.lfoTarget === "filter") {
      lfoGain.connect(filter.frequency);
    }
  }, []);

  const noteOn = useCallback((key: string) => {
    if (voicesRef.current.has(key)) return;
    const p = paramsRef.current;
    const ctx = ctxRef.current;
    if (!ctx || !filterRef.current) return;

    const now = ctx.currentTime;
    const semitone = KEY_TO_SEMITONE[key];
    if (semitone === undefined) return;

    const midi = 60 + (p.octave - 4) * 12 + semitone;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = p.waveform;
    osc.frequency.value = freq;

    if (p.lfoTarget === "pitch" && lfoGainRef.current) {
      lfoGainRef.current.connect(osc.detune);
    }

    const ampEnv = ctx.createGain();
    const a = Math.max(p.ampA, 0.001);
    const d = Math.max(p.ampD, 0.001);
    ampEnv.gain.setValueAtTime(0, now);
    ampEnv.gain.linearRampToValueAtTime(1, now + a);
    ampEnv.gain.linearRampToValueAtTime(p.ampS, now + a + d);

    osc.connect(ampEnv);
    ampEnv.connect(filterRef.current);
    osc.start(now);

    const baseCutoff = p.filterCutoff;
    const fa = Math.max(p.filtA, 0.001);
    const fd = Math.max(p.filtD, 0.001);
    filterRef.current.frequency.cancelScheduledValues(now);
    filterRef.current.frequency.setValueAtTime(baseCutoff, now);
    filterRef.current.frequency.linearRampToValueAtTime(
      baseCutoff + p.filtEnvAmt,
      now + fa,
    );
    filterRef.current.frequency.linearRampToValueAtTime(
      baseCutoff + p.filtEnvAmt * p.filtS,
      now + fa + fd,
    );

    voicesRef.current.set(key, { osc, ampEnv });
  }, []);

  const noteOff = useCallback((key: string) => {
    const voice = voicesRef.current.get(key);
    const ctx = ctxRef.current;
    if (!voice || !ctx) return;

    const p = paramsRef.current;
    const now = ctx.currentTime;
    const ar = Math.max(p.ampR, 0.001);
    const fr = Math.max(p.filtR, 0.001);

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

    voicesRef.current.delete(key);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (
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
        setActiveKeys(new Set(pressedRef.current));
        initAudio();
        noteOn(key);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (pressedRef.current.has(key)) {
        pressedRef.current.delete(key);
        setActiveKeys(new Set(pressedRef.current));
        noteOff(key);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [initAudio, noteOn, noteOff, setParams]);

  useEffect(() => {
    return () => {
      ctxRef.current?.close();
    };
  }, []);

  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const SAMPLE_RATE = 44100;
  const SUSTAIN_DUR = 2.0;
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
      const noteOff = a + d + SUSTAIN_DUR;
      const duration = noteOff + r + 0.05;

      const ctx = new OfflineAudioContext(
        1,
        Math.ceil(duration * SAMPLE_RATE),
        SAMPLE_RATE,
      );
      const osc = ctx.createOscillator();
      osc.type = p.waveform;
      osc.frequency.value = midiToFreq(midi);

      const ampEnv = ctx.createGain();
      ampEnv.gain.setValueAtTime(0, 0);
      ampEnv.gain.linearRampToValueAtTime(1, a);
      ampEnv.gain.linearRampToValueAtTime(p.ampS, a + d);
      ampEnv.gain.setValueAtTime(p.ampS, noteOff);
      ampEnv.gain.linearRampToValueAtTime(0, noteOff + r);

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
        noteOff,
      );
      filter.frequency.linearRampToValueAtTime(p.filterCutoff, noteOff + fr);
      filter.Q.value = p.filterRes;

      const master = ctx.createGain();
      master.gain.value = p.volume * 0.15;

      osc.connect(ampEnv);
      ampEnv.connect(filter);
      filter.connect(master);
      master.connect(ctx.destination);
      osc.start(0);
      osc.stop(duration);

      const rendered = await ctx.startRendering();
      const oct = Math.floor(midi / 12) - 1;
      samples.push({
        midi,
        name: NOTE_NAMES_EXP[midi % 12] + oct,
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

    const sfzLines = ["// Patchwork Synth export", ""];
    for (let i = 0; i < samples.length; i++) {
      const { midi, name, data } = samples[i];
      const lo = i === 0 ? 0 : Math.floor((samples[i - 1].midi + midi) / 2) + 1;
      const hi =
        i === samples.length - 1
          ? 127
          : Math.floor((midi + samples[i + 1].midi) / 2);
      zip.file(name + ".wav", encodeWav(data, SAMPLE_RATE));
      sfzLines.push(
        "<region>",
        `sample=${name}.wav`,
        `pitch_keycenter=${midi}`,
        `lokey=${lo}`,
        `hikey=${hi}`,
        "",
      );
    }
    zip.file("patch.sfz", sfzLines.join("\n"));

    setExportStatus("Compressing…");
    await new Promise<void>((r) => setTimeout(r, 0));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a_el = document.createElement("a");
    a_el.href = url;
    a_el.download = "patchwork.zip";
    a_el.click();
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
      "Patchwork Synth",
    );
    const blob = new Blob([sf2], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a_el = document.createElement("a");
    a_el.href = url;
    a_el.download = "patchwork.sf2";
    a_el.click();
    URL.revokeObjectURL(url);
    setExportStatus(null);
  };

  const set = (key: keyof SynthParams) => (v: number) =>
    setParams((p) => ({ ...p, [key]: v }));

  const keys = Object.entries(KEY_TO_SEMITONE);

  return (
    <div style={{ padding: "1rem", fontFamily: "monospace" }}>
      <h1>Patchwork Synth</h1>
      <p className="mb-8">
        Press keyboard keys to play. <strong>Z</strong> / <strong>X</strong>{" "}
        shift octave. Current octave: <strong>{params.octave}</strong>
      </p>

      <fieldset>
        <legend>Waveform</legend>
        {(["sine", "sawtooth", "square"] as OscillatorType[]).map((w) => (
          <label key={w} style={{ marginRight: "1rem" }}>
            <input
              type="radio"
              name="waveform"
              value={w}
              checked={params.waveform === w}
              onChange={() => setParams((p) => ({ ...p, waveform: w }))}
            />{" "}
            {w}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Volume</legend>
        <div className="flex gap-4 pt-2">
          <Knob
            label="Level"
            value={params.volume}
            min={0}
            max={1}
            step={0.01}
            displayFn={(v) => v.toFixed(2)}
            onChange={set("volume")}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Filter</legend>
        <div className="flex gap-4 pt-2">
          <Knob
            label="Cutoff"
            value={params.filterCutoff}
            min={20}
            max={20000}
            step={10}
            displayFn={(v) => `${Math.round(v)}Hz`}
            onChange={set("filterCutoff")}
          />
          <Knob
            label="Res"
            value={params.filterRes}
            min={0.1}
            max={20}
            step={0.1}
            displayFn={(v) => v.toFixed(1)}
            onChange={set("filterRes")}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Amplitude Envelope</legend>
        <div className="flex gap-4 pt-2">
          <Knob
            label="Attack"
            value={params.ampA}
            min={0.001}
            max={4}
            step={0.001}
            displayFn={(v) => `${v.toFixed(3)}s`}
            onChange={set("ampA")}
          />
          <Knob
            label="Decay"
            value={params.ampD}
            min={0.001}
            max={4}
            step={0.001}
            displayFn={(v) => `${v.toFixed(3)}s`}
            onChange={set("ampD")}
          />
          <Knob
            label="Sustain"
            value={params.ampS}
            min={0}
            max={1}
            step={0.01}
            displayFn={(v) => v.toFixed(2)}
            onChange={set("ampS")}
          />
          <Knob
            label="Release"
            value={params.ampR}
            min={0.001}
            max={4}
            step={0.001}
            displayFn={(v) => `${v.toFixed(3)}s`}
            onChange={set("ampR")}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Filter Envelope</legend>
        <div className="flex gap-4 pt-2">
          <Knob
            label="Amt"
            value={params.filtEnvAmt}
            min={0}
            max={15000}
            step={10}
            displayFn={(v) => `${Math.round(v)}Hz`}
            onChange={set("filtEnvAmt")}
          />
          <Knob
            label="Attack"
            value={params.filtA}
            min={0.001}
            max={4}
            step={0.001}
            displayFn={(v) => `${v.toFixed(3)}s`}
            onChange={set("filtA")}
          />
          <Knob
            label="Decay"
            value={params.filtD}
            min={0.001}
            max={4}
            step={0.001}
            displayFn={(v) => `${v.toFixed(3)}s`}
            onChange={set("filtD")}
          />
          <Knob
            label="Sustain"
            value={params.filtS}
            min={0}
            max={1}
            step={0.01}
            displayFn={(v) => v.toFixed(2)}
            onChange={set("filtS")}
          />
          <Knob
            label="Release"
            value={params.filtR}
            min={0.001}
            max={4}
            step={0.001}
            displayFn={(v) => `${v.toFixed(3)}s`}
            onChange={set("filtR")}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>LFO</legend>
        <div className="flex gap-4 pt-2">
          <Knob
            label="Rate"
            value={params.lfoRate}
            min={0.1}
            max={20}
            step={0.1}
            displayFn={(v) => `${v.toFixed(1)}Hz`}
            onChange={set("lfoRate")}
          />
          <Knob
            label="Depth"
            value={params.lfoDepth}
            min={0}
            max={1200}
            step={1}
            displayFn={(v) => `${Math.round(v)}`}
            onChange={set("lfoDepth")}
          />
        </div>
        <div style={{ marginTop: "0.5rem" }}>
          Target:{" "}
          {(["none", "pitch", "filter"] as const).map((t) => (
            <label key={t} style={{ marginRight: "1rem" }}>
              <input
                type="radio"
                name="lfoTarget"
                value={t}
                checked={params.lfoTarget === t}
                onChange={() => setParams((p) => ({ ...p, lfoTarget: t }))}
              />{" "}
              {t}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Keyboard — octave {params.octave} (Z = down, X = up)</legend>
        <div
          style={{
            display: "flex",
            gap: "2px",
            userSelect: "none",
            marginTop: "0.5rem",
          }}
        >
          {keys.map(([key, semitone]) => {
            const noteName = NOTE_NAMES[semitone % 12];
            const isSharp = noteName.includes("#");
            const isActive = activeKeys.has(key);
            return (
              <div
                key={key}
                style={{
                  border: "1px solid black",
                  padding: "0.5rem 0.3rem",
                  minWidth: "2rem",
                  textAlign: "center",
                  background: isActive ? "#888" : isSharp ? "#222" : "#fff",
                  color: isActive ? "#fff" : isSharp ? "#fff" : "#000",
                  cursor: "pointer",
                }}
                onMouseDown={() => {
                  if (!pressedRef.current.has(key)) {
                    pressedRef.current.add(key);
                    setActiveKeys(new Set(pressedRef.current));
                    initAudio();
                    noteOn(key);
                  }
                }}
                onMouseUp={() => {
                  if (pressedRef.current.has(key)) {
                    pressedRef.current.delete(key);
                    setActiveKeys(new Set(pressedRef.current));
                    noteOff(key);
                  }
                }}
                onMouseLeave={() => {
                  if (pressedRef.current.has(key)) {
                    pressedRef.current.delete(key);
                    setActiveKeys(new Set(pressedRef.current));
                    noteOff(key);
                  }
                }}
              >
                <div>{key.toUpperCase()}</div>
                <div style={{ fontSize: "0.65rem" }}>{noteName}</div>
              </div>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend>Export</legend>
        {exportStatus ? (
          <span>{exportStatus}</span>
        ) : (
          <>
            <button onClick={exportSFZ} style={{ marginRight: "0.5rem" }}>
              SFZ + WAV (.zip)
            </button>
            <button onClick={exportSF2}>SF2</button>
          </>
        )}
      </fieldset>
    </div>
  );
}

export default function Synth() {
  const [params, setParams] = useState<SynthParams>(DEFAULT_PARAMS);
  return <SynthInner params={params} setParams={setParams} />;
}
