import { selectionImageDistance, type SelectionImageFeatures } from "./image-search-features.js";

type FeedbackExample = {
  rowId: string; imageId: string; imageUrl: string; features: SelectionImageFeatures;
  positiveCount: number; negativeCount: number;
};
type LearningEvidence = { similarity: number; confirmations: number; conflicted: boolean };
const imageKey = (rowId: string, id: string, url: string) => JSON.stringify([rowId, id, url]);

/** Case-based comparisons only; confirmation counts never inflate a visual score. */
export function selectionImageLearningEvidence(query: SelectionImageFeatures, feedback: { examples: FeedbackExample[]; rejected: FeedbackExample[] }) {
  const evidence = new Map<string, LearningEvidence>();
  const conflictedRows = new Set<string>(), confirmationsByRow = new Map<string, number>();
  for (const example of feedback.rejected) {
    if ((1 - selectionImageDistance(query, example.features)) * 100 <= 90) continue;
    conflictedRows.add(example.rowId);
  }
  for (const example of feedback.examples) {
    const similarity = (1 - selectionImageDistance(query, example.features)) * 100;
    if (similarity <= 90) continue;
    const key = imageKey(example.rowId, example.imageId, example.imageUrl), prior = evidence.get(key);
    if (conflictedRows.has(example.rowId) || example.negativeCount > 0) continue;
    confirmationsByRow.set(example.rowId, (confirmationsByRow.get(example.rowId) || 0) + example.positiveCount);
    evidence.set(key, { similarity: Math.max(prior?.similarity || 0, similarity), confirmations: 0, conflicted: false });
  }
  return (candidate: { rowId: string; image: { id: string; url: string } }): LearningEvidence => ({
    similarity: evidence.get(imageKey(candidate.rowId, candidate.image.id, candidate.image.url))?.similarity || 0,
    confirmations: confirmationsByRow.get(candidate.rowId) || 0,
    conflicted: conflictedRows.has(candidate.rowId),
  });
}

/** At least two independent confirmations, strong image agreement and a clear lead. */
export function canFocusSelectionImageMatch(matches: { imageSimilarity: number; confirmations: number; conflicted: boolean }[]) {
  const first = matches[0], second = matches[1];
  return !!first && first.confirmations >= 2 && !first.conflicted && first.imageSimilarity >= 98 &&
    (!second || first.imageSimilarity - second.imageSimilarity >= 2);
}
