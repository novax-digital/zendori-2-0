// Public form types for the embed bundle + hosted page + builder preview.
// Hand-rolled (no zod in the browser bundle); the server validates with zod.

export type PublicFormFieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'consent';

export interface PublicFormField {
  key: string;
  type: PublicFormFieldType;
  label: string;
  placeholder?: string;
  required: boolean;
  options?: string[];
  maxLength?: number;
  consentText?: string;
}

export interface PublicFormDesign {
  color: string;
  radius: 'square' | 'rounded' | 'pill';
  submitLabel: string;
  title?: string;
  intro?: string;
  successMessage: string;
}

export interface PublicFormDefinition {
  fields: PublicFormField[];
  design: PublicFormDesign;
  privacyPolicyUrl?: string;
  locale: string;
}

export interface FormBootstrapResponse {
  name: string;
  definition: PublicFormDefinition;
  renderToken: string;
}

export type FormValues = Record<string, string | boolean>;
