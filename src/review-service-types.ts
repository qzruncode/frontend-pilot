import type { ReviewJob, ReviewProgressEvent } from "./contracts.js";

export type ProgressListener = (event: ReviewProgressEvent) => void;

export interface ReviewCiBinding {
  jobId: string;
  pipelineId: string;
  jobUrl: string;
  tokenHash: string;
}

export interface InternalJob extends ReviewJob {
  key: string;
  ciBinding: ReviewCiBinding | null;
  controller: AbortController | null;
  progressSequence: number;
  listeners: Set<ProgressListener>;
  suppressProgressNotes?: boolean;
}
