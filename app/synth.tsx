'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const KEY_TO_SEMITONE: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5,
  t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12,
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

interface SynthParams {
  waveform: OscillatorType
  filterCutoff: number
  filterRes: number
  volume: number
  ampA: number
  ampD: number
  ampS: number
  ampR: number
  filtA: number
  filtD: number
  filtS: number
  filtR: number
  filtEnvAmt: number
  lfoRate: number
  lfoDepth: number
  lfoTarget: 'pitch' | 'filter' | 'none'
  octave: number
}

interface Voice {
  osc: OscillatorNode
  ampEnv: GainNode
}

function Knob({
  label,
  value,
  min,
  max,
  step,
  display,
  paramKey,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  paramKey: keyof SynthParams
  onChange: (key: keyof SynthParams, val: number) => void
}) {
  return (
    <label style={{ display: 'block' }}>
      {label}: {display}{' '}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(paramKey, parseFloat(e.target.value))}
      />
    </label>
  )
}

export default function Synth() {
  const [params, setParams] = useState<SynthParams>({
    waveform: 'sawtooth',
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
    lfoTarget: 'none',
    octave: 4,
  })

  const ctxRef = useRef<AudioContext | null>(null)
  const filterRef = useRef<BiquadFilterNode | null>(null)
  const masterGainRef = useRef<GainNode | null>(null)
  const lfoRef = useRef<OscillatorNode | null>(null)
  const lfoGainRef = useRef<GainNode | null>(null)
  const voicesRef = useRef<Map<string, Voice>>(new Map())
  const pressedRef = useRef<Set<string>>(new Set())
  const paramsRef = useRef(params)
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set())

  useEffect(() => { paramsRef.current = params }, [params])

  useEffect(() => {
    if (!filterRef.current || !ctxRef.current) return
    // Only update filter frequency when no voices are active; envelope manages it otherwise
    if (voicesRef.current.size === 0) {
      filterRef.current.frequency.value = params.filterCutoff
    }
    filterRef.current.Q.value = params.filterRes
  }, [params.filterCutoff, params.filterRes])

  useEffect(() => {
    if (masterGainRef.current) masterGainRef.current.gain.value = params.volume * 0.15
  }, [params.volume])

  useEffect(() => {
    if (lfoRef.current) lfoRef.current.frequency.value = params.lfoRate
  }, [params.lfoRate])

  useEffect(() => {
    if (lfoGainRef.current) lfoGainRef.current.gain.value = params.lfoDepth
  }, [params.lfoDepth])

  useEffect(() => {
    voicesRef.current.forEach(v => { v.osc.type = params.waveform })
  }, [params.waveform])

  useEffect(() => {
    if (!lfoGainRef.current) return
    const lfoGain = lfoGainRef.current
    try { lfoGain.disconnect() } catch { /* not connected */ }
    if (params.lfoTarget === 'filter' && filterRef.current) {
      lfoGain.connect(filterRef.current.frequency)
    }
  }, [params.lfoTarget])

  const initAudio = useCallback(() => {
    if (ctxRef.current) return
    const ctx = new AudioContext()
    ctxRef.current = ctx

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = paramsRef.current.filterCutoff
    filter.Q.value = paramsRef.current.filterRes
    filterRef.current = filter

    const master = ctx.createGain()
    master.gain.value = paramsRef.current.volume * 0.15
    masterGainRef.current = master

    filter.connect(master)
    master.connect(ctx.destination)

    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = paramsRef.current.lfoRate
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = paramsRef.current.lfoDepth
    lfo.connect(lfoGain)
    lfoRef.current = lfo
    lfoGainRef.current = lfoGain
    lfo.start()

    if (paramsRef.current.lfoTarget === 'filter') {
      lfoGain.connect(filter.frequency)
    }
  }, [])

  const noteOn = useCallback((key: string) => {
    if (voicesRef.current.has(key)) return
    const p = paramsRef.current
    const ctx = ctxRef.current
    if (!ctx || !filterRef.current) return

    const now = ctx.currentTime
    const semitone = KEY_TO_SEMITONE[key]
    if (semitone === undefined) return

    const midi = 60 + (p.octave - 4) * 12 + semitone
    const freq = midiToFreq(midi)

    const osc = ctx.createOscillator()
    osc.type = p.waveform
    osc.frequency.value = freq

    if (p.lfoTarget === 'pitch' && lfoGainRef.current) {
      lfoGainRef.current.connect(osc.detune)
    }

    const ampEnv = ctx.createGain()
    const a = Math.max(p.ampA, 0.001)
    const d = Math.max(p.ampD, 0.001)
    ampEnv.gain.setValueAtTime(0, now)
    ampEnv.gain.linearRampToValueAtTime(1, now + a)
    ampEnv.gain.linearRampToValueAtTime(p.ampS, now + a + d)

    osc.connect(ampEnv)
    ampEnv.connect(filterRef.current)
    osc.start(now)

    const baseCutoff = p.filterCutoff
    const fa = Math.max(p.filtA, 0.001)
    const fd = Math.max(p.filtD, 0.001)
    filterRef.current.frequency.cancelScheduledValues(now)
    filterRef.current.frequency.setValueAtTime(baseCutoff, now)
    filterRef.current.frequency.linearRampToValueAtTime(baseCutoff + p.filtEnvAmt, now + fa)
    filterRef.current.frequency.linearRampToValueAtTime(
      baseCutoff + p.filtEnvAmt * p.filtS,
      now + fa + fd
    )

    voicesRef.current.set(key, { osc, ampEnv })
  }, [])

  const noteOff = useCallback((key: string) => {
    const voice = voicesRef.current.get(key)
    const ctx = ctxRef.current
    if (!voice || !ctx) return

    const p = paramsRef.current
    const now = ctx.currentTime
    const ar = Math.max(p.ampR, 0.001)
    const fr = Math.max(p.filtR, 0.001)

    voice.ampEnv.gain.cancelScheduledValues(now)
    voice.ampEnv.gain.setValueAtTime(voice.ampEnv.gain.value, now)
    voice.ampEnv.gain.linearRampToValueAtTime(0, now + ar)
    voice.osc.stop(now + ar + 0.01)

    if (filterRef.current) {
      filterRef.current.frequency.cancelScheduledValues(now)
      filterRef.current.frequency.setValueAtTime(filterRef.current.frequency.value, now)
      filterRef.current.frequency.linearRampToValueAtTime(p.filterCutoff, now + fr)
    }

    voicesRef.current.delete(key)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      const key = e.key.toLowerCase()

      if (key === 'z') {
        setParams(p => ({ ...p, octave: Math.max(0, p.octave - 1) }))
        return
      }
      if (key === 'x') {
        setParams(p => ({ ...p, octave: Math.min(8, p.octave + 1) }))
        return
      }

      if (key in KEY_TO_SEMITONE && !pressedRef.current.has(key)) {
        pressedRef.current.add(key)
        setActiveKeys(new Set(pressedRef.current))
        initAudio()
        noteOn(key)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (pressedRef.current.has(key)) {
        pressedRef.current.delete(key)
        setActiveKeys(new Set(pressedRef.current))
        noteOff(key)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [initAudio, noteOn, noteOff])

  useEffect(() => {
    return () => { ctxRef.current?.close() }
  }, [])

  const setNum = (key: keyof SynthParams, val: number) =>
    setParams(p => ({ ...p, [key]: val }))

  const keys = Object.entries(KEY_TO_SEMITONE)

  return (
    <div style={{ padding: '1rem', fontFamily: 'monospace' }}>
      <h1>Patchwork Synth</h1>
      <p>Press keyboard keys to play. <strong>Z</strong> / <strong>X</strong> shift octave down/up. Current octave: <strong>{params.octave}</strong></p>

      <fieldset>
        <legend>Waveform</legend>
        {(['sine', 'sawtooth', 'square'] as OscillatorType[]).map(w => (
          <label key={w} style={{ marginRight: '1rem' }}>
            <input
              type="radio"
              name="waveform"
              value={w}
              checked={params.waveform === w}
              onChange={() => setParams(p => ({ ...p, waveform: w }))}
            />
            {' '}{w}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Volume</legend>
        <Knob label="Level" value={params.volume} min={0} max={1} step={0.01}
          display={params.volume.toFixed(2)} paramKey="volume" onChange={setNum} />
      </fieldset>

      <fieldset>
        <legend>Filter</legend>
        <Knob label="Cutoff" value={params.filterCutoff} min={20} max={20000} step={1}
          display={`${params.filterCutoff.toFixed(0)} Hz`} paramKey="filterCutoff" onChange={setNum} />
        <Knob label="Resonance" value={params.filterRes} min={0.1} max={20} step={0.1}
          display={params.filterRes.toFixed(1)} paramKey="filterRes" onChange={setNum} />
      </fieldset>

      <fieldset>
        <legend>Amplitude Envelope</legend>
        <Knob label="Attack"  value={params.ampA} min={0.001} max={4} step={0.001}
          display={`${params.ampA.toFixed(3)}s`} paramKey="ampA" onChange={setNum} />
        <Knob label="Decay"   value={params.ampD} min={0.001} max={4} step={0.001}
          display={`${params.ampD.toFixed(3)}s`} paramKey="ampD" onChange={setNum} />
        <Knob label="Sustain" value={params.ampS} min={0}     max={1} step={0.01}
          display={params.ampS.toFixed(2)}         paramKey="ampS" onChange={setNum} />
        <Knob label="Release" value={params.ampR} min={0.001} max={4} step={0.001}
          display={`${params.ampR.toFixed(3)}s`} paramKey="ampR" onChange={setNum} />
      </fieldset>

      <fieldset>
        <legend>Filter Envelope</legend>
        <Knob label="Amount"  value={params.filtEnvAmt} min={0} max={15000} step={10}
          display={`${params.filtEnvAmt.toFixed(0)} Hz`} paramKey="filtEnvAmt" onChange={setNum} />
        <Knob label="Attack"  value={params.filtA} min={0.001} max={4} step={0.001}
          display={`${params.filtA.toFixed(3)}s`} paramKey="filtA" onChange={setNum} />
        <Knob label="Decay"   value={params.filtD} min={0.001} max={4} step={0.001}
          display={`${params.filtD.toFixed(3)}s`} paramKey="filtD" onChange={setNum} />
        <Knob label="Sustain" value={params.filtS} min={0}     max={1} step={0.01}
          display={params.filtS.toFixed(2)}         paramKey="filtS" onChange={setNum} />
        <Knob label="Release" value={params.filtR} min={0.001} max={4} step={0.001}
          display={`${params.filtR.toFixed(3)}s`} paramKey="filtR" onChange={setNum} />
      </fieldset>

      <fieldset>
        <legend>LFO</legend>
        <Knob label="Rate"  value={params.lfoRate}  min={0.1}  max={20}   step={0.1}
          display={`${params.lfoRate.toFixed(1)} Hz`} paramKey="lfoRate" onChange={setNum} />
        <Knob label="Depth" value={params.lfoDepth} min={0}    max={1200} step={1}
          display={params.lfoDepth.toFixed(0)}         paramKey="lfoDepth" onChange={setNum} />
        <div>
          Target:{' '}
          {(['none', 'pitch', 'filter'] as const).map(t => (
            <label key={t} style={{ marginRight: '1rem' }}>
              <input
                type="radio"
                name="lfoTarget"
                value={t}
                checked={params.lfoTarget === t}
                onChange={() => setParams(p => ({ ...p, lfoTarget: t }))}
              />
              {' '}{t}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Keyboard — octave {params.octave} (Z = octave down, X = octave up)</legend>
        <div style={{ display: 'flex', gap: '2px', userSelect: 'none', marginTop: '0.5rem' }}>
          {keys.map(([key, semitone]) => {
            const noteName = NOTE_NAMES[semitone % 12]
            const isSharp = noteName.includes('#')
            const isActive = activeKeys.has(key)
            return (
              <div
                key={key}
                style={{
                  border: '1px solid black',
                  padding: '0.5rem 0.3rem',
                  minWidth: '2rem',
                  textAlign: 'center',
                  background: isActive ? '#888' : isSharp ? '#222' : '#fff',
                  color: isActive ? '#fff' : isSharp ? '#fff' : '#000',
                  cursor: 'pointer',
                }}
                onMouseDown={() => {
                  if (!pressedRef.current.has(key)) {
                    pressedRef.current.add(key)
                    setActiveKeys(new Set(pressedRef.current))
                    initAudio()
                    noteOn(key)
                  }
                }}
                onMouseUp={() => {
                  if (pressedRef.current.has(key)) {
                    pressedRef.current.delete(key)
                    setActiveKeys(new Set(pressedRef.current))
                    noteOff(key)
                  }
                }}
                onMouseLeave={() => {
                  if (pressedRef.current.has(key)) {
                    pressedRef.current.delete(key)
                    setActiveKeys(new Set(pressedRef.current))
                    noteOff(key)
                  }
                }}
              >
                <div>{key.toUpperCase()}</div>
                <div style={{ fontSize: '0.65rem' }}>{noteName}</div>
              </div>
            )
          })}
        </div>
      </fieldset>
    </div>
  )
}
