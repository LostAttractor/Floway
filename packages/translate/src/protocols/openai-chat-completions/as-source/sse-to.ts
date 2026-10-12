import { usageFromIR } from './usage.ts';
import { createIROrdinalMapper } from '../../../ir/ordinal-mapper.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import { IRNone, type IRJSONObject, type IRTokenLogprob } from '../../../ir/types.ts';
import { irRangeToCodePoints } from '../../../shared/coordinates.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const irChatError = (error: IRJSONObject): IRJSONObject => ({
  message: error.message,
  type: typeof error.type === 'string' && error.type !== 'error' ? error.type : error.code ?? 'server_error',
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(error.param === undefined ? {} : { param: error.param }),
  ...(error.provider_specific_fields === undefined ? {} : { provider_specific_fields: error.provider_specific_fields }),
});

interface OpenAIChatCompletionsSSEOutputOptions {
  id?: string;
  created?: number;
  audioMetadata?: (choice: number) => { id: string; expires_at: number };
  continuousUsageStats?: boolean;
}

const itemPath = (choice: number, item: number): IRPath => ['choices', choice, 'items', item];

export const openaiChatCompletionsFromIR = async function* (
  frames: AsyncIterable<IRFrame>,
  options: OpenAIChatCompletionsSSEOutputOptions = {},
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const startedChoices = new Set<number>();
  const tools = new Map<number, ReturnType<typeof createIROrdinalMapper>>();
  const startedAudio = new Set<string>();
  let usage: Record<string, any> | undefined;

  // Continuous usage is cumulative metadata on emitted choice chunks.
  // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/openai/chat_completion/serving.py#L798-L871
  const chunk = (choices: Record<string, any>[], fields: Record<string, any> = {}): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => eventFrame({
    id: metadata.id,
    object: 'chat.completion.chunk',
    model: metadata.model,
    created: metadata.created,
    choices,
    ...(options.continuousUsageStats && choices.length > 0 ? { usage: usage ?? null } : {}),
    ...fields,
  } as OpenAIChatCompletionsStreamEvent);
  const deltaFrame = (choice: number, delta: Record<string, any>, tier?: string): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => chunk([{ index: choice, delta, finish_reason: null }], tier === undefined ? {} : { service_tier: tier });
  const ensureChoice = (choice: number, tier?: string): ProtocolFrame<OpenAIChatCompletionsStreamEvent> | undefined => {
    if (startedChoices.has(choice)) return undefined;
    startedChoices.add(choice);
    tools.set(choice, createIROrdinalMapper());
    return deltaFrame(choice, { role: 'assistant', content: '' }, tier);
  };

  for await (const { record, collector } of consumeIRRecords(frames)) {
    const { state } = collector;
    if (record.type === 'error') {
      yield eventFrame({ error: irChatError(record.error) } as unknown as OpenAIChatCompletionsStreamEvent);
      return;
    }
    if (record.type === 'operation' && record.path[0] === 'model' && typeof record.value === 'string') metadata.model = record.value;
    if (record.type === 'operation' && record.path[0] === 'usage') usage = state.usage === undefined ? undefined : usageFromIR(state.usage);
    if (record.type === 'start') {
      if (state.model === undefined) throw new TypeError('ChatCompletions output requires an IR model before start');
      metadata = { id: options.id ?? record.id, model: state.model, created: record.created ?? options.created ?? Math.floor(Date.now() / 1000) };
      started = true;
      for (let choice = 0; choice < state.choices.length; choice++) {
        const opening = ensureChoice(choice, state.service_tier);
        if (opening !== undefined) yield opening;
      }
      continue;
    }
    if (!started) continue;
    const tier = state.service_tier;

    if (record.type === 'operation' && record.operation === 'initialize' && record.path.length === 2 && record.path[0] === 'choices' && typeof record.path[1] === 'number') {
      const opening = ensureChoice(record.path[1], tier);
      if (opening !== undefined) yield opening;
      continue;
    }

    if (record.type === 'operation' && record.path[0] === 'choices' && typeof record.path[1] === 'number') {
      const choice = record.path[1];
      const opening = ensureChoice(choice, tier);
      if (opening !== undefined) yield opening;
      const path = record.path;

      if (record.operation === 'initialize' && path.length === 4 && path[2] === 'items' && typeof path[3] === 'number') {
        const item = record.value as any;
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          const ordinal = tools.get(choice)!.open(path);
          const custom = item.type === 'custom_tool_call';
          const namespace = custom ? 'custom' : 'function';
          const callId = item.call_id === undefined || item.call_id === IRNone ? `${metadata.id}_${choice}_${path[3]}` : item.call_id;
          yield deltaFrame(choice, { tool_calls: [{ index: ordinal, id: callId, type: custom ? 'custom' : 'function', [namespace]: { name: item.name } }] }, tier);
        }
        continue;
      }

      if (record.operation === 'initialize' && path.length === 6 && path[2] === 'items' && path[4] === 'content') {
        const part = record.value as any;
        if (part.type === 'image') throw new TypeError('ChatCompletions cannot represent image output');
      }

      if (record.operation === 'append') {
        if (path.length === 7 && path[2] === 'items' && path[4] === 'content' && (path[6] === 'text' || path[6] === 'refusal')) {
          yield deltaFrame(choice, { [path[6] === 'text' ? 'content' : 'refusal']: record.value }, tier);
          continue;
        }
        if (path.length === 8 && path[2] === 'items' && path[4] === 'content' && path[6] === 'audio' && (path[7] === 'data' || path[7] === 'transcript')) {
          const item = state.choices[choice].items[path[3] as number];
          const part = item.type === 'message' ? item.content[path[5] as number] : undefined;
          if (part?.type !== 'audio') throw new TypeError('ChatCompletions audio delta requires an audio part');
          const audioPath = JSON.stringify(path.slice(0, 6));
          if (path[7] === 'data') {
            const audioMetadata = options.audioMetadata?.(choice);
            if (audioMetadata === undefined) throw new Error('ChatCompletions audio requires replay ID and expiry metadata');
            const first = !startedAudio.has(audioPath);
            startedAudio.add(audioPath);
            yield deltaFrame(choice, { audio: { ...(first ? audioMetadata : {}), data: record.value, ...(first ? { transcript: part.audio.transcript ?? '' } : {}) } }, tier);
          } else if (startedAudio.has(audioPath)) yield deltaFrame(choice, { audio: { transcript: record.value } }, tier);
          continue;
        }
        if (path.length === 6 && path[2] === 'items' && (path[4] === 'summary' || path[4] === 'content')) {
          yield deltaFrame(choice, { reasoning_text: record.value }, tier);
          continue;
        }
        if (path.length === 5 && path[2] === 'items' && (path[4] === 'arguments' || path[4] === 'input')) {
          const item = state.choices[choice].items[path[3] as number];
          if (item.type !== 'function_call' && item.type !== 'custom_tool_call') throw new TypeError('ChatCompletions tool delta requires a tool item');
          const ordinal = tools.get(choice)!.get(path.slice(0, 4));
          const custom = item.type === 'custom_tool_call';
          yield deltaFrame(choice, { tool_calls: [{ index: ordinal, [custom ? 'custom' : 'function']: { [custom ? 'input' : 'arguments']: record.value } }] }, tier);
          continue;
        }
      }

      if (record.operation === 'assign' && path.length === 5 && path[2] === 'items' && (path[4] === 'name' || path[4] === 'call_id')) {
        const item = state.choices[choice].items[path[3] as number];
        if (item.type !== 'function_call' && item.type !== 'custom_tool_call') throw new TypeError('ChatCompletions tool metadata requires a tool item');
        const ordinal = tools.get(choice)!.get(path.slice(0, 4));
        const custom = item.type === 'custom_tool_call';
        const callId = item.call_id === undefined || item.call_id === IRNone ? `${metadata.id}_${choice}_${path[3]}` : item.call_id;
        yield deltaFrame(choice, { tool_calls: [{ index: ordinal, id: callId, type: custom ? 'custom' : 'function', [custom ? 'custom' : 'function']: { name: item.name } }] }, tier);
        continue;
      }

      if (record.operation === 'assign' && path[2] === 'logprobs' && typeof path[3] === 'number' && path[4] === 'tokens' && typeof path[5] === 'number') {
        const group = state.choices[choice].logprobs?.[path[3]];
        const token = record.value as unknown as IRTokenLogprob;
        if (group === undefined) throw new TypeError('ChatCompletions logprob token requires a group');
        let refusal = false;
        if (group.scope === 'text_part') {
          const item = state.choices[choice].items[group.item_index];
          const part = item?.type === 'message' ? item.content[group.content_index] : undefined;
          if (part?.type !== 'text' && part?.type !== 'refusal') throw new TypeError('Text-part logprobs require a text or refusal owner');
          refusal = part.type === 'refusal';
        }
        yield chunk([{ index: choice, delta: {}, logprobs: { content: refusal ? null : [token], refusal: refusal ? [token] : null }, finish_reason: null }], tier === undefined ? {} : { service_tier: tier });
        continue;
      }
    }

    if (record.type === 'item_end') {
      const path = itemPath(record.choice, record.item);
      const item = state.choices[record.choice].items[record.item];
      if (item.type === 'function_call' || item.type === 'custom_tool_call') tools.get(record.choice)!.close(path);
      if (item.type === 'reasoning' && item.id !== undefined) yield deltaFrame(record.choice, { reasoning_items: [{ type: 'reasoning', id: item.id, summary: (item.summary ?? []).map(text => ({ type: 'summary_text', text })), ...(item.encrypted_content === undefined ? {} : { encrypted_content: item.encrypted_content }) }] }, tier);
      continue;
    }

    if (record.type === 'part_end') {
      const path: IRPath = ['choices', record.choice, 'items', record.item, 'content', record.part];
      const item = state.choices[record.choice].items[record.item];
      const part = item.type === 'message' ? item.content[record.part] : undefined;
      if (part?.type === 'audio' && !startedAudio.has(JSON.stringify(path)) && part.audio.transcript !== undefined) yield deltaFrame(record.choice, { content: part.audio.transcript }, tier);
      continue;
    }

    if (record.type === 'choice_end') {
      const choice = state.choices[record.choice];
      const opaque = choice.items.find(item => item.type === 'reasoning' && item.id === undefined && item.encrypted_content != null);
      if (opaque?.type === 'reasoning') yield deltaFrame(record.choice, { reasoning_opaque: opaque.encrypted_content }, tier);
      let flattened = '';
      const annotations: Record<string, any>[] = [];
      choice.items.forEach(item => {
        if (item.type !== 'message') return;
        item.content.forEach(part => {
          if (part.type !== 'text') return;
          const base = flattened.length;
          flattened += part.text;
          for (const annotation of part.annotations ?? []) {
            if (annotation.source_kind === 'document' || annotation.source == null) throw new TypeError('ChatCompletions cannot represent document or source-less citations');
            if (annotation.output_text_range === undefined) continue;
            const range = annotation.output_text_range;
            const offsets = irRangeToCodePoints(flattened, { start: base + range.start, end_exclusive: base + range.end_exclusive });
            annotations.push({ type: 'url_citation', url_citation: { start_index: offsets.start, end_index: offsets.end, title: annotation.source_label ?? annotation.source, url: annotation.source } });
          }
        });
      });
      if (annotations.length > 0) yield deltaFrame(record.choice, { annotations }, tier);
      if (choice.refusal?.explanation != null) yield deltaFrame(record.choice, { refusal: choice.refusal.explanation }, tier);
      yield chunk([{ index: record.choice, delta: {}, finish_reason: record.finish_reason }], tier === undefined ? {} : { service_tier: tier });
      continue;
    }

    if (record.type === 'finish') {
      if (state.usage !== undefined) yield chunk([], { usage: usageFromIR(state.usage), ...(tier === undefined ? {} : { service_tier: tier }) });
      yield doneFrame();
    }
  }
};
