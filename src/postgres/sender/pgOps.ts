import { Origin } from '@annotorious/core';
import type { Canvas } from '@allmaps/iiif-parser';
import type { Annotation, AnnotationBody, Annotator, AnnotationTarget } from '@annotorious/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PostgrestBuilder, PostgrestSingleResponse } from '@supabase/postgrest-js';
import { 
  type SupabaseAnnotation, 
  type SupabaseAnnotationBody, 
  type SupabaseAnnotationTarget, 
  Visibility 
} from '../../SupabaseAnnotation';

export const pgOps = (
  anno: Annotator<Annotation, Annotation>, 
  supabase: SupabaseClient,
  source?: string | Canvas
) => {

  const { store } = anno.state;

  const sourceURI = typeof source === 'string' ? source : source?.uri;

  // Generic Supabase retry handler
  const withRetry = async (requestFn: () => PostgrestBuilder<{ [x: string]: any}[]>, retries: number = 3) => {
    return new Promise<PostgrestSingleResponse<{ [x: string]: any}[]>>((resolve, reject) => {
      const doRequest = () => requestFn().then(response => {
        if (response.error || !(response.data?.length > 0)) {
          if (retries > 0) {
            retries--;
            console.warn('[PG] Supbase save error - retrying');
            setTimeout(doRequest, 250);
          } else {
            reject('Too many retries');
          }
        } else {
          resolve(response);
        } 
      });

      doRequest();
    });
  }

  const initialLoad = (layerIds: string | string[]) => {
    const query = supabase
      .from('annotations')
      .select(`
        id,
        layer_id,
        is_private,
        targets!inner ( 
          annotation_id,
          created_at,
          created_by:profiles!targets_created_by_fkey(
            id,
            nickname,
            first_name,
            last_name,
            avatar_url
          ),
          updated_at,
          updated_by:profiles!targets_updated_by_fkey(
            id,
            nickname,
            first_name,
            last_name,
            avatar_url
          ),
          version,
          value
        ),
        bodies ( 
          id,
          annotation_id,
          created_at,
          created_by:profiles!bodies_created_by_fkey(
            id,
            nickname,
            first_name,
            last_name,
            avatar_url
          ),
          updated_at,
          updated_by:profiles!bodies_updated_by_fkey(
            id,
            nickname,
            first_name,
            last_name,
            avatar_url
          ),
          version,
          format,
          purpose,
          value
        )
      `)
      .not('targets.value', 'is', null)

    return Array.isArray(layerIds) ?
      query.in('layer_id', layerIds) :
      query.eq('layer_id', layerIds);
  }

  const createAnnotation = (a: SupabaseAnnotation, layer_id: string, is_private: boolean) => {
    const versioned: SupabaseAnnotation = {
      ...a,
      target: {
        ...a.target,
        version: 1
      },
      visibility: is_private ? Visibility.PRIVATE : undefined,
      layer_id
    };

    if (source)
      versioned.target.selector['source'] = sourceURI;

    store.updateAnnotation(versioned, Origin.REMOTE);
    
    return supabase
      .from('annotations')
      .insert({
        id: a.id,
        created_at: new Date(),
        created_by: anno.getUser().id,
        layer_id,
        is_private
      });
  }

  const createTarget = (t: AnnotationTarget, layer_id: string) => {
    const selector = source ? {
      ...t.selector,
      source: sourceURI
    } : t.selector;

    return supabase
      .from('targets')
      .insert({
        created_at: t.created,
        created_by: anno.getUser().id,
        updated_at: t.created,
        updated_by: anno.getUser().id,
        annotation_id: t.annotation,
        value: JSON.stringify(selector),
        layer_id
      });
  }
  
  /** 
   * We're calling the 'archive_record_rpc' manually here, so we
   * can set the 'keepalive' flag, and make sure the request gets
   * executed, even if the user closes the browser tab.
   */
  const archiveAnnotation = (a: Annotation) =>
    supabase.auth.getSession().then(({ data }) => {
      const { access_token } = data.session;

      // @ts-ignore
      const { supabaseUrl, supabaseKey } = supabase;

      const url = `${supabaseUrl}/rest/v1/rpc/archive_record_rpc`;

      const payload = {
        _table_name: 'annotations',
        _id: a.id
      };

      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Apikey': supabaseKey,
          'Authorization': `Bearer ${access_token}`
        },
        body: JSON.stringify(payload),
        keepalive: true // important!
      });
    })

  const archiveBodies = (bodies: AnnotationBody[]): Promise<void> => {

    const archiveOne = (b: AnnotationBody): Promise<void> =>
      new Promise((resolve, reject) => {
        supabase
          .rpc('archive_record_rpc', {
            _table_name: 'bodies',
            _id: b.id
          })
          .then(({ error }) => {
            if (error)
              reject(error);
            else
              resolve(undefined);
          });
        });

    return bodies.reduce((promise, body) =>
      promise.then(() => archiveOne(body)), Promise.resolve());
  }

  const updateVisibility = (a: SupabaseAnnotation) => supabase
    .from('annotations')
    .update({
      is_private: a.visibility === Visibility.PRIVATE
    })
    .eq('id', a.id);

  const updateTarget = (t: SupabaseAnnotationTarget) => {
    // Edge cases (related to auto-rollback of empt annotations)
    // can lead to situations where annotation is deleted 
    // before the update event is processed.
    const exists = store.getAnnotation(t.annotation);
    if (exists) {
      const versioned = {
        ...t,
        version: t.version ? t.version + 1 : 1
      };

      if (source)
        versioned.selector['source'] = sourceURI;

      store.updateTarget(versioned, Origin.REMOTE);

      return withRetry(() => supabase
        .from('targets')
        .update({
          updated_at: versioned.updated,
          updated_by: anno.getUser().id,
          value: JSON.stringify(versioned.selector)
        })
        .eq('annotation_id', versioned.annotation)
        .select());
    } else {
      return Promise.resolve({ error: undefined });
    }
  }
  
  const upsertBodies = (bodies: SupabaseAnnotationBody[], layer_id: string) => {
    const versioned = bodies.map(b => ({
      ...b,
      version: b.version ? b.version + 1 : 1
    }));

    store.bulkUpdateBodies(versioned, Origin.REMOTE);

    return supabase
      .from('bodies')
      .upsert(versioned.map(b => ({
        id: b.id,
        created_at: b.created,
        created_by: b.creator.id,
        updated_at: b.created,
        updated_by: anno.getUser().id,
        annotation_id: b.annotation,
        format: b.format,
        purpose: b.purpose,
        value: b.value,
        layer_id
      })));
  }

  return {
    archiveAnnotation,
    archiveBodies,
    createAnnotation,
    createTarget,
    initialLoad,
    updateTarget,
    updateVisibility,
    upsertBodies
  }

}
