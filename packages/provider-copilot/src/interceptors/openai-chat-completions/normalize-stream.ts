import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type PromptAnnotationField = 'prompt_filter_results' | 'prompt_annotations';

interface ChatCompletionsIdentity {
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

const promptAnnotationFields: readonly PromptAnnotationField[] = ['prompt_filter_results', 'prompt_annotations'];

const hasPromptAnnotation = (chunk: Record<string, unknown>): boolean => promptAnnotationFields.some(field => Object.hasOwn(chunk, field));

const isPromptAnnotationChunk = (chunk: Record<string, unknown>): boolean =>
  (chunk.id === '' || chunk.id === undefined)
  && Array.isArray(chunk.choices)
  && chunk.choices.length === 0
  && hasPromptAnnotation(chunk);

const identityFromChunk = (chunk: Record<string, unknown>): ChatCompletionsIdentity | undefined =>
  typeof chunk.id === 'string' && chunk.id !== ''
    && typeof chunk.created === 'number'
    && typeof chunk.model === 'string' && chunk.model !== ''
    ? { id: chunk.id, created: chunk.created, model: chunk.model }
    : undefined;

const mergeAnnotationArrays = (field: PromptAnnotationField, previous: unknown, next: unknown): unknown => {
  if (Array.isArray(previous) && Array.isArray(next)) return previous === next ? previous : [...previous, ...next];
  if (Object.is(previous, next)) return previous;
  throw new TypeError(`Copilot ChatCompletions repeated incompatible ${field} values`);
};

const addPromptAnnotations = (pending: Partial<Record<PromptAnnotationField, unknown>>, chunk: Record<string, unknown>): void => {
  for (const field of promptAnnotationFields) {
    if (!Object.hasOwn(chunk, field)) continue;
    pending[field] = Object.hasOwn(pending, field)
      ? mergeAnnotationArrays(field, pending[field], chunk[field])
      : chunk[field];
  }
};

const mergePromptAnnotations = (
  chunk: Record<string, unknown>,
  pending: Partial<Record<PromptAnnotationField, unknown>>,
): Record<string, unknown> => {
  let merged = chunk;
  for (const field of promptAnnotationFields) {
    if (!Object.hasOwn(pending, field)) continue;
    merged = {
      ...merged,
      [field]: Object.hasOwn(merged, field)
        ? mergeAnnotationArrays(field, pending[field], merged[field])
        : pending[field],
    };
  }
  return merged;
};

// Normalize Copilot's prompt-only identity and per-chunk envelope fields to the
// ChatCompletions stream contract before any consumer sees the response.
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
export const normalizeCopilotChatCompletionsStream = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  let identity: ChatCompletionsIdentity | undefined;
  let hasPendingPromptAnnotations = false;
  const pendingPromptAnnotations: Partial<Record<PromptAnnotationField, unknown>> = {};

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      if (frame.type === 'done' && hasPendingPromptAnnotations) throw new TypeError('Copilot ChatCompletions prompt annotations ended without a response chunk');
      yield frame;
      continue;
    }

    const chunk = frame.event as unknown as Record<string, unknown>;
    if (isPromptAnnotationChunk(chunk)) {
      addPromptAnnotations(pendingPromptAnnotations, chunk);
      hasPendingPromptAnnotations = true;
      continue;
    }

    identity ??= identityFromChunk(chunk);
    if (identity === undefined) throw new TypeError('Copilot ChatCompletions requires a response chunk with an id, created timestamp, and model');

    let normalizedChunk = chunk;
    if (hasPendingPromptAnnotations) {
      normalizedChunk = mergePromptAnnotations(normalizedChunk, pendingPromptAnnotations);
      for (const field of promptAnnotationFields) delete pendingPromptAnnotations[field];
      hasPendingPromptAnnotations = false;
    }

    if (normalizedChunk.id !== identity.id) throw new TypeError(`Copilot ChatCompletions response id changed from ${identity.id} to ${String(normalizedChunk.id)}`);
    if (normalizedChunk.model !== identity.model) throw new TypeError(`Copilot ChatCompletions response model changed from ${identity.model} to ${String(normalizedChunk.model)}`);
    if (normalizedChunk.object !== undefined && normalizedChunk.object !== 'chat.completion.chunk') throw new TypeError('Copilot ChatCompletions chunk object must be chat.completion.chunk');
    if (typeof normalizedChunk.created !== 'number') throw new TypeError('Copilot ChatCompletions chunk requires a created timestamp');

    if (normalizedChunk.object === undefined || normalizedChunk.created !== identity.created) {
      normalizedChunk = {
        ...normalizedChunk,
        ...(normalizedChunk.object === undefined ? { object: 'chat.completion.chunk' } : {}),
        created: identity.created,
      };
    }

    yield normalizedChunk === chunk ? frame : { ...frame, event: normalizedChunk as unknown as OpenAIChatCompletionsStreamEvent };
  }

  if (hasPendingPromptAnnotations) throw new TypeError('Copilot ChatCompletions prompt annotations ended without a response chunk');
};
