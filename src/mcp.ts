import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import { config } from './config.js'
import { audioRepo, usageRepo } from './db.js'
import { putAudio, presignAudioUrl, deleteAudioObject } from './storage.js'
import { synthesize, resolveVoice, chunkText, estimateSec, VOICES } from './tts.js'
import { startGenerationJob } from './jobs.js'
import { getVoiceSamples } from './samples.js'
import { userIdFrom, authUserFrom } from './auth.js'
import type {
  AudioRecord,
  HistoryItem,
  HistoryPayload,
  PlayerPayload,
  ProcessingPayload,
  StatusPayload,
  VoicesPayload,
  VortexPayload,
} from './types.js'

const PLAYER_URI = 'ui://oto/player.html'

// Texts at or under SYNC_THRESHOLD synthesize inside the tool call (well under
// host/edge timeouts); longer ones return a processing payload and generate in
// a background job that the widget polls via get_audio_status.
const SYNC_THRESHOLD = 4_000
const TEXT_MAX_CHARS = 50_000

// Railway buckets use virtual-host style URLs: presigned GETs resolve to
// https://<bucket>.<endpoint-host>/..., so the CSP must cover that subdomain,
// not just the bare endpoint origin.
const endpointUrl = new URL(config.BUCKET_ENDPOINT)
const bucketOrigins = [
  endpointUrl.origin,
  `${endpointUrl.protocol}//${config.BUCKET_NAME}.${endpointUrl.host}`,
]

// The iframe CSP is deny-by-default; the player streams mp3s from the bucket.
const uiCsp = {
  csp: {
    resourceDomains: bucketOrigins,
    connectDomains: bucketOrigins,
  },
  prefersBorder: true,
}

let playerHtml: string | null = null
function loadPlayerHtml(): string {
  if (playerHtml === null) {
    const htmlPath = path.join(process.cwd(), 'dist', 'ui', 'index.html')
    try {
      playerHtml = readFileSync(htmlPath, 'utf-8')
    } catch {
      throw new Error(`Player UI bundle missing at ${htmlPath} — run "npm run build:ui" first`)
    }
  }
  return playerHtml
}

const playerPayloadShape = {
  kind: z.literal('audio'),
  id: z.string(),
  title: z.string(),
  audioUrl: z.string(),
  durationSec: z.number().nullable(),
  voice: z.string(),
  createdAt: z.string(),
  deduped: z.boolean(),
}

const audioStatusEnum = z.enum(['processing', 'ready', 'error'])

const statusPayloadShape = {
  kind: z.literal('status'),
  id: z.string(),
  status: audioStatusEnum,
  chunksDone: z.number(),
  chunksTotal: z.number(),
  error: z.string().nullable(),
  audio: z.object(playerPayloadShape).nullable(),
}

const historyPayloadShape = {
  kind: z.literal('history'),
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      durationSec: z.number().nullable(),
      voice: z.string(),
      charCount: z.number(),
      createdAt: z.string(),
      status: audioStatusEnum,
    }),
  ),
  total: z.number(),
}

const voicesPayloadShape = {
  kind: z.literal('voices'),
  voices: z.array(z.object({ voice: z.string(), sampleUrl: z.string() })),
  favorite: z.string().nullable(),
}

function makeTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= 60 ? line : `${line.slice(0, 57)}…`
}

function contentHash(text: string, voice: string, instructions?: string): string {
  // The instructions suffix is only appended when present so hashes (and the
  // stored audio they dedup against) stay stable for instruction-less requests.
  const key =
    `${config.TTS_MODEL}|${voice}|${config.TTS_FORMAT}|${text}` +
    (instructions ? `|i:${instructions}` : '')
  return createHash('sha256').update(key).digest('hex')
}

