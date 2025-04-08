import type { Canvas } from '@allmaps/iiif-parser';
import type { AppearanceProvider } from '@annotorious/core';

export type SupabasePluginConfig = {

  appearanceProvider?: AppearanceProvider

  apiKey: string,

  channel: string,

  defaultLayer?: string,

  eventsPerSecond?: number,

  layerIds: string | string[],
  
  source?: string;

  // @deprecated
  canvases?: Canvas[];

  supabaseUrl: string,
  
}