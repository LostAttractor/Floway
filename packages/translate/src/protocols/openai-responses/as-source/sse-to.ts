import { usageFromIR } from './usage.ts';
import type { IRCollector } from '../../../ir/collector.ts';
import { irChangedItems, irChangedParts } from '../../../ir/item-updates.ts';
import { createIRMessageLayouts } from '../../../ir/message-layout.ts';
import { createIRMetadataReader, irOutputMetadata } from '../../../ir/metadata.ts';
import type { IRSSEOutputOptions } from '../../../ir/sse-output-options.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import { createIRStringProjection } from '../../../ir/string-projection.ts';
import type { IRItem, IRSourceCitation } from '../../../ir/types.ts';
import { irRangeToCodePoints } from '../../../shared/coordinates.ts';
import { cloneJSON } from '../../../shared/json/clone.ts';
import { isCompleteJSONObject } from '../../../shared/json/object.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createRandomOpenAIResponsesItemId, openaiResponsesResultToEvents, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const openaiResponsesFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IRSSEOutputOptions = {}): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRStringProjection();
  const readMetadata = createIRMetadataReader();
  const output: Record<string, any>[] = [];
  const indices = new Map<string, number>();
  const ended = new Set<string>();
  const pendingStarts = new Set<number>();
  let startBarrier: number | undefined;
  const messageLayout = createIRMessageLayouts();
  const logprobGroups = new Map<string, number>();
  const logprobVersions = new Map<string, number>();
  const closedParts = new Set<string>();
  let sequence = 0;
  let finishReason = 'stop';
  let extension: Record<string, any> = {};
  const startedItems = new Set<number>();
  const startedParts = new Set<string>();
  const completedItems = new Map<number, 'completed' | 'incomplete'>();
  let choiceEnded = false;
  const emit = (event: Record<string, any>): ProtocolFrame<OpenAIResponsesStreamEventEx> => eventFrame({ ...event, sequence_number: sequence++ } as OpenAIResponsesStreamEventEx);
  const response = (status: string, usage: unknown = null): Record<string, any> => ({ ...extension, id: metadata.id, object: 'response', created_at: metadata.created, model: metadata.model, status, output: cloneJSON(output), usage, error: null, incomplete_details: status === 'incomplete' ? extension.incomplete_details ?? { reason: finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } : null });
  let stateChatSource = false;
  const targetItem = (item: IRItem, sourceIndex: number, closed: boolean, partIndex: number | undefined, collector: IRCollector): Record<string, any> | undefined => {
    const id = collector.read(['extensions', 'openaiResponses', 'item_ids', String(sourceIndex)]) ?? createRandomOpenAIResponsesItemId(item.type === 'message' && partIndex !== undefined && item.content[partIndex].type === 'image' ? 'image_generation_call' : item.type);
    if (partIndex !== undefined && item.type === 'message') {
      const part = item.content[partIndex];
      if (part.type === 'image' && !collector.has(['choices', 0, 'items', sourceIndex, 'content', partIndex, 'image', 'data'])) return undefined;
      if (part.type === 'image') return { type: 'image_generation_call', id, status: 'in_progress', result: null };
      if (part.type === 'text' || part.type === 'refusal') return { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] };
      return undefined;
    }
    if (item.type === 'message') return undefined;
    if (item.type === 'reasoning') return { type: 'reasoning', id, status: 'in_progress', summary: [], ...(collector.within(['choices', 0, 'items', sourceIndex, 'content']) ? { content: [] } : {}) };
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && (!collector.has(['choices', 0, 'items', sourceIndex, 'name']) || item.name === '')) {
      if (closed) throw new TypeError('Completed tool calls require a name');
      return undefined;
    }
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && stateChatSource && (!collector.has(['choices', 0, 'items', sourceIndex, 'call_id']) || !item.call_id)) {
      if (closed) throw new TypeError('Completed tool calls require an id');
      return undefined;
    }
    if (item.type === 'function_call') return { type: 'function_call', id, call_id: collector.has(['choices', 0, 'items', sourceIndex, 'call_id']) ? item.call_id : id, name: item.name, arguments: '', status: 'in_progress' };
    return { type: 'custom_tool_call', id, ...(collector.has(['choices', 0, 'items', sourceIndex, 'call_id']) ? { call_id: item.call_id } : {}), name: item.name, input: '', status: 'in_progress' };
  };
  for await (const { record, collector } of consumeIRRecords(frames)) {
    const { state } = collector;
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); if (!metadata.id.startsWith('resp_')) metadata.id = `resp_${crypto.randomUUID().replace(/-/g, '')}`; started = true; }
    if (record.type === 'choice_end') { finishReason = record.finish_reason; choiceEnded = true; }
    if (record.type === 'item_start') startedItems.add(record.item);
    if (record.type === 'part_start') startedParts.add(`${record.item}/${record.part}`);
    if (record.type === 'item_end') completedItems.set(record.item, record.status ?? 'completed');
    if (!started && record.type !== 'error') continue;
    if (record.type === 'operation' && record.operation === 'initialize') continue;
    const published = readMetadata(collector);
    const usage = published.usage;
    const servingMetadata = published.extensions?.anthropicMessages ?? published.extensions?.openaiResponses ?? published.extensions?.openaiChatCompletions;
    if (typeof servingMetadata?.model === 'string') metadata.model = servingMetadata.model;
    extension = { ...published.extensions?.openaiResponses };
    delete extension.item_ids;
    stateChatSource = state.extensions?.openaiChatCompletions !== undefined;
    const openaiTier = (published.extensions?.openaiResponses ?? published.extensions?.openaiChatCompletions)?.service_tier;
    const messagesUsage = published.extensions?.anthropicMessages?.usage as Record<string, any> | undefined;
    const tier = typeof openaiTier === 'string' ? openaiTier : messagesUsage?.speed === 'fast' ? 'fast' : typeof messagesUsage?.service_tier === 'string' ? messagesUsage.service_tier : undefined;
    if (tier !== undefined) extension.service_tier = tier;
    if (record.type === 'error') {
      yield emit({ type: 'error', message: record.error.message, code: record.error.code ?? record.error.type, ...(record.error.param === undefined ? {} : { param: record.error.param }) });
      return;
    }
    if (state.choices.length > 1) throw new Error('Responses cannot represent multiple choices');
    if (record.type === 'start') {
      const initialUsage = usage === undefined ? null : usageFromIR(usage);
      yield emit({ type: 'response.created', response: response('in_progress', initialUsage) });
      yield emit({ type: 'response.in_progress', response: response('in_progress', initialUsage) });
    }
    if (record.type === 'operation' || record.type === 'item_start' || record.type === 'part_start' || record.type === 'item_end' || record.type === 'part_end' || record.type === 'choice_end' || record.type === 'finish') {
      let startsBlocked = false;
      const changedItems = irChangedItems(collector, record).get(0) ?? new Set<number>();
      if (startBarrier !== undefined && changedItems.has(startBarrier)) { for (const index of pendingStarts) changedItems.add(index); startBarrier = undefined; }
      for (const sourceIndex of [...changedItems].toSorted((a, b) => a - b)) {
        pendingStarts.delete(sourceIndex);
        const item = state.choices[0].items[sourceIndex];
        const source: IRPath = ['choices', 0, 'items', sourceIndex];
        const layout = item.type === 'message' ? messageLayout(item, record, 0, sourceIndex) : undefined;
        const closing = completedItems.has(sourceIndex) || record.type === 'finish';
        if (!collector.within(source) && !startedItems.has(sourceIndex)) continue;
        if (item.type === 'message') for (const p of irChangedParts(item, record, 0, sourceIndex)) {
          const part = item.content[p]; if (part.type !== 'audio') continue;
          for (const field of ['data', 'transcript'] as const) if (collector.has([...source, 'content', p, 'audio', field])) {
            const delta = projection.appendFromRecord(record, [...source, 'content', p, 'audio', field], part.audio[field]!, ['audio', field]);
            if (delta !== '') yield emit({ type: field === 'data' ? 'response.audio.delta' : 'response.audio.transcript.delta', delta });
          }
          const key = `${sourceIndex}/${p}/audio`;
          if (closing && !ended.has(key)) {
            if (collector.has([...source, 'content', p, 'audio', 'data'])) yield emit({ type: 'response.audio.done' });
            if (collector.has([...source, 'content', p, 'audio', 'transcript'])) yield emit({ type: 'response.audio.transcript.done' });
            ended.add(key);
          }
        }
        const parts = item.type === 'message' ? irChangedParts(item, record, 0, sourceIndex).filter(index => item.content[index].type !== 'audio') : [undefined];
        for (const partIndex of parts) {
          if (item.type === 'message' && partIndex !== undefined && !collector.within([...source, 'content', partIndex]) && !startedParts.has(`${sourceIndex}/${partIndex}`)) continue;
          const messagePart = item.type === 'message' && partIndex !== undefined && ['text', 'refusal'].includes(item.content[partIndex].type);
          const group = item.type === 'message' && partIndex !== undefined ? layout!.groups[partIndex] : 0;
          const key = `${sourceIndex}/${messagePart ? `message/${group}` : partIndex ?? 'item'}`;
          let index = indices.get(key);
          if (index === undefined) {
            if (startsBlocked || startBarrier !== undefined && sourceIndex > startBarrier) { pendingStarts.add(sourceIndex); continue; }
            const native = targetItem(item, sourceIndex, closing, partIndex, collector);
            if (native === undefined) {
              if ((item.type === 'function_call' || item.type === 'custom_tool_call') && !closing) { startsBlocked = true; startBarrier = sourceIndex; pendingStarts.add(sourceIndex); }
              continue;
            }
            index = output.length; indices.set(key, index); output.push(native);
            yield emit({ type: 'response.output_item.added', output_index: index, item: cloneJSON(native) });
          }
          const native = output[index];

          const target: IRPath = ['output', index];
          const part = item.type === 'message' ? item.content[partIndex!] : undefined;
          if (part?.type === 'image' && collector.has([...source, 'content', partIndex!, 'image', 'data'])) {
            native.result = part.image.data;
            // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts#L5805-L5839
            if (collector.has([...source, 'content', partIndex!, 'image', 'mime_type'])) native.output_format = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[part.image.mime_type as 'image/png' | 'image/jpeg' | 'image/webp'];
            projection.assign([...source, 'content', partIndex!, 'image', 'data'], part.image.data, [...target, 'result']);
          } else if (part?.type === 'text' || part?.type === 'refusal') {
            const original = partIndex!;
            const p = item.type === 'message' ? layout!.positions[original] : 0;
            const refusal = part.type === 'refusal';
            const text = collector.has([...source, 'content', original, refusal ? 'refusal' : 'text']) ? refusal ? part.refusal : part.text : native.content[p]?.[refusal ? 'refusal' : 'text'] ?? '';
            const field = refusal ? 'refusal' : 'text';
            if (native.content[p] === undefined) {
              native.content[p] = refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
              yield emit({ type: 'response.content_part.added', item_id: native.id, output_index: index, content_index: p, part: cloneJSON(native.content[p]) });
            }
            const path = [...source, 'content', original, field];
            const delta = collector.has(path) ? projection.appendFromRecord(record, path, text, [...target, 'content', p, field], true) : '';
            native.content[p][field] = text;
            if (delta !== '') yield emit({ type: refusal ? 'response.refusal.delta' : 'response.output_text.delta', item_id: native.id, output_index: index, content_index: p, delta, ...(refusal ? {} : { logprobs: [] }) });
            if (part.type === 'text') {
              const annotations = (collector.read([...source, 'content', original, 'annotations']) ?? []).filter((a: unknown) => a !== undefined).flatMap((a: IRSourceCitation): Record<string, any>[] => {
                if ((a.source_kind === 'url' || a.source_kind === 'search_result') && a.source != null) {
                  const range = irRangeToCodePoints(text, a.output_text_range ?? { start: 0, end_exclusive: text.length });
                  return [{ type: 'url_citation', url: a.source, title: a.source_label ?? a.source, start_index: range.start, end_index: range.end }];
                }
                if (a.source_kind === 'document' && a.source !== undefined && a.source !== null) return [{ type: 'file_citation', file_id: a.source, filename: a.source_label ?? a.source, index: 0 }];
                return [];
              });
              const oldCount = native.content[p].annotations.length;
              native.content[p].annotations = annotations;
              for (let a = oldCount; !ended.has(key) && a < annotations.length; a++) yield emit({ type: 'response.output_text.annotation.added', item_id: native.id, output_index: index, content_index: p, annotation_index: a, annotation: annotations[a] });
              const logprobPath: IRPath = ['choices', 0, 'logprobs'];
              const version = collector.version(logprobPath);
              const owner = `${sourceIndex}/${original}`;
              if (version !== logprobVersions.get(owner)) {
                let groupIndex = logprobGroups.get(owner);
                const groups = state.choices[0].logprobs;
                const cached = groupIndex === undefined ? undefined : groups?.[groupIndex];
                if (cached?.scope !== 'text_part' || cached.item_index !== sourceIndex || cached.content_index !== original) groupIndex = groups?.findIndex(g => g.scope === 'text_part' && g.item_index === sourceIndex && g.content_index === original);
                if (groupIndex !== undefined && groupIndex >= 0) {
                  logprobGroups.set(owner, groupIndex);
                  const path = [...logprobPath, groupIndex, 'tokens'];
                  const tokens = groups![groupIndex].tokens;
                  const replacing = record.type === 'operation' && record.operation === 'assign' && record.path.length <= path.length && record.path.every((key, index) => key === path[index]);
                  const result = replacing ? [] : native.content[p].logprobs ?? [];
                  if (record.type === 'operation' && record.path.length > path.length && path.every((key, index) => key === record.path[index]) && typeof record.path[path.length] === 'number') {
                    const token = record.path[path.length] as number;
                    result[token] = collector.read([...path, token]);
                  }
                  for (let token = result.length; token < tokens.length; token++) { const value = collector.read([...path, token]); if (value !== undefined) result.push(value); }
                  native.content[p].logprobs = result;
                }
                logprobVersions.set(owner, version);
              }
            }
          } else if (item.type === 'reasoning') {
            for (const field of ['summary', 'content'] as const) for (let p = 0; p < (item[field]?.length ?? 0); p++) {
              if (!collector.has([...source, field, p])) continue;
              native[field] ??= [];
              if (native[field][p] === undefined) {
                native[field][p] = { type: field === 'summary' ? 'summary_text' : 'reasoning_text', text: '' };
                yield emit({ type: field === 'summary' ? 'response.reasoning_summary_part.added' : 'response.content_part.added', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), part: cloneJSON(native[field][p]) });
              }
              const text = item[field]![p];
              const delta = projection.appendFromRecord(record, [...source, field, p], text, [...target, field, p, 'text'], true);
              native[field][p].text = text;
              if (delta !== '') yield emit({ type: field === 'summary' ? 'response.reasoning_summary_text.delta' : 'response.reasoning_text.delta', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), delta });
            }
            if (collector.has([...source, 'encrypted_content'])) {
              native.encrypted_content = item.encrypted_content;
              if (item.encrypted_content !== null) projection.assign([...source, 'encrypted_content'], item.encrypted_content!, [...target, 'encrypted_content']);
            }
          } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            const custom = item.type === 'custom_tool_call';
            const field = custom ? 'input' : 'arguments';
            const input = collector.read([...source, field]);
            if (input === undefined) {
              if (closing) throw new TypeError('Completed tool calls require input');
              continue;
            }
            const value = typeof input === 'object' ? closing ? JSON.stringify(input) : native[field] : input;
            const delta = projection.appendFromRecord(record, [...source, field], value, [...target, field], true);
            native[field] = value; native.name = item.name;
            if (collector.has([...source, 'call_id'])) native.call_id = item.call_id;
            if (delta !== '') yield emit({ type: custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: native.id, output_index: index, delta });
          }
          const closingPart = record.type === 'part_end' && record.item === sourceIndex && record.part === partIndex;
          if (native.type === 'message' && (closing || closingPart)) {
            const endingPart = item.type === 'message' && partIndex !== undefined ? layout!.positions[partIndex] : undefined;
            for (let p = 0; p < native.content.length; p++) {
              const partKey = `${index}/${p}`;
              if (closedParts.has(partKey) || !closing && p !== endingPart) continue;
              const part = native.content[p];
              yield emit({ type: part.type === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', item_id: native.id, output_index: index, content_index: p, ...(part.type === 'refusal' ? { refusal: part.refusal } : { text: part.text, logprobs: [...part.logprobs ?? []] }) });
              yield emit({ type: 'response.content_part.done', item_id: native.id, output_index: index, content_index: p, part: cloneJSON(part) });
              closedParts.add(partKey);
            }
          }
          const pendingArguments = closing && !ended.has(key) && item.type === 'function_call' && collector.has([...source, 'arguments']) && typeof item.arguments === 'string' && !isCompleteJSONObject(item.arguments);
          if (closing && !ended.has(key) && (!pendingArguments || choiceEnded || record.type === 'finish')) {
            if (item.type === 'reasoning') for (const field of ['summary', 'content'] as const) for (let p = 0; p < (native[field]?.length ?? 0); p++) {
              yield emit({ type: field === 'summary' ? 'response.reasoning_summary_text.done' : 'response.reasoning_text.done', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), text: native[field][p].text });
              yield emit({ type: field === 'summary' ? 'response.reasoning_summary_part.done' : 'response.content_part.done', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), part: cloneJSON(native[field][p]) });
            }
            if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              const custom = item.type === 'custom_tool_call'; const field = custom ? 'input' : 'arguments';
              yield emit({ type: custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', item_id: native.id, output_index: index, [field]: native[field], name: native.name });
            }
            native.status = completedItems.get(sourceIndex) === 'incomplete' || pendingArguments && finishReason === 'length' ? 'incomplete' : 'completed';
            yield emit({ type: 'response.output_item.done', output_index: index, item: cloneJSON(native) }); ended.add(key);
          }
        }
      }
    }
    if (record.type === 'finish') {
      const refusal = collector.read(['choices', 0, 'refusal']);
      if (refusal?.category === 'cyber' || refusal?.category === 'bio') {
        // Codex replaces absent/blank biology explanations with an OpenAI enrollment notice.
        // https://github.com/openai/codex/blob/de8fab6d7adfcef8b4ce6f02f3b5c8be4092015a/codex-rs/codex-api/src/sse/responses_error.rs#L59
        const message = refusal.explanation == null || refusal.explanation.trim() === '' ? `The upstream declined this request under the ${refusal.category} policy category.` : refusal.explanation;
        yield emit({ type: 'response.failed', response: { ...response('failed', usage === undefined ? null : usageFromIR(usage)), error: { code: `${refusal.category}_policy`, message } } });
        return;
      }
      if (record.status === 'failed') {
        yield emit({ type: 'response.failed', response: { ...response('failed', usage === undefined ? null : usageFromIR(usage)), error: record.error } });
        return;
      }

      if (refusal?.explanation != null) {
        const item = { type: 'message' as const, id: createRandomOpenAIResponsesItemId('message'), role: 'assistant' as const, status: 'completed' as const, content: [{ type: 'refusal' as const, refusal: refusal.explanation }] };
        const index = output.length;
        for (const frame of openaiResponsesResultToEvents({ id: metadata.id, object: 'response', model: metadata.model, status: 'completed', output: [item], error: null, incomplete_details: null })) {
          if (frame.type === 'event' && 'output_index' in frame.event) yield emit({ ...frame.event, output_index: index });
        }
        output.push(item);
      }
      const status = record.status === 'completed' && finishReason === 'content_filter' ? 'incomplete' : record.status;
      yield emit({ type: `response.${status}`, response: { ...response(status, usage === undefined ? null : usageFromIR(usage)), error: record.error ?? null } });

    }
  }
};
