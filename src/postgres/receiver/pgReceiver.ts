import { type Annotator, Origin } from '@annotorious/core';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import type { Canvas } from '@allmaps/iiif-parser';
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
  source?: string | Canvas
) => {

  const { store } = anno.state;

  /**
   * Motivations from annotation INSERTs, keyed by annotation ID. The annotation
   * record arrives before its target, but the annotation only gets added to the
   * store once the target arrives (see onInsertTarget).
   */
  const motivations = new Map<string, string>();

  /**
   * After INSERT and UPDATE ANNOTATION:
   * - Store the motivation (if any) until the target arrives.
   * - Note that this could potentially create unnecessary/stale entries
   *   on annotation UPDATE events. But annotation records rarely 
   *   update - unless the get unarchived!
   */
  const onUpsertAnnotation = (event: AnnotationChangeEvent) => {
    const { id, motivation } = event.new;
    if (motivation)
      motivations.set(id, motivation);
  }

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
        if ((existingBody.version ?? 0) < version) {
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

    const motivation = motivations.get(annotation_id);
    motivations.delete(annotation_id);

    const annotation = store.getAnnotation(annotation_id);
    if (!annotation) {
      const target = resolveTargetChange(event, presence.getPresentUsers());

      // Ignore targets created by myself. Note that, normally, targets created by 
      // self would mean that there's already an annotation. Thus, we wouldn't usually
      // reach this branch. HOWEVER: there is one edge case where the user creates
      // an annotation and then instantly deletes it again. In this case, the store
      // won't have the annotation anymore when this onInsertTarget handler is triggered
      // from the Supabase event.
      // See https://github.com/performant-software/vico/issues/351
      if (target.creator?.id === anno.getUser().id) return;

      const sourceURI = source ? typeof source === 'string' ? source : source?.uri : undefined;
      const shouldInsert = !source || (target.selector as any)['source'] === sourceURI;

      if (shouldInsert) {
        store.addAnnotation({
          id: annotation_id,
          bodies: [],
          target,
          layer_id: event.new.layer_id,
          motivation
        }, Origin.REMOTE);
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
      if ((annotation.target.version ?? 0) < version) {
        // console.log('[PGCDC] Overriding target');
        store.updateTarget(resolveTargetChange(event, presence.getPresentUsers(), annotation), Origin.REMOTE);
      }
    } else {
      // Target update for annotation that doesn't exist? Could be an un-archived annotation.
      onInsertTarget(event);
    }
  }

  const onEvent = (evt: RealtimePostgresChangesPayload<ChangeEvent>) => {
    const event = evt as unknown as ChangeEvent;
    const { table, eventType } = event;

    if (table === 'annotations' && (eventType === 'INSERT' || eventType === 'UPDATE')) {
      onUpsertAnnotation(event);
    } else if (table === 'annotations' && eventType === 'DELETE') {
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