import { Router } from 'express'
import type { RequestHandler } from 'express'
import { config } from './config.js'
import { synthesize, VOICES } from './tts.js'
import type { TtsProvider } from './tts.js'
import { audioObjectExists, putAudio, presignAudioUrl } from './storage.js'

// Voice preview samples ("hey, I'm coral…"). Generated once per
// (provider, language, voice) straight into the bucket — no DB row, no user
// library entry — then served via presigned URL like any other audio.
// The object key IS the dedup: previews/{provider}/{lang}/{voice}.mp3.

export const PREVIEW_LANGUAGES = ['en', 'es'] as const
type PreviewLang = (typeof PREVIEW_LANGUAGES)[number]

const SCRIPTS: Record<PreviewLang, Record<string, string>> = {
  en: {
    alloy: "Hey, I'm Alloy. Dependable, balanced, and yes — always picked first in radio dodgeball.",
    ash: "Hey, I'm Ash. I sound like your favorite podcast host who definitely needs more coffee.",
    ballad: "Hey, I'm Ballad. I turn your grocery list into an emotional journey. You're welcome.",
    coral: "Hey, I'm Coral! Bright, warm, and legally required to make everything sound exciting.",
    echo: "Hey, I'm Echo. Calm, steady, and great at pretending your deadline isn't tomorrow.",
    fable: "Hey, I'm Fable. Once upon a time, you picked me, and every story sounded epic. The end.",
    nova: "Hey, I'm Nova. Crisp, modern, and mildly convinced I'm the default for a reason.",
    onyx: "Hey, I'm Onyx. Deep, smooth, and frankly overqualified for reading your emails.",
    sage: "Hey, I'm Sage. Wise, unhurried, and certain that yes, you should hydrate.",
    shimmer: "Hey, I'm Shimmer! Light, sparkly, and physically unable to sound bored.",
    verse: "Hey, I'm Verse. Every sentence you write? I make it sound like poetry. Mostly.",
    marin: "Hey, I'm Marin. Clear, friendly, and told repeatedly that I sound trustworthy. Suspicious, right?",
    cedar: "Hey, I'm Cedar. Grounded, natural, and rumored to smell great. That part's unverifiable.",
  },
  es: {
    alloy: 'Hola, soy Alloy. Equilibrado, confiable, y siempre el primero que eligen en el recreo.',
    ash: 'Hola, soy Ash. Sueno como tu podcast favorito, pero con urgencia de más café.',
    ballad: 'Hola, soy Ballad. Convierto tu lista del súper en una balada épica. De nada.',
    coral: '¡Hola, soy Coral! Alegre, cálida, y legalmente obligada a emocionarme por todo.',
    echo: 'Hola, soy Echo. Tranquilo, sereno, y experto en fingir que tu deadline no es mañana.',
    fable: 'Hola, soy Fable. Érase una vez que me elegiste, y todo sonó a cuento épico. Fin.',
    nova: 'Hola, soy Nova. Fresca, moderna, y un poquito convencida de que soy la mejor.',
    onyx: 'Hola, soy Onyx. Profundo, elegante, y francamente sobrecalificado para leer tus correos.',
    sage: 'Hola, soy Sage. Sabia, pausada, y segura de que sí: deberías tomar agua.',
    shimmer: '¡Hola, soy Shimmer! Brillante, chispeante, e incapaz de sonar aburrida.',
    verse: 'Hola, soy Verse. Cada frase tuya la hago sonar a poesía. Bueno, casi todas.',
    marin: 'Hola, soy Marin. Clara, amable, y dicen que sueno confiable. Sospechoso, ¿no?',
    cedar: 'Hola, soy Cedar. Natural, con los pies en la tierra, y dicen que huelo bien. Nadie lo ha comprobado.',
  },
}

const wrap =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next)

/** Mounted inside the authed /api router. */
export function previewsRouter(): Router {
  const router = Router()

  router.get(
    '/voices/:voice/preview',
    wrap(async (req, res) => {
      const voice = String(req.params.voice).toLowerCase()
      if (!VOICES.includes(voice)) {
        return res.status(404).json({ error: 'Unknown voice' })
      }
      const provider: TtsProvider =
        req.query.provider === 'fish' && config.fishEnabled ? 'fish' : 'openai'
      const lang: PreviewLang = req.query.lang === 'es' ? 'es' : 'en'

      const key = `previews/${provider}/${lang}/${voice}.mp3`
      if (!(await audioObjectExists(key))) {
        // ponytail: concurrent first requests may both synthesize; last write
        // wins on an identical script — harmless, not worth a lock.
        const { audio } = await synthesize(SCRIPTS[lang][voice], {
          voice,
          provider,
          instructions: 'Playful and characterful, like a quick self-introduction with a wink.',
        })
        await putAudio(key, audio)
      }
      res.json({ url: await presignAudioUrl(key), expiresIn: config.AUDIO_URL_TTL_SECONDS })
    }),
  )

  return router
}
