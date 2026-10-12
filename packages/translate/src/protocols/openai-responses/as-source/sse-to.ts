import { createRandomOpenAIResponsesResponseId } from './response-id.ts';
import { usageFromIR } from './usage.ts';
import { irPathKey } from '../../../ir/operation-paths.ts';
import { createIROrdinalMapper } from '../../../ir/ordinal-mapper.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import { IRNone, type IRSourceCitation, type IRTokenLogprob } from '../../../ir/types.ts';
import { createIRUnitQueue, createIRUnitRegistry } from '../../../ir/unit-queue.ts';
import { irRangeToCodePoints } from '../../../shared/coordinates.ts';
import { isCompleteJSONObject, parseJSONObject } from '../../../shared/json/object.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

interface ResponsesOutputUnit {
  readonly path: IRPath;
  readonly kind: 'message' | 'image' | 'reasoning' | 'function_call' | 'custom_tool_call';
  readonly parts: IRPath[];
  readonly contentOrdinals: ReturnType<typeof createIROrdinalMapper>;
  readonly annotationCounts: Map<string, number>;
  opened: boolean;
  outputIndex?: number;
  id?: string;
  callId?: string;
  status?: 'completed' | 'incomplete';
  nextPending?: ResponsesOutputUnit;
}

interface OpenAIResponsesSSEOutputOptions {
  id?: string;
  created?: number;
}

