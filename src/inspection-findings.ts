import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isInspectionFindingCompleted, type InspectionFinding, type InspectionJiraLink, type InspectionRun } from "./contracts.js";
import type { ReviewFinding } from "./review-prompt.js";
import type { InspectionStore } from "./inspection-store.js";
import { InspectionDuplicateDecisionSchema, type InspectionDuplicateInput, type InspectionDuplicateDecision } from "./inspection-duplicates.js";

export type InspectionFindingContext = Pick<InspectionRun,
  "id" | "projectId" | "branch" | "headSha" | "createdAt" | "maintainerId" | "maintainerName" | "operatorId" | "operatorName">;
export interface TrackedInspectionFinding {
  context: InspectionFindingContext;
  ruleId: string | null;
  codeFingerprint: string | null;
  finding: InspectionFinding & { tracking: NonNullable<InspectionFinding["tracking"]> };
}

class InspectionDuplicateCandidateError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export class InspectionDuplicateUncertainError extends InspectionDuplicateCandidateError {
  constructor(reason: string) {
    super(reason);
    this.name = "InspectionDuplicateUncertainError";
  }
}

export class InspectionDuplicateInvalidAssociationError extends InspectionDuplicateCandidateError {
  constructor(reason: string) {
    super(reason);
    this.name = "InspectionDuplicateInvalidAssociationError";
  }
}

export function findingFingerprint(finding: ReviewFinding): string {
  return digest([normalizeFindingPath(finding.path), finding.line ?? "", finding.category, finding.issue]);
}

export function normalizeFindingPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/").replace(/^\.\//, ""));
}

