import type { Category } from './types';

export type RequirementItem = {
  id: string;
  text: string;
  sourceMessageId: string;
  strength: 'hard' | 'soft';
  active: boolean;
  version: number;
  rule: 'min' | 'max' | 'equals' | 'not_equals' | 'preserve' | 'semantic';
  category: Category;
  field: string;
  expected: string | number;
};
export type RequirementCheck = {
  requirementId: string;
  text: string;
  strength: 'hard' | 'soft';
  status: 'pass' | 'fail' | 'unknown';
  expected: unknown;
  actual: unknown;
  evidence: unknown[];
  missingInformation: string[];
};
export type RequirementAcceptance = {
  stage: 'requirements';
  passed: boolean;
  candidateVersion: string;
  checks: RequirementCheck[];
  signature?: string;
};
