import { ChangeSet, Origin, mergeChanges } from '@annotorious/core';
import { Annotation, Annotator, PRESENCE_KEY, StoreChangeEvent } from '@annotorious/core';
import type { RealtimeChannel } from '@supabase/realtime-js';
import type { PresenceConnector } from '../presence';
import { affectedAnnotations, apply, marshal } from './broadcastProtocol';
import { BroadcastEventType, type BroadcastMessage } from './Types';
import type { SupabaseAnnotation } from 'src/SupabaseAnnotation';

// Duration during which fast successive store changes get merged 
// with the last change, rather than triggering a broadcast message
// immedidately.
const DEBOUNCE = 100;

export const BroadcastConnector = (
  anno: Annotator<Annotation, Annotation>, 
  defaultLayerId: string,
  presence: ReturnType<typeof PresenceConnector>,
  source?: string
) => {

  let privacyMode = false;

  const { store } = anno.state;

  let observer: (event: StoreChangeEvent<Annotation>) => void  = null;

  let bufferedChanges: ChangeSet<SupabaseAnnotation>;

  let timeoutId: ReturnType<typeof setTimeout>;

  let lastMessageAt = 0;

  const onStoreChange = (channel: RealtimeChannel) => ((event: StoreChangeEvent<Annotation>) =>  {
    const send = (changes: ChangeSet<Annotation>) => {
      const message: BroadcastMessage = {
        from: { presenceKey: PRESENCE_KEY, ...anno.getUser() },
        events: marshal(changes, store, defaultLayerId, privacyMode, source),
        source
      };

      // Not all store changes trigger broadcast events - make
      // sure we only send a message when there are >0 events!
      if (message.events.length > 0) {      
        channel.send({
          type: 'broadcast',
          event: 'change',
          payload: message
        });
      }

      bufferedChanges = undefined;
      lastMessageAt = now;
    }

    const now = performance.now();

    const timeSinceLastMessage = now - lastMessageAt;

    // Merge changes with the current buffer
    bufferedChanges = bufferedChanges ? mergeChanges(bufferedChanges, event.changes) : event.changes;

    if (timeSinceLastMessage >= DEBOUNCE) {
      send({...bufferedChanges});
    } else {
      clearTimeout(timeoutId);
      
      timeoutId = setTimeout(() => {
        send({...bufferedChanges});
      }, DEBOUNCE - timeSinceLastMessage);
    }
  });

  const connect = (channel: RealtimeChannel) => {
    if (observer)
      throw 'Supabase realtime: already connected';

    // Link store change events to Supabase RT message channel
    observer = onStoreChange(channel);

    store.observe(observer, { origin: Origin.LOCAL });

    if (source) {
      channel.send({
        type: 'broadcast',
        event: 'change',
        payload: {
          from: { presenceKey: PRESENCE_KEY, ...anno.getUser() },
          events: [{ type: BroadcastEventType.CHANGE_SOURCE }],
          source
        }
      });
    }

    // Listen to RT channel broadcast events
    channel.on('broadcast', { event: 'change' }, event => {
      const { from, events, source: activitySource } = event.payload as BroadcastMessage;

      // console.log('[Broadcast Rx]', { from, events, source });

      // Apply the change event to the store
      if (!source || activitySource === source)
        events.forEach(event => apply(store, event, source));

      // Notify presence state about user activity
      presence.notifyActivity(from, affectedAnnotations(events), activitySource);
    });
  }

  return {
    connect,
    destroy: () => observer && store.unobserve(observer),
    get privacyMode() {
      return privacyMode;
    },
    set privacyMode(mode: boolean) {
      privacyMode = mode;
    }
  }

}