import type { ChatMessage, GenerationFinishReason, GenerationUsage } from '@/lib/domain/chat';
import type { ModelIdentity } from '@/lib/domain/types';

/**
 * Generation protocols are deliberately separate from model-catalog discovery.
 * Several providers share the same wire protocol.
 */
export type GenerationProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations';

export interface ResolvedGenerationTarget {
  identity: ModelIdentity;
  providerLabel: string;
  modelName: string;
  protocol: GenerationProtocol;
  baseUrl: string;
  apiKey: string;
}

export interface GenerationRequest {
  systemPrompt: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
}

export type GenerationEvent =
  | { type: 'start' }
  | { type: 'text-delta'; delta: string }
  | {
      type: 'finish';
      reason: GenerationFinishReason;
      usage: GenerationUsage;
    };

export interface GenerationAdapter {
  stream(
    target: ResolvedGenerationTarget,
    request: GenerationRequest,
  ): AsyncIterable<GenerationEvent>;
}
