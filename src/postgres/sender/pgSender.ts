import { type Annotation, type Annotator, diffAnnotations, Origin } from '@annotorious/core';
import type { Canvas } from '@allmaps/iiif-parser';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Emitter } from 'nanoevents';
import type { SupabaseAnnotation } from '../../SupabaseAnnotation';
import type { SupabasePluginEvents } from '../../SupabasePluginEvents';
import { parseAnnotationRecord } from './pgCrosswalk';
import type { AnnotationRecord } from '../Types';
import { pgOps } from './pgOps';

/**
 * For legacy interop. Normally, the 'source' of an annotation will be the same
 * as the current source prop provided to the plugin. However, older versions of
 * Recogito used the wrong value for the source: the derived Image API URL.
 * 
 * This means that annotations produced in an old system will get filtered out 
 * in a new system. This helper method extracts both valid 'source' URL values,
 * so that old annotations remain supported by new versions for Recogito Studio.
 */
const getValidSources = (canvas: string | Canvas): string[] => {
  if (typeof canvas === 'string') return [canvas];

  const source = canvas.uri;
  const imageURI = canvas?.image?.uri;

  // Should never happen
  if (!imageURI) return [source];

  const legacyInterop = imageURI.endsWith('info.json') 
    ? imageURI : `${imageURI.endsWith('/') ? imageURI : `${imageURI}/`}info.json`;

  return [source, legacyInterop];
}

export const createSender = (
  anno: Annotator<Annotation, Annotation>, 
  defaultLayerId: string,
  layerIds: string | string[], 
  supabase: SupabaseClient, 
  emitter: Emitter<SupabasePluginEvents>,
  source?: string | Canvas
) => {

  let privacyMode = false;

  const ops = pgOps(anno, supabase, source);

  // Queue event actions and make sure they are processed in order
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };


  // That's what Claude said - just needs tweaking if wrong
  const isDuplicateKeyError = (error: { code?: string } | null | undefined) => {
    console.log('Supabase error', error);
    return error?.code === '23505';
  }

  const onCreateAnnotation = async (a: SupabaseAnnotation) => {
    try {
      const { error } = await ops.createAnnotation(a, defaultLayerId, privacyMode);

      if (error) {
        if (isDuplicateKeyError(error)) {
          // Assuming an Undo action on a soft-deleted annotation - call restore RPC endpoint instead
          await ops.restoreAnnotation(a);
        } else {
          emitter.emit('saveError', error);
        }
      } else {
        const targetResponse = await ops.createTarget(a.target, defaultLayerId);
        if (targetResponse.error) {
          emitter.emit('saveError', targetResponse.error);
        } else {
          // Annotations don't normally have bodies when they are created through
          // the interface, but plugins might programmatically create annotations
          // with initial bodies.
          if ((a.bodies || []).length > 0) {
            await ops.upsertBodies(a.bodies, defaultLayerId).then(response => {
              if (response.error) {
                emitter.emit('saveError', response.error);
              }
            })
          }
        }
      }
    } catch (error) {
      emitter.emit('saveError', error as any);
    }
  }

  const onDeleteAnnotation = (a: Annotation) => ops.archiveAnnotation(a)
    .catch(error => {
      if (error) emitter.emit('saveError', error);
    });

  const onUpdateAnnotation = async (a: SupabaseAnnotation, previous: SupabaseAnnotation) => {
    const { 
      oldValue,
      newValue,
      bodiesCreated, 
      bodiesDeleted, 
      bodiesUpdated, 
      targetUpdated 
    } = diffAnnotations(previous, a);

    // Each step runs on its own, so one failure doesn't skip the others
    const step = async (fn: () => PromiseLike<{ error?: unknown } | void>) => {
      try {
        const res = await fn();
        if (res && res.error) emitter.emit('saveError', res.error as any);
      } catch (error) {
        emitter.emit('saveError', error as any);
      }
    };

    if (oldValue.visibility !== newValue.visibility)
      await step(() => ops.updateVisibility(newValue));

    if ((bodiesCreated?.length || 0) + (bodiesUpdated?.length || 0) > 0)
      await step(() => ops.upsertBodies([
        ...(bodiesCreated || []), 
        ...(bodiesUpdated || []).map(u => u.newBody) 
      ], a.layer_id as string));

    if (bodiesDeleted && bodiesDeleted.length > 0)
      await step(() => ops.archiveBodies(bodiesDeleted));

    if (targetUpdated)
      await step(() => ops.updateTarget(a.target));
  }

  const handlers = {
    create: (a: SupabaseAnnotation) => enqueue(() => onCreateAnnotation(a)),
    delete: (a: Annotation) => enqueue(() => onDeleteAnnotation(a)),
    update: (a: SupabaseAnnotation, prev: SupabaseAnnotation) => enqueue(() => onUpdateAnnotation(a, prev))
  };

  anno.on('createAnnotation', handlers.create);
  anno.on('deleteAnnotation', handlers.delete);
  anno.on('updateAnnotation', handlers.update);

  ops.initialLoad(layerIds).then(({ data, error }) => {
    if (error) {
      emitter.emit('initialLoadError', error);
    } else {
      const annotations = (data as unknown as AnnotationRecord[]).map(parseAnnotationRecord);

      const filteredBySource = source ? annotations.filter(a => { 
        if ('source' in a.target.selector) {
          const validSources = getValidSources(source);
          return validSources.includes(a.target.selector.source as string);
        } else {
          return false;
        }
      }) : annotations;

      // Note that we only feed annotations for this source into the Annotator state...
      anno.state.store.bulkAddAnnotations(filteredBySource, true, Origin.REMOTE);

      // ...but still pass ALL annotations upwards in the event
      emitter.emit('initialLoad', annotations);
    }
  });

  return {
    destroy: () => {
      anno.off('createAnnotation', handlers.create);
      anno.off('deleteAnnotation', handlers.delete);
      anno.off('updateAnnotation', handlers.update);
    },
    get privacyMode() {
      return privacyMode;
    },
    set privacyMode(mode: boolean) {
      privacyMode = mode;
    }
  }

}