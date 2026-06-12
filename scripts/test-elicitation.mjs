#!/usr/bin/env node
/**
 * Elicitation test client for the oto MCP server.
 *
 * Exercises the text_to_speech elicitation matrix against a locally running
 * server (AUTH_MODE=disabled, stateful /mcp sessions):
 *
 *   node scripts/test-elicitation.mjs <scenario> [nonce]
 *
 * scenario ∈ all | voice-pick | voice-save | voice-decline | voice-cancel
 *          | cost-yes | cost-no | no-elicit-fallback
 *
 * The optional [nonce] is mixed into every generated text so dedup never
 * short-circuits across runs (defaults to Date.now()).
 *
 * Notes:
 * - Scenarios share one server-side user (auth is disabled), so voice-save
 *   persists a favorite voice. In "all" mode it therefore runs after the
 *   other voice scenarios. On a DB where a favorite is already saved, the
 *   voice-elicitation scenarios print SKIP instead of failing.
 * - cost-yes / cost-no are only meaningful when the server-side remaining
 *   quota is small enough that a <200-char text estimates to >50% of it;
 *   otherwise they print a SKIP note.
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
  'voice-pick': scenarioVoicePick,
  'voice-save': scenarioVoiceSave,
  'voice-decline': scenarioVoiceDecline,
  'voice-cancel': scenarioVoiceCancel,
  'cost-yes': scenarioCostYes,
  'cost-no': scenarioCostNo,
  'no-elicit-fallback': scenarioNoElicitFallback,
}

// voice-save persists the favorite voice for the shared dev user, so in "all"
// mode it runs after every scenario that needs the voice elicitation to fire.
const ALL_ORDER = [
  'voice-pick',
  'voice-decline',
  'voice-cancel',
  'cost-yes',
  'cost-no',
  'voice-save',
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
