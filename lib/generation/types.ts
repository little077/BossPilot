import type { ChatMessage, GenerationFinishReason, GenerationUsage } from '@/lib/domain/chat';
import type { DomainToolName, ModelIdentity } from '@/lib/domain/types';

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

export interface GenerationToolDefinition {
  name: DomainToolName;
  label: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}

export interface GenerationToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type GenerationInputMessage =
  | {
      role: 'user';
      content: string;
      createdAt: number;
    }
  | {
      role: 'assistant';
      content: string;
      createdAt: number;
      finishReason?: GenerationFinishReason;
      toolCalls?: GenerationToolCall[];
    }
  | {
      role: 'toolResult';
      toolCallId: string;
      toolName: string;
      content: string;
      isError: boolean;
      createdAt: number;
    };

export interface GenerationRequest {
  systemPrompt: string;
  /** 兼容现有聊天快照；工具回合由 Manager 追加协议无关的内部消息。 */
  messages: Array<ChatMessage | GenerationInputMessage>;
  tools?: GenerationToolDefinition[];
  signal: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
}

export type GenerationEvent =
  | { type: 'start' }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolCall: GenerationToolCall }
  | {
      type: 'finish';
      reason: GenerationFinishReason;
      usage: GenerationUsage;
    };

export interface GenerationToolExecutionResult {
  content: string;
  isError: boolean;
  statusText: string;
  detail?: string;
  errorCode?:
    | 'NOT_ON_JOB_PAGE'
    | 'NO_JOB_SELECTED'
    | 'NO_JOB_LIST'
    | 'CAPTCHA_DETECTED'
    | 'SELECTOR_MISS'
    | 'NO_PERMISSION'
    | 'EXTRACTION_FAILED'
    | 'CANCELLED';
}

export type GenerationToolExecutor = (
  call: GenerationToolCall,
  signal: AbortSignal,
) => Promise<GenerationToolExecutionResult>;

export interface GenerationAdapter {
  stream(
    target: ResolvedGenerationTarget,
    request: GenerationRequest,
  ): AsyncIterable<GenerationEvent>;
}
