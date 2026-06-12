// Courtesy lock so two oto widgets in one conversation don't talk over each
// other. localStorage may be unavailable in the sandboxed iframe — every
// access is wrapped and silently degrades to "no coordination".

const LOCK_KEY = 'oto.playback-lock'

export const instanceId = `oto-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`

/** Announce that this instance started playing. */
export function announcePlayback(): void {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: instanceId, at: Date.now() }))
  } catch {
    // storage unavailable in this sandbox — degrade gracefully
  }
}

/** Invoke `callback` when another instance announces playback. Returns an unsubscribe. */
export function onOtherPlayback(callback: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key !== LOCK_KEY || event.newValue == null) return
    try {
      const lock = JSON.parse(event.newValue) as { owner?: string }
      if (lock.owner && lock.owner !== instanceId) callback()
    } catch {
      // malformed lock — ignore
    }
  }
  try {
    window.addEventListener('storage', handler)
  } catch {
    return () => {}
  }
  return () => window.removeEventListener('storage', handler)
}
