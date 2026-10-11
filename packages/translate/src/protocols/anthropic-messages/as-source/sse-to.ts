import { isContextExceededError } from './context-window-error.ts';
import { usageFromIR } from './usage.ts';
import type { IRCollector } from '../../../ir/collector.ts';
import { irChangedItems, irChangedParts } from '../../../ir/item-updates.ts';
import { createIRMetadataReader, irOutputMetadata } from '../../../ir/metadata.ts';
import type { IRSSEOutputOptions } from '../../../ir/sse-output-options.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import { createIRStringProjection } from '../../../ir/string-projection.ts';
import { createIRTextUpdateQueue } from '../../../ir/text-update-queue.ts';
import type { IRJSONObject, IRContentPart, IRItem, IRSourceCitation } from '../../../ir/types.ts';
import { cloneJSON } from '../../../shared/json/clone.ts';
import { isCompleteJSONObject, parseJSONObject } from '../../../shared/json/object.ts';
import { packReasoningSignature } from '../via-openai-responses/reasoning.ts';
import { PROMPT_TOO_LONG_MESSAGE, type AnthropicMessagesStreamEventEx, type AnthropicMessagesTextCitation } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type EventFrame } from '@floway-dev/protocols/common';

const irMessagesError = (error: IRJSONObject): IRJSONObject => isContextExceededError(error)
  ? { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE }
  : { type: ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error'].includes(error.type as string) ? error.type : 'api_error', message: error.message };

interface AnthropicMessagesBlockState { order: number; item: number; part?: number; block?: Record<string, any>; index?: number; closed: boolean; stopped: boolean; citations: number }

interface AnthropicMessagesSSEOutputOptions extends IRSSEOutputOptions {
  // Source document/search-result indexes belong to the translated request context.
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L1286-L1543
  resolveCitation?: (citation: IRSourceCitation) => AnthropicMessagesTextCitation | undefined;
}

export const anthropicMessagesFromIR = async function* (frames: AsyncIterable<IRFrame>, options: AnthropicMessagesSSEOutputOptions = {}): AsyncGenerator<EventFrame<AnthropicMessagesStreamEventEx>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRStringProjection();
  const readMetadata = createIRMetadataReader();
  const textUpdateQueue = createIRTextUpdateQueue();
  const units = new Map<string, AnthropicMessagesBlockState>();
  const pendingStarts = new Set<AnthropicMessagesBlockState>();
  let startBarrier: AnthropicMessagesBlockState | undefined;
  const startedUnits = new Set<string>();
  let blockIndex = 0;
  let finishReason = 'end_turn';
  let messageStarted = false;
  const emit = (event: Record<string, any>): EventFrame<AnthropicMessagesStreamEventEx> => eventFrame(event as AnthropicMessagesStreamEventEx);
  const blockFor = (item: IRItem, part: IRContentPart | undefined, index: number, closed: boolean, collector: IRCollector): Record<string, any> | undefined => {
    if (item.type === 'message') return part?.type === 'text' || part?.type === 'refusal' || part?.type === 'audio' && part.audio.transcript !== undefined ? { type: 'text', text: '', citations: [] } : undefined;
    if (item.type === 'reasoning') {
      const text = [...item.summary ?? [], ...item.content ?? []].join('');
      const id = collector.read(['extensions', 'openaiResponses', 'item_ids', String(index)]);
      const signature = id === undefined ? item.encrypted_content : packReasoningSignature(id, item.encrypted_content ?? '');
      if (text !== '' || (item.summary?.length ?? 0) + (item.content?.length ?? 0) > 0) return { type: 'thinking', thinking: '', signature: '' };
      if (!closed || signature == null) return undefined;
      return { type: 'redacted_thinking', data: signature };
    }
    if (item.type === 'function_call') return item.name === '' ? undefined : { type: 'tool_use', id: item.call_id ?? `${metadata.id}_${index}`, name: item.name, input: {} };
    return undefined;
  };
  for await (const { record, collector } of consumeIRRecords(frames)) {
    const { state } = collector;
    if (record.type === 'operation' && record.operation === 'assign') projection.validateText(state, record.path);
    textUpdateQueue.update(collector, record);
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); started = true; }
    if (!started && record.type !== 'error') continue;
    if (record.type === 'operation' && record.operation === 'initialize') continue;
    if (record.type === 'item_start') startedUnits.add(`${record.item}/item`);
    if (record.type === 'part_start') startedUnits.add(`${record.item}/${record.part}`);
    const published = readMetadata(collector);
    const actualState = { ...state, extensions: published.extensions };
    const servingMetadata = actualState.extensions?.anthropicMessages ?? actualState.extensions?.openaiResponses ?? actualState.extensions?.openaiChatCompletions;
    if (typeof servingMetadata?.model === 'string') metadata.model = servingMetadata.model;
    if (record.type === 'error' || record.type === 'finish' && record.status === 'failed') {
      if (record.error === undefined) throw new TypeError('Failed IR generation requires an error');
      yield emit({ type: 'error', error: irMessagesError(record.error) });
      return;
    }
    if (state.choices.length > 1) throw new Error('Messages cannot represent multiple choices');
    const openaiTier = (actualState.extensions?.openaiResponses ?? actualState.extensions?.openaiChatCompletions)?.service_tier;
    const messagesUsage = actualState.extensions?.anthropicMessages?.usage as Record<string, any> | undefined;
    const tier = typeof openaiTier === 'string' ? openaiTier : messagesUsage?.speed === 'fast' ? 'fast' : typeof messagesUsage?.service_tier === 'string' ? messagesUsage.service_tier : undefined;
    const usage = { ...usageFromIR(published.usage ?? {}), ...(published.extensions?.anthropicMessages?.usage ?? {}), ...(tier === undefined ? {} : tier === 'fast' ? { speed: 'fast' } : { service_tier: tier }) };
    if (!messageStarted && (record.type === 'start' || state.choices.some(choice => choice.items.length > 0) || state.usage?.input_tokens_inclusive !== undefined || record.type === 'choice_end' || record.type === 'finish')) {
      yield emit({ type: 'message_start', message: { id: metadata.id, type: 'message', role: 'assistant', model: metadata.model, content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, usage } });
      messageStarted = true;
    }
    if (record.type === 'ping') yield emit({ type: 'ping' });
    if (record.type === 'choice_end') finishReason = record.finish_reason === 'length' ? 'max_tokens' : record.finish_reason === 'tool_calls' ? 'tool_use' : record.finish_reason === 'content_filter' ? 'refusal' : 'end_turn';
    const changedItems = irChangedItems(collector, record).get(0) ?? new Set<number>();
    const changedUnits = new Set<AnthropicMessagesBlockState>();
    for (const index of changedItems) {
      const item = state.choices[0].items[index];
      const parts = item.type === 'message' ? irChangedParts(item, record, 0, index) : [undefined];
      for (const part of parts) {
        const key = `${index}/${part ?? 'item'}`;
        if (!units.has(key)) {
          const unit = { order: units.size, item: index, part, closed: false, stopped: false, citations: 0 }; units.set(key, unit);
        }
      }
      for (const part of parts) { const unit = units.get(`${index}/${part ?? 'item'}`)!; if (!unit.stopped) changedUnits.add(unit); }
    }
    if (startBarrier !== undefined && changedUnits.has(startBarrier)) { for (const unit of pendingStarts) changedUnits.add(unit); startBarrier = undefined; }
    for (const unit of changedUnits) {
      if (record.type === 'finish' || record.type === 'item_end' && record.item === unit.item || record.type === 'part_end' && record.item === unit.item && record.part === unit.part) unit.closed = true;
    }
    let startsBlocked = false;
    for (const unit of [...changedUnits].toSorted((a, b) => a.order - b.order)) {
      pendingStarts.delete(unit);
      if (unit.stopped) continue;
      const item = state.choices[0].items[unit.item];
      const part = item.type === 'message' && unit.part !== undefined ? item.content[unit.part] : undefined;
      const source: IRPath = ['choices', 0, 'items', unit.item];
      const actualPart = part === undefined ? undefined : { ...part, ...(part.type === 'audio' ? { audio: collector.read([...source, 'content', unit.part!, 'audio']) ?? {} } : {}) } as IRContentPart;
      if (part?.type === 'text' && !collector.has([...source, 'content', unit.part!, 'text']) && !startedUnits.has(`${unit.item}/${unit.part}`)) continue;
      if (part?.type === 'refusal' && !collector.has([...source, 'content', unit.part!, 'refusal']) && !startedUnits.has(`${unit.item}/${unit.part}`)) continue;
      const actualItem = item.type === 'reasoning' || item.type === 'function_call' ? { type: item.type, ...collector.read(source) } as IRItem : item;
      if (item.type === 'function_call' && !collector.has([...source, 'name'])) continue;
      if (item.type === 'reasoning' && !collector.within([...source, 'summary']) && !collector.within([...source, 'content']) && !collector.has([...source, 'encrypted_content'])) continue;
      const block = blockFor(actualItem, actualPart, unit.item, unit.closed, collector);
      if (block === undefined) {
        if (item.type === 'function_call' && item.name === '') {
          if (unit.closed) throw new TypeError('Completed tool calls require a name');
          pendingStarts.add(unit); startBarrier = startBarrier === undefined || unit.order < startBarrier.order ? unit : startBarrier; startsBlocked = true;
          continue;
        }
        if (!unit.closed && (part?.type === 'audio' || item.type === 'reasoning')) { pendingStarts.add(unit); startBarrier = startBarrier === undefined || unit.order < startBarrier.order ? unit : startBarrier; startsBlocked = true; }
        continue;
      }
      if (unit.index === undefined) {
        if (startsBlocked || startBarrier !== undefined && unit.order > startBarrier.order) { pendingStarts.add(unit); continue; }
        if (item.type === 'function_call' && state.extensions?.openaiChatCompletions !== undefined && !item.call_id) {
          if (unit.closed) throw new TypeError('Completed tool calls require an id');
          pendingStarts.add(unit); startBarrier = startBarrier === undefined || unit.order < startBarrier.order ? unit : startBarrier; startsBlocked = true;
          continue;
        }
        unit.index = blockIndex++; unit.block = block;
        yield emit({ type: 'content_block_start', index: unit.index, content_block: cloneJSON(block) });
      }
      const native = unit.block!;
      const target: IRPath = ['content', unit.index];
      const delta = (value: Record<string, any>): EventFrame<AnthropicMessagesStreamEventEx> => emit({ type: 'content_block_delta', index: unit.index, delta: value });
      if (item.type === 'message' && part !== undefined) {
        const field = part.type === 'text' ? ['text'] : part.type === 'refusal' ? ['refusal'] : ['audio', 'transcript'];
        for (const update of textUpdateQueue.take([...source, 'content', unit.part!, ...field])) {
          const value = projection.appendText(update, [...target, 'text']);
          if (value !== '') { native.text += value; yield delta({ type: 'text_delta', text: value }); }
        }
        if (part.type === 'text') {
          const citations = (collector.read([...source, 'content', unit.part!, 'annotations']) ?? []).filter((a: unknown) => a !== undefined).flatMap((a: IRSourceCitation) => {
            const converted = options.resolveCitation?.(a);
            return converted === undefined ? [] : [converted];
          });
          for (let c = unit.citations; c < citations.length; c++) {
            native.citations.push(citations[c]); yield delta({ type: 'citations_delta', citation: citations[c] });
          }
          unit.citations = citations.length;
        }
      } else if (item.type === 'reasoning') {
        if (native.type === 'thinking') {
          for (const update of textUpdateQueue.take(source)) {
            const value = projection.appendText(update, [...target, 'thinking']);
            if (value !== '') { native.thinking += value; yield delta({ type: 'thinking_delta', thinking: value }); }
          }
        }
        const cipher = collector.read([...source, 'encrypted_content']);
        const id = collector.read(['extensions', 'openaiResponses', 'item_ids', String(unit.item)]);
        const signature = id === undefined ? cipher : cipher === undefined ? undefined : packReasoningSignature(id, cipher ?? '');
        if (unit.closed && signature != null) {
          const field = native.type === 'thinking' ? 'signature' : 'data';
          projection.assign([...source, 'encrypted_content'], signature, [...target, field]);
          if (native.type === 'thinking') yield delta({ type: 'signature_delta', signature });
        }
      } else if (item.type === 'function_call') {
        const arguments_ = collector.read([...source, 'arguments']);
        if (arguments_ === undefined) { if (unit.closed) throw new TypeError('Completed tool calls require arguments'); continue; }
        if (typeof arguments_ === 'string' && options.parseToolArguments === undefined) {
          const value = projection.appendFromRecord(record, [...source, 'arguments'], arguments_, [...target, 'input']);
          if (value !== '') yield delta({ type: 'input_json_delta', partial_json: value });
          if (unit.closed && isCompleteJSONObject(arguments_)) projection.assign([...source, 'arguments'], JSON.stringify(parseJSONObject(arguments_)), [...target, 'input']);
        } else if (unit.closed) {
          const args = typeof arguments_ === 'string' ? parseJSONObject(arguments_, options.parseToolArguments) : arguments_;
          const value = projection.appendFromRecord(record, [...source, 'arguments'], JSON.stringify(args), [...target, 'input']);
          if (value !== '') yield delta({ type: 'input_json_delta', partial_json: value });
        }
      }
      if (unit.closed) {
        yield emit({ type: 'content_block_stop', index: unit.index });
        unit.stopped = true;
      }
    }
    if (record.type === 'choice_end' && record.finish_reason !== 'length') for (const [index, item] of (state.choices[0]?.items ?? []).entries()) {
      if (item.type === 'function_call' && collector.has(['choices', 0, 'items', index, 'arguments']) && typeof item.arguments === 'string') parseJSONObject(item.arguments, options.parseToolArguments);
    }
    // Messages allows multiple cumulative usage deltas; consumers must assign these counters.
    // https://platform.claude.com/docs/en/build-with-claude/streaming#event-types
    if (messageStarted && record.type === 'operation' && record.path[0] === 'usage') yield emit({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null, stop_details: null, container: null }, usage });
    if (record.type === 'finish') {
      const extension = actualState.extensions?.anthropicMessages;
      yield emit({ type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: extension?.stop_sequence ?? null, stop_details: collector.read(['choices', 0, 'refusal']) === undefined ? extension?.stop_details ?? null : { type: 'refusal', ...collector.read(['choices', 0, 'refusal']) }, container: extension?.container ?? null }, usage });

      yield emit({ type: 'message_stop' });
    }
  }
};
