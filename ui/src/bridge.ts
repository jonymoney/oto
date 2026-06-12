import type { App } from '@modelcontextprotocol/ext-apps/react'
import type {
  HistoryPayload,
  PlayerPayload,
  ProcessingPayload,
  VoicesPayload,
  VortexPayload,
} from '../../src/types'

export type ToolResult = Awaited<ReturnType<App['callServerTool']>>

/** Any structuredContent payload oto knows how to render. */
export type UiPayload =
  | PlayerPayload
  | HistoryPayload
  | ProcessingPayload
  | VoicesPayload
  | VortexPayload

/** First text block of a tool result — the error message on failed results. */
export function resultText(result: ToolResult): string {
  for (const block of result.content ?? []) {
    if (block.type === 'text') return block.text
  }
  return ''
}

async function callServerToolChecked(
  app: App,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await app.callServerTool({ name, arguments: args })
  if (result.isError) throw new Error(resultText(result) || `${name} failed`)
  return result
}

/**
 * Call an app-only server tool and unwrap structuredContent.
 * Tool-level failures come back as `isError: true` rather than throwing, so
 * both paths are normalized into a thrown Error here.
 */
export async function callTool<T>(
  app: App,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await callServerToolChecked(app, name, args)
  if (result.structuredContent == null) throw new Error(`${name} returned no data`)
  return result.structuredContent as T
}

/**
 * Call a server tool for its side effect only. Success is "the tool didn't
 * error" — no assumption about the shape (or presence) of structuredContent.
 */
export async function callToolAck(
  app: App,
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  await callServerToolChecked(app, name, args)
}

/** Narrow a tool result's structuredContent to one of oto's UI payloads. */
export function parseUiPayload(result: ToolResult): UiPayload | null {
  if (result.isError) return null
  const sc = result.structuredContent as { kind?: unknown } | undefined
  if (!sc) return null
  if (sc.kind === 'audio') return sc as unknown as PlayerPayload
  if (sc.kind === 'history') return sc as unknown as HistoryPayload
  if (sc.kind === 'processing') return sc as unknown as ProcessingPayload
  if (sc.kind === 'voices') return sc as unknown as VoicesPayload
  if (sc.kind === 'vortex') return sc as unknown as VortexPayload
  return null
}
