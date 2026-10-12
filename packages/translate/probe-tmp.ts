import { collect, iterate } from './__tests__/ir/helpers.ts';
import { irFromOpenAIChatCompletions } from './src/protocols/openai-chat-completions/as-target/sse-from.ts';
import { openaiResponsesFromIR } from './src/protocols/openai-responses/as-source/sse-to.ts';
import { openaiChatCompletionsFromIR } from './src/protocols/openai-chat-completions/as-source/sse-to.ts';
import { anthropicMessagesFromIR } from './src/protocols/anthropic-messages/as-source/sse-to.ts';
import { geminiGenerateContentFromIR } from './src/protocols/gemini-generate-content/as-source/sse-to.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const main = async () => {
  const native = [
    eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', created: 5, choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } } as any),
    eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', created: 5, choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } as any),
    eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', created: 5, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any),
    doneFrame(),
  ];
  const irFrames = await collect(irFromOpenAIChatCompletions(iterate(native as any[])));
  console.log('IR records:', JSON.stringify(irFrames.flatMap(frame => frame.records)));
  for (const [name, writer] of [['chat', openaiChatCompletionsFromIR], ['responses', openaiResponsesFromIR], ['messages', anthropicMessagesFromIR], ['gemini', geminiGenerateContentFromIR]] as const) {
    try {
      const out = await collect((writer as any)(iterate(irFrames)));
      console.log(name, 'OK', out.filter(frame => frame.type === 'event').length, 'events');
    } catch (error) { console.log(name, 'THREW:', (error as Error).message); }
  }
};

void main().catch(error => { console.error(error); process.exit(1); });
