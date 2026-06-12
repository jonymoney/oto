#!/usr/bin/env node
/**
 * Elicitation test client for the oto MCP server.
 *
 * Exercises the text_to_speech elicitation matrix against a locally running
 * server (AUTH_MODE=disabled, stateful /mcp sessions):
 *
 *   node scripts/test-elicitation.mjs <scenario> [nonce]
 *
 * scenario ∈ all | voices-tool | voice-pick | voice-save | voice-decline
 *          | voice-cancel | voice-listen | cost-yes | cost-no
 *          | favorite-tool-validation | no-elicit-fallback
 *
 * The optional [nonce] is mixed into every generated text so dedup never
 * short-circuits across runs (defaults to Date.now()).
 *
 * Notes:
 * - Scenarios share one server-side user (auth is disabled), so every
 *   scenario that persists a favorite voice (voice-listen, voice-save,
 *   favorite-tool-validation) affects all later ones. In "all" mode those
 *   run after the scenarios that need the voice elicitation to fire. On a
 *   DB where a favorite is already saved, the voice-elicitation scenarios
 *   print SKIP instead of failing.
 * - Required pre-state: there is no reset helper for the favorite voice, so
 *   to exercise the full elicitation matrix the shared dev user must start
 *   with NO saved favorite (clear it in the DB / use a fresh DB). Within a
 *   single "all" pass, voice-listen persists a favorite before voice-save
 *   runs, so voice-save prints SKIP unless the favorite is cleared in
 *   between (run it individually against a clean user to exercise it).
 * - cost-yes / cost-no are only meaningful when the server-side remaining
 *   quota is small enough that a <200-char text estimates to >50% of it;
 *   otherwise they print a SKIP note.
 * - voices-tool's first ever run against a fresh bucket lazily provisions
 *   the 13 global samples, so it can take noticeably longer than later runs.
 *
 * Output: one PASS/FAIL/SKIP line per scenario; exit code 1 if any FAIL.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'

const MCP_URL = process.env.OTO_MCP_URL ?? 'http://localhost:3101/mcp'
const CALL_TIMEOUT_MS = 180_000

const [, , scenarioArg, nonceArg] = process.argv
const nonce = nonceArg ?? String(Date.now())

const log = (...args) => console.log(...args)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Mirrors VOICES in src/tts.ts — the 13 built-in gpt-4o-mini-tts voices.
const VOICE_NAMES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova',
  'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
]

function uniqueText(label) {
  // Unique per scenario+nonce so the server's textHash dedup never reuses a
  // stored audio; kept well under 200 chars so generation costs ~nothing.
  return `oto elicitation test, ${label}, nonce ${nonce}. One short line.`
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

function hasAudio(result) {
  const kind = result?.structuredContent?.kind
  return kind === 'audio' || kind === 'processing'
}

function resultVoice(result) {
  const sc = result?.structuredContent
  if (sc?.kind === 'audio' && typeof sc.voice === 'string') return sc.voice
  // ProcessingPayload has no voice field; fall back to the result text
  // ("... voice cedar ...") emitted by the tool.
  const match = textOf(result).match(/voice\s+([a-z]+)/i)
  return match ? match[1].toLowerCase() : null
}

/** Classify an elicitation request by the property names it asks for. */
function classifyElicitation(params) {
  const props = params?.requestedSchema?.properties ?? {}
  const keys = Object.keys(props)
  if (keys.includes('voice')) return 'voice'
  if (keys.includes('confirm')) return 'confirm'
  return 'unknown'
}

function describeElicitation(params) {
  const props = params?.requestedSchema?.properties ?? {}
  return `message=${JSON.stringify(params?.message ?? null)} properties=[${Object.keys(props).join(', ')}]`
}

/**
 * Builds a scripted elicitation handler. `answers` maps an elicitation kind
 * ('voice' | 'confirm') to the ElicitResult to return; every request received
 * is logged (message + schema property names) and recorded in `seen`.
 */
function makeElicitPlan(answers) {
  const seen = { voice: [], confirm: [], unknown: [] }
  const handler = async (request) => {
    const params = request.params
    const kind = classifyElicitation(params)
    seen[kind].push(params)
    log(`  << elicitation [${kind}] ${describeElicitation(params)}`)
    const answer = answers[kind] ?? { action: 'decline' }
    if (!answers[kind]) {
      log(`  !! no scripted answer for elicitation kind "${kind}" — declining`)
    }
    log(`  >> scripted answer: ${JSON.stringify(answer)}`)
    return answer
  }
  return { handler, seen }
}

