import { Origin } from '@annotorious/core';
import type { Annotation, ChangeSet, Store, StoreChangeEvent } from '@annotorious/core';
import { BroadcastEventType } from './Types';
import type { BroadcastEvent, CreateAnnotationEvent } from './Types';
import { SupabaseAnnotation, Visibility } from '../SupabaseAnnotation';

/**
 * Returns a list of unique IDs of annotations that are 
 * affected the list of events.
 */
export const affectedAnnotations = (events: BroadcastEvent[]) => {
  const affectedAnnotations = events.reduce((annotationIds, e) => {
    if (e.type === BroadcastEventType.CREATE_ANNOTATION) {
      return [...annotationIds, e.annotation.id];
    } else if (e.type === BroadcastEventType.CREATE_BODY) {
      return [...annotationIds, e.body.annotation];
    } else if (e.type === BroadcastEventType.DELETE_BODY) {
      return [...annotationIds, e.annotation];
    } else if (e.type === BroadcastEventType.UPDATE_BODY) {
      return [...annotationIds, e.body.annotation];
    } else if (e.type === BroadcastEventType.UPDATE_TARGET) {
      return [...annotationIds, e.target.annotation];
    }
  }, [] as string[]);

  // Unique IDs only
  return Array.from(new Set(affectedAnnotations));
}

export const marshal = (
  changes: ChangeSet<SupabaseAnnotation>, 
  store: Store<Annotation>,
  defaultLayerId: string,
  privacyMode: boolean,
  source?: string
): BroadcastEvent[] => {
  // Don't broadcast create events while in private mode
  const created = privacyMode ? [] : changes.created || [];

  // Don't broadcast delete events for private annotations
  const deleted = (changes.deleted || [])
    .filter(a => a.visibility !== Visibility.PRIVATE);

  // Don't broadcast updates for private annotations
  const updated = (changes.updated || [])
    .filter(({ newValue }) => newValue.visibility !== Visibility.PRIVATE);

  const createAnnotationEvents: BroadcastEvent[] =
    created.map(annotation => {
      const event: BroadcastEvent = {
        type: BroadcastEventType.CREATE_ANNOTATION, 
        annotation: {
          ...annotation,
          target: {
            ...annotation.target,
            version: 1
          },
          layer_id: defaultLayerId
        }
      };

      if (source)
        event.annotation.target.selector['source'] = source;

      return event;
    });

  const makeAnnotationPublicEvents: BroadcastEvent[] = updated
    // Keep only updates that have neither body nor 
    .filter(update => 
      update.oldValue.visibility === Visibility.PRIVATE &&
      !update.newValue.visibility)
    .reduce((all, update) => ([
      ...all,
      {
        type: BroadcastEventType.CREATE_ANNOTATION,
        annotation: update.newValue
      }
    ]), [] as BroadcastEvent[]);

  const deleteAnnotationEvents: BroadcastEvent[] = deleted.map(annotation =>
    ({ type: BroadcastEventType.DELETE_ANNOTATION, id: annotation.id }));

  const deleteBodyEvents: BroadcastEvent[] = updated
    .filter(update => update.bodiesDeleted?.length > 0)
    .reduce((all, update) => ([
      ...all, 
      ...update.bodiesDeleted.map(body => ({ 
        type: BroadcastEventType.DELETE_BODY, 
        id: body.id, 
        annotation: body.annotation 
      }))]
    ), []);

  const updateTargetEvents: BroadcastEvent[] = updated
    .filter(update => update.targetUpdated)
    .reduce((all, update) => ([
      ...all,
      { type: BroadcastEventType.UPDATE_TARGET, target: update.targetUpdated.newTarget }
    ]), []);

  // Apply version updates to the store
  const createdTargets = 
    createAnnotationEvents.map(evt => (evt as CreateAnnotationEvent).annotation.target);

  if (createdTargets.length > 0)
    store.bulkUpdateTargets(createdTargets, Origin.REMOTE);

  return [
    ...createAnnotationEvents,
    ...makeAnnotationPublicEvents,
    ...deleteAnnotationEvents,
    ...deleteBodyEvents,
    ...updateTargetEvents
  ];
}

const reviveDateFields = (obj: any, keyOrKeys: string | string[]) => {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [ keyOrKeys ];

  keys.forEach(key => {
    if (obj[key])
      obj[key] = new Date(obj[key]);
  });

  return obj;
}

const reviveDates = (event: BroadcastEvent) => {
  if (event.type === BroadcastEventType.CREATE_ANNOTATION) {
    return { 
      ...event,
      annotation: {
        ...event.annotation,
        target: reviveDateFields(event.annotation.target, ['created', 'updated']),
        bodies: event.annotation.bodies.map(b => reviveDateFields(b, ['created', 'updated']))
      }
    }
  } else if (event.type === BroadcastEventType.CREATE_BODY || event.type === BroadcastEventType.UPDATE_BODY) {
    return {
      ...event,
      body: reviveDateFields(event.body, ['created', 'updated'])
    }
  } else if (event.type === BroadcastEventType.UPDATE_TARGET) {
    return  {
      ...event,
      target: reviveDateFields(event.target, ['created', 'updated'])
    }
  } else {
    return event;
  }
}
  
export const apply = (store: Store<Annotation>, event: BroadcastEvent, source?: string) => {
  const e = reviveDates(event);

  if (e.type === BroadcastEventType.CREATE_ANNOTATION) {
    const shouldAdd = !source || e.annotation.target.selector.source === source;
    if (shouldAdd)
      store.addAnnotation(e.annotation, Origin.REMOTE);
  } else if (e.type === BroadcastEventType.DELETE_ANNOTATION) {
    store.deleteAnnotation(e.id, Origin.REMOTE);
  } else if (e.type === BroadcastEventType.CREATE_BODY) {
    store.addBody(e.body, Origin.REMOTE);
  } else if (e.type === BroadcastEventType.DELETE_BODY) {
    store.deleteBody({ id: e.id, annotation: e.annotation }, Origin.REMOTE);
  } else if (e.type === BroadcastEventType.UPDATE_BODY) {
    const { id, annotation } = e.body;
    store.updateBody({ id, annotation }, e.body, Origin.REMOTE);
  } else if (e.type === BroadcastEventType.UPDATE_TARGET) {
    store.updateTarget(e.target, Origin.REMOTE);
  }
}
