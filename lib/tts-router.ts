/**
 * TTS Router
 *
 * Single source of truth for:
 *  - Which locales are routed to Azure TTS (AZURE_LOCALES)
 *  - Voice maps for both Azure and Gemini, keyed by locale + gender
 *
 * To add a new Azure-supported locale:
 *  1. Add the locale string to AZURE_LOCALES
 *  2. Add a { female, male } entry to AZURE_VOICE_MAP
 *
 * To add a new Gemini locale:
 *  1. Add a { female, male } entry to GEMINI_VOICE_MAP
 *
 * The frontend only sends { text, locale, gender? } — it never specifies a provider.
 */

export type TtsGender = 'female' | 'male';

// ─────────────────────────────────────────────────────────────────────────────
// Azure — target locales
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Locales that must be routed to Azure TTS.
 * Gemini TTS does not support European Portuguese (pt-PT) natively,
 * making Azure the only reliable option for these locales.
 */
export const AZURE_LOCALES = new Set([
  'pt-PT',
]);

/**
 * Azure Neural voice IDs per locale and gender.
 * Full list: https://learn.microsoft.com/azure/ai-services/speech-service/language-support
 */
export const AZURE_VOICE_MAP: Record<string, Record<TtsGender, string>> = {
  'pt-PT': { female: 'pt-PT-FernandaNeural', male: 'pt-PT-DuarteNeural' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Gemini — voice map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gemini prebuilt voice names per locale and gender.
 * Voices: https://ai.google.dev/gemini-api/docs/speech-generation
 * 'default' is used as fallback when no locale-specific entry is found.
 */
export const GEMINI_VOICE_MAP: Record<string, Record<TtsGender, string>> = {
  'en-US': { female: 'Zephyr',  male: 'Puck'    },
  'en-GB': { female: 'Aoede',   male: 'Fenrir'  },
  'en-AU': { female: 'Leda',    male: 'Orus'    },
  'es-MX': { female: 'Sulafat', male: 'Charon'  },
  'es-ES': { female: 'Sulafat', male: 'Charon'  },
  'fr-FR': { female: 'Aoede',   male: 'Fenrir'  },
  'fr-CA': { female: 'Aoede',   male: 'Fenrir'  },
  'de-DE': { female: 'Kore',    male: 'Puck'    },
  'pt-BR': { female: 'Sulafat', male: 'Charon'  },
  'ca-ES': { female: 'Aoede',   male: 'Fenrir'  },
  'ja-JP': { female: 'Kore',    male: 'Charon'  },
  'ko-KR': { female: 'Leda',    male: 'Orus'    },
  'zh-CN': { female: 'Zephyr',  male: 'Puck'    },
  default:  { female: 'Sulafat', male: 'Charon'  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export type TtsProvider = 'azure' | 'gemini';

export interface TtsRouteResult {
  provider: TtsProvider;
  voice: string;
}

/**
 * Resolves which TTS provider and voice to use for a given locale + gender.
 * The frontend never needs to know about this — it only sends locale + gender.
 */
export function resolveTtsRoute(locale: string, gender: TtsGender = 'female'): TtsRouteResult {
  if (AZURE_LOCALES.has(locale)) {
    const voiceMap = AZURE_VOICE_MAP[locale];
    const voice = voiceMap?.[gender] ?? AZURE_VOICE_MAP['pt-PT'][gender];
    return { provider: 'azure', voice };
  }

  const voiceMap = GEMINI_VOICE_MAP[locale] ?? GEMINI_VOICE_MAP['default'];
  const voice = voiceMap[gender];
  return { provider: 'gemini', voice };
}
