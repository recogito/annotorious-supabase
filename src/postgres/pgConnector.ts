import type { RealtimeChannel } from '@supabase/realtime-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Annotation, Annotator } from '@annotorious/core';
import type { Emitter } from 'nanoevents';
import type { SupabasePluginEvents } from '../SupabasePluginEvents';
import type { PresenceConnector } from '../presence';
import { createReceiver } from './receiver';
import { createSender } from './sender';

export const PostgresConnector = (
  anno: Annotator<Annotation, Annotation>, 
  defaultLayerId: string,
  layerIds: string | string[], 
  supabase: SupabaseClient, 
  presence: ReturnType<typeof PresenceConnector>, 
  emitter: Emitter<SupabasePluginEvents>,
  source?: string
) => {

  let privacyMode = false;

  let sender: ReturnType<typeof createSender> | undefined;

  let receiver: ReturnType<typeof createReceiver> | undefined;

  const connect = (channel: RealtimeChannel) => {
    sender = createSender(anno, defaultLayerId, layerIds, supabase, emitter, source);
    sender.privacyMode = privacyMode;

    receiver = createReceiver(anno, layerIds, channel, presence, emitter, source);
  }

  return {
    connect,
    destroy: () => {
      sender?.destroy();
    },
    get privacyMode() {
      if (sender && sender.privacyMode !== privacyMode)
        throw 'Fatal privacy mode integrity error. Should never happen';

      return privacyMode;
    },
    set privacyMode(mode: boolean) {
      privacyMode = mode;

      if (sender)
        sender.privacyMode = mode;
    }
  }

}