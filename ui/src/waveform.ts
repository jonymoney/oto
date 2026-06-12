function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministic pseudo-waveform for an audio id: `count` bar heights in
 * [0.18, 1]. Neighbor smoothing plus a gentle center envelope makes the
 * bars read as speech rather than white noise, and the same id always
 * produces the same shape.
 */
export function barHeights(seed: string, count: number): number[] {
  const rand = mulberry32(fnv1a(seed))
  const raw = Array.from({ length: count }, () => rand())
  return raw.map((value, i) => {
    const prev = raw[(i + count - 1) % count]
    const next = raw[(i + 1) % count]
    const mixed = value * 0.6 + (prev + next) * 0.2
    const envelope = 0.72 + 0.28 * Math.sin((Math.PI * (i + 0.5)) / count)
    return Math.max(0.18, Math.min(1, (0.25 + mixed * 0.75) * envelope))
  })
}
