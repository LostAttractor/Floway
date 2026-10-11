import type { IRJSONObject } from './types.ts';

export interface IRSSEOutputOptions {
  id?: string;
  created?: number;
  audioMetadata?: (choice: number) => { id: string; expires_at: number };
  parseToolArguments?: (text: string) => IRJSONObject;
}
