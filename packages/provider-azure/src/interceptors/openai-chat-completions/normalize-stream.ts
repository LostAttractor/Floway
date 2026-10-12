import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type PromptAnnotationField = 'prompt_filter_results' | 'prompt_annotations';

interface ChatCompletionsIdentity {
  readonly id: string;
  readonly object: string;
  readonly created: number;
  readonly model: string;
}

const promptAnnotationFields: readonly PromptAnnotationField[] = ['prompt_filter_results', 'prompt_annotations'];
const contentFilterChoiceFields = ['content_filter_results', 'content_filter_offsets', 'content_filter_raw'] as const;

const hasPromptAnnotation = (chunk: Record<string, unknown>): boolean => promptAnnotationFields.some(field => Object.hasOwn(chunk, field));

const isPromptAnnotationChunk = (chunk: Record<string, unknown>): boolean =>
  chunk.id === '' && chunk.model === '' && Array.isArray(chunk.choices) && chunk.choices.length === 0 && hasPromptAnnotation(chunk);

const mergeAnnotationArrays = (field: PromptAnnotationField, previous: unknown, next: unknown): unknown => {
  if (Array.isArray(previous) && Array.isArray(next)) return [...previous, ...next];
  if (Object.is(previous, next)) return previous;
  throw new TypeError(`Azure ChatCompletions repeated incompatible ${field} values`);
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
  const merged = { ...chunk };
  for (const field of promptAnnotationFields) {
    if (!Object.hasOwn(pending, field)) continue;
    merged[field] = Object.hasOwn(merged, field)
      ? mergeAnnotationArrays(field, pending[field], merged[field])
      : pending[field];
  }
  return merged;
};

const isContentFilterChoice = (choice: Record<string, unknown>): boolean => contentFilterChoiceFields.some(field => Object.hasOwn(choice, field));

const hasContentFilterAnnotation = (choices: readonly Record<string, unknown>[]): boolean => choices.some(isContentFilterChoice);

const identityFromChunk = (chunk: Record<string, unknown>): ChatCompletionsIdentity | undefined =>
  typeof chunk.id === 'string' && chunk.id !== ''
    && typeof chunk.model === 'string' && chunk.model !== ''
    && typeof chunk.object === 'string' && chunk.object !== ''
    && typeof chunk.created === 'number'
    ? { id: chunk.id, object: chunk.object, created: chunk.created, model: chunk.model }
    : undefined;

const restoreAzureAnnotationIdentity = (chunk: Record<string, unknown>, identity: ChatCompletionsIdentity): Record<string, unknown> => ({
  ...chunk,
  ...((chunk.id === '' || chunk.id === null || chunk.id === undefined) ? { id: identity.id } : {}),
  ...((chunk.object === '' || chunk.object === null || chunk.object === undefined) ? { object: identity.object } : {}),
  ...((chunk.created === 0 || chunk.created === null || chunk.created === undefined) ? { created: identity.created } : {}),
  ...((chunk.model === '' || chunk.model === null || chunk.model === undefined) ? { model: identity.model } : {}),
});

// Azure separates prompt annotations and may emit content-filter choices after
// finish_reason. These frames violate required ChatCompletions envelope fields,
// while their filter fields are documented Azure extensions and remain intact.
// https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/content-streaming
// https://github.com/dotnet/extensions/issues/7812
// https://github.com/dotnet/extensions/issues/7790
export const normalizeAzureChatCompletionsStream = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  let identity: ChatCompletionsIdentity | undefined;
  let hasPendingPromptAnnotations = false;
  const pendingPromptAnnotations: Partial<Record<PromptAnnotationField, unknown>> = {};

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      if (frame.type === 'done' && hasPendingPromptAnnotations) throw new TypeError('Azure ChatCompletions prompt annotations ended without a response chunk');
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
    const choices = chunk.choices as Record<string, unknown>[];
    const hasFilterAnnotation = hasContentFilterAnnotation(choices);
    const normalizedChoices = choices.map(choice => {
      if (!isContentFilterChoice(choice) || (choice.delta !== undefined && choice.delta !== null)) return choice;
      return { ...choice, delta: {} };
    });
    const choicesChanged = normalizedChoices.some((choice, index) => choice !== choices[index]);
    let normalizedChunk = choicesChanged ? { ...chunk, choices: normalizedChoices } : chunk;
    if (hasFilterAnnotation && identity !== undefined) normalizedChunk = restoreAzureAnnotationIdentity(normalizedChunk, identity);
    if (hasPendingPromptAnnotations) {
      normalizedChunk = mergePromptAnnotations(normalizedChunk, pendingPromptAnnotations);
      for (const field of promptAnnotationFields) delete pendingPromptAnnotations[field];
      hasPendingPromptAnnotations = false;
    }

    yield normalizedChunk === chunk ? frame : { ...frame, event: normalizedChunk as unknown as OpenAIChatCompletionsStreamEvent };
  }

  if (hasPendingPromptAnnotations) throw new TypeError('Azure ChatCompletions prompt annotations ended without a response chunk');
};
