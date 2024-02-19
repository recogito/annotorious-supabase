import type { AnnotationBody, User } from '@annotorious/core';
import type { AnnotationRecord, BodyRecord, ProfileRecord, TargetRecord } from '../Types';
import { 
  SupabaseAnnotation, 
  SupabaseAnnotationBody, 
  SupabaseAnnotationTarget, 
  Visibility
} from '../../SupabaseAnnotation';

export const parseProfileRecord = (p: ProfileRecord | undefined): User => p ? ({
  id: p.id,
  name: p.nickname,
  avatar: p.avatar_url
}) : undefined;

export const parseBodyRecord = (body: BodyRecord): SupabaseAnnotationBody => ({
  id: body.id,
  annotation: body.annotation_id,
  format: body.format,
  purpose: body.purpose,
  value: body.value,
  creator: parseProfileRecord(body.created_by),
  created: new Date(body.created_at),
  updatedBy: parseProfileRecord(body.updated_by),
  updated: body.updated_at ? new Date(body.updated_at) : null,
  version: body.version
});

const patchLegacyTextSelector = (selector: any): any => {
  if (Array.isArray(selector))
    return selector; // All is well

  if (selector.quote)
    // Text selector that's NOT an array!
    return [selector];

  // Nothing to patch
  return selector;
}

export const parseTargetRecord = (target: TargetRecord): SupabaseAnnotationTarget => ({
  annotation: target.annotation_id,
  selector: patchLegacyTextSelector(JSON.parse(target.value)),
  creator: parseProfileRecord(target.created_by),
  created: new Date(target.created_at),
  updatedBy: parseProfileRecord(target.created_by),
  updated: target.updated_at ? new Date(target.updated_at) : null,
  version: target.version
});

export const parseAnnotationRecord = (record: AnnotationRecord): SupabaseAnnotation => {
  // Fatal integrity issue
  if (record.targets.length === 0)
    throw { message: 'Invalid annotation: target missing', record };

  // Integrity error (but not fatal)
  if (record.targets.length > 1)
    console.warn('Invalid annotation: too many targets', record);

  const bodies: AnnotationBody[] = record.bodies.map(parseBodyRecord);

  return {
    id: record.id,
    target: parseTargetRecord(record.targets[0]),
    bodies,
    visibility: record.is_private && Visibility.PRIVATE,
    layer_id: record.layer_id
  };
}
