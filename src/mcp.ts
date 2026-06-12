import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import { config } from './config.js'
import { audioRepo } from './db.js'
import { putAudio, presignAudioUrl, deleteAudioObject } from './storage.js'
import { synthesize, resolveVoice, VOICES } from './tts.js'
import { userIdFrom } from './auth.js'
import type { AudioRecord, HistoryItem, HistoryPayload, PlayerPayload, VortexPayload } from './types.js'

const PLAYER_URI = 'ui://oto/player.html'

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
    }),
  ),
  total: z.number(),
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

function historyItem(rec: AudioRecord): HistoryItem {
  return {
    id: rec.id,
    title: rec.title,
    durationSec: rec.durationSec,
    voice: rec.voice,
    charCount: rec.charCount,
    createdAt: rec.createdAt,
  }
}

type ToolExtra = { authInfo?: Parameters<typeof userIdFrom>[0]['authInfo'] }

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
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
        `Voices: ${VOICES.join(', ')}.`,
      inputSchema: {
        // Capped so worst-case generation stays well under host/edge timeouts:
        // responses are buffered JSON with zero bytes on the wire until done.
        text: z.string().min(1).max(8000).describe('The text to read aloud'),
        voice: z.string().optional().describe(`Voice to use (default ${config.TTS_VOICE})`),
        instructions: z
          .string()
          .max(4000)
          .optional()
          .describe('Optional delivery directions: tone, accent, emotion, pacing'),
      },
      outputSchema: playerPayloadShape,
      _meta: { ui: { resourceUri: PLAYER_URI } },
    },
    async ({ text, voice, instructions }, extra) => {
      try {
        const userId = userIdFrom(extra as ToolExtra)
        const cleanText = text.trim()
        if (!cleanText) return errorResult(new Error('Text is empty'))

        const resolvedVoice = resolveVoice(voice)
        const hash = contentHash(cleanText, resolvedVoice, instructions?.trim() || undefined)

        const existing = await audioRepo.findByHash(userId, hash)
        if (existing) {
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

        const result = await synthesize(cleanText, { voice: resolvedVoice, instructions })
        const objectKey = `audio/${userId}/${hash}.${result.format}`
        await putAudio(objectKey, result.audio)

        const rec = await audioRepo.insert({
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
        })

        const payload = await playerPayload(rec, false)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Generated audio "${rec.title}" (${fmtDuration(rec.durationSec)}, voice ${rec.voice}). The player is displayed to the user.`,
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