function fmtDuration(durationSec: number | null): string {
  if (durationSec === null) return 'unknown length'
  const s = Math.round(durationSec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const quotaSec = config.QUOTA_MINUTES * 60

function fmtMinutes(seconds: number): string {
  return `${(seconds / 60).toFixed(1)} min`
}

/** Exempt from the generation quota via env allowlist or the DB unlimited flag. */
async function isQuotaExempt(userId: string, email?: string): Promise<boolean> {
  if (email && config.quotaExemptEmails.has(email.toLowerCase())) return true
  return usageRepo.isUnlimited(userId)
}

/** True when the connected client declared the elicitation capability. */
function canElicit(server: McpServer): boolean {
  return Boolean(server.server.getClientCapabilities()?.elicitation)
}

type VoiceElicitOutcome =
  | { kind: 'voice'; voice: string }
  | { kind: 'cancelled' }
  /** The user wants to hear the samples first — show the gallery, generate nothing. */
  | { kind: 'listen' }
  /** Declined, or the elicitation itself failed — use the config default voice. */
  | { kind: 'fallback' }

/** Sentinel enum entry in the voice elicitation — never a real voice. */
const LISTEN_FIRST = 'listen-first'

/** Asks the user to pick a voice (and optionally save it as their favorite). */
async function elicitVoice(
  server: McpServer,
  userId: string,
  email?: string,
): Promise<VoiceElicitOutcome> {
  let result: ElicitResult
  try {
    result = await server.server.elicitInput({
      message: 'Which voice should oto use for this audio?',
      requestedSchema: {
        type: 'object',
        properties: {
          voice: {
            type: 'string',
            title: 'Voice',
            description: 'The voice that reads your text aloud',
            enum: [LISTEN_FIRST, ...VOICES],
            enumNames: [
              '🎧 Listen to the voices first',
              ...VOICES.map((v) => v.charAt(0).toUpperCase() + v.slice(1)),
            ],
          },
          saveAsFavorite: {
            type: 'boolean',
            title: 'Save as favorite',
            description: 'Use this voice automatically for all future audio',
            default: false,
          },
        },
        required: ['voice'],
      },
    })
  } catch (err) {
    // A client that advertised elicitation but errors/times out gets the
    // non-elicit behavior (config default voice) instead of a crashed tool.
    console.error('Voice elicitation failed; falling back to the default voice:', err)
    return { kind: 'fallback' }
  }
  if (result.action === 'cancel') return { kind: 'cancelled' }
  if (result.action !== 'accept') return { kind: 'fallback' }
  const picked = result.content?.voice
  // The sentinel must never reach resolveVoice (or, downstream, contentHash):
  // it is not a voice, it is a request to browse the gallery. saveAsFavorite
  // is deliberately ignored here — there is nothing to save yet.
  if (picked === LISTEN_FIRST) return { kind: 'listen' }
  const chosen = resolveVoice(typeof picked === 'string' ? picked : undefined)
  if (result.content?.saveAsFavorite === true) {
    try {
      await usageRepo.setFavoriteVoice(userId, chosen, email)
    } catch (err) {
      // The chosen voice still applies to this generation; only the save failed.
      console.error('Failed to save favorite voice:', err)
    }
  }
  return { kind: 'voice', voice: chosen }
}

/**
 * Confirms a generation that would consume a big share of the remaining quota.
 * Returns true to proceed — including when the elicitation itself fails, which
 * falls back to the non-elicit behavior (generate without asking).
 */
async function elicitCostConfirm(
  server: McpServer,
  estSec: number,
  remainingSec: number,
): Promise<boolean> {
  let result: ElicitResult
  try {
    result = await server.server.elicitInput({
      message:
        `This will generate ~${fmtMinutes(estSec)} of audio and you have ` +
        `${fmtMinutes(remainingSec)} of quota left. Generate it?`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Generate this audio',
            description: `Uses ~${fmtMinutes(estSec)} of your remaining ${fmtMinutes(remainingSec)} quota`,
            default: false,
          },
        },
        required: ['confirm'],
      },
    })
  } catch (err) {
    console.error('Quota confirmation elicitation failed; proceeding without it:', err)
    return true
  }
  return result.action === 'accept' && result.content?.confirm === true
}

async function playerPayload(rec: AudioRecord, deduped: boolean): Promise<PlayerPayload> {
  return {
    kind: 'audio',
    id: rec.id,
    title: rec.title,
    audioUrl: await presignAudioUrl(rec.objectKey),
    durationSec: rec.durationSec,
    voice: rec.voice,
    createdAt: rec.createdAt,
    deduped,
  }
}

function processingPayload(rec: AudioRecord): ProcessingPayload {
  return {
    kind: 'processing',
    id: rec.id,
    title: rec.title,
    charCount: rec.charCount,
    chunksDone: rec.chunksDone,
    // chunksTotal is always set on 'processing' rows; ?? 0 satisfies the type.
    chunksTotal: rec.chunksTotal ?? 0,
    createdAt: rec.createdAt,
  }
}

