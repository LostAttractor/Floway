import { usageFromIR } from './usage.ts';
import { irOutputMetadata } from '../../../ir/metadata.ts';
import { createIRProjection, type IROutputOptions } from '../../../ir/projection.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import { createIRTextStream, type IRTextUpdate } from '../../../ir/text.ts';
import type { IRItem, IRJSONObject, IRSourceCitation } from '../../../ir/types.ts';
import { irRangeToUTF8 } from '../../../shared/coordinates.ts';
import { isCompleteJSONObject, parseJSONObject } from '../../../shared/json/object.ts';
import { isContextExceededError } from '../../anthropic-messages/as-source/context-window-error.ts';
import { eventFrame, FAST_SERVICE_TIER, type EventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

// A failed Responses event has no HTTP status; these are target classifications.
// https://developers.openai.com/api/reference/resources/responses/streaming-events
// https://ai.google.dev/gemini-api/docs/troubleshooting
const irGenerateContentError = (error: IRJSONObject): IRJSONObject => {
  const code = error.code ?? error.type;
  const [status, statusCode] = code === 'rate_limit_exceeded' || code === 'rate_limit_error' ? ['RESOURCE_EXHAUSTED', 429]
    : code === 'invalid_prompt' || code === 'invalid_request_error' || isContextExceededError(error) ? ['INVALID_ARGUMENT', 400]
      : code === 'overloaded_error' ? ['UNAVAILABLE', 503] : ['INTERNAL', 500];
  return { code: statusCode, status, message: error.message };
};

export interface IRGenerateContentOutputOptions extends IROutputOptions { imageMimeType?: string; audioMimeType?: string }

const streamsText = (item: IRItem): boolean => item.type === 'reasoning' || item.type === 'message' && item.content.every(part => part.type === 'text' || part.type === 'refusal');

export const geminiGenerateContentFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IRGenerateContentOutputOptions = {}): AsyncGenerator<EventFrame<GeminiGenerateContentStreamEvent>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRProjection();
  const textStream = createIRTextStream();
  const itemStatuses = new Map<string, 'completed' | 'incomplete' | undefined>();
  const completedItems = new Set<string>();
  const startedItems = new Set<string>();
  const parts = new Map<number, Record<string, any>[]>();
  const lastKind = new Map<number, string>();
  const emitted = new Set<string>();
  const terminalCandidates: Record<string, any>[] = [];
  let extension: Record<string, any> = {};
  const emit = (event: Record<string, any>): EventFrame<GeminiGenerateContentStreamEvent> => eventFrame({ ...extension, responseId: metadata.id, modelVersion: metadata.model, ...event } as GeminiGenerateContentStreamEvent);
  const emitPart = (choice: number, part: Record<string, any>): EventFrame<GeminiGenerateContentStreamEvent> => emit({ candidates: [{ index: choice, content: { role: 'model', parts: [part] } }] });
  for await (const { state, record, values } of consumeIRRecords(frames)) {
    if (record.type === 'operation' && record.operation === 'assign') projection.validateText(state, record.path);
    textStream.update(state, values);
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); started = true; }
    if (!started && record.type !== 'error') continue;
    if (record.type === 'operation' && record.operation === 'initialize') continue;
    const published = { ...state, extensions: values.read(['extensions'], state.extensions) ?? {} };
    const usage = values.read(['usage'], state.usage);
    const servingMetadata = published.extensions?.anthropicMessages ?? published.extensions?.openaiResponses ?? published.extensions?.openaiChatCompletions;
    if (typeof servingMetadata?.model === 'string') metadata.model = servingMetadata.model;
    if (record.type === 'item_start') startedItems.add(`${record.choice}/${record.item}`);
    if (record.type === 'item_end') { completedItems.add(`${record.choice}/${record.item}`); itemStatuses.set(`${record.choice}/${record.item}`, record.status); }
    extension = published.extensions?.geminiGenerateContent ?? {};
    if (record.type === 'error' || record.type === 'finish' && record.status === 'failed') {
      if (record.error === undefined) throw new TypeError('Failed IR generation requires an error');
      yield eventFrame({ error: irGenerateContentError(record.error) } as GeminiGenerateContentStreamEvent);
      return;
    }
    if (record.type === 'operation' || record.type === 'item_start' || record.type === 'part_start' || record.type === 'item_end' || record.type === 'choice_end' || record.type === 'finish') {
      for (let choice = 0; choice < state.choices.length; choice++) {
        let native = parts.get(choice);
        if (native === undefined) { native = []; parts.set(choice, native); }
        let textRunEnd = 0;
        for (let index = 0; index < state.choices[choice].items.length; index++) {
          const item = state.choices[choice].items[index];
          const source: IRPath = ['choices', choice, 'items', index];
          if (!values.within(source) && !startedItems.has(`${choice}/${index}`)) continue;
          const closed = completedItems.has(`${choice}/${index}`) || record.type === 'choice_end' && record.choice === choice || record.type === 'finish' || record.type === 'item_end' && record.item === index && record.choice === choice;
          const textDelta = (update: IRTextUpdate, thought: boolean): Record<string, any> | undefined => {
            const kind = thought ? 'thought' : 'text';
            const merge = !thought && lastKind.get(choice) === kind;
            const position = merge ? native!.length - 1 : native!.length;
            const delta = projection.appendText(update, ['candidates', choice, 'content', 'parts', position, 'text']);
            if (delta === '' && !(update.text === '' && update.start === 0)) return undefined;
            if (merge) native![position].text += delta;
            else native!.push({ text: delta, ...(thought ? { thought: true } : {}) });
            lastKind.set(choice, kind);
            return { text: delta, ...(thought ? { thought: true } : {}) };
          };
          if (streamsText(item) && index >= textRunEnd) {
            textRunEnd = index + 1;
            while (textRunEnd < state.choices[choice].items.length && streamsText(state.choices[choice].items[textRunEnd])) textRunEnd++;
            for (const update of textStream.takeMatching(update => update.path[0] === 'choices' && update.path[1] === choice && (update.path[3] as number) >= index && (update.path[3] as number) < textRunEnd)) {
              const delta = textDelta(update, state.choices[choice].items[update.path[3] as number].type === 'reasoning');
              if (delta !== undefined) yield emitPart(choice, delta);
            }
          }
          if (item.type === 'message' && !streamsText(item)) for (let p = 0; p < item.content.length; p++) {
            const part = item.content[p]; const path = [...source, 'content', p];
            if (part.type === 'text' || part.type === 'refusal') {
              for (const update of textStream.take([...path, part.type === 'text' ? 'text' : 'refusal'])) {
                const delta = textDelta(update, false);
                if (delta !== undefined) yield emitPart(choice, delta);
              }
            } else if (closed) {
              const key = JSON.stringify(path);
              if (emitted.has(key)) continue;
              if ((part.type === 'image' || part.type === 'audio') && values.has([...path, part.type === 'image' ? 'image' : 'audio', 'data'])) {
                const media = part.type === 'image' ? part.image : part.audio;
                const mime = (values.has([...path, part.type === 'image' ? 'image' : 'audio', 'mime_type']) ? media.mime_type : undefined) ?? (part.type === 'image' ? options.imageMimeType : options.audioMimeType);
                if (mime === undefined) throw new TypeError('GenerateContent inline data requires a MIME type');
                const value: Record<string, any> = { inlineData: { mimeType: mime, data: media.data } };
                const target = ['candidates', choice, 'content', 'parts', native.length, 'inlineData', 'data'];
                projection.assign([...path, part.type === 'image' ? 'image' : 'audio', 'data'], media.data!, target);
                if (part.type === 'audio' && values.has([...path, 'audio', 'transcript'])) {
                  value.audioTranscription = { text: part.audio.transcript };
                  projection.assign([...path, 'audio', 'transcript'], part.audio.transcript!, ['candidates', choice, 'content', 'parts', native.length, 'audioTranscription', 'text']);
                }
                native.push(value); lastKind.set(choice, 'media'); yield emitPart(choice, value);
              } else if (part.type === 'audio' && values.has([...path, 'audio', 'transcript'])) {
                for (const update of textStream.take([...path, 'audio', 'transcript'])) {
                  const delta = textDelta(update, false);
                  if (delta !== undefined) yield emitPart(choice, delta);
                }
              }
              emitted.add(key);
            }
          } else if (item.type === 'reasoning') {
            const key = `${choice}/${index}/signature`;
            if (closed && values.has([...source, 'encrypted_content']) && item.encrypted_content != null && !emitted.has(key)) {
              const value = { thoughtSignature: item.encrypted_content };
              projection.assign([...source, 'encrypted_content'], item.encrypted_content, ['candidates', choice, 'content', 'parts', native.length, 'thoughtSignature']);
              native.push(value); lastKind.set(choice, 'signature'); emitted.add(key); yield emitPart(choice, value);
            }
          } else if (item.type === 'function_call' && closed) {
            const key = JSON.stringify(source);
            if (emitted.has(key)) continue;
            const status = itemStatuses.get(`${choice}/${index}`);
            if (status === 'incomplete' || values.has([...source, 'arguments']) && typeof item.arguments === 'string' && options.parseToolArguments === undefined && !isCompleteJSONObject(item.arguments)) {
              if (status === 'incomplete' || record.type === 'choice_end' && record.finish_reason === 'length') { emitted.add(key); continue; }
              if (status === undefined && record.type !== 'choice_end' && record.type !== 'finish') break;
            }
            if (!values.has([...source, 'name'])) throw new TypeError('Completed tool calls require a name');
            const arguments_ = values.read([...source, 'arguments'], item.arguments);
            const args: unknown = typeof arguments_ === 'string' ? parseJSONObject(arguments_, options.parseToolArguments) : arguments_;
            const value = { functionCall: { name: item.name, ...(values.has([...source, 'call_id']) ? { id: item.call_id } : {}), ...(args === undefined ? {} : { args }) } };
            if (args !== undefined) projection.assign([...source, 'arguments'], JSON.stringify(args), ['candidates', choice, 'content', 'parts', native.length, 'functionCall', 'args']);
            native.push(value); lastKind.set(choice, 'function'); emitted.add(key); yield emitPart(choice, value);
          }
          if (!closed && !streamsText(item)) break;
        }
      }
    }
    if (record.type === 'choice_end') {
      const native = parts.get(record.choice)!;
      const final = projection.result();
      const chunks: Record<string, any>[] = []; const supports: Record<string, any>[] = [];
      state.choices[record.choice].items.forEach((item, index) => {
        if (item.type !== 'message') return;
        item.content.forEach((part, p) => {
          if (part.type !== 'text') return;
          const maps = final.projections.filter(m => JSON.stringify(m.source_path) === JSON.stringify(['choices', record.choice, 'items', index, 'content', p, 'text']));
          for (const annotation of (values.read(['choices', record.choice, 'items', index, 'content', p, 'annotations'], part.annotations) ?? []).filter((a: unknown) => a !== undefined)) {
            const chunk = groundingChunk(annotation);
            const chunkIndex = chunks.length; chunks.push(chunk);
            const outputRange = annotation.output_text_range ?? { start: 0, end_exclusive: part.text.length };
            for (const map of maps) {
              const start = Math.max(map.source_start, outputRange.start); const end = Math.min(map.source_end_exclusive, outputRange.end_exclusive);
              if (end <= start) continue;
              const position = map.target_path[4] as number; const text = native[position].text as string;
              const range = { start: map.target_start + start - map.source_start, end_exclusive: map.target_start + end - map.source_start };
              const bytes = irRangeToUTF8(text, range);
              supports.push({ groundingChunkIndices: [chunkIndex], segment: { partIndex: position, startIndex: bytes.start, endIndex: bytes.end, text: text.slice(range.start, range.end_exclusive) } });
            }
          }
        });
      });
      const tokens = values.read(['choices', record.choice, 'logprobs'], state.choices[record.choice].logprobs)?.flatMap((group: { tokens: Record<string, any>[] }) => group.tokens.filter((token: unknown) => token !== undefined));
      const refusal = values.read(['choices', record.choice, 'refusal'], state.choices[record.choice].refusal);
      terminalCandidates.push({ ...(refusal?.explanation == null ? {} : { finishMessage: refusal.explanation }), index: record.choice, finishReason: record.finish_reason === 'length' ? 'MAX_TOKENS' : record.finish_reason === 'content_filter' ? 'SAFETY' : 'STOP', ...(chunks.length === 0 ? {} : { groundingMetadata: { groundingChunks: chunks, groundingSupports: supports } }), ...(tokens === undefined ? {} : { logprobsResult: { chosenCandidates: tokens.map((t: Record<string, any>) => ({ token: t.token, logProbability: t.logprob })), topCandidates: tokens.map((t: Record<string, any>) => ({ candidates: (t.top_logprobs ?? []).map((a: Record<string, any>) => ({ token: a.token, logProbability: a.logprob })) })) } }) });
    }
    if (record.type === 'finish') {
      const openaiTier = (published.extensions?.openaiResponses ?? published.extensions?.openaiChatCompletions)?.service_tier;
      const messagesUsage = published.extensions?.anthropicMessages?.usage as Record<string, any> | undefined;
      const tier = typeof openaiTier === 'string' ? openaiTier : messagesUsage?.speed === 'fast' ? 'fast' : typeof messagesUsage?.service_tier === 'string' ? messagesUsage.service_tier : undefined;
      // GenerateContent names its normal lane standard and its accelerated lane priority.
      // https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta
      const serviceTier = tier === 'fast' ? FAST_SERVICE_TIER : tier === 'default' ? 'standard' : tier;
      yield emit({ candidates: terminalCandidates, ...(usage === undefined ? {} : { usageMetadata: { ...usageFromIR(usage), ...(serviceTier === undefined ? {} : { serviceTier }) } }) });
    }
  }
};

const groundingChunk = (citation: IRSourceCitation): Record<string, any> => {
  if (citation.source_kind === 'url') return { web: { uri: citation.source, title: citation.source_label } };
  return { retrievedContext: { ...(citation.source == null ? {} : { uri: citation.source }), ...(citation.source_label == null ? {} : { title: citation.source_label }), ...(citation.source_text === undefined ? {} : { text: citation.source_text.text }), ...(citation.source_page_range === undefined ? {} : { pageNumber: citation.source_page_range.start_one_based }) } };
};
