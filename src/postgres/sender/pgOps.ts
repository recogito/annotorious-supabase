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
  const withRetry = async (requestFn: () => PostgrestBuilder<Record<string, string>, { [x: string]: any}[], false>, retries: number = 3) => {
    return new Promise<PostgrestSingleResponse<{ [x: string]: any}[]>>((resolve, reject) => {
      const doRequest = () => Promise.resolve(requestFn()).then(response => {
        if (response.error) {
          if (retries > 0) {
            retries--;
            console.warn('[PG] Supabase save error - retrying');
            setTimeout(doRequest, 250);
          } else {
            reject('Too many retries');
          }
        } else if (!(response.data?.length > 0)) {
          // Row deleted or hidden by RLS (archived): retrying won't help
          console.warn('[PG] PG update affected no rows');
          resolve(response);
        } else {
          resolve(response);
        } 
      }).catch(reject);

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
        motivation,
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
      (versioned.target.selector as any).source = sourceURI;

    store.updateAnnotation(versioned, Origin.REMOTE);
    
    return supabase
      .from('annotations')
      .insert({
        id: a.id,
        created_at: new Date(),
        created_by: anno.getUser().id,
        layer_id,
        is_private,
        motivation: a.motivation
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

  const callRPC = async (endpoint: string, payload: Record<string, unknown>) => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error('[annotorious-supabase] Auth session missing');

    // @ts-ignore
    const { supabaseUrl, supabaseKey } = supabase;
    const url = `${supabaseUrl}/rest/v1/rpc/${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Apikey': supabaseKey,
        'Authorization': `Bearer ${data.session.access_token}`
      },
      body: JSON.stringify(payload),
      keepalive: true // important!
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));      
      throw Object.assign(new Error(body.message ?? `RPC call to ${endpoint} failed with status ${response.status}`), {
        status: response.status,
        code: body.code
      });
    }

    return response;
  }
  
  /** 
   * We're calling the 'archive_record_rpc' manually here, so we
   * can set the 'keepalive' flag, and make sure the request gets
   * executed, even if the user closes the browser tab.
   */
  const archiveAnnotation = (a: Annotation) => callRPC('archive_record_rpc', {      
    _table_name: 'annotations',
    _id: a.id
  });

  const restoreAnnotation = (a: Annotation, bodies?: AnnotationBody[]) => callRPC('restore_annotation_rpc', {
    _annotation_id: a.id,
    _body_ids: bodies ?? (a.bodies || []).map(b => b.id)
  });  

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
        (versioned.selector as any).source = sourceURI;

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
        created_by: b.creator?.id,
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
    restoreAnnotation,
    updateTarget,
    updateVisibility,
    upsertBodies
  }

}
