import type { AppearanceProvider } from '@annotorious/core';

export type SupabasePluginConfig = {

  apiKey: string,
  
  supabaseUrl: string,

  channel: string,

  defaultLayer?: string,

  layerIds: string | string[],

  eventsPerSecond?: number,

  appearanceProvider?: AppearanceProvider
  
}