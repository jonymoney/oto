// Run: npm test  (tsx --test; outside tsconfig's "src" include, so it never builds)
import assert from 'node:assert/strict'
import test from 'node:test'
import { mapWithLimit, chunkText } from '../src/tts.js'

test('mapWithLimit keeps input order regardless of completion order', async () => {
  // Later items finish first, so an order-by-completion bug would show here.
  const out = await mapWithLimit([50, 30, 10, 0], 4, async (ms) => {
    await new Promise((r) => setTimeout(r, ms))
    return ms
  })
  assert.deepEqual(out, [50, 30, 10, 0])
})

test('mapWithLimit never exceeds its concurrency cap', async () => {
  let running = 0
  let peak = 0
  await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 5))
    running -= 1
  })
  assert.equal(peak, 4)
})

test('mapWithLimit handles fewer items than the cap, and none at all', async () => {
  assert.deepEqual(await mapWithLimit([1, 2], 8, async (n) => n * 2), [2, 4])
  assert.deepEqual(await mapWithLimit([], 4, async (n) => n), [])
})

test('mapWithLimit propagates a worker failure', async () => {
  await assert.rejects(
    mapWithLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    }),
    /boom/,
  )
})

test('chunkText respects the cap and loses no text', async () => {
  const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i}.`).join(' ')
  const chunks = chunkText(text, 200)
  assert.ok(chunks.every((c) => c.length <= 200), 'every chunk within maxChars')
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '))
})

test('chunkText hard-splits a run with no boundary to break on', async () => {
  const chunks = chunkText('x'.repeat(250), 100)
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50])
})
