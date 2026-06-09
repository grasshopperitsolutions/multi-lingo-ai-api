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
  model?: string;              // default: 'gemini-3.5-flash'
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
   * Use a TTS-capable model, e.g. 'gemini-2.5-flash-preview-tts'.
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

export type ProviderParams = OpenAIParams | PerplexityParams | GeminiParams;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AskAIRequest {
  /** Single-turn convenience shorthand — wrapped as a user message. */
  prompt?: string;
  /** Full conversation history for multi-turn exchanges. */
  messages?: ChatMessage[];
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
}