/**
 * Opens a fresh stateful session against MCP_URL, runs `fn`, then deletes all
 * audio ids that `fn` registered in createdIds and tears the session down.
 *
 * When `elicitation` is false the client declares NO elicitation capability
 * and any incoming elicitation/create is reported via `onUnexpectedElicit`
 * and answered with MethodNotFound — exactly what a host without elicitation
 * support would do.
 */
async function withSession({ elicitation = true, onElicit, onUnexpectedElicit }, fn) {
  const client = new Client(
    { name: 'oto-elicitation-test', version: '0.1.0' },
    { capabilities: elicitation ? { elicitation: {} } : {} },
  )
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, onElicit)
  } else {
    client.fallbackRequestHandler = async (request) => {
      if (request.method === 'elicitation/create') {
        log(`  !! unexpected elicitation/create received without capability: ${describeElicitation(request.params)}`)
        onUnexpectedElicit?.(request)
      }
      throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`)
    }
  }

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
  await client.connect(transport)
  const createdIds = new Set()
  try {
    return await fn({ client, createdIds })
  } finally {
    for (const id of createdIds) {
      try {
        await client.callTool(
          { name: 'delete_audio', arguments: { id } },
          undefined,
          { timeout: 30_000 },
        )
        log(`  cleanup: deleted audio ${id}`)
      } catch (err) {
        log(`  cleanup: failed to delete audio ${id}: ${err?.message ?? err}`)
      }
    }
    try {
      await transport.terminateSession()
    } catch {
      // Older/stateless servers may not support DELETE; ignore.
    }
    try {
      await client.close()
    } catch {
      // ignore
    }
  }
}

/** Calls text_to_speech and registers any created audio id for cleanup. */
async function callTts(client, createdIds, text) {
  const result = await client.callTool(
    { name: 'text_to_speech', arguments: { text } },
    undefined,
    { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
  )
  const sc = result?.structuredContent
  if ((sc?.kind === 'audio' || sc?.kind === 'processing') && typeof sc.id === 'string') {
    createdIds.add(sc.id)
  }
  log(`  tool result: isError=${result?.isError === true} kind=${sc?.kind ?? 'none'}${sc?.voice ? ` voice=${sc.voice}` : ''}`)
  log(`  tool text: ${textOf(result).slice(0, 200)}`)
  return result
}

/** Calls any other tool with logging; no audio-id bookkeeping (use callTts for text_to_speech). */
async function callTool(client, name, args) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
  )
  log(`  ${name} result: isError=${result?.isError === true} kind=${result?.structuredContent?.kind ?? 'none'}`)
  log(`  ${name} text: ${textOf(result).slice(0, 200)}`)
  return result
}

/** Like callTts but never throws — cancel/decline paths may reject the call. */
async function callTtsSettled(client, createdIds, text) {
  try {
    return { ok: true, result: await callTts(client, createdIds, text) }
  } catch (err) {
    log(`  tool call rejected: ${err?.message ?? err}`)
    return { ok: false, error: err }
  }
}

const pass = (detail) => ({ status: 'PASS', detail })
const fail = (detail) => ({ status: 'FAIL', detail })
const skip = (detail) => ({ status: 'SKIP', detail })

const FAVORITE_SAVED_NOTE =
  'no voice elicitation fired but generation succeeded — a favorite voice is ' +
  'probably already saved for this user (reset the favorite / use a fresh DB to exercise this path)'

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioVoicesTool() {
  // The gallery never elicits, so the client's elicitation capability is
  // irrelevant — connect without it (the strictest host shape).
  return withSession({ elicitation: false }, async ({ client }) => {
    const result = await callTool(client, 'voices', {})
    if (result?.isError === true) return fail(`voices tool errored: ${textOf(result)}`)
    const sc = result?.structuredContent
    if (sc?.kind !== 'voices') {
      return fail(`expected structuredContent.kind "voices", got ${sc?.kind ?? 'none'}`)
    }
    if (!Array.isArray(sc.voices)) return fail('structuredContent.voices is not an array')
    if (sc.voices.length !== VOICE_NAMES.length) {
      return fail(`expected exactly ${VOICE_NAMES.length} voice samples, got ${sc.voices.length}`)
    }
    const bad = sc.voices.filter(
      (v) =>
        typeof v?.voice !== 'string' || v.voice.length === 0 ||
        typeof v?.sampleUrl !== 'string' || !v.sampleUrl.startsWith('https://'),
    )
    if (bad.length > 0) {
      return fail(
        `${bad.length} sample entr${bad.length === 1 ? 'y lacks' : 'ies lack'} a voice name or a non-empty https sampleUrl: ` +
          JSON.stringify(bad.slice(0, 3)),
      )
    }
    if (sc.favorite !== null && typeof sc.favorite !== 'string') {
      return fail(`favorite must be null or a string, got ${JSON.stringify(sc.favorite)}`)
    }
    return pass(
      `gallery returned ${sc.voices.length} voice samples, all with https sample URLs (favorite=${JSON.stringify(sc.favorite)})`,
    )
  })
}

async function scenarioVoicePick() {
  const plan = makeElicitPlan({
    voice: { action: 'accept', content: { voice: 'marin' } },
    // If the quota confirm also fires, approve it so the voice assertion runs.
    confirm: { action: 'accept', content: { confirm: true } },
  })
  return withSession({ onElicit: plan.handler }, async ({ client, createdIds }) => {
    const result = await callTts(client, createdIds, uniqueText('voice-pick'))
    if (plan.seen.voice.length === 0) {
      if (result.isError !== true && hasAudio(result)) {
        return skip(`${FAVORITE_SAVED_NOTE}; generated with voice=${resultVoice(result)}`)
      }
      return fail(`no voice elicitation fired and the call did not succeed: ${textOf(result)}`)
    }
    if (result.isError === true) {
      return fail(`tool returned an error after accepting voice marin: ${textOf(result)}`)
    }
    if (!hasAudio(result)) {
      return fail(`expected an audio/processing payload, got kind=${result?.structuredContent?.kind ?? 'none'}`)
    }
    const voice = resultVoice(result)
    if (voice !== 'marin') return fail(`expected voice marin, got ${voice}`)
    return pass(`voice elicitation fired (${plan.seen.voice.length}x), accepted marin, audio voice=marin`)
  })
}

async function scenarioVoiceSave() {
  const plan = makeElicitPlan({
    voice: { action: 'accept', content: { voice: 'cedar', saveAsFavorite: true } },
    confirm: { action: 'accept', content: { confirm: true } },
  })
  return withSession({ onElicit: plan.handler }, async ({ client, createdIds }) => {
    const first = await callTts(client, createdIds, uniqueText('voice-save call 1'))
    if (plan.seen.voice.length === 0) {
      if (first.isError !== true && hasAudio(first)) {
        return skip(`${FAVORITE_SAVED_NOTE}; cannot exercise save-as-favorite`)
      }
      return fail(`no voice elicitation fired and the first call did not succeed: ${textOf(first)}`)
    }
    if (first.isError === true) {
      return fail(`first call errored after accepting cedar+saveAsFavorite: ${textOf(first)}`)
    }
    const firstVoice = resultVoice(first)
    if (firstVoice !== 'cedar') return fail(`first call: expected voice cedar, got ${firstVoice}`)

    // Second call: the favorite must now be saved, so NO voice elicitation
    // may fire and the voice must still be cedar.
    const voiceElicitsBefore = plan.seen.voice.length
    const second = await callTts(client, createdIds, uniqueText('voice-save call 2'))
    if (plan.seen.voice.length > voiceElicitsBefore) {
      return fail('second call re-elicited the voice — favorite was not saved')
    }
    if (second.isError === true) return fail(`second call errored: ${textOf(second)}`)
    const secondVoice = resultVoice(second)
    if (secondVoice !== 'cedar') {
      return fail(`second call: expected favorite voice cedar, got ${secondVoice}`)
    }
    return pass('accepted cedar with saveAsFavorite; second call used cedar without re-eliciting')
  })
}

async function scenarioVoiceDecline() {
  const plan = makeElicitPlan({
    voice: { action: 'decline' },
    confirm: { action: 'accept', content: { confirm: true } },
  })
  return withSession({ onElicit: plan.handler }, async ({ client, createdIds }) => {
    const out = await callTtsSettled(client, createdIds, uniqueText('voice-decline'))
    if (plan.seen.voice.length === 0) {
      if (out.ok && out.result.isError !== true && hasAudio(out.result)) {
        return skip(`${FAVORITE_SAVED_NOTE}; generated with voice=${resultVoice(out.result)}`)
      }
      return fail(
        `no voice elicitation fired and the call did not succeed: ${out.ok ? textOf(out.result) : out.error?.message}`,
      )
    }
    // The server contract for decline is either "fall back to the default
    // voice" or "abort cleanly" — both are coherent; log which one we saw.
    if (out.ok && out.result.isError !== true && hasAudio(out.result)) {
      return pass(`declined the voice choice; server fell back and generated with voice=${resultVoice(out.result)}`)
    }
    const reason = out.ok ? textOf(out.result).slice(0, 160) : (out.error?.message ?? String(out.error))
    return pass(`declined the voice choice; server did not generate audio (${reason})`)
  })
}

async function scenarioVoiceCancel() {
  const plan = makeElicitPlan({
    voice: { action: 'cancel' },
    confirm: { action: 'accept', content: { confirm: true } },
  })
  return withSession({ onElicit: plan.handler }, async ({ client, createdIds }) => {
    const out = await callTtsSettled(client, createdIds, uniqueText('voice-cancel'))
    if (plan.seen.voice.length === 0) {
      if (out.ok && out.result.isError !== true && hasAudio(out.result)) {
        return skip(`${FAVORITE_SAVED_NOTE}; cannot exercise cancel`)
      }
      return fail(
        `no voice elicitation fired and the call did not succeed: ${out.ok ? textOf(out.result) : out.error?.message}`,
      )
    }
    if (out.ok && hasAudio(out.result)) {
      return fail(`audio was generated (id=${out.result.structuredContent.id}) despite cancelling the voice elicitation`)
    }
    const reason = out.ok ? textOf(out.result).slice(0, 160) : (out.error?.message ?? String(out.error))
    return pass(`cancel honored — no audio generated (${reason})`)
  })
}

async function scenarioVoiceListen() {
  const plan = makeElicitPlan({
    voice: { action: 'accept', content: { voice: 'listen-first' } },
    confirm: { action: 'accept', content: { confirm: true } },
  })
  return withSession({ onElicit: plan.handler }, async ({ client, createdIds }) => {
    const first = await callTts(client, createdIds, uniqueText('voice-listen call 1'))
    if (plan.seen.voice.length === 0) {
      if (first.isError !== true && hasAudio(first)) {
        return skip(`${FAVORITE_SAVED_NOTE}; cannot exercise listen-first`)
      }
      return fail(`no voice elicitation fired and the call did not succeed: ${textOf(first)}`)
    }
    if (first.isError === true) {
      return fail(`tool errored after answering listen-first: ${textOf(first)}`)
    }
    if (hasAudio(first)) {
      return fail(
        `audio was created (kind=${first.structuredContent.kind}, id=${first.structuredContent.id}) although listen-first must show the gallery instead of generating`,
      )
    }
    if (first?.structuredContent?.kind !== 'voices') {
      return fail(
        `expected the voice gallery (kind "voices") instead of generation, got kind=${first?.structuredContent?.kind ?? 'none'}`,
      )
    }

    // The user "picked from the gallery": persist nova via the new tool.
    const set = await callTool(client, 'set_favorite_voice', { voice: 'nova' })
    if (set?.isError === true) return fail(`set_favorite_voice nova errored: ${textOf(set)}`)
    if (set?.structuredContent?.ok === false) {
      return fail(`set_favorite_voice nova returned ok=false: ${textOf(set)}`)
    }

    // Second call: the favorite must now apply, so NO voice elicitation may
    // fire and the generated audio must use nova.
    const voiceElicitsBefore = plan.seen.voice.length
    const second = await callTts(client, createdIds, uniqueText('voice-listen call 2'))
    if (plan.seen.voice.length > voiceElicitsBefore) {
      return fail('second call re-elicited the voice although set_favorite_voice saved nova')
    }
    if (second.isError === true) return fail(`second call errored: ${textOf(second)}`)
    if (!hasAudio(second)) {
      return fail(`second call: expected an audio/processing payload, got kind=${second?.structuredContent?.kind ?? 'none'}`)
    }
    const voice = resultVoice(second)
    if (voice !== 'nova') return fail(`second call: expected favorite voice nova, got ${voice}`)
    return pass(
      'listen-first showed the gallery without generating; set_favorite_voice nova saved; second call generated with nova without re-eliciting',
    )
  })
}

async function scenarioCostYes() {
  const plan = makeElicitPlan({
    // If no favorite exists yet, a voice question may precede the cost
    // confirm — answer it with a valid voice without saving.
    voice: { action: 'accept', content: { voice: 'alloy' } },
    confirm: { action: 'accept', content: { confirm: true } },
  })
  return withSession({ onElicit: plan.handler }, async ({ client, createdIds }) => {
    const out = await callTtsSettled(client, createdIds, uniqueText('cost-yes'))
    if (plan.seen.confirm.length === 0) {
      if (out.ok && out.result.isError !== true && hasAudio(out.result)) {
        return skip(
          'cost confirmation never fired — this short text estimates well under 50% of the remaining quota. ' +
            'Run the server with a tiny quota (or a nearly-exhausted user) to exercise this path.',
        )
      }
      return fail(
        `no cost confirmation fired and the call did not succeed: ${out.ok ? textOf(out.result) : out.error?.message}`,
      )
    }
    if (!out.ok) return fail(`confirmed yes but the call rejected: ${out.error?.message}`)
    if (out.result.isError === true) return fail(`confirmed yes but the tool errored: ${textOf(out.result)}`)
    if (!hasAudio(out.result)) {
      return fail(`confirmed yes but no audio payload returned (kind=${out.result?.structuredContent?.kind ?? 'none'})`)
    }
    return pass('cost confirmation fired; confirm=true produced audio')
  })
}

async function scenarioCostNo() {
  const plan = makeElicitPlan({
    voice: { action: 'accept', content: { voice: 'alloy' } },
    confirm: { action: 'accept', content: { confirm: false } },
  })
  return withSession({ onElicit: plan.handler }, async ({ client, createdIds }) => {
    const out = await callTtsSettled(client, createdIds, uniqueText('cost-no'))
    if (plan.seen.confirm.length === 0) {
      if (out.ok && out.result.isError !== true && hasAudio(out.result)) {
        return skip(
          'cost confirmation never fired — this short text estimates well under 50% of the remaining quota. ' +
            'Run the server with a tiny quota (or a nearly-exhausted user) to exercise this path. ' +
            '(The audio generated meanwhile was cleaned up.)',
        )
      }
      return fail(
        `no cost confirmation fired and the call did not succeed: ${out.ok ? textOf(out.result) : out.error?.message}`,
      )
    }
    if (out.ok && hasAudio(out.result)) {
      return fail(`audio was generated (id=${out.result.structuredContent.id}) despite confirm=false`)
    }
    const reason = out.ok ? textOf(out.result).slice(0, 160) : (out.error?.message ?? String(out.error))
    return pass(`cost confirmation fired; confirm=false prevented generation (${reason})`)
  })
}

async function scenarioFavoriteToolValidation() {
  // Direct tool calls only — no elicitation involved.
  return withSession({ elicitation: false }, async ({ client }) => {
    let invalid
    try {
      invalid = await callTool(client, 'set_favorite_voice', { voice: 'darth-vader' })
    } catch (err) {
      return fail(
        `set_favorite_voice with an invalid voice rejected at the protocol level instead of returning an isError result: ${err?.message ?? err}`,
      )
    }
    if (invalid?.isError !== true) {
      return fail(
        `expected isError=true for voice "darth-vader", got isError=${invalid?.isError === true} (${textOf(invalid).slice(0, 160)})`,
      )
    }
    const errText = textOf(invalid).toLowerCase()
    const mentioned = VOICE_NAMES.filter((v) => errText.includes(v))
    if (mentioned.length < 2) {
      return fail(`error for the invalid voice does not mention the valid voices: ${textOf(invalid).slice(0, 200)}`)
    }

    // Case-insensitive save: 'Cedar' must persist as canonical 'cedar'.
    const set = await callTool(client, 'set_favorite_voice', { voice: 'Cedar' })
    if (set?.isError === true) return fail(`set_favorite_voice "Cedar" errored: ${textOf(set)}`)
    if (set?.structuredContent?.ok === false) {
      return fail(`set_favorite_voice "Cedar" returned ok=false: ${textOf(set)}`)
    }
    // Verify through the contract-defined gallery payload rather than relying
    // on set_favorite_voice's own output shape.
    const gallery = await callTool(client, 'voices', {})
    if (gallery?.isError === true) return fail(`voices tool errored while verifying the favorite: ${textOf(gallery)}`)
    const favorite = gallery?.structuredContent?.favorite
    if (favorite !== 'cedar') {
      return fail(`expected favorite "cedar" after setting "Cedar", gallery reports ${JSON.stringify(favorite)}`)
    }
    return pass('invalid voice "darth-vader" rejected with the valid-voice list; "Cedar" saved case-insensitively as "cedar"')
  })
}

async function scenarioNoElicitFallback() {
  const unexpected = []
  return withSession(
    { elicitation: false, onUnexpectedElicit: (request) => unexpected.push(request) },
    async ({ client, createdIds }) => {
      const out = await callTtsSettled(client, createdIds, uniqueText('no-elicit-fallback'))
      if (unexpected.length > 0) {
        return fail(`server sent ${unexpected.length} elicitation request(s) although the client declared no elicitation capability`)
      }
      if (!out.ok) return fail(`tool call rejected: ${out.error?.message}`)
      if (out.result.isError === true) return fail(`tool errored: ${textOf(out.result)}`)
      if (!hasAudio(out.result)) {
        return fail(`expected an audio/processing payload, got kind=${out.result?.structuredContent?.kind ?? 'none'}`)
      }
      return pass(`no elicitation, generation succeeded with voice=${resultVoice(out.result) ?? '(processing)'} — today's behavior preserved`)
    },
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SCENARIOS = {
  'voices-tool': scenarioVoicesTool,
  'voice-pick': scenarioVoicePick,
  'voice-save': scenarioVoiceSave,
  'voice-decline': scenarioVoiceDecline,
  'voice-cancel': scenarioVoiceCancel,
  'voice-listen': scenarioVoiceListen,
  'cost-yes': scenarioCostYes,
  'cost-no': scenarioCostNo,
  'favorite-tool-validation': scenarioFavoriteToolValidation,
  'no-elicit-fallback': scenarioNoElicitFallback,
}

// voice-listen, voice-save and favorite-tool-validation persist a favorite
// voice for the shared dev user, so in "all" mode they run after every
// scenario that needs the voice elicitation to fire. voice-listen runs before
// voice-save so the new listen-first path is exercised on a clean user;
// voice-save then SKIPs (a favorite is already saved) unless the favorite is
// cleared in between — see the pre-state note in the header comment.
// favorite-tool-validation needs no elicitation and leaves the favorite at
// 'cedar'; voices-tool and no-elicit-fallback work regardless of the favorite.
const ALL_ORDER = [
  'voices-tool',
  'voice-pick',
  'voice-decline',
  'voice-cancel',
  'cost-yes',
  'cost-no',
  'voice-listen',
  'voice-save',
  'favorite-tool-validation',
  'no-elicit-fallback',
]

function usage() {
  console.error(`Usage: node scripts/test-elicitation.mjs <scenario> [nonce]`)
  console.error(`  scenario: all | ${Object.keys(SCENARIOS).join(' | ')}`)
  console.error(`  target:   ${MCP_URL} (override with OTO_MCP_URL)`)
}

async function main() {
  if (!scenarioArg || (scenarioArg !== 'all' && !(scenarioArg in SCENARIOS))) {
    usage()
    process.exit(2)
  }
  const names = scenarioArg === 'all' ? ALL_ORDER : [scenarioArg]

  log(`oto elicitation test — target ${MCP_URL}, nonce ${nonce}`)

  const results = []
  for (const name of names) {
    log(`\n=== ${name} ===`)
    let res
    try {
      res = await SCENARIOS[name]()
    } catch (err) {
      res = fail(`unexpected error: ${err?.stack ?? err}`)
    }
    log(`  -> ${res.status}: ${res.detail}`)
    results.push([name, res])
  }

  log('\n--- results ---')
  let failures = 0
  for (const [name, res] of results) {
    if (res.status === 'FAIL') failures += 1
    log(`${res.status} ${name} — ${res.detail}`)
  }
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('fatal:', err?.stack ?? err)
  process.exit(1)
})
