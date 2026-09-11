import type { Draft } from '../../agent/conversation-state';

export function clearComputedSelection(draft: Draft): Draft {
  const next = { ...draft };
  delete next.partSelections;
  delete next.selectionSources;
  delete next.selectionConfirmationMessageIds;
  return next;
}
