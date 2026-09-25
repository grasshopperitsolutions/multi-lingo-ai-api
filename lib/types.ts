import { IncomingMessage, ServerResponse } from 'http';

export type VercelRequest = IncomingMessage & {
  req?: any;
  body?: any;
  query?: any;
};

export type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  json: (body: any) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// AI Provider Types
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderName = 'openai' | 'perplexity' | 'gemini';

export interface OpenAIParams {
  provider: 'openai';
  model?: string;       // default: 'gpt-4o-mini'
  temperature?: number; // default: 0.7
  max_tokens?: number;  // default: 300
}

/** Full Sonar API parameter surface — all fields are optional (defaults applied in provider). */
export interface PerplexityParams {
  provider: 'perplexity';
  // Core
  model?: string;                    // default: 'sonar'
  temperature?: number;              // 0–2, default: 0.2
  max_tokens?: number;               // default: 300
  top_p?: number;                    // 0–1, default: 0.9
  stream?: boolean;                  // default: false
  stop?: string | string[];          // stop sequence(s)

  // Search behaviour
  search_mode?: 'web' | 'academic' | 'sec'; // default: 'web'
  disable_search?: boolean;          // default: false
  enable_search_classifier?: boolean;
  return_images?: boolean;           // default: false
  return_related_questions?: boolean; // default: false
  search_domain_filter?: string[];   // restrict search to domains
  search_language_filter?: string[]; // ISO 639-1 language codes
  search_recency_filter?: 'hour' | 'day' | 'week' | 'month' | 'year';
  search_after_date_filter?: string;  // MM/DD/YYYY
  search_before_date_filter?: string; // MM/DD/YYYY

  // Output
  stream_mode?: 'full' | 'concise';  // default: 'full'
  language_preference?: string;      // ISO 639-1, e.g. 'en'
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  response_format?: { type: 'json_schema'; json_schema: Record<string, unknown> };

  // Advanced search options object (sub-fields forwarded as-is)
  web_search_options?: Record<string, unknown>;
}

/**
 * Thinking level for Gemini 3.x models.
 * Controls how many reasoning tokens the model uses before responding.
 * 'minimal' = fewest tokens; 'high' = most thorough reasoning.
 * Has no effect on Gemini 2.x models.
 */
export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Gemini (@google/genai SDK) parameter surface.
 * Uses `config` block with generationConfig fields.
 * responseMimeType + responseSchema enforce structured JSON output.
 */
export interface GeminiParams {
  provider: 'gemini';
  model?: string;              // default: 'gemini-3.5-flash-lite'
  temperature?: number;        // 0–2, default: 0.8
  maxOutputTokens?: number;    // default: 1024
  topP?: number;               // 0–1, default: 0.9
  topK?: number;               // integer, SDK default if omitted
  stopSequences?: string[];    // stop sequence(s)
  /**
   * When true, enforces JSON output via responseMimeType: 'application/json'.
   * Your prompt must still describe the desired JSON structure unless
   * you also provide responseSchema.
   */
  jsonMode?: boolean;          // default: false
  /**
   * Optional JSON Schema object. When provided, Gemini enforces the exact
   * shape of the output. Implies jsonMode = true.
   * Shape: { type: 'object', properties: { ... }, required: [...] }
   */
  responseSchema?: Record<string, unknown>;
  systemInstruction?: string;  // system-level prompt prepended before contents

  // ── Gemini 3.x thinking controls ─────────────────────────────────────────
  /**
   * Controls how much reasoning the model performs before responding.
   * 'minimal' = fewest thinking tokens (cheapest, fastest).
   * 'high'    = most thorough reasoning (most tokens, slowest).
   * Default (when omitted by caller): 'minimal'.
   * Gemini 3.x only — no effect on 2.x models.
   */
  thinkingLevel?: GeminiThinkingLevel;
  /**
   * Whether to include the model's summarised thinking in the response output.
   * Keep false in production — it adds tokens and surfaces internal reasoning.
   * Default: false.
   */
  includeThoughts?: boolean;

  // ── TTS (Text-to-Speech) mode ─────────────────────────────────────────────
  /**
   * When true, switches to audio-output mode using responseModalities: ['AUDIO'].
   * The prompt is treated as the text to synthesise, not a text-generation input.
   * Returns audioData (Base64) and mimeType instead of text.
   * Use a TTS-capable model, e.g. 'gemini-3.1-flash-tts-preview'.
   */
  tts?: boolean;
  /**
   * Voice name for TTS synthesis. Defaults to 'Sulafat'.
   * Available voices include: Aoede, Charon, Fenrir, Kore, Leda, Orus,
   * Puck, Sulafat, Zephyr (among others).
   * Only used when tts: true.
   */
  voice?: string;
  /**
   * BCP-47 language code hint for TTS, e.g. 'pt-PT', 'en-US'.
   * Only used when tts: true.
   */
  language?: string;
}

