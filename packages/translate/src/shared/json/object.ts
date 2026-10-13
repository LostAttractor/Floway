import { rawJSON } from './raw-json.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

const parseJSON = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return rawJSON.rawJSON(context!.source);
  return value;
});

export const parseJSONObject = (text: string): Record<string, unknown> => {
  const value = parseJSON(text);
  if (!isJsonObject(value) || rawJSON.isRawJSON(value)) throw new TypeError('Tool arguments require a JSON object');
  return value;
};

export const parseStrictJsonObject = (json: string, subject: string): Record<string, unknown> => {
  if (!json) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Upstream ${subject} was not valid JSON.`, {
      cause: error,
    });
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Upstream ${subject} must be a JSON object.`);
  }

  return parsed;
};
