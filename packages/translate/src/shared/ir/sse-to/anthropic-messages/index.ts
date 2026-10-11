import { packReasoningSignature } from '../../../anthropic-messages-and-openai-responses/reasoning.ts';
import { isContextExceededError } from '../../../anthropic-messages-via/context-window-error.ts';
import type { IRJSONObject, IRContentPart, IRItem, IRSourceCitation } from '../../ir.ts';
import { cloneIRJSON, isCompleteIRJSONObject, parseIRJSONObject } from '../../shared/json.ts';
import { irOutputMetadata, irServingModel } from '../../shared/metadata.ts';
import { createIRProjection, type IROutputOptions } from '../../shared/projection.ts';
import { createIRTextStream } from '../../shared/text.ts';
import { usageFromIR, irServiceTier, type IRWire } from '../../shared/usage.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../stream.ts';
import { PROMPT_TOO_LONG_MESSAGE, type AnthropicMessagesStreamEventEx, type AnthropicMessagesTextCitation } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type EventFrame } from '@floway-dev/protocols/common';

const irMessagesError = (error: IRJSONObject): IRJSONObject => isContextExceededError(error)
  ? { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE }
  : { type: ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error'].includes(error.type as string) ? error.type : 'api_error', message: error.message };

interface IRMessagesUnit { item: number; part?: number; block?: IRWire; index?: number; closed: boolean; stopped: boolean; citations: number }

export interface IRMessagesOutputOptions extends IROutputOptions {
  // Source document/search-result indexes belong to the translated request context.
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L1286-L1543
  resolveCitation?: (citation: IRSourceCitation) => AnthropicMessagesTextCitation | undefined;
}

export const anthropicMessagesFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IRMessagesOutputOptions = {}): AsyncGenerator<EventFrame<AnthropicMessagesStreamEventEx>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRProjection();
  const textStream = createIRTextStream();
  const units: IRMessagesUnit[] = [];
  const keys = new Set<string>();
  const startedUnits = new Set<string>();
  let blockIndex = 0;
  let finishReason = 'end_turn';
  let messageStarted = false;
  let sourceIds: IRWire = {};
  const emit = (event: IRWire): EventFrame<AnthropicMessagesStreamEventEx> => eventFrame(event as AnthropicMessagesStreamEventEx);
  const blockFor = (item: IRItem, part: IRContentPart | undefined, index: number, closed: boolean): IRWire | undefined => {
    if (item.type === 'message') return part?.type === 'text' || part?.type === 'refusal' || part?.type === 'audio' && part.audio.transcript !== undefined ? { type: 'text', text: '', citations: [] } : undefined;
    if (item.type === 'reasoning') {
      const text = [...item.summary ?? [], ...item.content ?? []].join('');
      const signature = sourceIds[index] === undefined ? item.encrypted_content : packReasoningSignature(sourceIds[index], item.encrypted_content ?? '');
      if (text !== '' || (item.summary?.length ?? 0) + (item.content?.length ?? 0) > 0) return { type: 'thinking', thinking: '', signature: '' };
      if (!closed || signature == null) return undefined;
      return { type: 'redacted_thinking', data: signature };
    }
    if (item.type === 'function_call') return item.name === '' ? undefined : { type: 'tool_use', id: item.call_id ?? `${metadata.id}_${index}`, name: item.name, input: {} };
    return undefined;
  };
  for await (const { state, record, values } of consumeIRRecords(frames)) {
    if (record.type === 'operation' && record.operation === 'assign') projection.validateText(state, record.path);
    textStream.update(state, values);
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); started = true; }
    if (!started && record.type !== 'error') continue;
    if (record.type === 'operation' && record.operation === 'initialize') continue;
    if (record.type === 'item_start') startedUnits.add(`${record.item}/item`);
    if (record.type === 'part_start') startedUnits.add(`${record.item}/${record.part}`);
    const actualState = { ...state, extensions: values.read(['extensions'], state.extensions) };
    metadata.model = irServingModel(actualState, metadata.model);
    if (record.type === 'error' || record.type === 'finish' && record.status === 'failed') {
      if (record.error === undefined) throw new TypeError('Failed IR generation requires an error');
      yield emit({ type: 'error', error: irMessagesError(record.error) });
      return;
    }
    if (state.choices.length > 1) throw new Error('Messages cannot represent multiple choices');
    sourceIds = actualState.extensions?.openaiResponses?.item_ids as IRWire ?? {};
    const tier = irServiceTier(actualState);
    const usage = { ...usageFromIR(values.read(['usage'], state.usage) ?? {}, 'anthropicMessages'), ...(values.read(['extensions', 'anthropicMessages', 'usage'], (state.extensions?.anthropicMessages as IRWire | undefined)?.usage) ?? {}), ...(tier === undefined ? {} : tier === 'fast' ? { speed: 'fast' } : { service_tier: tier }) };
    if (!messageStarted && (record.type === 'start' || state.choices.some(choice => choice.items.length > 0) || state.usage?.input_tokens_inclusive !== undefined || record.type === 'choice_end' || record.type === 'finish')) {
      yield emit({ type: 'message_start', message: { id: metadata.id, type: 'message', role: 'assistant', model: metadata.model, content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, usage } });
      messageStarted = true;
    }
    if (record.type === 'ping') yield emit({ type: 'ping' });
    if (record.type === 'choice_end') finishReason = record.finish_reason === 'length' ? 'max_tokens' : record.finish_reason === 'tool_calls' ? 'tool_use' : record.finish_reason === 'content_filter' ? 'refusal' : 'end_turn';
    state.choices[0]?.items.forEach((item, index) => {
      const parts = item.type === 'message' ? item.content.map((_, p) => p) : [undefined];
      for (const part of parts) {
        const key = `${index}/${part ?? 'item'}`;
        if (!keys.has(key)) { units.push({ item: index, part, closed: false, stopped: false, citations: 0 }); keys.add(key); }
      }
    });
    for (const unit of units) {
      if (record.type === 'finish' || record.type === 'item_end' && record.item === unit.item || record.type === 'part_end' && record.item === unit.item && record.part === unit.part) unit.closed = true;
    }
    let startsBlocked = false;
    for (const unit of units) {
      if (unit.stopped) continue;
      const item = state.choices[0].items[unit.item];
      const part = item.type === 'message' && unit.part !== undefined ? item.content[unit.part] : undefined;
      const source: IRPath = ['choices', 0, 'items', unit.item];
      const actualPart = part === undefined ? undefined : { ...part, ...(part.type === 'audio' ? { audio: values.read([...source, 'content', unit.part!, 'audio'], part.audio) ?? {} } : {}) } as IRContentPart;
      if (part?.type === 'text' && !values.has([...source, 'content', unit.part!, 'text']) && !startedUnits.has(`${unit.item}/${unit.part}`)) continue;
      if (part?.type === 'refusal' && !values.has([...source, 'content', unit.part!, 'refusal']) && !startedUnits.has(`${unit.item}/${unit.part}`)) continue;
      const actualItem = item.type === 'reasoning' || item.type === 'function_call' ? { type: item.type, ...values.read(source, item) } as IRItem : item;
      if (item.type === 'function_call' && !values.has([...source, 'name'])) continue;
      if (item.type === 'reasoning' && !values.within([...source, 'summary']) && !values.within([...source, 'content']) && !values.has([...source, 'encrypted_content'])) continue;
      const block = blockFor(actualItem, actualPart, unit.item, unit.closed);
      if (block === undefined) {
        if (item.type === 'function_call' && item.name === '') {
          if (unit.closed) throw new TypeError('Completed tool calls require a name');
          startsBlocked = true;
          continue;
        }
        if (!unit.closed && (part?.type === 'audio' || item.type === 'reasoning')) startsBlocked = true;
        continue;
      }
      if (unit.index === undefined) {
        if (startsBlocked) continue;
        if (item.type === 'function_call' && state.extensions?.openaiChatCompletions !== undefined && !item.call_id) {
          if (unit.closed) throw new TypeError('Completed tool calls require an id');
          startsBlocked = true;
          continue;
        }
        unit.index = blockIndex++; unit.block = block;
        yield emit({ type: 'content_block_start', index: unit.index, content_block: cloneIRJSON(block) });
      }
      const native = unit.block!;
      const target: IRPath = ['content', unit.index];
      const delta = (value: IRWire): EventFrame<AnthropicMessagesStreamEventEx> => emit({ type: 'content_block_delta', index: unit.index, delta: value });
      if (item.type === 'message' && part !== undefined) {
        const field = part.type === 'text' ? ['text'] : part.type === 'refusal' ? ['refusal'] : ['audio', 'transcript'];
        for (const update of textStream.take([...source, 'content', unit.part!, ...field])) {
          const value = projection.appendText(update, [...target, 'text']);
          if (value !== '') { native.text += value; yield delta({ type: 'text_delta', text: value }); }
        }
        if (part.type === 'text') {
          const citations = (values.read([...source, 'content', unit.part!, 'annotations'], part.annotations) ?? []).filter((a: unknown) => a !== undefined).flatMap((a: IRSourceCitation) => {
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
          for (const update of textStream.take(source)) {
            const value = projection.appendText(update, [...target, 'thinking']);
            if (value !== '') { native.thinking += value; yield delta({ type: 'thinking_delta', thinking: value }); }
          }
        }
        const cipher = values.read([...source, 'encrypted_content'], item.encrypted_content);
        const signature = sourceIds[unit.item] === undefined ? cipher : cipher === undefined ? undefined : packReasoningSignature(sourceIds[unit.item], cipher ?? '');
        if (unit.closed && signature != null) {
          const field = native.type === 'thinking' ? 'signature' : 'data';
          projection.assign([...source, 'encrypted_content'], signature, [...target, field]);
          if (native.type === 'thinking') yield delta({ type: 'signature_delta', signature });
        }
      } else if (item.type === 'function_call') {
        const arguments_ = values.read([...source, 'arguments'], item.arguments);
        if (arguments_ === undefined) { if (unit.closed) throw new TypeError('Completed tool calls require arguments'); continue; }
        if (typeof arguments_ === 'string' && options.parseToolArguments === undefined) {
          const value = projection.append([...source, 'arguments'], arguments_, [...target, 'input']);
          if (value !== '') yield delta({ type: 'input_json_delta', partial_json: value });
          if (unit.closed && isCompleteIRJSONObject(arguments_)) projection.assign([...source, 'arguments'], JSON.stringify(parseIRJSONObject(arguments_)), [...target, 'input']);
        } else if (unit.closed) {
          const args = typeof arguments_ === 'string' ? parseIRJSONObject(arguments_, options.parseToolArguments) : arguments_;
          const value = projection.append([...source, 'arguments'], JSON.stringify(args), [...target, 'input']);
          if (value !== '') yield delta({ type: 'input_json_delta', partial_json: value });
        }
      }
      if (unit.closed) {
        yield emit({ type: 'content_block_stop', index: unit.index });
        unit.stopped = true;
      }
    }
    if (record.type === 'choice_end' && record.finish_reason !== 'length') for (const [index, item] of (state.choices[0]?.items ?? []).entries()) {
      if (item.type === 'function_call' && values.has(['choices', 0, 'items', index, 'arguments']) && typeof item.arguments === 'string') parseIRJSONObject(item.arguments, options.parseToolArguments);
    }
    // Messages allows multiple cumulative usage deltas; consumers must assign these counters.
    // https://platform.claude.com/docs/en/build-with-claude/streaming#event-types
    if (messageStarted && record.type === 'operation' && record.path[0] === 'usage') yield emit({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null, stop_details: null, container: null }, usage });
    if (record.type === 'finish') {
      const extension = actualState.extensions?.anthropicMessages;
      yield emit({ type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: extension?.stop_sequence ?? null, stop_details: values.read(['choices', 0, 'refusal'], state.choices[0]?.refusal) === undefined ? extension?.stop_details ?? null : { type: 'refusal', ...values.read(['choices', 0, 'refusal'], state.choices[0]?.refusal) }, container: extension?.container ?? null }, usage });

      yield emit({ type: 'message_stop' });
    }
  }
};