/**
 * The model to use instead when the caller is on the Explorer tier.
 *
 * Deliberately not a field on any provider's own interface: it is not a
 * parameter any provider understands, it is a second candidate the request
 * carries so the server can choose between them. api/ask-ai.ts swaps it into
 * `model` and nothing downstream ever sees it.
 *
 * It rides alongside `model` because that is where the model already lives —
 * on the admin-edited prompt document, next to the template it belongs to.
 * Blank or absent means "the same model as everyone else", which is the
 * default for every prompt nobody has deliberately split.
 */
export interface TierModelOverride {
  explorerModel?: string;
}

/**
 * Whether this request's result may be stored in the shared TTS cache.
 *
 * Like `explorerModel` above, this is not a parameter any provider
 * understands — it is a decision the caller hands the server, and it rides
 * here because `providerParams` is already the bag of per-request choices.
 *
 * It exists because the server cannot tell app content from a user's own
 * words by looking at the text. `ttsClips` is shared by every user of the
 * app, so the translator, the grammar text page and the dictionary's input
 * box — the three surfaces that read back something a person typed — send
 * this false and pay for synthesis every time. Everything else (stories,
 * culture, exam listening, the challenge words) is generated content that
 * everybody is entitled to hear.
 *
 * Absent means false. The default is "do not share" on purpose: a new call
 * site that forgets the flag loses a cache hit, which is cheap, rather than
 * putting a stranger's sentence in a pool everyone reads from.
 */
export interface TtsCacheHint {
  cacheable?: boolean;
}

/**
 * Why the call is being made, when the reason is app maintenance rather than
 * something the user asked for.
 *
 * - `ui-translation`: the frontend's translationService translating the
 *   interface into a language — seeding a new one, filling keys added after a
 *   deploy, an admin resync. `locale` names the language, which must exist.
 * - `language-identify`: the one call that identifies a language a user is
 *   adding.
 *
 * Both skip the user's daily allowance (see ask-ai.ts). Like `explorerModel`,
 * no provider reads it; it rides in `providerParams` because that is already
 * the bag of per-request choices.
 */
export interface MaintenancePurpose {
  purpose?: 'ui-translation' | 'language-identify';
  locale?: string;
}

export type ProviderParams = (OpenAIParams | PerplexityParams | GeminiParams) &
  TierModelOverride &
  TtsCacheHint &
  MaintenancePurpose;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * One image sent alongside a prompt, inline rather than by URL.
 *
 * Inline because the alternative is storing the file first, and the one
 * caller — a student photographing their own notebook — has no use for the
 * photo after it is read. Nothing is written anywhere; it exists for the
 * length of the request.
 */
export interface InlineImage {
  /** Base64 **without** a data: prefix. */
  data: string;
  mimeType: string;
}

/**
 * One recording the model listens to, inline in the request body.
 *
 * Inline for the same reason images are, and more strongly: the privacy policy
 * (§2.6, §6) promises a recording is kept only as long as it takes to produce
 * the feedback. Storing it first would make that promise harder to keep than
 * simply never writing it anywhere.
 */
export interface InlineAudio {
  /** Base64 **without** a data: prefix. */
  data: string;
  mimeType: string;
}

export interface AskAIRequest {
  /** Single-turn convenience shorthand — wrapped as a user message. */
  prompt?: string;
  /** Full conversation history for multi-turn exchanges. */
  messages?: ChatMessage[];
  /**
   * Images for the model to look at, attached to the prompt. Gemini only —
   * every other provider rejects the request rather than quietly answering
   * from the text alone, which would look like a bad answer instead of an
   * unsupported one.
   */
  images?: InlineImage[];
  /**
   * A recording for the model to listen to. Gemini only, same as images, and
   * rejected rather than dropped elsewhere — answering from the text alone
   * would look like bad feedback instead of an unsupported request.
   */
  audio?: InlineAudio[];
  providerParams: ProviderParams;
}

export interface AskAIResponse {
  text: string;
  provider: ProviderName;
  model: string;
  /** Base64-encoded audio data. Present only for TTS responses. */
  audioData?: string;
  /** MIME type of the audio data, e.g. 'audio/wav'. Present only for TTS responses. */
  mimeType?: string;
  /**
   * Why generation stopped, e.g. 'STOP' (complete) or 'MAX_TOKENS' (truncated).
   * Lets a caller tell a reply that was cut off mid-output from one that is
   * merely malformed — the two need different remedies.
   */
  finishReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription / Stripe Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The subscription tiers for Multi Lingo AI. `vip` and `admin` are hidden
 * tiers not shown on the pricing page — assigned manually via the admin
 * Users panel (see tierLimits.js on the frontend for the matching enum).
 */
export type SubscriptionTier = 'explorer' | 'voyager' | 'maestro' | 'vip' | 'admin';

/**
 * Payload sent by the frontend for the 'checkout' action.
 * The backend maps plan + interval to the Stripe Price ID using env vars,
 * keeping all price IDs server-side.
 */
export interface StripeCheckoutRequest {
  plan: 'voyager' | 'maestro';
  interval: 'monthly' | 'yearly';
}

export interface StripeUserFields {
  subscriptionTier: SubscriptionTier;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** 'trialing' | 'active' | 'past_due' | 'canceled' */
  subscriptionStatus?: string;
  /** Unix timestamp of the current billing period end. */
  currentPeriodEnd?: number;
}
