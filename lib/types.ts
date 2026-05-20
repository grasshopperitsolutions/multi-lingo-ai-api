import { IncomingMessage, ServerResponse } from 'http';

export type VercelRequest = IncomingMessage & {
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
 * Gemini (@google/genai SDK) parameter surface.
 * Uses `config` block with generationConfig fields.
 * responseMimeType + responseSchema enforce structured JSON output.
 */
export interface GeminiParams {
  provider: 'gemini';
  model?: string;              // default: 'gemini-2.0-flash'
  temperature?: number;        // 0–2, default: 0.8
  maxOutputTokens?: number;    // default: 300
  topP?: number;               // 0–1, default: 0.9
  topK?: number;               // integer, default: 40
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
}
