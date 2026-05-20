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

// ─────────────────────────────────────────────────────────────────────────────
// Game / Challenges — Firestore Schema Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixed category enum shared across all word-based games.
 * Used as the third segment of the gameWords document ID:
 *   gameWords/{game}__{learningDialect}__{category}
 */
export type GameWordCategory =
  | 'general'
  | 'food'
  | 'travel'
  | 'sports'
  | 'tech'
  | 'nature';

/**
 * Supported challenge/game identifiers.
 * Add new games here as they are introduced.
 */
export type GameId = 'hangman';

/**
 * Top-level document in the `gameWords` collection.
 * Document ID pattern: `{game}__{learningDialect}__{category}`
 * Example:             `hangman__es-MX__food`
 *
 * Words are stored in the `words` subcollection under this document.
 */
export interface GameWordPool {
  game: GameId;
  learningDialect: string;   // BCP-47 tag, e.g. 'es-MX', 'pt-BR'
  category: GameWordCategory;
  totalCount: number;        // mirrors words subcollection size — kept in sync on write
  lastAIRefill: FirebaseFirestore.Timestamp | null;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

/**
 * Document in the `gameWords/{poolId}/words` subcollection.
 *
 * `hints` is a map keyed by userDialect (BCP-47).
 * This allows one word entry to serve learners with different native languages
 * without duplicating the word itself.
 *
 * Example hints map:
 *   {
 *     'en-US': 'A round fruit, often red or green, that grows on trees.',
 *     'pt-BR': 'Uma fruta redonda, geralmente vermelha ou verde.',
 *   }
 *
 * If a hint for a requested userDialect is absent, HangmanService generates it
 * via AI and patches it back using PATCH /api/firestore with a dot-notation key:
 *   { 'hints.pt-BR': 'Uma fruta ...' }
 */
export interface GameWord {
  word: string;                        // the vocabulary word in learningDialect
  hints: Record<string, string>;       // keyed by userDialect BCP-47 tag
  addedBy: 'ai' | 'seed';             // origin of this word
  usedCount: number;                   // how many times it has been served
  createdAt: FirebaseFirestore.Timestamp;
}

/**
 * Document in `userGameProgress/{uid}/games/{game}__{learningDialect}`.
 * Tracks which word IDs this user has already seen for a given game + dialect pair.
 */
export interface UserGameProgress {
  seenWordIds: string[];               // array of GameWord document IDs
  totalPlayed: number;
  lastPlayedAt: FirebaseFirestore.Timestamp;
}