function digest(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

// Like SARIF primaryLocationLineHash, use source text and its occurrence rather
// than the absolute line number or generated prose. Repeated statements stay distinct.
export function sourceFingerprint(lines: string[] | null, line: number | null): string | null {
  if (!lines || !line) return null;
  const text = lines[line - 1]?.trim();
  if (!text || !/[\p{L}\p{N}_]/u.test(text) || /^(\/\/|\/\*|\*|#)/.test(text)) return null;
  const occurrence = lines.slice(0, line).filter((candidate) => candidate.trim() === text).length;
  return digest([text, occurrence]);
}

function sameScope(left: InspectionFindingContext, right: InspectionFindingContext): boolean {
  return left.projectId === right.projectId && left.branch === right.branch
    && (left.maintainerId ?? null) === (right.maintainerId ?? null);
}

function preferredRecord(records: TrackedInspectionFinding[], context: InspectionFindingContext): TrackedInspectionFinding | undefined {
  const priority = ({ finding }: TrackedInspectionFinding): number => finding.jira.status !== "created" ? 2
    : isInspectionFindingCompleted(finding) ? 1 : 0;
  // If old versions created duplicates, continue the retained open Jira instead of creating another.
  return [...records].sort((a, b) => priority(a) - priority(b)
    || Number(!sameScope(a.context, context)) - Number(!sameScope(b.context, context))
    || a.finding.tracking.firstSeenAt.localeCompare(b.finding.tracking.firstSeenAt)
    || a.finding.tracking.id.localeCompare(b.finding.tracking.id))[0];
}

export class InspectionFindingTracker {
  private readonly records = new Map<string, TrackedInspectionFinding>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: InspectionStore) {
    for (const record of store.loadTrackedFindings()) this.records.set(record.finding.tracking.id, record);
    // Backfill all retained history, including runs outside the UI's loading limit.
    for (const run of store.loadFindingHistory()) {
      if (!run.result) continue;
      let changed = false;
      const findings = new Map([...run.result.findings, ...run.result.ruleResults.flatMap((rule) => rule.findings)]
        .map((finding) => [finding.fingerprint, finding]));
      for (const finding of findings.values()) {
        if (finding.tracking && this.records.has(finding.tracking.id)) continue;
        const ruleId = run.result.ruleResults.find((rule) => rule.findings.some((item) => item.fingerprint === finding.fingerprint))?.ruleId ?? null;
        const prior = [...this.records.values()].find((record) => sameScope(record.context, run)
          && record.ruleId === ruleId && findingFingerprint(record.finding) === findingFingerprint(finding));
        const tracked = this.record(run, ruleId, finding, null, prior);
        for (const copy of [...run.result.findings, ...run.result.ruleResults.flatMap((rule) => rule.findings)]) {
          if (copy.fingerprint === finding.fingerprint) {
            copy.tracking = { ...tracked.tracking };
            copy.jira = { ...tracked.jira };
          }
        }
        changed = true;
      }
      if (changed) store.saveFindingHistory(run.id, run.result);
    }
  }

  list(): TrackedInspectionFinding[] { return [...this.records.values()]; }

  get(id: string, maintainerId?: string | null): TrackedInspectionFinding | undefined {
    const record = this.records.get(id);
    return record && (maintainerId === undefined || record.context.maintainerId === maintainerId) ? record : undefined;
  }

  saveJira(id: string, jira: InspectionJiraLink, maintainerId?: string | null): void {
    const record = this.records.get(id);
    if (!record || maintainerId !== undefined && record.context.maintainerId !== maintainerId) return;
    record.finding.jira = { ...jira };
    this.store.saveTrackedFinding(record);
  }

  track(context: InspectionFindingContext, ruleId: string | null, finding: InspectionFinding, options: {
    readLines: (ref: string, filePath: string) => Promise<string[] | null>;
    resolveDuplicates: (input: InspectionDuplicateInput) => Promise<InspectionDuplicateDecision>;
    authorizeLegacy: (finding: InspectionFinding) => Promise<boolean>;
    validate: () => void;
  }): Promise<InspectionFinding> {
    const task = this.pending.then(async () => {
      options.validate();
      const codeFingerprint = context.headSha && finding.line
        ? sourceFingerprint(await options.readLines(context.headSha, finding.path), finding.line) : null;
      const candidates = this.list().filter((record) => record.context.projectId === context.projectId
        && record.context.branch === context.branch && (record.ruleId === ruleId || !record.ruleId || !ruleId)
        && record.context.maintainerId === context.maintainerId
        && normalizeFindingPath(record.finding.path) === normalizeFindingPath(finding.path));
      const related: TrackedInspectionFinding[] = [];
      for (const record of candidates) {
        if (codeFingerprint && !record.codeFingerprint && record.context.headSha) {
          record.codeFingerprint = sourceFingerprint(await options.readLines(record.context.headSha, record.finding.path), record.finding.line);
          options.validate();
          this.store.saveTrackedFinding(record);
        }
        const fileScope = finding.scope === "file" || finding.scope === "cross_file"
          || record.finding.scope === "file" || record.finding.scope === "cross_file";
        const sameLocation = fileScope || (codeFingerprint && record.codeFingerprint
          ? codeFingerprint === record.codeFingerprint : finding.line === record.finding.line);
        if (!sameLocation) continue;
        if (!sameScope(record.context, context) && !await options.authorizeLegacy(record.finding)) continue;
        options.validate();
        related.push(record);
      }
      let matches = related.filter((record) => findingFingerprint(record.finding) === findingFingerprint(finding));
      if (related.length !== matches.length) {
        matches = [];
        for (let start = 0; start < related.length; start += 20) {
          const batch = related.slice(start, start + 20);
          const decision = InspectionDuplicateDecisionSchema.parse(await options.resolveDuplicates({
            ruleId, finding,
            candidates: batch.map((record) => ({ id: record.finding.tracking.id, ruleId: record.ruleId, finding: record.finding })),
          }));
          options.validate();
          const ids = new Set(decision.duplicateIds);
          if (decision.status === "uncertain") throw new InspectionDuplicateUncertainError(decision.reason);
          if ((decision.status === "matched") !== (ids.size > 0)
            || ids.size !== decision.duplicateIds.length || [...ids].some((id) => !batch.some((record) => record.finding.tracking.id === id))
            || batch.some((record) => findingFingerprint(record.finding) === findingFingerprint(finding) && !ids.has(record.finding.tracking.id))) {
            throw new InspectionDuplicateInvalidAssociationError(
              `status=${decision.status}，返回关联 ${decision.duplicateIds.join(",") || "空"}，候选范围 ${batch.map((record) => record.finding.tracking.id).join(",")}`,
            );
          }
          matches.push(...batch.filter((record) => ids.has(record.finding.tracking.id)));
        }
      }
      if (new Set(matches.map((record) => record.finding.jira.key).filter(Boolean)).size > 1) {
        const readable: TrackedInspectionFinding[] = [];
        for (const record of matches) {
          // Legacy links were checked above; refresh owned links too when choosing among old duplicates.
          if (!sameScope(record.context, context) || await options.authorizeLegacy(record.finding)) readable.push(record);
          options.validate();
        }
        if (!readable.some((record) => record.finding.jira.status === "created")) throw new Error("已有重复工单的状态暂时无法核对，已停止建单。");
        matches = readable;
      }
      const prior = preferredRecord(matches, context);
      options.validate();
      return this.record(context, ruleId, finding, codeFingerprint, prior);
    });
    this.pending = task.catch(() => undefined);
    return task;
  }

  private record(context: InspectionFindingContext, ruleId: string | null, finding: InspectionFinding,
    codeFingerprint: string | null, prior?: TrackedInspectionFinding): InspectionFinding & { tracking: NonNullable<InspectionFinding["tracking"]> } {
    const sameOwner = prior && sameScope(prior.context, context);
    const previous = prior?.finding.tracking;
    const tracked = {
      ...finding,
      tracking: {
        id: sameOwner
          ? previous!.id
          : finding.tracking?.id && !this.records.has(finding.tracking.id) ? finding.tracking.id : randomUUID(),
        firstSeenAt: previous?.firstSeenAt ?? context.createdAt,
        lastSeenAt: previous && previous.lastSeenAt > context.createdAt ? previous.lastSeenAt : context.createdAt,
        occurrenceCount: (previous?.occurrenceCount ?? 0) + (prior?.context.id === context.id ? 0 : 1),
      },
      jira: { ...(finding.jira.status === "created" ? finding.jira : prior?.finding.jira.status === "created" ? prior.finding.jira : finding.jira) },
    };
    const record: TrackedInspectionFinding = {
      context: { id: context.id, projectId: context.projectId, branch: context.branch, headSha: context.headSha, createdAt: context.createdAt,
        maintainerId: context.maintainerId, maintainerName: context.maintainerName, operatorId: context.operatorId, operatorName: context.operatorName },
      ruleId: ruleId ?? prior?.ruleId ?? null, codeFingerprint: codeFingerprint ?? prior?.codeFingerprint ?? null, finding: structuredClone(tracked),
    };
    this.records.set(tracked.tracking.id, record);
    this.store.saveTrackedFinding(record);
    return tracked;
  }
}
