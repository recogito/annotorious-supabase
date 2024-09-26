import { Annotation, createPresenceState, PRESENCE_KEY } from '@annotorious/core';
import type { Annotator, User } from '@annotorious/core';
import type { RealtimeChannel } from '@supabase/realtime-js';
import type { Emitter } from 'nanoevents';
import type { SupabasePluginEvents } from '../SupabasePluginEvents';
import type { SelectEvent } from './Types';
import type { AppearanceProvider } from '@annotorious/core';

export const PresenceConnector = (
  anno: Annotator<Annotation, Annotation>, 
  appearanceProvider: AppearanceProvider, 
  emitter: Emitter<SupabasePluginEvents>,
  source?: string
) => {

  let channel: RealtimeChannel;

  const presence = createPresenceState(appearanceProvider);

  // Forward presence events
  presence.on('presence', users => emitter.emit('presence', users));
  presence.on('selectionChange', (from, selection) => emitter.emit('selectionChange', from, selection));

  const trackUser = () => {    
    if (channel)
      channel.track({ user: anno.getUser() });
  }

  const connect = (c: RealtimeChannel) => {
    channel = c;

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<{ user: User }>();
      
      const presentUsers = Object.entries(state).map(([presenceKey, state]) => ({
        presenceKey, user: state[0].user
      }));
      
      presence.syncUsers(presentUsers);
    });

    // Link selection events to Supabase RT message channel
    anno.on('selectionChanged', selection => {      
      const event: SelectEvent = {
        from: { presenceKey: PRESENCE_KEY, ...anno.getUser() },
        ids: selection && selection.length > 0 ? selection.map(a => a.id) : null,
        source
      };

      setTimeout(() => {
        channel.send({
          type: 'broadcast',
          event: 'select',
          payload: event
        });
      }, 10);
    });

    channel.on('broadcast', { event: 'select' }, event => {
      const { from, ids, source: activitySource } = (event.payload as SelectEvent);

      if ((!source || (source === activitySource)) && from.presenceKey !== PRESENCE_KEY)
        presence.updateSelection(from.presenceKey, ids);
      else 
        emitter.emit('offPageActivity', { source: activitySource, user: from });
    });
  }

  const notifyActivity = (user: User & { presenceKey: string }, annotationIds: string[], activitySource?: string) => {
    if (source && source !== activitySource)
      emitter.emit('offPageActivity', { source: activitySource, user });
    else
      presence.notifyActivity(user.presenceKey, annotationIds);
  }

  return {
    connect,
    getPresentUsers: presence.getPresentUsers,
    destroy: () => channel && channel.untrack(),
    notifyActivity,
    trackUser
  }

}