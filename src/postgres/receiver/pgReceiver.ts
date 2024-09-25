import { Annotator, Origin } from '@annotorious/core';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import type { Emitter } from 'nanoevents';
import type { SupabaseAnnotation } from '../../SupabaseAnnotation';
import type { PresenceConnector } from '../../presence';
import type { SupabasePluginEvents } from '../../SupabasePluginEvents';
import type { AnnotationChangeEvent, BodyChangeEvent, ChangeEvent, TargetChangeEvent } from '../Types';
import { resolveBodyChange, resolveTargetChange } from './pgCDCMessageResolver';

export const createReceiver = (
  anno: Annotator<SupabaseAnnotation, SupabaseAnnotation>, 
  layerIds: string | string[], 
  channel: RealtimeChannel, 
  presence: ReturnType<typeof PresenceConnector>, 
  emitter: Emitter<SupabasePluginEvents>,
  source?: string
) => {

  const { store } = anno.state;

  /**
   * After DELETE ANNOTATION:
   * - Check if annotation exists.
   * - Delete if it does.
   */
  const onDeleteAnnotation = (event: AnnotationChangeEvent) => {
    const { id } = event.old;

    const annotation = store.getAnnotation(id);
    if (annotation) {
      store.deleteAnnotation(id, Origin.REMOTE);
    }
  }

  /**
   * After INSERT BODY:
   * - Check if annotation exists.
   * - If it does not: throw INTEGRITY ERROR if it does not.
   * - If it does: check if body exists.
   * - If it does: update if different.
   * - If it does not: insert.
   */
  const onUpsertBody = (event: BodyChangeEvent) => {
    const { annotation_id, id, version } = event.new;

    const annotation = store.getAnnotation(annotation_id);

    if (annotation) {
      const existingBody = annotation.bodies.find(b => b.id === id);

      if (existingBody) {
        if (existingBody.version < version) {
          store.updateBody(existingBody, resolveBodyChange(event, presence.getPresentUsers(), annotation), Origin.REMOTE);
        }
      } else {
        // Body doesn't exist - add
        store.addBody(resolveBodyChange(event, presence.getPresentUsers(), annotation), Origin.REMOTE);
      }
    } else {
      emitter.emit('integrityError', 'Attempt to upsert body on missing annotation: ' + annotation_id);
    }
  }

  /**
   * After DELETE BODY:
   * - Check if body exists.
   * - Delete if it does.
   */
  const onDeleteBody = (event: BodyChangeEvent) => {
    const body = store.getBody(event.old.id);
    if (body) {
      store.deleteBody(body, Origin.REMOTE);
    }
  }

  /** 
   * After INSERT TARGET:
   * 1. check if annotation exists.
   * 2. if it doesn't: create annotation with target.
   */
  const onInsertTarget = (event: TargetChangeEvent) => {
    const { annotation_id, value } = event.new;

    if (!value) 
      return; // Discard annotations without a target selector

    const annotation = store.getAnnotation(annotation_id);
    if (!annotation) {
      const target = resolveTargetChange(event, presence.getPresentUsers());
  
      const shouldInsert = !source || target.selector['source'] === source;
      if (shouldInsert) {
        store.addAnnotation({
          id: annotation_id,
          bodies: [],
          target,
          layer_id: event.new.layer_id
        }, Origin.REMOTE);
      } else {
        const source: string = target.selector['source'];
        const user = target.creator!;
        emitter.emit('offPageActivity', { source, user })
      }
    }
  }

  /** 
   * After UPDATE TARGET:
   * 1. check if annotation exists.
   * 2. update target if different.
   * 
   * Throw integrity error if annotation does not exist.
   */
  const onUpdateTarget = (event: TargetChangeEvent) => {
    const { annotation_id, version } = event.new;

    const annotation = store.getAnnotation(annotation_id);
    if (annotation) {
      if (annotation.target.version < version) {
        console.log('[PGCDC] Overriding target');
        store.updateTarget(resolveTargetChange(event, presence.getPresentUsers(), annotation), Origin.REMOTE);
      }
    } else {
      // emitter.emit('integrityError', 'Attempt to update target on missing annotation: ' + annotation_id);
    }
  }

  const onEvent = (evt: RealtimePostgresChangesPayload<ChangeEvent>) => {
    const event = evt as unknown as ChangeEvent;
    const { table, eventType } = event;

    if (table === 'annotations' && eventType === 'DELETE') {
      onDeleteAnnotation(event);
    } else if (table === 'bodies' && eventType === 'INSERT') {
      onUpsertBody(event);
    } else if (table === 'bodies' && eventType === 'UPDATE') {
      onUpsertBody(event);
    } else if (table === 'bodies' && eventType === 'DELETE') {
      onDeleteBody(event);
    } else if (table === 'targets' && eventType === 'INSERT') {
      onInsertTarget(event);
    } else if (table === 'targets' && eventType === 'UPDATE') {
      onUpdateTarget(event);
    }  
  }

  const filter = Array.isArray(layerIds) ? 
    layerIds.length === 1 ? `layer_id=eq.${layerIds[0]}` : 
    `layer_id=in.(${layerIds.join(', ')})` :
    `layer_id=eq.${layerIds}`;

  channel
    .on<ChangeEvent>(
     'postgres_changes', 
      { 
        event: '*', 
        schema: 'public',
        table: 'annotations',
        filter
      }, 
      onEvent
    )
    .on(
      'postgres_changes', 
       { 
         event: '*', 
         schema: 'public',
         table: 'targets',
         filter
       }, 
       onEvent
     )
     .on(
      'postgres_changes', 
       { 
         event: '*', 
         schema: 'public',
         table: 'bodies',
         filter
       }, 
       onEvent
     ); 

}