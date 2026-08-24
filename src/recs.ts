import { audioRepo, savedRepo, followRepo, prefsRepo, positionsRepo } from './db.js'
import type { AudioRecord } from './types.js'

// Content-based recommendations v1 for the Explore "For You" shelf.
// Pure ranking over data already in Postgres — no new tables, no ML.
// Depends on db.js only (peer of api.ts; never imports api/mcp/share).

export type RecCandidate = AudioRecord & { ownerUsername: string }

const TTL_MS = 15 * 60 * 1000
// ponytail: in-memory per-process cache, lazily evicted on read — a restart
// clears it and that's fine (recs recompute in one round of queries).
const cache = new Map<string, { at: number; items: RecCandidate[] }>()

/**
 * Top-10 recommendations for a user, cached 15 min. Returns [] when fewer
 * than 3 candidates survive the exclusions (api.ts adds the further hide
 * rule comparing against the recent shelf, which it alone knows).
 */
export async function recommendationsFor(userId: string): Promise<RecCandidate[]> {
  const hit = cache.get(userId)
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return hit.items
    cache.delete(userId)
  }
  const items = await compute(userId)
  cache.set(userId, { at: Date.now(), items })
  return items
}

async function compute(userId: string): Promise<RecCandidate[]> {
  const [owned, saved, prefs, followees, candidatePool] = await Promise.all([
    audioRepo.listByUser(userId, 200, 0).then((r) => r.items),
    savedRepo.listSaved(userId),
    prefsRepo.get(userId),
    followRepo.followeeIds(userId),
    // Candidates: recent public ready audios with username'd owners, caller excluded.
    audioRepo.listPublicRecent(userId, 200, 0),
  ])

  // Weighted tag bag: 3 per saved audio, 2 per owned+played row, 1 per owned unplayed.
  const bag = new Map<string, number>()
  const addTags = (tags: string[], w: number) => {
    for (const t of new Set(tags.map((s) => s.toLowerCase()))) {
      bag.set(t, (bag.get(t) ?? 0) + w)
    }
  }
  for (const r of saved) addTags(r.tags, 3)
  // "Played" = has a row in the per-user positions table.
  const played = await positionsRepo.forUser(userId, owned.map((r) => r.id))
  for (const r of owned) addTags(r.tags, played.has(r.id) ? 2 : 1)
  let totalWeight = 0
  for (const w of bag.values()) totalWeight += w

  // Language set: pref language plus the languages of the user's own/saved rows.
  const languages = new Set<string>()
  if (prefs.language) languages.add(prefs.language.toLowerCase())
  for (const r of [...owned, ...saved]) if (r.language) languages.add(r.language.toLowerCase())

  // Top-2 moods across owned + saved rows.
  const moodCounts = new Map<string, number>()
  for (const r of [...owned, ...saved]) {
    if (r.mood) {
      const m = r.mood.toLowerCase()
      moodCounts.set(m, (moodCounts.get(m) ?? 0) + 1)
    }
  }
  const topMoods = new Set(
    [...moodCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([m]) => m),
  )

  const savedIds = new Set(saved.map((r) => r.id))
  const candidates = candidatePool.filter((r) => !savedIds.has(r.id))
  if (candidates.length < 3) return []

  const followeeSet = new Set(followees)
  const saveCounts = await savedRepo.saveCounts(candidates.map((r) => r.id))
  // Saves weigh 3x plays.
  const popularity = (r: RecCandidate) => Math.log1p(r.plays + 3 * (saveCounts.get(r.id) ?? 0))

  const score = (r: RecCandidate): number => {
    let overlap = 0
    for (const t of new Set(r.tags.map((s) => s.toLowerCase()))) overlap += bag.get(t) ?? 0
    const tagAffinity = totalWeight > 0 ? overlap / totalWeight : 0
    const ageDays = Math.max(0, (Date.now() - Date.parse(r.createdAt)) / 86_400_000)
    return (
      3.0 * tagAffinity +
      (r.language && languages.has(r.language.toLowerCase()) ? 1.0 : 0) +
      (r.mood && topMoods.has(r.mood.toLowerCase()) ? 0.5 : 0) +
      (followeeSet.has(r.userId) ? 0.5 : 0) +
      Math.exp(-ageDays / 14) +
      0.5 * (popularity(r) / 3)
    )
  }

  // Cold start (no tag profile): popularity, then recency.
  const ranked =
    totalWeight === 0
      ? [...candidates].sort(
          (a, b) =>
            popularity(b) - popularity(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
        )
      : candidates
          .map((r) => [score(r), r] as const)
          .sort((a, b) => b[0] - a[0])
          .map(([, r]) => r)

  // Greedy diversity: top 10 with at most 2 per author.
  const perAuthor = new Map<string, number>()
  const out: RecCandidate[] = []
  for (const r of ranked) {
    const n = perAuthor.get(r.userId) ?? 0
    if (n >= 2) continue
    perAuthor.set(r.userId, n + 1)
    out.push(r)
    if (out.length === 10) break
  }
  return out.length < 3 ? [] : out
}
