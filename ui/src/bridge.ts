import type { App } from '@modelcontextprotocol/ext-apps/react'
import type { HistoryPayload, PlayerPayload } from '../../src/types'

export type ToolResult = Awaited<ReturnType<App['callServerTool']>>

function resultText(result: ToolResult): string {
  for (const block of result.content ?? []) {
    if (block.type === 'text') return block.text
  }
  return ''
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
  const result = await app.callServerTool({ name, arguments: args })
  if (result.isError) throw new Error(resultText(result) || `${name} failed`)
  if (result.structuredContent == null) throw new Error(`${name} returned no data`)
  return result.structuredContent as T
}

/** Narrow a tool result's structuredContent to one of oto's UI payloads. */
export function parseUiPayload(result: ToolResult): PlayerPayload | HistoryPayload | null {
  const sc = result.structuredContent as { kind?: unknown } | undefined
  if (!sc) return null
  if (sc.kind === 'audio') return sc as unknown as PlayerPayload
  if (sc.kind === 'history') return sc as unknown as HistoryPayload
  return null
}
