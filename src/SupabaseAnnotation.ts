import type { Annotation, AnnotationBody, AnnotationTarget } from '@annotorious/core';

export interface SupabaseAnnotation extends Annotation {

  target: SupabaseAnnotationTarget;

  bodies: SupabaseAnnotationBody[];

  layer_id?: string;

  visibility?: Visibility;

}

export interface SupabaseAnnotationTarget extends AnnotationTarget {

  version?: number;

}

export interface SupabaseAnnotationBody extends AnnotationBody {

  version?: number;

}

export type Visibility = string;

export const Visibility = (value: string) => value;

Visibility.PRIVATE = 'PRIVATE';