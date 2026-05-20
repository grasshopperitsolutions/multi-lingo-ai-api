import { IncomingMessage, ServerResponse } from 'http';

export type VercelRequest = IncomingMessage & {
  body?: any;
  query?: any;
};

export type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  json: (body: any) => void;
};

// --- AI Provider Types ---

export type ProviderName = 'openai' | 'perplexity';

export interface OpenAIParams {
  provider: 'openai';
  model?: string;       // default: 'gpt-4o-mini'
  temperature?: number; // default: 0.7
  max_tokens?: number;  // default: 300
}

export interface PerplexityParams {
  provider: 'perplexity';
  model?: string;       // default: 'sonar'
  temperature?: number; // default: 0.7
  max_tokens?: number;  // default: 300
}

export type ProviderParams = OpenAIParams | PerplexityParams;

export interface AskAIRequest {
  prompt: string;
  providerParams: ProviderParams;
}

export interface AskAIResponse {
  text: string;
  provider: ProviderName;
  model: string;
}
