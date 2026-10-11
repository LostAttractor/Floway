import type { IRCollector } from './collector.ts';
import type { IRSSEOutputOptions } from './sse-output-options.ts';
import type { IREvent } from './stream.ts';
import { createJSONPathIndex } from '../shared/json/path-index.ts';

export const irOutputMetadata = (event: Extract<IREvent, { type: 'start' }>, options: IRSSEOutputOptions) => ({
  id: options.id ?? event.id,
  model: event.model,
  created: event.created ?? options.created ?? Math.floor(Date.now() / 1000),
});

export const createIRMetadataReader = () => {
  let extensionVersion = -1;
  let usageVersion = -1;
  let extensions: any;
  let usage: any;
  const fields = createJSONPathIndex<{ version: number; value: any }>();
  return (collector: IRCollector): { extensions: any; usage: any } => {
    const nextExtensionVersion = collector.version(['extensions']);
    const nextUsageVersion = collector.version(['usage']);
    if (extensionVersion !== nextExtensionVersion) {
      extensions = collector.within(['extensions']) ? Object.fromEntries(Object.keys(collector.state.extensions!).filter(protocol => collector.within(['extensions', protocol])).map(protocol => {
        const source = (collector.state.extensions as Record<string, any>)[protocol];
        const properties = Object.keys(source).filter(key => (protocol !== 'openaiResponses' || key !== 'item_ids') && collector.within(['extensions', protocol, key])).map(key => {
          const path = ['extensions', protocol, key];
          const version = collector.version(path);
          let field = fields.get(path);
          if (field?.version !== version) { field = { version, value: collector.read(path) }; fields.set(path, field); }
          return [key, field.value];
        });
        return [protocol, Object.fromEntries(properties)];
      })) : undefined;
      extensionVersion = nextExtensionVersion;
    }
    if (usageVersion !== nextUsageVersion) { usage = collector.read(['usage']); usageVersion = nextUsageVersion; }
    return { extensions, usage };
  };
};
