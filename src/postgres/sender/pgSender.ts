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

  const onCreateAnnotation = (a: SupabaseAnnotation) => ops.createAnnotation(a, defaultLayerId, privacyMode)
    .then(({ error }) => {
      if (error) {
        emitter.emit('saveError', error);
      } else {
        ops.createTarget(a.target, defaultLayerId).then(response => {
          if (response.error) {
            emitter.emit('saveError', response.error);
          }
        });
      }
    });

  const onDeleteAnnotation = (a: Annotation) => ops.archiveAnnotation(a)
    .catch(error => {
      if (error)
        emitter.emit('saveError', error);
    });

  const onUpdateAnnotation = (a: SupabaseAnnotation, previous: SupabaseAnnotation) => {
    const { 
      oldValue,
      newValue,
      bodiesCreated, 
      bodiesDeleted, 
      bodiesUpdated, 
      targetUpdated 
    } = diffAnnotations(previous, a);

    // Check if annotation visibility has changed
    const oldVisibility = oldValue.visibility;
    const newVisibility = newValue.visibility;

    if (oldVisibility !== newVisibility) {
      ops.updateVisibility(newValue).then(({ error }) => {
        if (error)
          emitter.emit('saveError', error);
      });
    }

    if ((bodiesCreated?.length || 0) + (bodiesUpdated?.length || 0) > 0) {
      ops.upsertBodies([
        ...(bodiesCreated || []), 
        ...(bodiesUpdated || []).map(u => u.newBody) 
      // @ts-ignore
      ], a.layer_id).then(({ error }) => {
        if (error)
          emitter.emit('saveError', error);
      });
    }

    if (bodiesDeleted?.length > 0) {
      ops.archiveBodies(bodiesDeleted)
        .catch(error => {
          emitter.emit('saveError', error);
        });
    }

    if (targetUpdated) {
      ops.updateTarget(a.target).then(response => {
        if (response.error)
          emitter.emit('saveError', response.error);
      });
    }
  }

  anno.on('createAnnotation', onCreateAnnotation);
  anno.on('deleteAnnotation', onDeleteAnnotation);
  anno.on('updateAnnotation', onUpdateAnnotation);

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
      anno.off('createAnnotation', onCreateAnnotation);
      anno.off('deleteAnnotation', onDeleteAnnotation);
      anno.off('updateAnnotation', onUpdateAnnotation);
    },
    get privacyMode() {
      return privacyMode;
    },
    set privacyMode(mode: boolean) {
      privacyMode = mode;
    }
  }

}