function historyItem(rec: AudioRecord): HistoryItem {
  return {
    id: rec.id,
    title: rec.title,
    durationSec: rec.durationSec,
    voice: rec.voice,
    charCount: rec.charCount,
    createdAt: rec.createdAt,
    status: rec.status,
  }
}

type ToolExtra = { authInfo?: Parameters<typeof userIdFrom>[0]['authInfo'] }

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

/** Voice gallery result: all samples plus the user's current favorite. */
async function voicesResult(userId: string) {
  const [voices, favorite] = await Promise.all([
    getVoiceSamples(),
    usageRepo.getFavoriteVoice(userId),
  ])
  const payload: VoicesPayload = { kind: 'voices', voices, favorite }
  return {
    content: [
      {
        type: 'text' as const,
        text:
          favorite === null
            ? 'Voice gallery displayed — the user can listen to samples and pick a favorite. Offer to generate the audio again once they have chosen.'
            : `Voice gallery displayed — the user can listen to samples and pick a favorite (current favorite: ${favorite}). Offer to generate the audio again once they have chosen.`,
      },
    ],
    structuredContent: payload,
  }
}

async function getHistory(userId: string, limit?: number, offset?: number) {
  const { items, total } = await audioRepo.listByUser(userId, limit, offset)
  const payload: HistoryPayload = { kind: 'history', items: items.map(historyItem), total }
  return {
    content: [
      {
        type: 'text' as const,
        text: total === 0
          ? 'No audios generated yet.'
          : `${total} audio${total === 1 ? '' : 's'} in history. The list is displayed to the user.`,
      },
    ],
    structuredContent: payload,
  }
}

