// Minimal SF2 (SoundFont 2.04) writer.
// Spec: https://freepats.zenvoid.org/sf2/sfspec24.pdf

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

function str(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i)
  return out
}

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff])
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff])
}

// RIFF chunk: size field holds actual byte count, data padded to even length
function ck(id: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 !== 0 ? concat([data, new Uint8Array(1)]) : data
  return concat([str(id, 4), u32(data.length), pad])
}

// LIST chunk: LIST <size> <type> <subchunks>
function list(type: string, subchunks: Uint8Array[]): Uint8Array {
  const inner = concat([str(type, 4), ...subchunks])
  return concat([str('LIST', 4), u32(inner.length), inner])
}

function float32ToInt16(f32: Float32Array): Int16Array {
  let peak = 0
  for (let i = 0; i < f32.length; i++) peak = Math.max(peak, Math.abs(f32[i]))
  const scale = peak > 0.0001 ? 32767 / peak : 32767
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) out[i] = Math.round(f32[i] * scale)
  return out
}

export function buildSF2(
  samples: { midi: number; data: Float32Array }[],
  sampleRate: number,
  bankName: string,
): ArrayBuffer {
  const GUARD = 46 // required zero-sample guard between samples per spec
  const NOTE_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']

  type Sample = { name: string; midi: number; i16: Int16Array; start: number }
  const cvt: Sample[] = []
  let pos = 0
  for (const s of samples) {
    const i16 = float32ToInt16(s.data)
    const oct = Math.floor(s.midi / 12) - 1
    cvt.push({ name: NOTE_NAMES[s.midi % 12] + oct, midi: s.midi, i16, start: pos })
    pos += i16.length + GUARD
  }

  const smplBuf = new Int16Array(pos)
  for (const s of cvt) smplBuf.set(s.i16, s.start)

  // ── INFO ──────────────────────────────────────────────────────────────────
  const inam = bankName.slice(0, 255) + '\0'
  const inamPadded = inam.length % 2 !== 0 ? inam + '\0' : inam
  const infoChunk = list('INFO', [
    ck('ifil', concat([u16(2), u16(1)])),
    ck('isng', str('EMU8000\0', 8)),
    ck('INAM', str(inamPadded, inamPadded.length)),
  ])

  // ── sdta ──────────────────────────────────────────────────────────────────
  const sdtaChunk = list('sdta', [ck('smpl', new Uint8Array(smplBuf.buffer))])

  // ── pdta ──────────────────────────────────────────────────────────────────
  const N = cvt.length

  // phdr — 38 bytes: name(20) preset(2) bank(2) bagIdx(2) lib(4) genre(4) morph(4)
  const phdrData = concat([
    concat([str('Jamboree Synth', 20), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0)]),
    concat([str('EOP', 20), u16(255), u16(255), u16(1), u32(0), u32(0), u32(0)]),
  ])

  // pbag — 4 bytes: genIdx(2) modIdx(2) — 1 zone + terminal
  const pbagData = concat([u16(0), u16(0), u16(1), u16(0)])

  // pmod — terminal only (10 zero bytes)
  const pmodData = new Uint8Array(10)

  // pgen — instrument generator (type 41) pointing to inst 0 + terminal
  const pgenData = concat([u16(41), u16(0), new Uint8Array(4)])

  // inst — 22 bytes: name(20) bagIdx(2)
  const instData = concat([
    concat([str('Jamboree Synth', 20), u16(0)]),
    concat([str('EOI', 20), u16(N)]),
  ])

  // ibag — 4 bytes per zone; 3 generators per zone: keyRange, overridingRootKey, sampleID
  const ZONE_GENS = 3
  const ibagParts: Uint8Array[] = []
  for (let i = 0; i <= N; i++) ibagParts.push(concat([u16(i * ZONE_GENS), u16(0)]))
  const ibagData = concat(ibagParts)

  // imod — terminal only
  const imodData = new Uint8Array(10)

  // Key ranges split at midpoints between adjacent root keys
  const ranges = cvt.map((s, i) => ({
    lo: i === 0 ? 0 : Math.floor((cvt[i - 1].midi + s.midi) / 2) + 1,
    hi: i === N - 1 ? 127 : Math.floor((s.midi + cvt[i + 1].midi) / 2),
  }))

  // igen — 4 bytes each: keyRange(43), overridingRootKey(58), sampleID(53) per zone + terminal
  const igenParts: Uint8Array[] = []
  for (let i = 0; i < N; i++) {
    igenParts.push(concat([u16(43), new Uint8Array([ranges[i].lo, ranges[i].hi])]))
    igenParts.push(concat([u16(58), u16(cvt[i].midi)]))
    igenParts.push(concat([u16(53), u16(i)]))
  }
  igenParts.push(new Uint8Array(4))
  const igenData = concat(igenParts)

  // shdr — 46 bytes: name(20) start(4) end(4) loopStart(4) loopEnd(4) sr(4) pitch(1) corr(1) link(2) type(2)
  const shdrParts: Uint8Array[] = []
  for (const s of cvt) {
    shdrParts.push(concat([
      str(s.name, 20),
      u32(s.start), u32(s.start + s.i16.length),
      u32(s.start), u32(s.start + 1),
      u32(sampleRate),
      new Uint8Array([s.midi & 0x7f, 0]),
      u16(0), u16(1),
    ]))
  }
  shdrParts.push(concat([str('EOS', 20), u32(0), u32(0), u32(0), u32(0), u32(0), new Uint8Array([0, 0]), u16(0), u16(0)]))
  const shdrData = concat(shdrParts)

  const pdtaChunk = list('pdta', [
    ck('phdr', phdrData), ck('pbag', pbagData), ck('pmod', pmodData), ck('pgen', pgenData),
    ck('inst', instData), ck('ibag', ibagData), ck('imod', imodData), ck('igen', igenData),
    ck('shdr', shdrData),
  ])

  const sfbkContent = concat([str('sfbk', 4), infoChunk, sdtaChunk, pdtaChunk])
  const out = concat([str('RIFF', 4), u32(sfbkContent.length), sfbkContent])
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}
