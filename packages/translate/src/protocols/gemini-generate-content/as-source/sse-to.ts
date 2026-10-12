import { usageFromIR } from './usage.ts';
import type { IRSSEOutputOptions } from '../../../ir/sse-output-options.ts';
import { consumeIRRecords, type IRFrame, type IRPath, type IRRecord } from '../../../ir/stream.ts';
import { IRNone, type IRJSONObject, type IRSourceCitation } from '../../../ir/types.ts';
import { irRangeToUTF8 } from '../../../shared/coordinates.ts';
import { isCompleteJSONObject, parseJSONObject } from '../../../shared/json/object.ts';
import { isContextExceededError } from '../../anthropic-messages/as-source/context-window-error.ts';
import { eventFrame, FAST_SERVICE_TIER, type EventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const irGenerateContentError = (error: IRJSONObject): IRJSONObject => {
  const code = error.code ?? error.type;
  const [status, statusCode] = code === 'rate_limit_exceeded' || code === 'rate_limit_error' ? ['RESOURCE_EXHAUSTED', 429]
    : code === 'invalid_prompt' || code === 'invalid_request_error' || isContextExceededError(error) ? ['INVALID_ARGUMENT', 400]
      : code === 'overloaded_error' ? ['UNAVAILABLE', 503] : ['INTERNAL', 500];
  return { code: statusCode, status, message: error.message };
};

interface GenerateContentUnit {
  readonly path: IRPath;
  readonly kind: 'message_part' | 'reasoning' | 'function_call' | 'custom_tool_call';
  opened: boolean;
  nextPending?: GenerateContentUnit;
}

interface GenerateContentQueue { head?: GenerateContentUnit; tail?: GenerateContentUnit }
interface PendingTextQueue {
  values: { unit: GenerateContentUnit; source: IRPath; text: string; thought: boolean }[];
  head: number;
}

interface TextSegment {
  source: IRPath;
  sourceStart: number;
  sourceEnd: number;
  partIndex: number;
  targetStart: number;
}

interface GeminiGenerateContentSSEOutputOptions extends IRSSEOutputOptions { imageMimeType?: string; audioMimeType?: string }

const keyOf = (path: IRPath): string => JSON.stringify(path);

export const geminiGenerateContentFromIR = async function* (
  frames: AsyncIterable<IRFrame>,
  options: GeminiGenerateContentSSEOutputOptions = {},
): AsyncGenerator<EventFrame<GeminiGenerateContentStreamEvent>> {
  let metadata = { id: '', model: '' };
  let started = false;
  const queues = new Map<number, GenerateContentQueue>();
  const unitsByPath = new Map<string, GenerateContentUnit>();
  const nextPartIndices = new Map<number, number>();
  const lastKinds = new Map<number, 'text' | 'thought' | 'other'>();
  const mappings = new Map<string, TextSegment[]>();
  const segmentsByChoice = new Map<number, Map<number, TextSegment[]>>();
  const targetLengths = new Map<string, number>();
  const terminalCandidates = new Map<number, Record<string, any>>();
  const pendingText = new Map<number, PendingTextQueue>();

  const emit = (event: Record<string, any>): EventFrame<GeminiGenerateContentStreamEvent> => eventFrame({ responseId: metadata.id, modelVersion: metadata.model, ...event } as GeminiGenerateContentStreamEvent);
  const emitPart = (choice: number, part: Record<string, any>): EventFrame<GeminiGenerateContentStreamEvent> => emit({ candidates: [{ index: choice, content: { role: 'model', parts: [part] } }] });
  const addUnit = (choice: number, unit: GenerateContentUnit): void => {
    let queue = queues.get(choice);
    if (queue === undefined) { queue = {}; queues.set(choice, queue); }
    if (queue.tail === undefined) queue.head = unit;
    else queue.tail.nextPending = unit;
    queue.tail = unit;
    unitsByPath.set(keyOf(unit.path), unit);
  };
  const unitForRecord = (record: IRRecord): GenerateContentUnit | undefined => {
    if (record.type === 'item_end') return unitsByPath.get(keyOf(['choices', record.choice, 'items', record.item]));
    if (record.type === 'part_end') return unitsByPath.get(keyOf(['choices', record.choice, 'items', record.item, 'content', record.part]));
    if (record.type !== 'operation' || record.path[0] !== 'choices' || record.path[2] !== 'items') return undefined;
    const item = record.path.slice(0, 4);
    const part = record.path[4] === 'content' && typeof record.path[5] === 'number' ? record.path.slice(0, 6) : undefined;
    return part === undefined ? unitsByPath.get(keyOf(item)) : unitsByPath.get(keyOf(part)) ?? unitsByPath.get(keyOf(item));
  };

  const occupyPart = (choice: number, kind: 'text' | 'thought' | 'other'): number => {
    const next = nextPartIndices.get(choice) ?? 0;
    if (kind !== 'other' && lastKinds.get(choice) === kind) return next - 1;
    nextPartIndices.set(choice, next + 1);
    lastKinds.set(choice, kind);
    return next;
  };

  const appendText = (choice: number, source: IRPath, text: string, thought: boolean): Record<string, any> | undefined => {
    if (text === '') return undefined;
    const kind = thought ? 'thought' : 'text';
    const partIndex = occupyPart(choice, kind);
    const targetKey = `${choice}/${partIndex}`;
    const targetStart = targetLengths.get(targetKey) ?? 0;
    targetLengths.set(targetKey, targetStart + text.length);
    const segments = mappings.get(keyOf(source)) ?? [];
    const sourceEnd = segments.length === 0 ? text.length : segments.at(-1)!.sourceEnd + text.length;
    const sourceStart = sourceEnd - text.length;
    const previous = segments.at(-1);
    if (previous?.partIndex === partIndex && previous.sourceEnd === sourceStart && previous.targetStart + previous.sourceEnd - previous.sourceStart === targetStart) previous.sourceEnd = sourceEnd;
    else {
      const segment = { source, sourceStart, sourceEnd, partIndex, targetStart };
      segments.push(segment);
      let byPart = segmentsByChoice.get(choice);
      if (byPart === undefined) { byPart = new Map(); segmentsByChoice.set(choice, byPart); }
      const partSegments = byPart.get(partIndex) ?? [];
      partSegments.push(segment);
      byPart.set(partIndex, partSegments);
    }
    mappings.set(keyOf(source), segments);
    return { text, ...(thought ? { thought: true } : {}) };
  };

  for await (const { record, collector } of consumeIRRecords(frames)) {
    const { state } = collector;
    if (record.type === 'error') { yield eventFrame({ error: irGenerateContentError(record.error) } as GeminiGenerateContentStreamEvent); return; }
    if (record.type === 'operation' && record.path[0] === 'model' && typeof record.value === 'string') metadata.model = record.value;
    if (record.type === 'start') { metadata = { id: options.id ?? record.id, model: state.model ?? '' }; started = true; continue; }
    if (!started) continue;
    const endingChoice = record.type === 'choice_end' ? record : undefined;

    if (record.type === 'operation' && record.operation === 'initialize') {
      if (record.path.length === 4 && record.path[0] === 'choices' && record.path[2] === 'items') {
        const item = record.value as any;
        if (item.type === 'reasoning' || item.type === 'function_call' || item.type === 'custom_tool_call') addUnit(record.path[1] as number, { path: record.path, kind: item.type, opened: false });
      } else if (record.path.length === 6 && record.path[0] === 'choices' && record.path[2] === 'items' && record.path[4] === 'content' && record.value !== null && typeof record.value === 'object') addUnit(record.path[1] as number, { path: record.path, kind: 'message_part', opened: false });
    }

    const justOpened = new Set<string>();
    for (const [choice, queue] of queues) {
      while (queue.head !== undefined) {
        const unit = queue.head;
        const item = state.choices[choice].items[unit.path[3] as number];
        const closed = !collector.isOpen(unit.path);
        let wait = false;
        let part: Record<string, any> | undefined;
        if (unit.kind === 'message_part') {
          if (item.type !== 'message') throw new TypeError('GenerateContent message unit requires a message item');
          const content = item.content[unit.path[5] as number];
          if (content.type === 'text' || content.type === 'refusal') {
            part = undefined;
          } else if (!closed) wait = true;
          else if (content.type === 'image' || content.type === 'audio' && content.audio.data !== undefined) {
            const media = content.type === 'image' ? content.image : content.audio;
            const mime = media.mime_type ?? (content.type === 'image' ? options.imageMimeType : options.audioMimeType);
            if (mime === undefined) throw new TypeError('GenerateContent inline data requires a MIME type');
            part = { inlineData: { mimeType: mime, data: media.data }, ...(content.type === 'audio' && content.audio.transcript !== undefined ? { audioTranscription: { text: content.audio.transcript } } : {}) };
            occupyPart(choice, 'other');
          } else if (content.type === 'audio' && content.audio.transcript !== undefined) part = appendText(choice, [...unit.path, 'audio', 'transcript'], content.audio.transcript, false);
        } else if (unit.kind === 'reasoning') {
          if (item.type !== 'reasoning') throw new TypeError('GenerateContent reasoning unit requires a reasoning item');
          if (item.summary !== undefined || item.content !== undefined) {
            part = undefined;
          } else if (!closed) wait = true;
          else if (item.encrypted_content != null) {
            part = { thoughtSignature: item.encrypted_content };
            occupyPart(choice, 'other');
          }
        } else if (unit.kind === 'function_call') {
          if (!closed) wait = true;
          else {
            if (item.type !== 'function_call') throw new TypeError('GenerateContent function unit requires a function item');
            if (record.type === 'item_end' && record.item === unit.path[3] && record.status === 'incomplete' || endingChoice?.finish_reason === 'length') part = undefined;
            else if (!isCompleteJSONObject(item.arguments) && endingChoice === undefined && record.type !== 'finish') wait = true;
            else {
              const args = parseJSONObject(item.arguments, options.parseToolArguments);
              part = { functionCall: { name: item.name, ...(item.call_id === undefined || item.call_id === IRNone ? {} : { id: item.call_id }), args } };
              occupyPart(choice, 'other');
            }
          }
        }
        if (wait) break;
        queue.head = unit.nextPending;
        unit.nextPending = undefined;
        if (queue.head === undefined) queue.tail = undefined;
        unit.opened = true; justOpened.add(keyOf(unit.path));
        if (part !== undefined) yield emitPart(choice, part);
        if (closed) unitsByPath.delete(keyOf(unit.path));
      }
      if (queue.head === undefined) queues.delete(choice);
    }

    for (const [choice, queue] of pendingText) {
      while (queue.head < queue.values.length && queue.values[queue.head].unit.opened) {
        const pending = queue.values[queue.head++];
        const part = appendText(choice, pending.source, pending.text, pending.thought);
        if (part !== undefined) yield emitPart(choice, part);
      }
      if (queue.head === queue.values.length) pendingText.delete(choice);
    }

    const unit = unitForRecord(record);
    if (unit !== undefined && (unit.kind === 'message_part' || unit.kind === 'reasoning') && record.type === 'operation' && record.operation === 'append' && !unit.opened) {
      const choice = record.path[1] as number;
      const item = state.choices[record.path[1] as number].items[record.path[3] as number];
      let queue = pendingText.get(choice);
      if (queue === undefined) { queue = { values: [], head: 0 }; pendingText.set(choice, queue); }
      queue.values.push({ unit, source: record.path, text: record.value, thought: item.type === 'reasoning' });
    } else if (unit?.opened && !justOpened.has(keyOf(unit.path)) && record.type === 'operation' && record.operation === 'append') {
      const choice = record.path[1] as number;
      const item = state.choices[choice].items[record.path[3] as number];
      let thought = false;
      if (item.type === 'reasoning') thought = true;
      const part = appendText(choice, record.path, record.value, thought);
      if (part !== undefined) yield emitPart(choice, part);
    }

    if (record.type === 'item_end') {
      const item = state.choices[record.choice].items[record.item];
      if (item.type === 'reasoning' && (item.summary !== undefined || item.content !== undefined) && item.encrypted_content != null) {
        const value = { thoughtSignature: item.encrypted_content };
        occupyPart(record.choice, 'other');
        yield emitPart(record.choice, value);
      }
      unitsByPath.delete(keyOf(['choices', record.choice, 'items', record.item]));
    } else if (record.type === 'part_end') {
      unitsByPath.delete(keyOf(['choices', record.choice, 'items', record.item, 'content', record.part]));
    }

    if (record.type === 'choice_end') {
      const choice = state.choices[record.choice];
      const partTexts = new Map<number, string>();
      for (const [partIndex, segments] of segmentsByChoice.get(record.choice) ?? []) {
        let text = '';
        for (const segment of segments) {
          if (text.length !== segment.targetStart) throw new TypeError('GenerateContent text segments must remain contiguous');
          const source = collector.value<string>(segment.source);
          if (source === undefined) throw new TypeError(`GenerateContent text segment source is missing: ${JSON.stringify(segment.source)}`);
          text += source.slice(segment.sourceStart, segment.sourceEnd);
        }
        partTexts.set(partIndex, text);
      }
      const chunks: Record<string, any>[] = [];
      const supports: Record<string, any>[] = [];
      choice.items.forEach((item, itemIndex) => {
        if (item.type !== 'message') return;
        item.content.forEach((content, partIndex) => {
          if (content.type !== 'text') return;
          for (const annotation of content.annotations ?? []) {
            const chunk = groundingChunk(annotation);
            const chunkIndex = chunks.length; chunks.push(chunk);
            const outputRange = annotation.output_text_range ?? { start: 0, end_exclusive: content.text.length };
            for (const segment of mappings.get(keyOf(['choices', record.choice, 'items', itemIndex, 'content', partIndex, 'text'])) ?? []) {
              const start = Math.max(segment.sourceStart, outputRange.start);
              const end = Math.min(segment.sourceEnd, outputRange.end_exclusive);
              if (end <= start) continue;
              const text = partTexts.get(segment.partIndex);
              if (text === undefined) throw new TypeError(`GenerateContent text part ${segment.partIndex} is missing`);
              const range = { start: segment.targetStart + start - segment.sourceStart, end_exclusive: segment.targetStart + end - segment.sourceStart };
              const bytes = irRangeToUTF8(text, range);
              supports.push({ groundingChunkIndices: [chunkIndex], segment: { partIndex: segment.partIndex, startIndex: bytes.start, endIndex: bytes.end, text: text.slice(range.start, range.end_exclusive) } });
            }
          }
        });
      });
      const tokens = choice.logprobs?.flatMap(group => group.tokens);
      terminalCandidates.set(record.choice, { ...(choice.refusal?.explanation == null ? {} : { finishMessage: choice.refusal.explanation }), index: record.choice, finishReason: record.finish_reason === 'length' ? 'MAX_TOKENS' : record.finish_reason === 'content_filter' ? 'SAFETY' : 'STOP', ...(chunks.length === 0 ? {} : { groundingMetadata: { groundingChunks: chunks, groundingSupports: supports } }), ...(tokens === undefined ? {} : { logprobsResult: { chosenCandidates: tokens.map(token => ({ token: token.token, logProbability: token.logprob })), topCandidates: tokens.map(token => ({ candidates: (token.top_logprobs ?? []).map(alternative => ({ token: alternative.token, logProbability: alternative.logprob })) })) } }) });
    }

    if (record.type === 'finish') {
      const serviceTier = state.service_tier === 'fast' ? FAST_SERVICE_TIER : state.service_tier === 'default' ? 'standard' : state.service_tier;
      yield emit({ candidates: [...terminalCandidates.entries()].toSorted(([a], [b]) => a - b).map(([, candidate]) => candidate), ...(state.usage === undefined ? {} : { usageMetadata: { ...usageFromIR(state.usage), ...(serviceTier === undefined ? {} : { serviceTier }) } }) });
    }
  }
};

const groundingChunk = (citation: IRSourceCitation): Record<string, any> => {
  if (citation.source_kind === 'url') return { web: { uri: citation.source, title: citation.source_label } };
  return { retrievedContext: { ...(citation.source == null ? {} : { uri: citation.source }), ...(citation.source_label == null ? {} : { title: citation.source_label }), ...(citation.source_text === undefined ? {} : { text: citation.source_text.text }), ...(citation.source_page_range === undefined ? {} : { pageNumber: citation.source_page_range.start_one_based }) } };
};