export function buildServer(): McpServer {
  const origin = new URL(config.MCP_SERVER_URL).origin
  const server = new McpServer({
    name: 'oto',
    title: 'oto',
    version: '0.1.0',
    websiteUrl: origin,
    icons: [{ src: `${origin}/icon.png`, mimeType: 'image/png', sizes: ['512x512'] }],
  })

  registerAppResource(
    server,
    'oto player',
    PLAYER_URI,
    { _meta: { ui: uiCsp } },
    async () => ({
      contents: [
        {
          uri: PLAYER_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadPlayerHtml(),
          // Content-item _meta takes precedence over the listing-level default.
          _meta: { ui: uiCsp },
        },
      ],
    }),
  )

  registerAppTool(
    server,
    'text_to_speech',
    {
      title: 'Text to speech',
      description:
        'Convert text to spoken audio and show an inline audio player. ' +
        'Audio is generated once and stored: repeating the same text/voice returns the existing audio. ' +
        `Texts over ${SYNC_THRESHOLD} characters generate in the background — the player shows progress and updates itself when ready. ` +
        `Voices: ${VOICES.join(', ')}. ` +
        'The tool may ask the user directly to pick a voice (when none is set) or to confirm a generation that would use a large share of their remaining quota.' +
        (quotaSec > 0
          ? ` Each user can generate up to ${config.QUOTA_MINUTES} minutes of new audio; stored audios stay playable for free.`
          : ''),
      inputSchema: {
        // Long texts generate in the background, so the cap bounds per-request
        // cost rather than response latency.
        text: z.string().min(1).max(TEXT_MAX_CHARS).describe('The text to read aloud'),
        voice: z.string().optional().describe(`Voice to use (default ${config.TTS_VOICE})`),
        instructions: z
          .string()
          .max(4000)
          .optional()
          .describe('Optional delivery directions: tone, accent, emotion, pacing'),
      },
      // No outputSchema: the result is a union (PlayerPayload | ProcessingPayload)
      // that a flat zod shape can't express; structuredContent alone is valid.
      _meta: { ui: { resourceUri: PLAYER_URI } },
    },
    async ({ text, voice, instructions }, extra) => {
      try {
        const { userId, email } = authUserFrom(extra as ToolExtra)
        const cleanText = text.trim()
        if (!cleanText) return errorResult(new Error('Text is empty'))

        // Voice resolution happens before hashing — the voice is part of the
        // dedup key. Explicit param wins; then the saved favorite; then (on
        // elicitation-capable hosts) the user picks; else the config default.
        let resolvedVoice: string
        if (voice !== undefined) {
          resolvedVoice = resolveVoice(voice)
        } else {
          const favorite = await usageRepo.getFavoriteVoice(userId)
          if (favorite) {
            resolvedVoice = resolveVoice(favorite)
          } else if (canElicit(server)) {
            const outcome = await elicitVoice(server, userId, email)
            if (outcome.kind === 'cancelled') {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Voice selection cancelled — no audio generated.',
                  },
                ],
              }
            }
            // The user wants to audition the voices: show the gallery instead
            // of generating. Not an error — the model should offer to retry
            // the generation once a voice is picked.
            if (outcome.kind === 'listen') return await voicesResult(userId)
            resolvedVoice = outcome.kind === 'voice' ? outcome.voice : resolveVoice()
          } else {
            resolvedVoice = resolveVoice()
          }
        }
        const hash = contentHash(cleanText, resolvedVoice, instructions?.trim() || undefined)

        let existing = await audioRepo.findByHash(userId, hash)
        // Janitor here as well as in get_audio_status: a wedged 'processing'
        // row must not hold its dedup key forever when the widget never polls
        // it to resolution (it flips to 'error' and is cleared just below).
        if (existing) existing = await audioRepo.resolveStale(existing)
        if (existing?.status === 'processing') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `"${existing.title}" is already generating (${existing.chunksDone}/${existing.chunksTotal ?? '?'} chunks done) — the player updates itself when ready.`,
              },
            ],
            structuredContent: processingPayload(existing),
          }
        }
        if (existing?.status === 'error') {
          // A dead row would block the dedup key forever — clear it and regenerate.
          await audioRepo.deleteById(userId, existing.id)
        } else if (existing) {
          const payload = await playerPayload(existing, true)
          return {
            content: [
              {
                type: 'text' as const,
                text: `Reused existing audio "${existing.title}" (${fmtDuration(existing.durationSec)}, voice ${existing.voice}) — no regeneration needed. The player is displayed to the user.`,
              },
            ],
            structuredContent: payload,
          }
        }

        const exempt = quotaSec === 0 || (await isQuotaExempt(userId, email))
        if (quotaSec > 0 && !exempt) {
          const usedSec = await usageRepo.generatedSec(userId)
          if (usedSec >= quotaSec) {
            return errorResult(
              new Error(
                `Generation limit reached (${fmtMinutes(usedSec)} of ${config.QUOTA_MINUTES} min). ` +
                  'New audio cannot be generated, but everything in your history stays playable.',
              ),
            )
          }
          // Pre-flight on the length estimate (with 15% headroom for its
          // roughness) so a long text can't start a background job that blows
          // far past the quota.
          const estSec = estimateSec(cleanText.length)
          if (usedSec + estSec > quotaSec * 1.15) {
            return errorResult(
              new Error(
                `This text is ~${fmtMinutes(estSec)} of audio, but only ${fmtMinutes(Math.max(quotaSec - usedSec, 0))} ` +
                  `of the ${config.QUOTA_MINUTES} min generation quota remains. Try a shorter text.`,
              ),
            )
          }
          // On elicitation-capable hosts, a generation that would eat more
          // than half the remaining quota needs the user's explicit go-ahead.
          const remainingSec = quotaSec - usedSec
          if (estSec > remainingSec * 0.5 && canElicit(server)) {
            const confirmed = await elicitCostConfirm(server, estSec, remainingSec)
            if (!confirmed) {
              return {
                content: [{ type: 'text' as const, text: 'Generation cancelled.' }],
              }
            }
          }
        }

        const objectKey = `audio/${userId}/${hash}.${config.TTS_FORMAT}`

        if (cleanText.length > SYNC_THRESHOLD) {
          const chunks = chunkText(cleanText)
          const { rec, created } = await audioRepo.insert({
            userId,
            textHash: hash,
            text: cleanText,
            title: makeTitle(cleanText),
            voice: resolvedVoice,
            model: config.TTS_MODEL,
            format: config.TTS_FORMAT,
            objectKey,
            durationSec: null,
            charCount: cleanText.length,
            status: 'processing',
            chunksTotal: chunks.length,
            chunksDone: 0,
            errorMessage: null,
          })
          // Only the request that actually inserted the row owns the job —
          // a lost race means another request is already generating it.
          if (created) {
            startGenerationJob({
              recId: rec.id,
              userId,
              email,
              text: cleanText,
              voice: resolvedVoice,
              instructions,
              objectKey: rec.objectKey,
            })
          }
          if (rec.status === 'ready') {
            return {
              content: [
                { type: 'text' as const, text: `Audio "${rec.title}" already exists. The player is displayed to the user.` },
              ],
              structuredContent: await playerPayload(rec, true),
            }
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Generating ~${fmtMinutes(estimateSec(cleanText.length))} of audio in the background — the player updates itself when ready.`,
              },
            ],
            structuredContent: processingPayload(rec),
          }
        }

        const result = await synthesize(cleanText, { voice: resolvedVoice, instructions })
        await putAudio(objectKey, result.audio)

        const { rec } = await audioRepo.insert({
          userId,
          textHash: hash,
          text: cleanText,
          title: makeTitle(cleanText),
          voice: result.voice,
          model: result.model,
          format: result.format,
          objectKey,
          durationSec: result.durationSec,
          charCount: result.charCount,
          status: 'ready',
          chunksTotal: null,
          chunksDone: 0,
          errorMessage: null,
        })

        // Usage is recorded for everyone (cost visibility); only non-exempt
        // users see — and are bound by — the quota.
        const generatedSec = result.durationSec ?? estimateSec(result.charCount)
        await usageRepo.addGeneratedSec(userId, generatedSec, email)
        let quotaNote = ''
        if (quotaSec > 0 && !exempt) {
          const usedSec = await usageRepo.generatedSec(userId)
          quotaNote = ` Generation quota used: ${fmtMinutes(usedSec)} of ${config.QUOTA_MINUTES} min.`
        }

        const payload = await playerPayload(rec, false)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Generated audio "${rec.title}" (${fmtDuration(rec.durationSec)}, voice ${rec.voice}). The player is displayed to the user.${quotaNote}`,
            },
          ],
          structuredContent: payload,
        }
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  registerAppTool(
    server,
    'list_history',
    {
      title: 'Audio history',
      description: "List the user's previously generated audios and show the history browser.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Page size (default 50)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
      },
      outputSchema: historyPayloadShape,
      _meta: { ui: { resourceUri: PLAYER_URI } },
    },
    async ({ limit, offset }, extra) => {
      try {
        return await getHistory(userIdFrom(extra as ToolExtra), limit, offset)
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  registerAppTool(
    server,
    'voices',
    {
      title: 'Voice gallery',
      description:
        'Show the voice gallery: every available voice with a short playable sample, plus the ' +
        "user's current favorite. Call when the user wants to hear, compare, or choose voices. " +
        'Samples are pre-generated — this costs nothing and creates no new audio.',
      inputSchema: {},
      outputSchema: voicesPayloadShape,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: PLAYER_URI } },
    },
    async (_args, extra) => {
      try {
        return await voicesResult(userIdFrom(extra as ToolExtra))
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  // Default visibility (model AND app callable) and no UI of its own: the
  // gallery iframe calls it when the user taps a voice, and the model can call
  // it when the user states a favorite in chat. Plain registerTool — there is
  // no resourceUri to normalize.
  server.registerTool(
    'set_favorite_voice',
    {
      title: 'Set favorite voice',
      description:
        "Save the user's favorite voice — it is used automatically for all future audio. " +
        `Voices: ${VOICES.join(', ')}.`,
      inputSchema: { voice: z.string().describe('The voice to save as favorite') },
      outputSchema: { ok: z.boolean(), voice: z.string() },
    },
    async ({ voice }, extra) => {
      try {
        const { userId, email } = authUserFrom(extra as ToolExtra)
        // Strict validation, not resolveVoice: silently saving the config
        // default when the input is garbage would persist a favorite the user
        // never chose.
        const normalized = voice.trim().toLowerCase()
        const match = VOICES.find((v) => v === normalized)
        if (!match) {
          return errorResult(
            new Error(`Unknown voice "${voice}". Available voices: ${VOICES.join(', ')}.`),
          )
        }
        await usageRepo.setFavoriteVoice(userId, match, email)
        return {
          content: [
            { type: 'text' as const, text: `Saved — ${match} is now your oto voice.` },
          ],
          structuredContent: { ok: true, voice: match },
        }
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  registerAppTool(
    server,
    'vortex',
    {
      title: 'The Vortex',
      description:
        'Easter egg: open the oto vortex — a hypnotic ASCII spiral visual. ' +
        'Call when the user asks for the vortex, trip mode, or the oto easter egg. ' +
        'Generates no audio and costs nothing.',
      inputSchema: {},
      outputSchema: { kind: z.literal('vortex'), seed: z.number() },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: PLAYER_URI } },
    },
    async (_args, extra) => {
      try {
        userIdFrom(extra as ToolExtra)
        const payload: VortexPayload = {
          kind: 'vortex',
          seed: Math.floor(Math.random() * 2 ** 31),
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: 'The vortex is open. Best enjoyed while audio plays. There is nothing else to say.',
            },
          ],
          structuredContent: payload,
        }
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  // App-only tools: callable from the player iframe, hidden from the model.
  registerAppTool(
    server,
    'get_history',
    {
      description: 'Fetch a page of audio history (app-internal).',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputSchema: historyPayloadShape,
      _meta: { ui: { resourceUri: PLAYER_URI, visibility: ['app'] } },
    },
    async ({ limit, offset }, extra) => {
      try {
        return await getHistory(userIdFrom(extra as ToolExtra), limit, offset)
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  registerAppTool(
    server,
    'get_audio_url',
    {
      description: 'Get a fresh playback URL for a stored audio (app-internal).',
      inputSchema: { id: z.string().describe('Audio id') },
      outputSchema: playerPayloadShape,
      _meta: { ui: { resourceUri: PLAYER_URI, visibility: ['app'] } },
    },
    async ({ id }, extra) => {
      try {
        const userId = userIdFrom(extra as ToolExtra)
        const rec = await audioRepo.getById(userId, id)
        if (!rec) return errorResult(new Error('Audio not found'))
        if (rec.status !== 'ready') return errorResult(new Error('Audio not ready'))
        const payload = await playerPayload(rec, true)
        return {
          content: [{ type: 'text' as const, text: `Playback URL refreshed for "${rec.title}".` }],
          structuredContent: payload,
        }
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  registerAppTool(
    server,
    'get_audio_status',
    {
      description: 'Check generation progress for an audio (app-internal, polled by the player).',
      inputSchema: { id: z.string().describe('Audio id') },
      outputSchema: statusPayloadShape,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: PLAYER_URI, visibility: ['app'] } },
    },
    async ({ id }, extra) => {
      try {
        const userId = userIdFrom(extra as ToolExtra)
        let rec = await audioRepo.getById(userId, id)
        if (!rec) return errorResult(new Error('Audio not found'))
        // Lazy janitor: flips generations stuck in 'processing' to 'error'.
        rec = await audioRepo.resolveStale(rec)
        const payload: StatusPayload = {
          kind: 'status',
          id: rec.id,
          status: rec.status,
          chunksDone: rec.chunksDone,
          chunksTotal: rec.chunksTotal ?? 0,
          error: rec.errorMessage,
          audio: rec.status === 'ready' ? await playerPayload(rec, false) : null,
        }
        return {
          content: [{ type: 'text' as const, text: `"${rec.title}" is ${rec.status}.` }],
          structuredContent: payload,
        }
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  registerAppTool(
    server,
    'delete_audio',
    {
      description: 'Delete a stored audio and its file (app-internal).',
      inputSchema: { id: z.string().describe('Audio id') },
      outputSchema: { ok: z.boolean(), id: z.string() },
      // Hosts without MCP Apps support ignore visibility:["app"] and expose
      // this to the model — the destructive hint lets them gate it.
      annotations: { destructiveHint: true },
      _meta: { ui: { resourceUri: PLAYER_URI, visibility: ['app'] } },
    },
    async ({ id }, extra) => {
      try {
        const userId = userIdFrom(extra as ToolExtra)
        const rec = await audioRepo.deleteById(userId, id)
        if (!rec) return errorResult(new Error('Audio not found'))
        try {
          await deleteAudioObject(rec.objectKey)
        } catch (err) {
          // Row is gone; an orphaned object is acceptable. Surface in logs only.
          console.error(`Failed to delete bucket object ${rec.objectKey}:`, err)
        }
        return {
          content: [{ type: 'text' as const, text: `Deleted "${rec.title}".` }],
          structuredContent: { ok: true, id },
        }
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  return server
}