export const openaiResponsesFromIR = async function* (
  frames: AsyncIterable<IRFrame>,
  options: OpenAIResponsesSSEOutputOptions = {},
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  let sequence = 0;
  let finishReason = 'stop';
  const outputUnits: ResponsesOutputUnit[] = [];
  const units = createIRUnitRegistry<ResponsesOutputUnit>();
  const messageUnits = new Map<number, ResponsesOutputUnit[]>();
  const logprobGroups = new Map<string, number>();
  const pendingEnds = new Set<ResponsesOutputUnit>();
  const pending = createIRUnitQueue<ResponsesOutputUnit>();
  const emit = (event: Record<string, any>): ProtocolFrame<OpenAIResponsesStreamEventEx> => eventFrame({ ...event, sequence_number: sequence++ } as OpenAIResponsesStreamEventEx);

  const addUnit = (unit: ResponsesOutputUnit): void => {
    pending.enqueue(unit);
    units.set(unit.path, unit);
  };

  const convertAnnotation = (text: string, annotation: IRSourceCitation): Record<string, any> | undefined => {
    if ((annotation.source_kind === 'url' || annotation.source_kind === 'search_result') && annotation.source != null) {
      if (annotation.output_text_range === undefined) return undefined;
      const range = irRangeToCodePoints(text, annotation.output_text_range);
      return { type: 'url_citation', url: annotation.source, title: annotation.source_label ?? annotation.source, start_index: range.start, end_index: range.end };
    }
    if (annotation.source_kind === 'document' && annotation.source != null) return { type: 'file_citation', file_id: annotation.source, filename: annotation.source_label ?? annotation.source, index: 0 };
    return undefined;
  };

  const requireId = (unit: ResponsesOutputUnit): string => {
    if (unit.id === undefined) throw new TypeError('Responses output unit has no item ID');
    return unit.id;
  };

  const requireOutputIndex = (unit: ResponsesOutputUnit): number => {
    if (unit.outputIndex === undefined) throw new TypeError('Responses output unit has no output index');
    return unit.outputIndex;
  };

  const contentPart = (state: any, path: IRPath): Record<string, any> => {
    const item = state.choices[0].items[path[3] as number];
    if (item.type !== 'message') throw new TypeError('Responses content unit requires a message item');
    const part = item.content[path[5] as number];
    if (part.type === 'refusal') return { type: 'refusal', refusal: part.refusal };
    if (part.type !== 'text') throw new TypeError('Responses message output supports only text and refusal parts');
    const logprobGroup = logprobGroups.get(irPathKey(path));
    let logprobs: readonly IRTokenLogprob[] = [];
    if (logprobGroup !== undefined) {
      const group = state.choices[0].logprobs?.[logprobGroup];
      if (group === undefined) throw new TypeError(`Responses logprob group ${logprobGroup} is missing`);
      logprobs = group.tokens;
    }
    const annotations = (part.annotations ?? []).flatMap((annotation: IRSourceCitation) => {
      const converted = convertAnnotation(part.text, annotation);
      return converted === undefined ? [] : [converted];
    });
    return { type: 'output_text', text: part.text, annotations, logprobs };
  };

  const outputItem = (state: any, unit: ResponsesOutputUnit): Record<string, any> => {
    const item = state.choices[0].items[unit.path[3] as number];
    if (unit.status === undefined) throw new TypeError('Responses output snapshot requires a terminal status');
    const status = unit.status;
    const id = requireId(unit);
    if (unit.kind === 'message') return { type: 'message', id, role: 'assistant', status, content: unit.parts.map(path => contentPart(state, path)) };
    if (unit.kind === 'image') {
      if (item.type !== 'message') throw new TypeError('Responses image unit requires a message item');
      const part = item.content[unit.path[5] as number];
      if (part.type !== 'image') throw new TypeError('Responses image unit requires an image part');
      const outputFormat = part.image.mime_type === undefined ? undefined : { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[part.image.mime_type as 'image/png' | 'image/jpeg' | 'image/webp'];
      return { type: 'image_generation_call', id, status, result: part.image.data, ...(outputFormat === undefined ? {} : { output_format: outputFormat }) };
    }
    if (unit.kind === 'reasoning') {
      if (item.type !== 'reasoning') throw new TypeError('Responses reasoning unit requires a reasoning item');
      return {
        type: 'reasoning', id, status,
        summary: (item.summary ?? []).map((text: string) => ({ type: 'summary_text', text })),
        ...(item.content === undefined ? {} : { content: item.content.map((text: string) => ({ type: 'reasoning_text', text })) }),
        ...(item.encrypted_content === undefined ? {} : { encrypted_content: item.encrypted_content }),
      };
    }
    if (unit.callId === undefined) throw new TypeError('Responses tool unit has no call ID');
    const custom = unit.kind === 'custom_tool_call';
    if (custom && item.type !== 'custom_tool_call' || !custom && item.type !== 'function_call') throw new TypeError('Responses tool unit has the wrong IR item');
    return { type: custom ? 'custom_tool_call' : 'function_call', id, call_id: unit.callId, name: item.name, [custom ? 'input' : 'arguments']: custom ? item.input : item.arguments, status };
  };

  const response = (state: any, status: string, usage: unknown): Record<string, any> => ({
    id: metadata.id,
    object: 'response',
    created_at: metadata.created,
    model: metadata.model,
    status,
    output: outputUnits.map(unit => outputItem(state, unit)),
    usage,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } : null,
    ...(state.service_tier === undefined ? {} : { service_tier: state.service_tier }),
  });

  for await (const { record, collector } of consumeIRRecords(frames)) {
    const { state } = collector;
    if (record.type === 'error') {
      yield emit({ type: 'error', message: record.error.message, code: record.error.code ?? record.error.type, ...(record.error.param === undefined ? {} : { param: record.error.param }) });
      return;
    }
    if (record.type === 'operation' && record.path[0] === 'model' && typeof record.value === 'string') metadata.model = record.value;
    if (record.type === 'start') {
      if (state.model === undefined) throw new TypeError('Responses output requires an IR model before start');
      const id = options.id ?? record.id;
      metadata = { id: id?.startsWith('resp_') ? id : createRandomOpenAIResponsesResponseId(), model: state.model, created: record.created ?? options.created ?? Math.floor(Date.now() / 1000) };
      const initialUsage = state.usage === undefined ? null : usageFromIR(state.usage);
      yield emit({ type: 'response.created', response: response(state, 'in_progress', initialUsage) });
      yield emit({ type: 'response.in_progress', response: response(state, 'in_progress', initialUsage) });
      started = true;
      continue;
    }
    if (!started) continue;
    if (record.type === 'choice_end') {
      if (record.choice !== 0) throw new Error('Responses cannot represent multiple choices');
      finishReason = record.finish_reason;
      for (const current of pendingEnds) {
        const item = state.choices[0].items[current.path[3] as number];
        if (item.type !== 'function_call') throw new TypeError('Responses pending function unit requires a function item');
        const outputIndex = requireOutputIndex(current);
        if (finishReason !== 'length') parseJSONObject(item.arguments);
        yield emit({ type: 'response.function_call_arguments.done', item_id: requireId(current), output_index: outputIndex, arguments: item.arguments, name: item.name });
        current.status = finishReason === 'length' ? 'incomplete' : 'completed';
        yield emit({ type: 'response.output_item.done', output_index: outputIndex, item: outputItem(state, current) });
        units.delete(current.path);
        pendingEnds.delete(current);
      }
      continue;
    }

    if (record.type === 'operation' && record.operation === 'initialize') {
      if (record.path[0] === 'choices' && record.path[1] !== 0) throw new Error('Responses cannot represent multiple choices');
      if (record.path.length === 4 && record.path[0] === 'choices' && record.path[2] === 'logprobs') {
        const group = record.value as any;
        if (group.scope === 'text_part') logprobGroups.set(irPathKey(['choices', record.path[1], 'items', group.item_index, 'content', group.content_index]), record.path[3] as number);
      } else if (record.path.length === 4 && record.path[0] === 'choices' && record.path[2] === 'items') {
        const item = record.value as any;
        if (item.type === 'reasoning' || item.type === 'function_call' || item.type === 'custom_tool_call') addUnit({ path: record.path, kind: item.type, parts: [], contentOrdinals: createIROrdinalMapper(), annotationCounts: new Map(), opened: false });
      } else if (record.path.length === 6 && record.path[0] === 'choices' && record.path[2] === 'items' && record.path[4] === 'content') {
        const part = record.value as any;
        const itemIndex = record.path[3] as number;
        if (part.type === 'text' || part.type === 'refusal') {
          let itemUnits = messageUnits.get(itemIndex);
          if (itemUnits === undefined) { itemUnits = []; messageUnits.set(itemIndex, itemUnits); }
          let unit = itemUnits.at(-1);
          const previousPart = (record.path[5] as number) > 0 ? state.choices[0].items[itemIndex] : undefined;
          const previous = previousPart?.type === 'message' ? previousPart.content[(record.path[5] as number) - 1] : undefined;
          if (unit === undefined || previous === undefined || (previous.type !== 'text' && previous.type !== 'refusal')) {
            unit = { path: record.path, kind: 'message', parts: [], contentOrdinals: createIROrdinalMapper(), annotationCounts: new Map(), opened: false };
            itemUnits.push(unit);
            addUnit(unit);
          }
          unit.parts.push(record.path);
          units.set(record.path, unit);
        } else if (part.type === 'image') addUnit({ path: record.path, kind: 'image', parts: [record.path], contentOrdinals: createIROrdinalMapper(), annotationCounts: new Map(), opened: false });
      }
    }

    const justOpened = new Set<string>();
    const pendingEvents: Record<string, any>[] = [];
    while (pending.head !== undefined) {
      const unit = pending.head;
      const item = state.choices[0].items[unit.path[3] as number];
      let callId: string | typeof IRNone | undefined;
      if (unit.kind === 'function_call' || unit.kind === 'custom_tool_call') {
        if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || item.name === '') throw new TypeError('Completed tool calls require a name');
        callId = collector.optional<string>([...unit.path, 'call_id']);
        if (callId === undefined) break;
      }
      pending.dequeue();
      const outputIndex = outputUnits.length;
      unit.outputIndex = outputIndex;
      let added: Record<string, any>;
      if (unit.kind === 'message') {
        unit.id = createRandomOpenAIResponsesItemId('message');
        added = { type: 'message', id: unit.id, role: 'assistant', status: 'in_progress', content: [] };
      } else if (unit.kind === 'image') {
        unit.id = createRandomOpenAIResponsesItemId('image_generation_call');
        added = { type: 'image_generation_call', id: unit.id, status: 'in_progress', result: null };
      } else if (unit.kind === 'reasoning') {
        unit.id = item.type === 'reasoning' && item.id !== undefined ? item.id : createRandomOpenAIResponsesItemId('reasoning');
        added = { type: 'reasoning', id: unit.id, status: 'in_progress', summary: [], ...(item.type === 'reasoning' && item.content !== undefined ? { content: [] } : {}) };
      } else {
        if (item.type !== 'function_call' && item.type !== 'custom_tool_call') throw new TypeError('Responses tool unit has the wrong IR item');
        const custom = unit.kind === 'custom_tool_call';
        unit.id = createRandomOpenAIResponsesItemId(custom ? 'custom_tool_call' : 'function_call');
        unit.callId = callId === IRNone ? createRandomOpenAIResponsesItemId('function_call') : callId;
        added = { type: custom ? 'custom_tool_call' : 'function_call', id: unit.id, call_id: unit.callId, name: item.name, [custom ? 'input' : 'arguments']: '', status: 'in_progress' };
      }
      unit.opened = true;
      outputUnits.push(unit);
      pendingEvents.push({ type: 'response.output_item.added', output_index: outputIndex, item: added });
      justOpened.add(irPathKey(unit.path));

      if (unit.kind === 'message') for (const partPath of unit.parts) {
        const part = (state.choices[0].items[partPath[3] as number] as any).content[partPath[5] as number];
        const contentIndex = unit.contentOrdinals.open(partPath);
        const content: Record<string, any> = part.type === 'text' ? { type: 'output_text', text: '', annotations: [], logprobs: [] } : { type: 'refusal', refusal: '' };
        pendingEvents.push({ type: 'response.content_part.added', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, part: content });
        const text = part.type === 'text' ? part.text : part.refusal;
        if (text !== '') pendingEvents.push({ type: part.type === 'text' ? 'response.output_text.delta' : 'response.refusal.delta', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, delta: text, ...(part.type === 'text' ? { logprobs: [] } : {}) });
        if (part.type === 'text') {
          const annotations = (part.annotations ?? []).flatMap((annotation: IRSourceCitation) => {
            const converted = convertAnnotation(part.text, annotation);
            return converted === undefined ? [] : [converted];
          });
          annotations.forEach((annotation: Record<string, any>, annotationIndex: number) => {
            pendingEvents.push({ type: 'response.output_text.annotation.added', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, annotation_index: annotationIndex, annotation });
          });
          unit.annotationCounts.set(irPathKey(partPath), annotations.length);
        }
      } else if (unit.kind === 'reasoning' && item.type === 'reasoning') {
        for (const field of ['summary', 'content'] as const) for (let part = 0; part < (item[field]?.length ?? 0); part++) {
          const contentIndex = part;
          const nativePart = { type: field === 'summary' ? 'summary_text' : 'reasoning_text', text: '' };
          pendingEvents.push({ type: field === 'summary' ? 'response.reasoning_summary_part.added' : 'response.content_part.added', item_id: requireId(unit), output_index: outputIndex, ...(field === 'summary' ? { summary_index: contentIndex } : { content_index: contentIndex }), part: nativePart });
          if (item[field]![part] !== '') pendingEvents.push({ type: field === 'summary' ? 'response.reasoning_summary_text.delta' : 'response.reasoning_text.delta', item_id: requireId(unit), output_index: outputIndex, ...(field === 'summary' ? { summary_index: contentIndex } : { content_index: contentIndex }), delta: item[field]![part] });
        }
      } else if ((unit.kind === 'function_call' || unit.kind === 'custom_tool_call') && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
        const custom = item.type === 'custom_tool_call';
        const value = custom ? item.input : item.arguments;
        if (value !== '') pendingEvents.push({ type: custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: requireId(unit), output_index: outputIndex, delta: value });
      }
    }
    for (const event of pendingEvents) yield emit(event);

    const unit = units.forRecord(record);
    if (unit?.opened && !justOpened.has(irPathKey(unit.path)) && record.type === 'operation') {
      const outputIndex = requireOutputIndex(unit);
      if (record.operation === 'initialize' && unit.kind === 'message' && record.path.length === 6) {
        const part = (state.choices[0].items[record.path[3] as number] as any).content[record.path[5] as number];
        const contentIndex = unit.contentOrdinals.open(record.path);
        const content = part.type === 'text' ? { type: 'output_text', text: '', annotations: [], logprobs: [] } : { type: 'refusal', refusal: '' };
        yield emit({ type: 'response.content_part.added', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, part: content });
      } else if (record.operation === 'initialize' && unit.kind === 'reasoning' && record.path.length === 6 && (record.path[4] === 'summary' || record.path[4] === 'content')) {
        const field = record.path[4] as 'summary' | 'content';
        const contentIndex = record.path[5] as number;
        const part = { type: field === 'summary' ? 'summary_text' : 'reasoning_text', text: '' };
        yield emit({ type: field === 'summary' ? 'response.reasoning_summary_part.added' : 'response.content_part.added', item_id: requireId(unit), output_index: outputIndex, ...(field === 'summary' ? { summary_index: contentIndex } : { content_index: contentIndex }), part });
      } else if (record.operation === 'append') {
        if (unit.kind === 'message') {
          const partPath = record.path.slice(0, 6);
          const contentIndex = unit.contentOrdinals.get(partPath);
          const refusal = record.path.at(-1) === 'refusal';
          yield emit({ type: refusal ? 'response.refusal.delta' : 'response.output_text.delta', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, delta: record.value, ...(refusal ? {} : { logprobs: [] }) });
        } else if (unit.kind === 'reasoning') {
          const field = record.path[4] as 'summary' | 'content';
          const contentIndex = record.path[5] as number;
          yield emit({ type: field === 'summary' ? 'response.reasoning_summary_text.delta' : 'response.reasoning_text.delta', item_id: requireId(unit), output_index: outputIndex, ...(field === 'summary' ? { summary_index: contentIndex } : { content_index: contentIndex }), delta: record.value });
        } else if (unit.kind === 'function_call' || unit.kind === 'custom_tool_call') {
          const custom = unit.kind === 'custom_tool_call';
          yield emit({ type: custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: requireId(unit), output_index: outputIndex, delta: record.value });
        }
      } else if (record.operation === 'assign' && unit.kind === 'message' && record.path[6] === 'annotations') {
        const partPath = record.path.slice(0, 6);
        const contentIndex = unit.contentOrdinals.get(partPath);
        const part = (state.choices[0].items[partPath[3] as number] as any).content[partPath[5] as number];
        const converted = (part.annotations ?? []).flatMap((annotation: IRSourceCitation) => {
          const value = convertAnnotation(part.text, annotation);
          return value === undefined ? [] : [value];
        });
        const count = unit.annotationCounts.get(irPathKey(partPath)) ?? 0;
        for (let index = count; index < converted.length; index++) {
          yield emit({ type: 'response.output_text.annotation.added', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, annotation_index: index, annotation: converted[index] });
        }
        unit.annotationCounts.set(irPathKey(partPath), converted.length);
      }
    }

    if (record.type === 'operation' && record.operation === 'assign' && record.path[0] === 'choices' && record.path[2] === 'logprobs' && record.path[4] === 'tokens' && typeof record.path[5] === 'number') {
      const group = state.choices[0].logprobs?.[record.path[3] as number];
      if (group?.scope === 'text_part') {
        const partPath: IRPath = ['choices', 0, 'items', group.item_index, 'content', group.content_index];
        const owner = units.get(partPath);
        if (owner?.opened && owner.kind === 'message') {
          const outputIndex = requireOutputIndex(owner);
          const contentIndex = owner.contentOrdinals.get(partPath);
          const token = record.value as unknown as IRTokenLogprob;
          yield emit({ type: 'response.output_text.delta', item_id: requireId(owner), output_index: outputIndex, content_index: contentIndex, delta: '', logprobs: [token] });
        }
      }
    }

    if (record.type === 'part_end') {
      const partPath: IRPath = ['choices', record.choice, 'items', record.item, 'content', record.part];
      const item = state.choices[record.choice].items[record.item];
      const part = item.type === 'message' ? item.content[record.part] : undefined;
      if (part?.type === 'audio') {
        if (part.audio.data !== undefined) yield emit({ type: 'response.audio.done' });
        if (part.audio.transcript !== undefined) yield emit({ type: 'response.audio.transcript.done' });
      } else if (unit?.opened && unit.kind === 'message') {
        const outputIndex = requireOutputIndex(unit);
        const contentIndex = unit.contentOrdinals.get(partPath);
        const nativePart = contentPart(state, partPath);
        yield emit({ type: nativePart.type === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, ...(nativePart.type === 'refusal' ? { refusal: nativePart.refusal } : { text: nativePart.text, logprobs: [...nativePart.logprobs] }) });
        yield emit({ type: 'response.content_part.done', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, part: nativePart });
        unit.contentOrdinals.close(partPath);
      } else if (unit?.opened && unit.kind === 'image') {
        const outputIndex = requireOutputIndex(unit);
        if (part?.type !== 'image') throw new TypeError('Responses image unit requires an image part');
        unit.status = 'completed';
        yield emit({ type: 'response.output_item.done', output_index: outputIndex, item: outputItem(state, unit) });
        units.delete(unit.path);
      }
    }

    if (record.type === 'item_end') {
      const item = state.choices[record.choice].items[record.item];
      const closing = item.type === 'message' ? messageUnits.get(record.item) ?? [] : unit === undefined ? [] : [unit];
      for (const current of closing) if (current.opened && current.kind !== 'image') {
        const outputIndex = requireOutputIndex(current);
        if (current.kind === 'function_call' && item.type === 'function_call' && record.status === undefined && !isCompleteJSONObject(item.arguments)) {
          pendingEnds.add(current);
          continue;
        }
        if (current.kind === 'reasoning') {
          if (item.type !== 'reasoning') throw new TypeError('Responses reasoning unit requires a reasoning item');
          for (const field of ['summary', 'content'] as const) for (let part = 0; part < (item[field]?.length ?? 0); part++) {
            const contentIndex = part;
            const nativePart = { type: field === 'summary' ? 'summary_text' : 'reasoning_text', text: item[field]![contentIndex] };
            yield emit({ type: field === 'summary' ? 'response.reasoning_summary_text.done' : 'response.reasoning_text.done', item_id: requireId(current), output_index: outputIndex, ...(field === 'summary' ? { summary_index: contentIndex } : { content_index: contentIndex }), text: nativePart.text });
            yield emit({ type: field === 'summary' ? 'response.reasoning_summary_part.done' : 'response.content_part.done', item_id: requireId(current), output_index: outputIndex, ...(field === 'summary' ? { summary_index: contentIndex } : { content_index: contentIndex }), part: nativePart });
          }
        } else if (current.kind === 'custom_tool_call') {
          if (item.type !== 'custom_tool_call') throw new TypeError('Responses tool unit has the wrong IR item');
          yield emit({ type: 'response.custom_tool_call_input.done', item_id: requireId(current), output_index: outputIndex, input: item.input, name: item.name });
        } else if (current.kind === 'function_call') {
          if (item.type !== 'function_call') throw new TypeError('Responses tool unit has the wrong IR item');
          yield emit({ type: 'response.function_call_arguments.done', item_id: requireId(current), output_index: outputIndex, arguments: item.arguments, name: item.name });
        }
        current.status = record.status === 'incomplete' ? 'incomplete' : 'completed';
        yield emit({ type: 'response.output_item.done', output_index: outputIndex, item: outputItem(state, current) });
        units.delete(current.path);
        for (const part of current.parts) units.delete(part);
      }
      messageUnits.delete(record.item);
    }

    if (record.type === 'operation' && record.operation === 'append' && record.path.length === 8 && record.path[4] === 'content' && record.path[6] === 'audio') {
      yield emit({ type: record.path[7] === 'data' ? 'response.audio.delta' : 'response.audio.transcript.delta', delta: record.value });
    }

    if (record.type === 'finish') {
      const refusal = state.choices[0].refusal;
      const finalUsage = state.usage === undefined ? null : usageFromIR(state.usage);
      if (refusal?.category === 'cyber' || refusal?.category === 'bio') {
        const message = refusal.explanation == null || refusal.explanation.trim() === '' ? `The upstream declined this request under the ${refusal.category} policy category.` : refusal.explanation;
        yield emit({ type: 'response.failed', response: { ...response(state, 'failed', finalUsage), error: { code: `${refusal.category}_policy`, message } } });
        return;
      }
      const status = record.status === 'completed' && finishReason === 'content_filter' ? 'incomplete' : record.status;
      yield emit({ type: `response.${status}`, response: response(state, status, finalUsage) });
    }
  }
};
