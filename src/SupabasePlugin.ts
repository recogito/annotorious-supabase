import { createNanoEvents } from 'nanoevents';
import { PRESENCE_KEY, PresentUser, User } from '@annotorious/core';
import type { Annotator } from '@annotorious/core';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import type { SupabasePluginConfig } from './SupabasePluginConfig';
import type { SupabasePluginEvents } from './SupabasePluginEvents';
import { BroadcastConnector } from './broadcast';
import { PostgresConnector } from './postgres';
import { PresenceConnector } from './presence';
import type { SupabaseAnnotation } from './SupabaseAnnotation';

export const SupabasePlugin = (anno: Annotator<SupabaseAnnotation, SupabaseAnnotation>, config: SupabasePluginConfig) => {

  const emitter = createNanoEvents<SupabasePluginEvents>();

  const { apiKey, supabaseUrl, eventsPerSecond } = config;

  const defaultLayerId = config.defaultLayer || 
    Array.isArray(config.layerIds) ? config.layerIds[0] : config.layerIds;

  // Create Supabase client
  const supabase = createClient(supabaseUrl, apiKey, {
    realtime: {
      params: {
        eventsPerSecond: eventsPerSecond || 20,
      }
    }
  });

  // Set up channel and connectors for each channel type
  let channel: RealtimeChannel = null;
  
  const presence = PresenceConnector(anno, config.appearanceProvider, emitter);

  const broadcast = BroadcastConnector(anno, defaultLayerId, presence, config.source);
  
  const postgres = PostgresConnector(anno, defaultLayerId, config.layerIds, supabase, presence, emitter, config.source);

  // Creates the channel and inits all connectors
  const init = () => {
    channel = supabase.channel(config.channel, {
      config: {
        presence: {
          key: PRESENCE_KEY
        }
      }
    });

    presence.connect(channel);
    broadcast.connect(channel);
    postgres.connect(channel);

    channel.subscribe(status => {
      if (status === 'SUBSCRIBED')
        presence.trackUser();
    });  
  }

  // Will check if user is logged in, and fail otherwise
  const connect = () => new Promise<User>((resolve, reject) => {
    if (channel)
      reject('Connection already established');

    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) {
        supabase 
          .from('profiles')
          .select(`
            id,
            first_name,
            last_name,
            nickname,
            avatar_url
          `)
          .eq('id', data.user.id)
          .single()
          .then(({ error, data }) => {
            if (error) {
              console.error(error);
              reject('No profile found');
            } else {              
              const { id, nickname, first_name, last_name } = data;

              let name: string;

              // Prefer nickname
              if (nickname)
                name = nickname;
              // Otherwise, take full name (first, last)
              else if (first_name && last_name)
                name = `${first_name} ${last_name}`;
              // Or any of them, if only one is available
              else
                name = first_name || last_name;

              // Update Annotorious identity with Supabase identity
              anno.setUser({ id, name, avatar: data.avatar_url });

              init();

              resolve(anno.getUser());
            }
          });
      } else {
        reject('No credentials - user signed out.');
      }
    });

    supabase.auth.onAuthStateChange((event,session) => {
      if (event === 'USER_UPDATED') {
        const hasChanged = anno.getUser().id !== session.user.id;
        if (hasChanged) {
          anno.setUser({
            id: session.user.id
          });

          presence.trackUser(); 
        }
      }
    });

    anno.setPresenceProvider({ on });
  });

  const on = <E extends keyof SupabasePluginEvents>(event: E, callback: SupabasePluginEvents[E]) =>
    emitter.on(event, callback);

  const destroy = () => {
    presence?.destroy();
    broadcast?.destroy();
    postgres?.destroy();

    if (channel)
      supabase.removeChannel(channel);
  }

  return {
    auth: supabase.auth,
    connect,
    destroy,
    on,
    get privacyMode() {
      if (broadcast.privacyMode !== postgres.privacyMode)
        throw 'Fatal privacy mode integrity error. Should never happen';

      return broadcast.privacyMode;
    },
    set privacyMode(mode: boolean) {
      broadcast.privacyMode = mode;
      postgres.privacyMode = mode;
    }
  }

}

export const isMe = (user: PresentUser) => user.presenceKey === PRESENCE_KEY;
