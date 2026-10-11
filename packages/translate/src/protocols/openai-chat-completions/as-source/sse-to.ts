import { usageFromIR } from './usage.ts';
import { irOutputMetadata } from '../../../ir/metadata.ts';
import { createIRProjection, type IROutputOptions } from '../../../ir/projection.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import { createIRTextStream } from '../../../ir/text.ts';
import type { IRJSONObject } from '../../../ir/types.ts';
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

interface IRChatCompletionsOutputOptions extends IROutputOptions { continuousUsageStats?: boolean }

export const openaiChatCompletionsFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IRChatCompletionsOutputOptions = {}): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRProjection();
  const textStream = createIRTextStream();
  const opaqueItems = new Map<number, number>();
  const completedItems = new Set<string>();
  const reasoningCarriers = new Set<number>();
  const tools = new Map<string, number>();
  const names = new Map<string, string>();
  const logprobLengths = new Map<string, number>();
  const audioMetadata = new Map<number, Record<string, any>>();
  const opaqueChoices = new Set<number>();
  const startedChoices = new Set<number>();
  let extension: Record<string, any> = {};
  let usage: Record<string, any> | undefined;
  // Continuous usage is cumulative metadata on emitted choice chunks, not an extra progress event.
  // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/openai/chat_completion/serving.py#L798-L871
  const chunk = (choices: Record<string, any>[], fields: Record<string, any> = {}): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => eventFrame({ ...extension, id: metadata.id, object: 'chat.completion.chunk', model: metadata.model, created: metadata.created, choices, ...(options.continuousUsageStats && choices.length > 0 ? { usage: usage ?? null } : {}), ...fields } as OpenAIChatCompletionsStreamEvent);
  const deltaFrame = (choice: number, delta: Record<string, any>): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => chunk([{ index: choice, delta, finish_reason: null }]);
  for await (const { state, record, values } of consumeIRRecords(frames)) {
    if (record.type === 'operation' && record.operation === 'assign') projection.validateText(state, record.path);
    textStream.update(state, values);
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); started = true; }
    if (!started && record.type !== 'error') continue;
    if (record.type === 'operation' && record.operation === 'initialize') continue;
    usage = values.read(['usage'], state.usage) === undefined ? undefined : usageFromIR(values.read(['usage'], state.usage));
    const actualState = { ...state, extensions: values.read(['extensions'], state.extensions) };
    const servingMetadata = actualState.extensions?.anthropicMessages ?? actualState.extensions?.openaiResponses ?? actualState.extensions?.openaiChatCompletions;
    if (typeof servingMetadata?.model === 'string') metadata.model = servingMetadata.model;
    if (record.type === 'item_end') completedItems.add(`${record.choice}/${record.item}`);
    extension = { ...values.read(['extensions', 'openaiChatCompletions'], state.extensions?.openaiChatCompletions) };
    delete extension.reasoning_items; delete extension.reasoning_id;
    const openaiTier = (actualState.extensions?.openaiResponses ?? actualState.extensions?.openaiChatCompletions)?.service_tier;
    const messagesUsage = actualState.extensions?.anthropicMessages?.usage as Record<string, any> | undefined;
    const tier = typeof openaiTier === 'string' ? openaiTier : messagesUsage?.speed === 'fast' ? 'fast' : typeof messagesUsage?.service_tier === 'string' ? messagesUsage.service_tier : undefined;
    if (tier !== undefined) extension.service_tier = tier;
    if (record.type === 'error' || record.type === 'finish' && record.status === 'failed') {
      if (record.error === undefined) throw new TypeError('Failed IR generation requires an error');
      yield eventFrame({ error: irChatError(record.error) } as unknown as OpenAIChatCompletionsStreamEvent);
      return;
    }
    if (record.type === 'start' || record.type === 'operation' || record.type === 'part_end' || record.type === 'item_end' || record.type === 'choice_end' || record.type === 'finish') {
      for (let choice = 0; choice < state.choices.length; choice++) {
        if (!startedChoices.has(choice)) { yield deltaFrame(choice, { role: 'assistant', content: '' }); startedChoices.add(choice); }
        for (let index = 0; index < state.choices[choice].items.length; index++) {
          const item = state.choices[choice].items[index];
          const path: IRPath = ['choices', choice, 'items', index];
          const target: IRPath = ['choices', choice, 'message'];
          const closed = completedItems.has(`${choice}/${index}`) || record.type === 'finish' || record.type === 'choice_end' && record.choice === choice || record.type === 'item_end' && record.item === index && record.choice === choice;
          if (item.type === 'message') for (let p = 0; p < item.content.length; p++) {
            const part = item.content[p];
            const source = [...path, 'content', p];
            if (part.type === 'text' || part.type === 'refusal') {
              const key = part.type === 'text' ? 'content' : 'refusal';
              for (const update of textStream.take([...source, part.type === 'text' ? 'text' : 'refusal'])) {
                const delta = projection.appendText(update, [...target, key]);
                if (delta !== '') yield deltaFrame(choice, { [key]: delta });
              }
            } else if (part.type === 'audio') {
              if (!values.has([...source, 'audio', 'data'])) {
                if (!closed && !(record.type === 'part_end' && record.choice === choice && record.item === index && record.part === p)) continue;
                for (const update of textStream.take([...source, 'audio', 'transcript'])) {
                  const text = projection.appendText(update, [...target, 'content']);
                  if (text !== '') yield deltaFrame(choice, { content: text });
                }
                continue;
              }
              const delta: Record<string, any> = {};
              const metadata: Record<string, any> | undefined = options.audioMetadata?.(choice) ?? (actualState.extensions?.openaiChatCompletions as Record<string, any> | undefined)?.choices?.[choice]?.message?.audio;
              const sent = audioMetadata.get(choice) ?? {};
              for (const field of ['id', 'expires_at']) if (metadata?.[field] !== undefined && metadata[field] !== sent[field]) { delta[field] = metadata[field]; sent[field] = metadata[field]; }
              audioMetadata.set(choice, sent);
              if (part.audio.transcript === undefined && !('transcript' in sent)) { delta.transcript = ''; sent.transcript = ''; }
              if (values.has([...source, 'audio', 'data'])) {
                const value = projection.append([...source, 'audio', 'data'], part.audio.data!, [...target, 'audio', 'data']);
                if (value !== '') delta.data = value;
              }
              for (const update of textStream.take([...source, 'audio', 'transcript'])) {
                const value = projection.appendText(update, [...target, 'audio', 'transcript']);
                if (value !== '') delta.transcript = (delta.transcript ?? '') + value;
              }
              if (Object.keys(delta).length > 0) yield deltaFrame(choice, { audio: delta });
            }
          } else if (item.type === 'reasoning') {
            for (const update of textStream.take(path)) {
              const delta = projection.appendText(update, [...target, 'reasoning_text']);
              if (delta !== '') yield deltaFrame(choice, { reasoning_text: delta });
            }
            if (values.has([...path, 'encrypted_content']) && !opaqueItems.has(choice)) opaqueItems.set(choice, index);
            if (state.extensions?.anthropicMessages !== undefined && values.has([...path, 'encrypted_content']) && item.encrypted_content != null && closed && opaqueItems.get(choice) === index && !opaqueChoices.has(choice)) {
              yield deltaFrame(choice, { reasoning_opaque: item.encrypted_content });
              opaqueChoices.add(choice);
            }
          } else {
            const actualName = values.read([...path, 'name'], item.name);
            if (actualName === undefined || actualName === '') { if (closed && values.within(path)) throw new TypeError('Completed tool calls require a name'); continue; }
            const key = JSON.stringify(path);
            let toolIndex = tools.get(key);
            if (toolIndex === undefined) { toolIndex = [...tools.keys()].filter(k => JSON.parse(k)[1] === choice).length; tools.set(key, toolIndex); }
            const custom = item.type === 'custom_tool_call';
            const field = custom ? 'input' : 'arguments';
            const namespace = custom ? 'custom' : 'function';
            const actualArguments = values.read([...path, custom ? 'input' : 'arguments'], custom ? item.input : item.arguments);
            const argument = custom ? actualArguments ?? '' : typeof actualArguments === 'object' ? closed ? JSON.stringify(actualArguments) : '' : actualArguments ?? '';
            const delta = !custom && typeof item.arguments === 'object' && !closed ? '' : projection.append([...path, field], argument, [...target, 'tool_calls', toolIndex, namespace, field]);
            const actualId = values.read([...path, 'call_id'], item.call_id);
            const name = `${actualId ?? ''}\0${actualName}`;
            const changed = names.get(key) !== name;
            if (changed) names.set(key, name);
            if (changed || delta !== '') yield deltaFrame(choice, { tool_calls: [{ index: toolIndex, ...(changed ? { id: actualId ?? `${metadata.id}_${choice}_${index}`, type: custom ? 'custom' : 'function' } : {}), [namespace]: { ...(changed ? { name: actualName } : {}), ...(delta !== '' ? { [field]: delta } : {}) } }] });
          }

        }
        for (let group = 0; group < (state.choices[choice].logprobs?.length ?? 0); group++) {
          const value = values.read(['choices', choice, 'logprobs', group], state.choices[choice].logprobs![group]);
          if (value?.tokens === undefined) continue;
          const key = `${choice}/${group}`;
          const length = logprobLengths.get(key) ?? 0;
          if (value.tokens.length > length) {
            let refusal = false;
            if (value.scope === 'text_part') {
              const item = state.choices[choice].items[value.item_index];
              if (item.type !== 'message' || !['text', 'refusal'].includes(item.content[value.content_index].type)) throw new TypeError('Text-part logprobs require a text or refusal owner');
              refusal = item.content[value.content_index].type === 'refusal';
            }
            yield chunk([{ index: choice, delta: {}, logprobs: { content: refusal ? null : value.tokens.slice(length), refusal: refusal ? value.tokens.slice(length) : null } }]);
            logprobLengths.set(key, value.tokens.length);
          }
        }
      }
    }
    if (state.extensions?.openaiResponses !== undefined && (record.type === 'item_end' && record.choice === 0 || record.type === 'choice_end' && record.choice === 0 || record.type === 'finish')) {
      const ids = values.read(['extensions', 'openaiResponses', 'item_ids'], state.extensions.openaiResponses.item_ids) ?? {};
      const items = state.choices[0]?.items ?? [];
      const indices = record.type === 'item_end' ? [record.item] : items.map((_, index) => index);
      for (const index of indices) {
        const item = items[index];
        if (item.type !== 'reasoning' || !values.within(['choices', 0, 'items', index]) || reasoningCarriers.has(index)) continue;
        yield deltaFrame(0, { reasoning_items: [{ type: 'reasoning', id: ids[index], summary: (values.read(['choices', 0, 'items', index, 'summary'], item.summary) ?? []).filter((text: unknown) => text !== undefined).map((text: string) => ({ type: 'summary_text', text })) }] });
        reasoningCarriers.add(index);
      }
    }
    if (record.type === 'choice_end') {
      const choice = record.choice;
      if (state.choices[choice].items.some((item, index) => item.type === 'message' && item.content.some((part, p) => part.type === 'audio' && values.has(['choices', choice, 'items', index, 'content', p, 'audio', 'data'])))) {
        const metadata = audioMetadata.get(choice);
        if (metadata?.id === undefined || metadata.expires_at === undefined) throw new Error('ChatCompletions audio requires replay ID and expiry metadata');
      }
      const result = projection.result();
      const content = result.contents.find(v => JSON.stringify(v.path) === JSON.stringify(['choices', choice, 'message', 'content']))?.text ?? '';
      const annotations: Record<string, any>[] = [];
      state.choices[choice].items.forEach((item, index) => {
        if (item.type !== 'message') return;
        item.content.forEach((part, p) => {
          if (part.type !== 'text') return;
          const segments = result.projections.filter(v => JSON.stringify(v.source_path) === JSON.stringify(['choices', choice, 'items', index, 'content', p, 'text']));
          for (const annotation of (values.read(['choices', choice, 'items', index, 'content', p, 'annotations'], part.annotations) ?? []).filter((a: unknown) => a !== undefined)) if ((annotation.source_kind === 'url' || annotation.source_kind === 'search_result') && annotation.source != null) {
            const range = annotation.output_text_range ?? { start: 0, end_exclusive: part.text.length };
            for (const segment of segments) {
              const start = Math.max(range.start, segment.source_start);
              const end = Math.min(range.end_exclusive, segment.source_end_exclusive);
              if (end <= start) continue;
              const offsets = irRangeToCodePoints(content, { start: segment.target_start + start - segment.source_start, end_exclusive: segment.target_start + end - segment.source_start });
              annotations.push({ type: 'url_citation', url_citation: { start_index: offsets.start, end_index: offsets.end, title: annotation.source_label ?? annotation.source, url: annotation.source } });
            }
          }
        });
      });
      if (annotations.length > 0) yield deltaFrame(choice, { annotations });
      const refusal = values.read(['choices', choice, 'refusal'], state.choices[choice].refusal);
      if (refusal?.explanation != null) yield deltaFrame(choice, { refusal: refusal.explanation });
      yield chunk([{ index: choice, delta: {}, finish_reason: record.finish_reason }]);
    }
    if (record.type === 'finish') {
      if (values.read(['usage'], state.usage) !== undefined) yield chunk([], { usage: usageFromIR(values.read(['usage'], state.usage)) });

      yield doneFrame();
    }
  }
};
