import { InspectionAiPreReviewSchema, ReviewProgressEventSchema, type InspectionAiPreReview } from "./api-contracts.js";
import type { ReviewProgressEvent, ReviewProgressInput } from "./contracts.js";

const MAX_PROGRESS_EVENTS = 200;
const MAX_PROGRESS_TEXT = 4_000;

export interface PreSubmitReviewProgressRecorder {
  readonly initial: InspectionAiPreReview;
  readonly events: ReviewProgressEvent[];
  readonly onProgress: (event: ReviewProgressInput) => void;
}

export function createPreSubmitReviewProgressRecorder(input: {
  taskId: string;
  attempt: number;
  diffSha: string;
  getPhase: () => string;
  update: (patch: { phase: string; preReview: InspectionAiPreReview }) => void;
}): PreSubmitReviewProgressRecorder {
  let sequence = 0;
  let events: ReviewProgressEvent[] = [];
  const snapshot = (): InspectionAiPreReview => InspectionAiPreReviewSchema.parse({
    status: "pending",
    report: null,
    feedback: null,
    diffSha: input.diffSha,
    attempt: input.attempt,
    blockingFindingCount: 0,
    unmetRequirementCount: 0,
    missingRequirementCount: 0,
    unclearRequirementCount: 0,
    progress: events,
  });
  const onProgress = (event: ReviewProgressInput): void => {
    const reviewEvent = ReviewProgressEventSchema.parse({
      id: `${input.taskId}:pre-review:${input.attempt}:${++sequence}`,
      at: new Date().toISOString(),
      ...event,
      message: event.message.slice(0, MAX_PROGRESS_TEXT),
      detail: event.detail == null ? event.detail : event.detail.slice(0, MAX_PROGRESS_TEXT),
    });
    events = [...events, reviewEvent].slice(-MAX_PROGRESS_EVENTS);
    const phase = ["stage", "result", "warning", "error"].includes(event.kind)
      ? event.detail?.trim() ? `${event.message}：${event.detail.trim()}` : event.message
      : input.getPhase();
    input.update({ phase, preReview: snapshot() });
  };
  return {
    get initial() { return snapshot(); },
    get events() { return events; },
    onProgress,
  };
}
