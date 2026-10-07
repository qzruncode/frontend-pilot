import { InspectionAiAction, type InspectionAiSource } from "./inspection-ai-action";
import { InspectionBatchActionDialog, InspectionFindingOwner, InspectionOwnershipEvidence, hasInspectionFindingOwner } from "./inspection-assignment";
import { useIntegrationApi } from "./integration-api-context";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FileCode2,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Ticket,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { isInspectionFindingCompleted, shortenInspectionFindingTitle } from "@contracts";
import type {
  GitLabMergeRequestCreateOptions,
  GitLabProjectConfig,
  InspectionFinding,
  InspectionProject,
  InspectionPromptProfile,
  InspectionPromptRule,
  InspectionRun,
  JiraCreateIssueOption,
  JiraIssue,
  JiraIssueDetails,
  JiraIssueTransition,
  UpsertInspectionProjectInput,
} from "@contracts";
import {
  createInspectionRule,
  createInspectionJira,
  cancelInspectionRun,
  deleteInspectionRun,
  deleteInspectionRule,
  getInspectionRun,
  getInspectionRules,
  listInspectionProjects,
  listInspectionRuns,
  reorderInspectionRules,
  resolveInspectionFindingOwner,
  resolveInspectionRunOwners,
  retryInspectionRun,
  saveInspectionRule,
  saveInspectionProject,
  startInspection,
  subscribeToInspectionEvents,
  type GitLabOAuthStatus,
} from "./api";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import { errorMessage, mergeProgressEvents } from "./review-ui-utils";
import { GitLabOAuthDrawer } from "./assistant-gitlab-oauth";
import { JiraAccountDrawer } from "./assistant-jira-account";
import { GitLabMetric, GitLabProjectList } from "./gitlab-workbench-components";
import { GitLabSearchableSelect } from "./gitlab-searchable-select";
import { JiraMultiOptionPicker } from "./jira-create-issue-pickers";
import { JiraCreateIssueDrawer } from "./jira-create-issue-drawer";
import { JiraIssueDetailPanel } from "./jira-workbench-components";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { ReviewListRow } from "./review-list";
import { PromptRuleDialog, RuleList, type PromptRuleDialogMode } from "./review-rule-editors";
import { displayProfileName } from "./review-rule-utils";
import { ASSISTANT_ROUTE_PATHS, INSPECTION_CONFIG_ROUTE, inspectionConfigPath } from "./assistant-navigation-state";

type InspectionWorkbenchPageProps = {
  maintainerId: string;
  maintainerName: string;
  sessionReady: boolean;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

type InspectionTab = "overview" | "projects" | "runs" | "findings";
type FindingFilter = "pending" | "all" | "blocking" | "jira" | "done";
const ALL_INSPECTION_RULES = "__all_inspection_rules__";

type FormState = {
  branch: string;
  findingLimit: string;
  enabled: boolean;
  scheduleEnabled: boolean;
  scheduleCron: string;
  jiraMode: InspectionProject["jiraMode"];
  jiraComponent: string;
  jiraFixVersion: string;
};

type InspectionJiraOptions = {
  components: JiraCreateIssueOption[];
  fixVersions: JiraCreateIssueOption[];
};

type FindingEntry = {
  finding: InspectionFinding;
  run: InspectionRun;
};

const DEFAULT_FORM: FormState = {
  branch: "main",
  findingLimit: "",
  enabled: true,
  scheduleEnabled: false,
  scheduleCron: "0 0 * * *",
  jiraMode: "manual",
  jiraComponent: "",
  jiraFixVersion: "",
};

const INSPECTION_TABS: Array<{ id: InspectionTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "projects", label: "项目配置", icon: GitBranch },
  { id: "runs", label: "巡检记录", icon: ListChecks },
  { id: "findings", label: "问题清单", icon: Ticket },
];

function profileForProject(project: GitLabProjectConfig | null, profiles: InspectionPromptProfile[]): InspectionPromptProfile | null {
  if (!project) return null;
  return profiles.find((profile) => profile.name === project.pathWithNamespace)
    ?? profiles.find((profile) => profile.isDefault)
    ?? null;
}

function enabledPromptCount(profile: InspectionPromptProfile | null): number {
  return profile?.rules.filter((rule) => rule.enabled).length ?? 0;
}

type InspectionPromptDraft = Pick<InspectionPromptRule, "name" | "description" | "enabled" | "content">;

const EMPTY_INSPECTION_PROMPT: InspectionPromptDraft = {
  name: "",
  description: "",
  enabled: true,
  content: "",
};

function inspectionPromptDraft(rule: InspectionPromptRule): InspectionPromptDraft {
  return {
    name: rule.name,
    description: rule.description,
    enabled: rule.enabled,
    content: rule.content,
  };
}

function formFromProject(project: GitLabProjectConfig, config: InspectionProject | undefined): FormState {
  if (!config) return { ...DEFAULT_FORM, branch: project.defaultBranch || "main" };
  return {
    branch: config.branch,
    findingLimit: config.findingLimit === null ? "" : String(config.findingLimit),
    enabled: config.enabled,
    scheduleEnabled: config.scheduleEnabled,
    scheduleCron: config.scheduleCron,
    jiraMode: config.jiraMode,
    jiraComponent: config.jiraComponent ?? "",
    jiraFixVersion: config.jiraFixVersion ?? "",
  };
}

function parseFindingLimit(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("问题发现数量必须是大于等于 1 的整数，留空表示不限制。");
  return parsed;
}

function statusLabel(status: InspectionRun["status"]): string {
  return ({ queued: "排队中", running: "巡检中", completed: "已完成", failed: "失败", canceled: "已取消" })[status] ?? status;
}

function statusClass(status: InspectionRun["status"]): string {
  return `inspection-status-${status}`;
}

function isTerminalInspectionStatus(status: InspectionRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function hasInspectionJiraConfiguration(config: InspectionProject | undefined): boolean {
  return Boolean(config && config.jiraMode !== "off" && config.jiraComponent?.trim() && config.jiraFixVersion?.trim());
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function findingList(run: InspectionRun): InspectionFinding[] {
  if (!run.result) return [];
  const items = [...run.result.findings, ...run.result.ruleResults.flatMap((rule) => rule.findings)];
  return [...new Map(items.map((finding) => [finding.fingerprint, finding])).values()];
}

function isBlockingFinding(finding: InspectionFinding, run: InspectionRun): boolean {
  const blockingSeverities = run.result?.blockingSeverities?.map((severity) => severity.toLowerCase());
  return blockingSeverities?.includes(finding.severity.toLowerCase()) ?? ["critical", "high"].includes(finding.severity.toLowerCase());
}

function needsOwnerConfirmation(finding: InspectionFinding): boolean {
  return finding.jira.status !== "created" && !hasInspectionFindingOwner(finding);
}

function InspectionFindingStatus({ finding }: { finding: InspectionFinding }) {
  const completed = isInspectionFindingCompleted(finding);
  const statusTitle = [
    finding.jira.issueStatus ? `Jira：${finding.jira.issueStatus}` : null,
    finding.jira.aiResolutionStatus === "merged" ? "AI 修复 MR：已合并" : null,
    finding.jira.aiResolutionStatus === "reverted" ? "AI 修复 MR：已回滚" : null,
  ].filter(Boolean).join(" · ") || undefined;
  return <span className={`inspection-finding-state${completed ? " is-completed" : ""}`} title={statusTitle}>
    {completed ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{completed ? "已完成" : "待处理"}
  </span>;
}

function inspectionRunSummary(run: InspectionRun): { findingCount: number; blockingCount: number; matchedRuleCount: number; ruleCount: number } {
  const findings = findingList(run);
  const rules = run.result?.ruleResults ?? [];
  return {
    findingCount: findings.length,
    blockingCount: findings.filter((finding) => isBlockingFinding(finding, run)).length,
    matchedRuleCount: rules.filter((rule) => rule.findings.length > 0).length,
    ruleCount: rules.length,
  };
}

function inspectionProgressDetail(event: InspectionRun["progress"][number], run: InspectionRun): string | null {
  if (event.kind === "result" && run.result) {
    const summary = inspectionRunSummary(run);
    return `${summary.findingCount} 个问题 · ${run.result.gate === "passed" ? "门禁通过" : "需要关注"}`;
  }
  return event.detail ?? null;
}

function mergeInspectionFinding(run: InspectionRun, event: InspectionRun["progress"][number]): InspectionRun {
  const nextRun = { ...run, progress: mergeProgressEvents(run.progress, [event]) };
  if (event.kind !== "finding" || !event.finding) return nextRun;
  const current = run.result ?? {
    format: "structured" as const,
    summary: "巡检正在执行，已确认的问题会逐条记录。",
    ruleFindingCount: 0,
    findingCount: 0,
    headSha: run.headSha,
    ruleResults: [],
    findings: [],
  };
  const finding = [...current.findings, ...current.ruleResults.flatMap((rule) => rule.findings)]
    .find((candidate) => candidate.fingerprint === event.finding!.fingerprint) ?? event.finding;
  const ruleId = typeof event.meta?.inspectionRuleId === "string" ? event.meta.inspectionRuleId : null;
  const ruleResultsWithExistingRule = current.ruleResults.map((rule) => rule.ruleId !== ruleId || rule.findings.some((candidate) => candidate.fingerprint === finding.fingerprint)
    ? rule
    : { ...rule, findings: [...rule.findings, finding] });
  const ruleResults = ruleId && !ruleResultsWithExistingRule.some((rule) => rule.ruleId === ruleId)
    ? [...ruleResultsWithExistingRule, {
      ruleId,
      ruleName: typeof event.meta?.inspectionRuleName === "string" ? event.meta.inspectionRuleName : ruleId,
      conclusion: "巡检中",
      findings: [finding],
    }]
    : ruleResultsWithExistingRule;
  const ruleFindings = [...new Map(ruleResults.flatMap((rule) => rule.findings).map((candidate) => [candidate.fingerprint, candidate])).values()];
  const findings = [...new Map([...(ruleId ? current.findings : [...current.findings, finding]), ...ruleFindings].map((candidate) => [candidate.fingerprint, candidate])).values()];
  const blocking = findings.filter((candidate) => ["critical", "high"].includes(candidate.severity.toLowerCase()));
  return {
    ...nextRun,
    result: {
      ...current,
      ruleResults,
      findings: ruleId ? current.findings : findings,
      ruleFindingCount: ruleFindings.length,
      findingCount: findings.length,
      blockingFindingCount: blocking.length,
      blockingSeverities: [...new Set(blocking.map((candidate) => candidate.severity))],
    },
  };
}

function findingSortWeight(severity: string): number {
  return ({ critical: 4, high: 3, medium: 2, low: 1 })[severity.toLowerCase()] ?? 0;
}

function inspectionSeverityLabel(severity: string): string {
  return ({ critical: "严重", high: "高", medium: "中", low: "低" })[severity.toLowerCase()] ?? severity;
}

function InspectionState({ icon, title, detail, action, className }: { icon: ReactNode; title: string; detail: string; action?: ReactNode; className?: string }) {
  return <div className={["inspection-state", className].filter(Boolean).join(" ")} role="status"><span className="inspection-state-icon">{icon}</span><strong>{title}</strong><span>{detail}</span>{action}</div>;
}

function InspectionStatusBadge({ status }: { status: InspectionRun["status"] }) {
  return <span className={`inspection-status-badge ${statusClass(status)}`}><i aria-hidden="true" />{statusLabel(status)}</span>;
}

function InspectionFindingJiraActions({ finding, run, onResolveOwner, onCreateJira, onOpenJira, ownerBusy, jiraBusy, jiraConfigured }: {
  finding: InspectionFinding;
  run: InspectionRun;
  onResolveOwner: (run: InspectionRun, finding: InspectionFinding) => void;
  onCreateJira: (run: InspectionRun, finding: InspectionFinding) => void;
  onOpenJira: (key: string, url?: string | null, source?: InspectionAiSource) => void;
  ownerBusy: boolean;
  jiraBusy: boolean;
  jiraConfigured: boolean;
}) {
  const jira = finding.jira;
  const jiraConfigurationMissing = !jiraConfigured && jira.status !== "created";
  const ownerNeedsConfirmation = needsOwnerConfirmation(finding);
  return <div className="inspection-jira-actions">
    {jira.status === "created" && jira.key ? <><Button variant="ghost" size="sm" type="button" className="inspection-jira-link" onClick={() => onOpenJira(jira.key!, jira.url, { runId: run.id, findingId: finding.id })}><Ticket aria-hidden="true" />{jira.key}</Button>{jira.url && <a href={jira.url} target="_blank" rel="noreferrer" aria-label={`在 Jira 打开 ${jira.key}`}><ExternalLink aria-hidden="true" /></a>}</> : <>
      {ownerNeedsConfirmation && <Button variant="outline" size="sm" type="button" className="inspection-confirm-owner" disabled={ownerBusy || jiraBusy || !isTerminalInspectionStatus(run.status)} onClick={() => onResolveOwner(run, finding)} title={!isTerminalInspectionStatus(run.status) ? "巡检完成后才能确认负责人" : "调用 AI 确认负责人，不会创建 Jira"}><UserRound aria-hidden="true" className={ownerBusy ? "is-spinning" : ""} />{ownerBusy ? "确认中…" : "确认负责人"}</Button>}
      <Button variant="outline" size="sm" type="button" className="inspection-create-jira" disabled={jiraBusy || ownerBusy || run.status !== "completed" || jiraConfigurationMissing || ownerNeedsConfirmation} onClick={() => onCreateJira(run, finding)} title={ownerNeedsConfirmation ? "请先确认负责人，再创建 Jira" : jiraConfigurationMissing ? "请先完成 Jira 模块和修复版本配置" : "只创建 Jira，不会重新判断负责人"}><Ticket aria-hidden="true" />{ownerNeedsConfirmation ? "请先确认负责人" : jiraConfigurationMissing ? "待配置 Jira" : jira.status === "failed" ? "重试创建 Jira" : "创建 Jira"}</Button>
    </>}
  </div>;
}

function FindingCard({ finding, run, onResolveOwner, onCreateJira, onOpenJira, onOpenRun, onOpenDetail, ownerBusy, jiraBusy, jiraConfigured }: {
  finding: InspectionFinding;
  run: InspectionRun;
  onResolveOwner: (run: InspectionRun, finding: InspectionFinding) => void;
  onCreateJira: (run: InspectionRun, finding: InspectionFinding) => void;
  onOpenJira: (key: string, url?: string | null, source?: InspectionAiSource) => void;
  onOpenRun?: (run: InspectionRun) => void;
  onOpenDetail: () => void;
  ownerBusy: boolean;
  jiraBusy: boolean;
  jiraConfigured: boolean;
}) {
  const jira = finding.jira;
  const severity = finding.severity.toLowerCase();
  const title = shortenInspectionFindingTitle(finding.issue, finding.path, finding.line);
  const showJiraError = Boolean(jira.error && jira.status !== "created");
  return <article className={`inspection-finding-card inspection-finding-${severity}`}>
    <div className="inspection-finding-heading">
      <span className={`inspection-severity inspection-severity-${severity}`}>{inspectionSeverityLabel(finding.severity)}</span>
      <InspectionFindingStatus finding={finding} />
      <span className="inspection-finding-category">{finding.category}</span>
      <code><FileCode2 aria-hidden="true" />{finding.path}{finding.line ? `:${finding.line}` : ""}</code>
    </div>
    <button className="inspection-finding-content-trigger" type="button" aria-label={`查看问题详情：${title}`} onClick={onOpenDetail}>
      <span className="inspection-finding-issue" title={finding.issue}>{title}</span>
      {finding.suggestion && <span className="inspection-finding-description" title={finding.suggestion}>{finding.suggestion}</span>}
    </button>
    <div className="inspection-finding-source"><span>{run.projectName}</span><span>{run.branch}</span><span>{formatTime(run.finishedAt ?? run.createdAt)}</span>{finding.tracking && <span title={`首次发现：${formatTime(finding.tracking.firstSeenAt)}`}>{finding.tracking.occurrenceCount > 1 ? `持续发现 · ${finding.tracking.occurrenceCount} 次巡检` : "首次发现"}</span>}{onOpenRun && <Button variant="ghost" size="sm" type="button" onClick={() => onOpenRun(run)}>查看巡检</Button>}</div>
    <div className="inspection-finding-footer">
      <InspectionFindingOwner finding={finding} />
      <InspectionFindingJiraActions finding={finding} run={run} onResolveOwner={onResolveOwner} onCreateJira={onCreateJira} onOpenJira={onOpenJira} ownerBusy={ownerBusy} jiraBusy={jiraBusy} jiraConfigured={jiraConfigured} />
    </div>
    {showJiraError && <small className="inspection-jira-error">{jira.error}</small>}
    {jira.syncError && <small className="inspection-jira-error">{jira.syncError}</small>}
  </article>;
}

function InspectionFindingDetailContent({ finding, run, onResolveOwner, onCreateJira, onOpenJira, onOpenRun, ownerBusy, jiraBusy, jiraConfigured }: {
  finding: InspectionFinding;
  run: InspectionRun;
  onResolveOwner: (run: InspectionRun, finding: InspectionFinding) => void;
  onCreateJira: (run: InspectionRun, finding: InspectionFinding) => void;
  onOpenJira: (key: string, url?: string | null, source?: InspectionAiSource) => void;
  onOpenRun?: (run: InspectionRun) => void;
  ownerBusy: boolean;
  jiraBusy: boolean;
  jiraConfigured: boolean;
}) {
  const severity = finding.severity.toLowerCase();
  const jira = finding.jira;
  const location = `${finding.path}${finding.line ? `:${finding.line}` : ""}`;
  const title = shortenInspectionFindingTitle(finding.issue, finding.path, finding.line);
  const showJiraError = Boolean(jira.error && jira.status !== "created");
  return <div className={`inspection-finding-detail-content inspection-finding-${severity}`}>
    <div className="inspection-finding-detail-labels"><span className={`inspection-severity inspection-severity-${severity}`}>{inspectionSeverityLabel(finding.severity)}</span><InspectionFindingStatus finding={finding} /><span className="inspection-finding-category">{finding.category}</span><code><FileCode2 aria-hidden="true" />{location}</code></div>
    <section className="inspection-finding-detail-block"><span>问题标题</span><h3>{title}</h3></section>
    <section className="inspection-finding-detail-block"><span>问题描述 / 证据</span><p>{finding.issue}</p></section>
    <section className="inspection-finding-detail-block"><span>修复建议</span><p>{finding.suggestion || "暂无补充建议。"}</p></section>
    {finding.tracking && <section className="inspection-finding-detail-block"><span>问题跟踪</span><p>首次发现：{formatTime(finding.tracking.firstSeenAt)} · 最近发现：{formatTime(finding.tracking.lastSeenAt)} · 共 {finding.tracking.occurrenceCount} 次巡检发现</p></section>}
    <div className="inspection-finding-detail-context"><span>{run.projectName}</span><span>{run.branch}</span><span>{formatTime(run.finishedAt ?? run.createdAt)}</span><InspectionFindingOwner finding={finding} /></div>
    <InspectionOwnershipEvidence finding={finding} />
    {(onOpenRun || jira.status !== "created" || (jira.status === "created" && jira.key)) && <div className="inspection-finding-detail-actions">{onOpenRun && <Button variant="ghost" size="sm" type="button" onClick={() => onOpenRun(run)}>查看巡检</Button>}{(jira.status !== "created" || jira.key) && <InspectionFindingJiraActions finding={finding} run={run} onResolveOwner={onResolveOwner} onCreateJira={onCreateJira} onOpenJira={onOpenJira} ownerBusy={ownerBusy} jiraBusy={jiraBusy} jiraConfigured={jiraConfigured} />}</div>}
    {jira.issueStatus && <small className="inspection-jira-sync-note">Jira：{jira.issueStatus}{jira.syncedAt ? ` · 同步于 ${formatTime(jira.syncedAt)}` : ""}</small>}
    {jira.aiResolutionStatus === "merged" && <small className="inspection-jira-sync-note">AI 修复 MR：已合并</small>}
    {jira.aiResolutionStatus === "reverted" && <small className="inspection-jira-error">AI 修复 MR：已回滚</small>}
    {jira.syncError && <small className="inspection-jira-error">{jira.syncError}</small>}
    {showJiraError && <small className="inspection-jira-error">{jira.error}</small>}
  </div>;
}

function InspectionFindingDetailDialog({ finding, run, selectedIndex, total, onClose, onResolveOwner, onCreateJira, onOpenJira, onOpenRun, ownerBusy, jiraBusy, jiraConfigured }: {
  finding: InspectionFinding | null;
  run: InspectionRun | null;
  selectedIndex: number;
  total: number;
  onClose: () => void;
  onResolveOwner: (run: InspectionRun, finding: InspectionFinding) => void;
  onCreateJira: (run: InspectionRun, finding: InspectionFinding) => void;
  onOpenJira: (key: string, url?: string | null, source?: InspectionAiSource) => void;
  onOpenRun?: (run: InspectionRun) => void;
  ownerBusy: boolean;
  jiraBusy: boolean;
  jiraConfigured: boolean;
}) {
  return <AlertDialog open={Boolean(finding && run)} onOpenChange={(open) => { if (!open) onClose(); }}>
    {finding && run && <AlertDialogContent className="inspection-finding-dialog">
      <AlertDialogHeader className="inspection-finding-dialog-header">
        <div className="inspection-finding-dialog-heading"><AlertDialogTitle>巡检问题</AlertDialogTitle><div className="inspection-finding-dialog-heading-actions"><span>{selectedIndex} / {total}</span><AlertDialogCancel asChild><Button variant="outline" size="icon" type="button" aria-label="关闭问题详情" title="关闭"><X aria-hidden="true" /></Button></AlertDialogCancel></div></div>
      </AlertDialogHeader>
      <div className="inspection-finding-dialog-body"><InspectionFindingDetailContent finding={finding} run={run} onResolveOwner={onResolveOwner} onCreateJira={onCreateJira} onOpenJira={onOpenJira} onOpenRun={onOpenRun ? (entryRun) => { onClose(); onOpenRun(entryRun); } : undefined} ownerBusy={ownerBusy} jiraBusy={jiraBusy} jiraConfigured={jiraConfigured} /></div>
    </AlertDialogContent>}
  </AlertDialog>;
}

function InspectionFindingList({ entries, onResolveOwner, onCreateJira, onOpenJira, onOpenRun, ownerBusyKey, jiraBusyKey, ownerBatchBusy, jiraBatchBusy, isJiraConfigured }: {
  entries: FindingEntry[];
  onResolveOwner: (run: InspectionRun, finding: InspectionFinding) => void;
  onCreateJira: (run: InspectionRun, finding: InspectionFinding) => void;
  onOpenJira: (key: string, url?: string | null, source?: InspectionAiSource) => void;
  onOpenRun?: (run: InspectionRun) => void;
  ownerBusyKey: string | null;
  jiraBusyKey: string | null;
  ownerBatchBusy: boolean;
  jiraBatchBusy: boolean;
  isJiraConfigured: (run: InspectionRun) => boolean;
}) {
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null);
  const selectedEntry = entries.find(({ finding, run }) => `${run.id}:${finding.id}` === selectedEntryKey) ?? null;
  const selectedIndex = selectedEntry ? entries.findIndex(({ finding, run }) => `${run.id}:${finding.id}` === selectedEntryKey) + 1 : 0;

  useEffect(() => {
    if (selectedEntryKey && !selectedEntry) setSelectedEntryKey(null);
  }, [selectedEntry, selectedEntryKey]);

  return <>
    <div className="inspection-finding-list inspection-finding-list-page" aria-label="巡检问题列表">
      {entries.map(({ finding, run }) => <FindingCard key={`${run.id}:${finding.id}`} finding={finding} run={run} onResolveOwner={onResolveOwner} onCreateJira={onCreateJira} onOpenJira={onOpenJira} onOpenRun={onOpenRun} onOpenDetail={() => setSelectedEntryKey(`${run.id}:${finding.id}`)} ownerBusy={Boolean(ownerBatchBusy || ownerBusyKey === `${run.id}:${finding.id}`)} jiraBusy={Boolean(jiraBatchBusy || jiraBusyKey === `${run.id}:${finding.id}`)} jiraConfigured={isJiraConfigured(run)} />)}
    </div>
    <InspectionFindingDetailDialog
      finding={selectedEntry?.finding ?? null}
      run={selectedEntry?.run ?? null}
      selectedIndex={selectedIndex}
      total={entries.length}
      onClose={() => setSelectedEntryKey(null)}
      onResolveOwner={onResolveOwner}
      onCreateJira={onCreateJira}
      onOpenJira={onOpenJira}
      onOpenRun={onOpenRun}
      ownerBusy={Boolean(selectedEntry && (ownerBatchBusy || ownerBusyKey === `${selectedEntry.run.id}:${selectedEntry.finding.id}`))}
      jiraBusy={Boolean(selectedEntry && (jiraBatchBusy || jiraBusyKey === `${selectedEntry.run.id}:${selectedEntry.finding.id}`))}
      jiraConfigured={Boolean(selectedEntry && isJiraConfigured(selectedEntry.run))}
    />
  </>;
}

function InspectionRunList({ runs, selectedRunId, onSelect, onCancel, cancelingId, onDelete, deletingId, emptyTitle, emptyDetail, limit }: {
  runs: InspectionRun[];
  selectedRunId: string | null;
  onSelect: (run: InspectionRun) => void;
  onCancel: (run: InspectionRun) => void;
  cancelingId: string | null;
  onDelete: (run: InspectionRun) => void;
  deletingId: string | null;
  emptyTitle: string;
  emptyDetail: string;
  limit?: number;
}) {
  const visibleRuns = limit ? runs.slice(0, limit) : runs;
  if (visibleRuns.length === 0) return <InspectionState icon={<ListChecks />} title={emptyTitle} detail={emptyDetail} className="inspection-panel-empty" />;
  return <div className="inspection-run-list" aria-label="巡检记录列表">{visibleRuns.map((run) => {
    const summary = inspectionRunSummary(run);
    const canCancel = run.status === "queued" || run.status === "running";
    const canDelete = isTerminalInspectionStatus(run.status);
    const actions = (canCancel || canDelete) ? <>
      {canCancel && <Button variant="ghost" size="icon" className="review-history-row-action review-history-row-cancel" type="button" aria-label={`取消 ${run.projectName} 的巡检任务`} title="取消任务" onClick={() => onCancel(run)} disabled={Boolean(cancelingId || deletingId)}>{cancelingId === run.id ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <X aria-hidden="true" />}</Button>}
      {canDelete && <Button variant="ghost" size="icon" className="review-history-row-action review-history-row-delete" type="button" aria-label={`删除 ${run.projectName} 的巡检记录`} title="删除记录" onClick={() => onDelete(run)} disabled={Boolean(cancelingId || deletingId)}>{deletingId === run.id ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}</Button>}
    </> : null;
    return <ReviewListRow
      key={run.id}
      className="inspection-run-row"
      ariaLabel={`打开 ${run.projectName} 的${run.source === "schedule" ? "定期" : "手动"}巡检，${statusLabel(run.status)}`}
      selected={selectedRunId === run.id}
      onSelect={() => onSelect(run)}
      actions={actions}
      actionsLabel={`${run.projectName} 巡检记录操作`}
      main={<span className="inspection-run-row-main"><span className={`inspection-run-icon ${statusClass(run.status)}`}>{run.status === "running" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : run.status === "completed" ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}</span><span className="inspection-run-copy"><strong>{run.projectName}</strong><span className="inspection-run-summary">{run.result ? `${summary.findingCount} 个问题 · ${summary.blockingCount} 个阻断` : run.error || "正在准备代码工作区"}</span><span className="inspection-run-meta"><InspectionStatusBadge status={run.status} /><small>{run.source === "schedule" ? "定期巡检" : "手动巡检"} · {formatTime(run.createdAt)}</small></span></span></span>}
    />;
  })}</div>;
}

function InspectionPromptDrawer({ open, profile, onClose, onProfileChange, onNotice, onError }: {
  open: boolean;
  profile: InspectionPromptProfile | null;
  onClose: () => void;
  onProfileChange: (profile: InspectionPromptProfile) => void;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(profile?.rules[0]?.id ?? null);
  const [draft, setDraft] = useState<InspectionPromptDraft | null>(null);
  const [newRule, setNewRule] = useState(EMPTY_INSPECTION_PROMPT);
  const [promptDialogMode, setPromptDialogMode] = useState<PromptRuleDialogMode | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);

  const selectedRule = profile?.rules.find((rule) => rule.id === selectedRuleId) ?? null;

  useEffect(() => {
    if (!profile) {
      setSelectedRuleId(null);
      return;
    }
    setSelectedRuleId((current) => current && profile.rules.some((rule) => rule.id === current) ? current : profile.rules[0]?.id ?? null);
  }, [profile]);

  useEffect(() => {
    setDraft(selectedRule ? inspectionPromptDraft(selectedRule) : null);
    setDirty(false);
  }, [selectedRule]);

  const updateDraft = (patch: Partial<InspectionPromptDraft>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true);
    onError(null);
  };

  const openRuleEditor = (ruleId: string) => {
    const rule = profile?.rules.find((item) => item.id === ruleId);
    if (!rule || saving || reordering || togglingRuleId) return;
    setSelectedRuleId(ruleId);
    setDraft(inspectionPromptDraft(rule));
    setDirty(false);
    onError(null);
    setPromptDialogMode("edit");
  };

  const updatePromptDialogDraft = (patch: Partial<InspectionPromptDraft>) => {
    if (promptDialogMode === "edit") {
      updateDraft(patch);
      return;
    }
    setNewRule((current) => ({ ...current, ...patch }));
    onError(null);
  };

  const handlePromptDialogOpenChange = (nextOpen: boolean) => {
    if (nextOpen) return;
    if (saving) return;
    if (promptDialogMode === "edit" && dirty) {
      onError("当前巡检提示词有未保存修改，请先保存或放弃修改。");
      return;
    }
    setPromptDialogMode(null);
  };

  const saveRule = async () => {
    if (!profile || !selectedRule || !draft || saving || !dirty) return;
    setSaving(true);
    try {
      const response = await saveInspectionRule({ profile: profile.name, ruleId: selectedRule.id, ...draft });
      onProfileChange(response.profile);
      setDirty(false);
      onNotice("巡检提示词已保存");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (ruleId: string, enabled: boolean) => {
    if (!profile || saving || reordering || togglingRuleId) return;
    if (dirty) {
      onError("当前巡检提示词有未保存修改，请先保存或放弃修改。");
      return;
    }
    const rule = profile.rules.find((item) => item.id === ruleId);
    if (!rule) return;
    setTogglingRuleId(ruleId);
    try {
      const response = await saveInspectionRule({ profile: profile.name, ruleId, name: rule.name, description: rule.description, enabled, content: rule.content });
      onProfileChange(response.profile);
      onNotice(enabled ? `巡检提示词“${rule.name}”已启用` : `巡检提示词“${rule.name}”已停用`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setTogglingRuleId(null);
    }
  };

  const reorderRules = async (sourceId: string, targetId: string) => {
    if (!profile || sourceId === targetId || saving || reordering || togglingRuleId) return;
    if (dirty) {
      onError("当前巡检提示词有未保存修改，请先保存或放弃修改。");
      return;
    }
    const ids = profile.rules.map((rule) => rule.id);
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = ids.splice(sourceIndex, 1);
    if (!moved) return;
    ids.splice(targetIndex, 0, moved);
    setReordering(true);
    try {
      const response = await reorderInspectionRules({ profile: profile.name, ruleIds: ids });
      onProfileChange(response.profile);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setReordering(false);
    }
  };

  const createRule = async () => {
    if (!profile || !newRule.name.trim() || !newRule.content.trim() || saving || reordering || togglingRuleId) {
      if (!newRule.name.trim() || !newRule.content.trim()) onError("规则名称和规则正文不能为空。");
      return;
    }
    setSaving(true);
    try {
      const response = await createInspectionRule({ profile: profile.name, ...newRule });
      onProfileChange(response.profile);
      const created = response.profile.rules.find((rule) => !profile.rules.some((current) => current.id === rule.id));
      setSelectedRuleId(created?.id ?? null);
      setPromptDialogMode(null);
      setNewRule(EMPTY_INSPECTION_PROMPT);
      onNotice(`巡检提示词“${created?.name ?? newRule.name}”已创建`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteRule = async () => {
    if (!profile || !selectedRule || saving || reordering || togglingRuleId) return;
    if (dirty) {
      onError("当前巡检提示词有未保存修改，请先保存或放弃修改。");
      return;
    }
    if (!window.confirm(`确定删除巡检提示词“${selectedRule.name}”吗？`)) return;
    setSaving(true);
    try {
      const response = await deleteInspectionRule({ profile: profile.name, ruleId: selectedRule.id });
      onProfileChange(response.profile);
      setPromptDialogMode(null);
      onNotice(`巡检提示词“${selectedRule.name}”已删除`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty || saving || reordering || togglingRuleId) {
      onError("当前巡检提示词有未保存修改或正在保存，请完成后再关闭。");
      return;
    }
    onClose();
  };

  if (!open || !profile) return null;
  return <ReviewDrawerShell eyebrow="巡检提示词" title={displayProfileName(profile)} titleId="inspection-prompt-drawer-title" closeLabel="关闭巡检提示词" isClosing={false} onRequestClose={requestClose} contentClassName="review-rules-profile-drawer-content">
    <div className="review-rules-editor-pane inspection-prompt-editor-pane">
      <RuleList rules={profile.rules} selectedId={selectedRuleId} onSelect={openRuleEditor} onCreate={() => { setNewRule(EMPTY_INSPECTION_PROMPT); setPromptDialogMode("create"); }} onReorder={(sourceId, targetId) => void reorderRules(sourceId, targetId)} onToggle={(ruleId, enabled) => void toggleRule(ruleId, enabled)} reordering={reordering} togglingRuleId={togglingRuleId} createLabel="新建提示词" emptyDetail="为这个巡检 Profile 添加第一条巡检提示词。" />
      <PromptRuleDialog
        open={promptDialogMode !== null}
        mode={promptDialogMode ?? "create"}
        draft={promptDialogMode === "edit" ? draft ?? EMPTY_INSPECTION_PROMPT : newRule}
        dirty={promptDialogMode === "edit" && dirty}
        saving={saving}
        taskLabel="巡检"
        fieldIdPrefix="inspection-rule"
        onOpenChange={handlePromptDialogOpenChange}
        onChange={updatePromptDialogDraft}
        onSubmit={() => { if (promptDialogMode === "edit") void saveRule(); else void createRule(); }}
        onReset={promptDialogMode === "edit" && selectedRule ? () => { setDraft(inspectionPromptDraft(selectedRule)); setDirty(false); onError(null); } : undefined}
        onDelete={promptDialogMode === "edit" ? () => void deleteRule() : undefined}
      />
    </div>
  </ReviewDrawerShell>;
}

function InspectionProjectConfigCard({ project, config, profile, form, branchOptions, branchOptionsLoading, jiraOptions, jiraOptionsLoading, jiraOptionsError, onRetryJiraOptions, jiraConnected, saving, running, profileActionBusy, onChange, onSave, onRun, onOpenGitLab, onOpenProfile }: {
  project: GitLabProjectConfig | null;
  config: InspectionProject | undefined;
  profile: InspectionPromptProfile | null;
  form: FormState;
  branchOptions: GitLabMergeRequestCreateOptions | null;
  branchOptionsLoading: boolean;
  jiraOptions: InspectionJiraOptions;
  jiraOptionsLoading: boolean;
  jiraOptionsError: string | null;
  onRetryJiraOptions: () => void;
  jiraConnected: boolean;
  saving: boolean;
  running: boolean;
  profileActionBusy: boolean;
  onChange: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onSave: () => void;
  onRun: () => void;
  onOpenGitLab: () => void;
  onOpenProfile: () => void;
}) {
  if (!project) return <section className="gitlab-workbench-panel inspection-config-card"><InspectionState icon={<GitBranch />} title="选择一个 GitLab 项目" detail="项目的巡检规则、分支、调度和 Jira 联动会显示在这里。" /></section>;
  const projectProfile = profile?.name === project.pathWithNamespace;
  const profileButtonLabel = projectProfile ? "编辑巡检提示词" : "编辑默认提示词";
  const branchSelectOptions = [...(branchOptions?.branches.map((branch) => ({ value: branch.name, label: `${branch.name}${branch.isDefault ? " · 默认" : ""}${branch.isProtected ? " · 受保护" : ""}` })) ?? [])];
  if (form.branch && !branchSelectOptions.some((option) => option.value === form.branch)) branchSelectOptions.unshift({ value: form.branch, label: form.branch });
  return <section className="gitlab-workbench-panel inspection-config-card">
    <div className="inspection-config-owner"><ShieldCheck aria-hidden="true" /><div><span>定时任务维护人员</span><strong>{config?.maintainerName || "尚未绑定"}</strong><small>保存配置后，将使用当前维护人员执行定时巡检。</small></div></div>
    {config?.authorizationError && <p className="auth-error" role="alert">{config.authorizationError}</p>}
    <div className="inspection-config-toolbar"><div className="inspection-config-links"><Button variant="ghost" size="sm" type="button" onClick={onOpenGitLab}><GitBranch aria-hidden="true" />查看巡检账号</Button>{project.webUrl && <a href={project.webUrl} target="_blank" rel="noreferrer">GitLab 项目<ExternalLink aria-hidden="true" /></a>}</div><div className="gitlab-section-heading inspection-section-heading"><span className={`inspection-config-state ${config ? "is-configured" : ""}`}><i aria-hidden="true" />{config ? "已接入巡检" : "尚未接入"}</span></div></div>
    <div className="inspection-config-section inspection-profile-section inspection-profile-runtime-section"><div className="inspection-config-section-heading"><div className="inspection-config-section-title"><strong>巡检提示词</strong><span className="review-rules-tooltip-trigger review-rules-info-hint" tabIndex={0} aria-describedby="inspection-prompt-section-hint"><CircleAlert aria-hidden="true" /><span id="inspection-prompt-section-hint" className="review-rules-tooltip" role="tooltip">巡检拥有独立的 Profile 和 Markdown 提示词，不会改变 Review 规则。</span></span></div><span>{profile ? `${enabledPromptCount(profile)} 条提示词` : "未读取"}</span></div>{profile ? <div className="inspection-profile-summary"><span className="review-rules-profile-icon"><GitBranch aria-hidden="true" /></span><span className="review-rules-profile-copy"><span className="inspection-profile-title-row"><strong>{displayProfileName(profile)}</strong><Button className="inspection-profile-action" variant="outline" size="sm" type="button" disabled={profileActionBusy} onClick={onOpenProfile}>{profileActionBusy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <ListChecks aria-hidden="true" />}{profileButtonLabel}</Button></span><small>{projectProfile ? "按当前项目路径匹配" : "未配置项目 Profile，使用默认配置"} · {enabledPromptCount(profile)} 条启用提示词</small><code>{profile.name}</code></span></div> : <InspectionState icon={<CircleAlert />} title="没有可用的巡检 Profile" detail="请先准备默认巡检提示词配置。" className="inspection-inline-state" />}
    <div className="inspection-config-section-heading inspection-runtime-section-heading"><div className="inspection-config-section-title"><strong>运行与调度</strong><span className="review-rules-tooltip-trigger review-rules-info-hint" tabIndex={0} aria-describedby="inspection-schedule-section-hint"><CircleAlert aria-hidden="true" /><span id="inspection-schedule-section-hint" className="review-rules-tooltip" role="tooltip">固定分支后，手动和定期巡检使用同一份配置。定期巡检使用 5 段 Cron 表达式，按服务所在时区执行。</span></span></div><span>{config?.nextRunAt ? `下次 ${formatTime(config.nextRunAt)}` : "可随时手动触发"}</span></div><div className="inspection-config-grid">
      <label className="inspection-config-field"><span>巡检分支</span><GitLabSearchableSelect ariaLabel="巡检分支" value={form.branch} options={branchSelectOptions} emptyLabel="未选择分支" placeholder={branchOptionsLoading ? "正在读取 GitLab 分支…" : "选择 GitLab 分支"} searchPlaceholder="搜索 GitLab 分支…" disabled={branchOptionsLoading || !branchOptions} onChange={(value) => onChange("branch", value)} /></label>
      <label className="inspection-config-field"><span>定期巡检</span><Select value={form.scheduleEnabled ? "enabled" : "disabled"} onValueChange={(value) => onChange("scheduleEnabled", value === "enabled")}><SelectTrigger aria-label="定期巡检开关"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="disabled">关闭，手动触发</SelectItem><SelectItem value="enabled">开启定期巡检</SelectItem></SelectContent></Select></label>
      {form.scheduleEnabled && <label className="inspection-config-field"><span><span>巡检周期</span><span className="review-rules-tooltip-trigger review-rules-info-hint" tabIndex={0} aria-describedby="inspection-cron-examples-hint"><CircleAlert aria-hidden="true" /><span id="inspection-cron-examples-hint" className="review-rules-tooltip" role="tooltip">常用示例：<br />每 15 分钟：*/15 * * * *<br />每小时：0 * * * *<br />每天 2:30：30 2 * * *<br />工作日 9:00：0 9 * * 1-5</span></span></span><Input value={form.scheduleCron} onChange={(event) => onChange("scheduleCron", event.target.value)} placeholder="例如：30 2 * * 1-5" aria-label="巡检周期 Cron 表达式" /></label>}
      <label className="inspection-config-field"><span><span>问题发现数</span><span className="review-rules-tooltip-trigger review-rules-info-hint" tabIndex={0} aria-describedby="inspection-finding-limit-hint"><CircleAlert aria-hidden="true" /><span id="inspection-finding-limit-hint" className="review-rules-tooltip" role="tooltip">留空表示不限制；手动启动时也可以直接使用当前输入值。达到数量后会自动终止本次巡检。</span></span></span><Input type="number" min={1} step={1} value={form.findingLimit} onChange={(event) => onChange("findingLimit", event.target.value)} placeholder="留空表示不限制" aria-label="问题发现数量上限" /></label>
    </div>
    <div className="inspection-jira-section"><div className="inspection-config-section-heading"><div className="inspection-config-section-title"><strong>Jira 联动</strong><span className="review-rules-tooltip-trigger review-rules-info-hint" tabIndex={0} aria-describedby="inspection-jira-section-hint"><CircleAlert aria-hidden="true" /><span id="inspection-jira-section-hint" className="review-rules-tooltip" role="tooltip">使用当前维护人员的巡检 Jira 授权；字段和问题详情与巡检账号保持一致。</span></span></div><span className={`inspection-jira-mode inspection-jira-mode-${form.jiraMode}`}>{form.jiraMode === "off" ? "关闭" : form.jiraMode === "auto" ? "自动创建" : "手动创建"}</span></div>{form.jiraMode !== "off" && <div className="inspection-jira-auto-hint"><Ticket aria-hidden="true" /><span>负责人判断与 Jira 创建是两个步骤；手动模式分别操作，自动模式按项目策略在巡检后创建。</span></div>}{jiraOptionsLoading && <div className="jira-create-issue-options-status inspection-jira-options-status" role="status"><span>正在同步 Jira 模块和修复版本…</span></div>}{jiraOptionsError && <div className="jira-create-issue-options-status inspection-jira-options-status is-error" role="alert"><span>{jiraOptionsError}</span><Button type="button" variant="ghost" onClick={onRetryJiraOptions}>重新读取</Button></div>}<div className="inspection-config-grid">
      <label className="inspection-config-field"><span>问题创建策略</span><Select value={form.jiraMode} onValueChange={(value) => onChange("jiraMode", value as FormState["jiraMode"])}><SelectTrigger aria-label="Jira 创建策略"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">关闭 Jira</SelectItem><SelectItem value="manual">手动创建</SelectItem><SelectItem value="auto">自动创建（新问题）</SelectItem></SelectContent></Select></label>
      {form.jiraMode !== "off" && <><label className="inspection-config-field jira-config-option-field"><span>模块</span><JiraMultiOptionPicker id="inspection-jira-components" ariaLabel="模块" options={jiraOptions.components} value={form.jiraComponent ? [form.jiraComponent] : []} onChange={(values) => onChange("jiraComponent", values[0] ?? "")} placeholder={jiraOptionsLoading ? "正在读取模块…" : jiraConnected ? "选择模块" : "请先连接 Jira"} searchPlaceholder="搜索模块…" disabled={jiraOptionsLoading || jiraOptionsError !== null || !jiraConnected} maxSelected={1} /></label><label className="inspection-config-field jira-config-option-field"><span>修复版本</span><JiraMultiOptionPicker id="inspection-jira-fix-versions" ariaLabel="修复的版本" options={jiraOptions.fixVersions} value={form.jiraFixVersion ? [form.jiraFixVersion] : []} onChange={(values) => onChange("jiraFixVersion", values[0] ?? "")} placeholder={jiraOptionsLoading ? "正在读取修复版本…" : jiraConnected ? "选择修复版本" : "请先连接 Jira"} searchPlaceholder="搜索版本…" disabled={jiraOptionsLoading || jiraOptionsError !== null || !jiraConnected} maxSelected={1} /></label></>}
    </div></div></div>
    <div className="inspection-config-footer"><label className="inspection-enabled-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => onChange("enabled", event.target.checked)} /><span><i aria-hidden="true" />允许执行巡检</span></label><div><Button className="inspection-run-button" variant="outline" type="button" onClick={onRun} disabled={!config || !form.enabled || running}>{running ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Play aria-hidden="true" />}{running ? "正在启动…" : "立即巡检"}</Button><Button type="button" onClick={onSave} disabled={saving}>{saving ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}{saving ? "保存中…" : "保存"}</Button></div></div>
  </section>;
}

function InspectionProjectConfigDrawer({ open, project, config, profile, form, branchOptions, branchOptionsLoading, jiraOptions, jiraOptionsLoading, jiraOptionsError, onRetryJiraOptions, jiraConnected, saving, running, profileActionBusy, onChange, onSave, onRun, onOpenGitLab, onOpenProfile, onClose }: {
  open: boolean;
  project: GitLabProjectConfig | null;
  config: InspectionProject | undefined;
  profile: InspectionPromptProfile | null;
  form: FormState;
  branchOptions: GitLabMergeRequestCreateOptions | null;
  branchOptionsLoading: boolean;
  jiraOptions: InspectionJiraOptions;
  jiraOptionsLoading: boolean;
  jiraOptionsError: string | null;
  onRetryJiraOptions: () => void;
  jiraConnected: boolean;
  saving: boolean;
  running: boolean;
  profileActionBusy: boolean;
  onChange: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onSave: () => void;
  onRun: () => void;
  onOpenGitLab: () => void;
  onOpenProfile: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return <ReviewDrawerShell eyebrow="巡检配置" title={<span className="inspection-config-drawer-title">{project?.pathWithNamespace ?? "配置巡检"}</span>} titleId="inspection-config-drawer-title" closeLabel="关闭巡检配置" isClosing={false} onRequestClose={onClose} contentClassName="inspection-config-drawer-content">
    <InspectionProjectConfigCard project={project} config={config} profile={profile} form={form} branchOptions={branchOptions} branchOptionsLoading={branchOptionsLoading} jiraOptions={jiraOptions} jiraOptionsLoading={jiraOptionsLoading} jiraOptionsError={jiraOptionsError} onRetryJiraOptions={onRetryJiraOptions} jiraConnected={jiraConnected} saving={saving} running={running} profileActionBusy={profileActionBusy} onChange={onChange} onSave={onSave} onRun={onRun} onOpenGitLab={onOpenGitLab} onOpenProfile={onOpenProfile} />
  </ReviewDrawerShell>;
}

function InspectionRunDetailDrawer({ run, onClose, onOpenGitLab, onCancel, canceling, onResolveOwners, resolvingOwners, onResolveOwner, ownerBusyKey, ownerBatchBusy, onRerun, rerunning, onDelete, deleting, onCreateJira, onOpenJira, jiraBusyKey, jiraBatchBusy, jiraConfigured }: {
  run: InspectionRun | null;
  onClose: () => void;
  onOpenGitLab: () => void;
  onCancel: (run: InspectionRun) => void;
  canceling: boolean;
  onResolveOwners: (run: InspectionRun) => void;
  resolvingOwners: boolean;
  onResolveOwner: (run: InspectionRun, finding: InspectionFinding) => void;
  ownerBusyKey: string | null;
  ownerBatchBusy: boolean;
  onRerun: (run: InspectionRun) => void;
  rerunning: boolean;
  onDelete: (run: InspectionRun) => void;
  deleting: boolean;
  onCreateJira: (run: InspectionRun, finding: InspectionFinding) => void;
  onOpenJira: (key: string, url?: string | null, source?: InspectionAiSource) => void;
  jiraBusyKey: string | null;
  jiraBatchBusy: boolean;
  jiraConfigured: boolean;
}) {
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setSelectedRuleId(null);
    setProgressOpen(run?.status === "running");
    setActionsOpen(false);
  }, [run?.id]);
  useEffect(() => {
    if (!actionsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!actionsMenuRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsOpen]);
  if (!run) return null;
  const findings = findingList(run);
  const ruleResults = run.result?.ruleResults ?? [];
  const selectedRule = ruleResults.find((rule) => rule.ruleId === selectedRuleId) ?? null;
  const visibleFindings = selectedRule ? selectedRule.findings : findings;
  const summary = inspectionRunSummary(run);
  const canCancel = run.status === "queued" || run.status === "running";
  const canRerun = isTerminalInspectionStatus(run.status);
  const canDelete = isTerminalInspectionStatus(run.status);
  const unresolvedOwnerCount = findings.filter(needsOwnerConfirmation).length;
  const canResolveOwners = canRerun && findings.length > 0;
  return <ReviewDrawerShell eyebrow="巡检记录" title={run.projectName} titleId={`inspection-run-detail-title-${run.id}`} closeLabel="关闭巡检详情" isClosing={false} onRequestClose={onClose} contentClassName="inspection-run-detail-drawer-content">
    <div className="inspection-run-detail-inner">
      <div className="inspection-run-detail-header"><div><span>{run.source === "schedule" ? "定期巡检" : "手动巡检"} · {run.branch}</span><strong>{formatTime(run.createdAt)}</strong></div><InspectionStatusBadge status={run.status} /></div>
      <div className="inspection-run-identity"><span>维护人员 <strong>{run.maintainerName || "历史未绑定"}</strong></span><span>操作人 <strong>{run.operatorName || "未记录"}</strong></span></div>
      <div className="inspection-run-detail-actions">
        <div>
          <Button variant="outline" size="sm" type="button" onClick={onOpenGitLab}><GitBranch aria-hidden="true" />查看巡检账号</Button>
          {(canCancel || canResolveOwners || canRerun || canDelete) && <div className="inspection-run-actions-menu" ref={actionsMenuRef}>
            <Button variant="outline" size="icon" className="inspection-run-actions-trigger" type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded={actionsOpen} aria-controls={`inspection-run-actions-${run.id}`} title="更多操作" onClick={() => setActionsOpen((current) => !current)}><MoreHorizontal aria-hidden="true" /></Button>
            {actionsOpen && <div id={`inspection-run-actions-${run.id}`} className="inspection-run-actions-popover" role="menu" aria-label="巡检记录更多操作">
              {canCancel && <Button variant="ghost" size="sm" type="button" role="menuitem" onClick={() => { setActionsOpen(false); onCancel(run); }} disabled={canceling}><X aria-hidden="true" />{canceling ? "取消中…" : "取消任务"}</Button>}
              {canResolveOwners && <Button variant="ghost" size="sm" type="button" role="menuitem" onClick={() => { setActionsOpen(false); onResolveOwners(run); }} disabled={resolvingOwners || rerunning || canceling || deleting || unresolvedOwnerCount === 0} title={unresolvedOwnerCount === 0 ? "所有问题负责人已确认" : "只确认未确认问题的负责人，不创建 Jira"}><UserRound aria-hidden="true" className={resolvingOwners ? "is-spinning" : ""} />{resolvingOwners ? "正在确认负责人…" : `确认负责人（${unresolvedOwnerCount}）`}</Button>}
              <Button variant="ghost" size="sm" type="button" role="menuitem" onClick={() => { setActionsOpen(false); onRerun(run); }} disabled={!canRerun || rerunning || resolvingOwners || canceling || deleting} title={!canRerun ? "当前巡检仍在进行中" : undefined}><RefreshCw aria-hidden="true" className={rerunning ? "is-spinning" : ""} />{rerunning ? "正在重跑…" : "重跑巡检"}</Button>
              {canDelete && <Button variant="ghost" size="sm" type="button" role="menuitem" className="inspection-run-actions-menu-item-danger" onClick={() => { setActionsOpen(false); onDelete(run); }} disabled={rerunning || resolvingOwners || canceling || deleting}><Trash2 aria-hidden="true" />{deleting ? "正在删除…" : "删除记录"}</Button>}
            </div>}
          </div>}
        </div>
        {run.headSha && <code title={run.headSha}>{run.headSha.slice(0, 12)}</code>}
      </div>
      <div className="inspection-run-detail-summary"><div><span>问题（去重）</span><strong>{run.result ? summary.findingCount : "—"}</strong><small>跨规则重复项已合并</small></div><div><span>阻断</span><strong>{run.result ? summary.blockingCount : "—"}</strong><small>严重 / 高问题数</small></div><div><span>执行规则</span><strong>{summary.ruleCount > 0 ? `${summary.ruleCount} / ${summary.ruleCount}` : "—"}</strong><small>已执行 / 启用规则 · {summary.matchedRuleCount} 条发现问题</small></div></div>
      {run.error && <div className="inspection-error-box"><CircleAlert aria-hidden="true" /><span>{run.error}</span></div>}
      <Collapsible className="inspection-run-detail-section inspection-progress-collapsible" open={progressOpen} onOpenChange={setProgressOpen}>
        <div className="inspection-progress-heading">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="inspection-progress-toggle" type="button" aria-label={progressOpen ? "收起执行进度" : "展开执行进度"}>
              <ChevronDown className="inspection-progress-toggle-icon" aria-hidden="true" />
              <strong>执行进度</strong>
            </Button>
          </CollapsibleTrigger>
          <span>{run.progress.length} 个事件</span>
        </div>
        <CollapsibleContent id={`inspection-progress-${run.id}`} className="inspection-progress-content">
          {run.progress.length === 0 ? <div className="inspection-detail-muted">暂时没有进度事件。</div> : <div className="inspection-progress-list">{run.progress.slice(-12).map((event) => <div className={`inspection-progress-item inspection-progress-${event.kind}`} key={event.id}><i aria-hidden="true" /><div><strong>{event.message}</strong>{inspectionProgressDetail(event, run) && <span>{inspectionProgressDetail(event, run)}</span>}<small>{formatTime(event.at)}</small></div></div>)}</div>}
        </CollapsibleContent>
      </Collapsible>
      {run.result && <section className="inspection-run-detail-section inspection-run-detail-rules"><div className="inspection-progress-heading"><strong>规则执行结果</strong><div className="inspection-rule-filter"><Select value={selectedRuleId ?? ALL_INSPECTION_RULES} onValueChange={(value) => setSelectedRuleId(value === ALL_INSPECTION_RULES ? null : value)}><SelectTrigger className="inspection-rule-filter-trigger" aria-label="按规则筛选问题"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL_INSPECTION_RULES}>全部规则</SelectItem>{ruleResults.map((rule) => <SelectItem key={rule.ruleId} value={rule.ruleId}>{rule.ruleName} · {rule.findings.length} 个问题</SelectItem>)}</SelectContent></Select></div></div></section>}
      <section className="inspection-run-detail-section inspection-run-detail-findings"><div className="inspection-progress-heading"><strong>问题清单</strong><span>{selectedRule ? `${selectedRule.ruleName} · ${visibleFindings.length} 个问题` : `${findings.length} 个去重问题`}</span></div>{visibleFindings.length === 0 ? <div className="inspection-no-findings"><CheckCircle2 aria-hidden="true" /><span>{selectedRule ? "这条规则没有发现问题。" : "这次巡检没有发现明确问题。"}</span></div> : <InspectionFindingList key={`${run.id}:${selectedRuleId ?? ALL_INSPECTION_RULES}`} entries={visibleFindings.map((finding) => ({ finding, run }))} onResolveOwner={onResolveOwner} onCreateJira={onCreateJira} onOpenJira={onOpenJira} ownerBusyKey={ownerBusyKey} jiraBusyKey={jiraBusyKey} ownerBatchBusy={ownerBatchBusy} jiraBatchBusy={jiraBatchBusy} isJiraConfigured={() => jiraConfigured} />}</section>
    </div>
  </ReviewDrawerShell>;
}

function jiraIssuePlaceholder(key: string, url?: string | null): JiraIssue {
  return { id: key, key, summary: "正在读取 Jira 问题…", description: null, status: "", statusId: null, statusCategory: "", issueType: "", priority: null, projectKey: key.split("-")[0] || "JIRA", projectName: "Jira", webUrl: url || "", createdAt: null, updatedAt: null, resolution: null, labels: [], assignee: null, reporter: null };
}

export function InspectionWorkbenchPage({ maintainerId, maintainerName, sessionReady, onNotice, onError }: InspectionWorkbenchPageProps) {
  const { getGitLabMergeRequestCreateOptions, listGitLabProjects, getGitLabOAuthStatus, getJiraAccount, getJiraIssue, getJiraIssueTransitions, transitionJiraIssue, getJiraCreateIssueSupportingPatch } = useIntegrationApi();
  const location = useLocation();
  const navigate = useNavigate();
  const configurationRouteMatch = useMatch({ path: INSPECTION_CONFIG_ROUTE, end: true });
  const configurationProjectId = configurationRouteMatch?.params.projectId;
  const configurationTab = new URLSearchParams(location.search).get("tab");
  const [activeTab, setActiveTab] = useState<InspectionTab>(() => configurationProjectId || configurationTab === "projects" ? "projects" : "overview");
  const [gitlabProjects, setGitlabProjects] = useState<GitLabProjectConfig[]>([]);
  const [configuredProjects, setConfiguredProjects] = useState<InspectionProject[]>([]);
  const [inspectionProfiles, setInspectionProfiles] = useState<InspectionPromptProfile[]>([]);
  const [runs, setRuns] = useState<InspectionRun[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [runProjectFilter, setRunProjectFilter] = useState("all");
  const [findingFilter, setFindingFilter] = useState<FindingFilter>("pending");
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [branchOptions, setBranchOptions] = useState<GitLabMergeRequestCreateOptions | null>(null);
  const [branchOptionsLoading, setBranchOptionsLoading] = useState(false);
  const [jiraOptions, setJiraOptions] = useState<InspectionJiraOptions>({ components: [], fixVersions: [] });
  const [jiraOptionsLoading, setJiraOptionsLoading] = useState(false);
  const [jiraOptionsError, setJiraOptionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningProjectId, setRunningProjectId] = useState<string | null>(null);
  const [resolvingOwnersRunId, setResolvingOwnersRunId] = useState<string | null>(null);
  const [cancelingRunId, setCancelingRunId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [ownerBusyKey, setOwnerBusyKey] = useState<string | null>(null);
  const [jiraBusyKey, setJiraBusyKey] = useState<string | null>(null);
  const [ownerBatchBusy, setOwnerBatchBusy] = useState(false);
  const [jiraBatchBusy, setJiraBatchBusy] = useState(false);
  const [jiraBatchProgress, setJiraBatchProgress] = useState({ completed: 0, total: 0 });
  const [ownerBatchConfirmOpen, setOwnerBatchConfirmOpen] = useState(false);
  const [jiraBatchConfirmOpen, setJiraBatchConfirmOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gitlabOAuthStatus, setGitlabOAuthStatus] = useState<GitLabOAuthStatus | null>(null);
  const [jiraConnection, setJiraConnection] = useState<{ projectKey: string; tokenConfigured: boolean } | null>(null);
  const [gitlabSettingsOpen, setGitlabSettingsOpen] = useState(false);
  const [jiraSettingsOpen, setJiraSettingsOpen] = useState(false);
  const [jiraCreateOpen, setJiraCreateOpen] = useState(false);
  const [runDetailOpen, setRunDetailOpen] = useState(false);
  const [selectedJiraSource, setSelectedJiraSource] = useState<InspectionAiSource | null>(null);
  const [selectedJiraIssue, setSelectedJiraIssue] = useState<JiraIssue | null>(null);
  const [jiraDetail, setJiraDetail] = useState<JiraIssueDetails | null>(null);
  const [jiraTransitions, setJiraTransitions] = useState<JiraIssueTransition[]>([]);
  const [jiraTransitionsLoading, setJiraTransitionsLoading] = useState(false);
  const [jiraTransitionsError, setJiraTransitionsError] = useState<string | null>(null);
  const [jiraDetailLoading, setJiraDetailLoading] = useState(false);
  const [inspectionPromptOpen, setInspectionPromptOpen] = useState(false);
  const hydratedProjectIdRef = useRef<string | null>(null);
  const branchOptionsRequestRef = useRef(0);
  const jiraOptionsRequestRef = useRef(0);

  const configuredById = useMemo(() => new Map(configuredProjects.map((project) => [project.projectId, project])), [configuredProjects]);
  const projectById = useMemo(() => new Map(gitlabProjects.map((project) => [project.id, project])), [gitlabProjects]);
  const selectedGitLabProject = selectedProjectId ? projectById.get(selectedProjectId) ?? null : null;
  const selectedConfig = selectedProjectId ? configuredById.get(selectedProjectId) : undefined;
  const configurationProject = configurationProjectId ? projectById.get(configurationProjectId) ?? null : null;
  const configurationProjectConfig = configurationProjectId ? configuredById.get(configurationProjectId) : undefined;
  const configurationInspectionProfile = useMemo(() => profileForProject(configurationProject, inspectionProfiles), [configurationProject, inspectionProfiles]);
  const selectedRun = selectedRunId ? runs.find((run) => run.id === selectedRunId) ?? null : null;
  const sortedRuns = useMemo(() => [...runs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)), [runs]);
  const activeRuns = useMemo(() => sortedRuns.filter((run) => run.status === "queued" || run.status === "running"), [sortedRuns]);
  const activeRunKey = activeRuns.map((run) => run.id).join(",");
  const latestCompletedRuns = useMemo(() => {
    const latest = new Map<string, InspectionRun>();
    sortedRuns.filter((run) => run.status === "completed").forEach((run) => {
      if (!latest.has(run.projectId)) latest.set(run.projectId, run);
    });
    return latest;
  }, [sortedRuns]);
  const findingEntries = useMemo(() => [...latestCompletedRuns.values()].flatMap((run) => findingList(run).map((finding) => ({ finding, run }))).sort((left, right) => findingSortWeight(right.finding.severity) - findingSortWeight(left.finding.severity)), [latestCompletedRuns]);
  const attentionCount = findingEntries.filter(({ finding }) => !isInspectionFindingCompleted(finding)).length;
  const completedFindingCount = findingEntries.length - attentionCount;
  const autoJiraCount = configuredProjects.filter((project) => project.jiraMode === "auto").length;
  const recentRuns = sortedRuns.slice(0, 8);
  const filteredProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    return gitlabProjects.filter((project) => !query || `${project.name} ${project.pathWithNamespace}`.toLowerCase().includes(query));
  }, [gitlabProjects, projectSearch]);
  const runProjects = useMemo(() => {
    const projects = new Map<string, string>();
    gitlabProjects.forEach((project) => projects.set(project.id, project.pathWithNamespace));
    runs.forEach((run) => { if (!projects.has(run.projectId)) projects.set(run.projectId, run.projectPath); });
    return [...projects.entries()];
  }, [gitlabProjects, runs]);
  const visibleRuns = useMemo(() => sortedRuns.filter((run) => runProjectFilter === "all" || run.projectId === runProjectFilter), [runProjectFilter, sortedRuns]);
  const visibleFindings = useMemo(() => findingEntries.filter(({ finding, run }) => {
    if (findingFilter === "all") return true;
    if (findingFilter === "done") return isInspectionFindingCompleted(finding);
    if (isInspectionFindingCompleted(finding)) return false;
    return findingFilter === "pending" || findingFilter === "blocking" && isBlockingFinding(finding, run) || findingFilter === "jira" && finding.jira.status !== "created";
  }), [findingEntries, findingFilter]);
  const pendingJiraFindings = useMemo(() => findingEntries.filter(({ finding }) => finding.jira.status !== "created"), [findingEntries]);
  const ownerBatchCandidates = useMemo(() => pendingJiraFindings.filter(({ finding, run }) => run.maintainerId === maintainerId && needsOwnerConfirmation(finding)), [maintainerId, pendingJiraFindings]);
  const jiraBatchCandidates = useMemo(() => pendingJiraFindings.filter(({ finding, run }) => run.maintainerId === maintainerId && !needsOwnerConfirmation(finding) && hasInspectionJiraConfiguration(configuredById.get(run.projectId))), [configuredById, pendingJiraFindings, maintainerId]);

  const loadConnections = useCallback(async () => {
    if (!sessionReady) return;
    const [gitlabResult, jiraResult] = await Promise.allSettled([getGitLabOAuthStatus(), getJiraAccount()]);
    if (gitlabResult.status === "fulfilled") setGitlabOAuthStatus(gitlabResult.value);
    if (jiraResult.status === "fulfilled") setJiraConnection({ projectKey: jiraResult.value.projectKey, tokenConfigured: jiraResult.value.tokenConfigured });
  }, [sessionReady]);

  const loadJiraOptions = useCallback(async () => {
    const requestId = jiraOptionsRequestRef.current + 1;
    jiraOptionsRequestRef.current = requestId;
    if (!configurationProjectId || jiraConnection?.tokenConfigured !== true) {
      setJiraOptions({ components: [], fixVersions: [] });
      setJiraOptionsLoading(false);
      setJiraOptionsError(null);
      return;
    }
    setJiraOptions({ components: [], fixVersions: [] });
    setJiraOptionsLoading(true);
    setJiraOptionsError(null);
    const [componentsResult, fixVersionsResult] = await Promise.allSettled([
      getJiraCreateIssueSupportingPatch("components"),
      getJiraCreateIssueSupportingPatch("fixVersions"),
    ]);
    if (requestId !== jiraOptionsRequestRef.current) return;
    const components = componentsResult.status === "fulfilled" ? componentsResult.value.components ?? [] : [];
    const fixVersions = fixVersionsResult.status === "fulfilled" ? fixVersionsResult.value.fixVersions ?? [] : [];
    setJiraOptions({ components, fixVersions });
    if (componentsResult.status === "rejected" || fixVersionsResult.status === "rejected") {
      const message = "Jira 模块或修复版本读取失败，请重新读取。";
      setJiraOptionsError(message);
      onError(message);
    } else {
      setJiraOptionsError(null);
      onError(null);
    }
    setJiraOptionsLoading(false);
  }, [configurationProjectId, jiraConnection?.projectKey, jiraConnection?.tokenConfigured, onError]);

  const load = useCallback(async (quiet = false) => {
    if (!sessionReady) return;
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const [gitlabStatus, inspectionResponse, inspectionRulesResponse, runsResponse, jiraAccount] = await Promise.all([getGitLabOAuthStatus(), listInspectionProjects(), getInspectionRules(), listInspectionRuns(), getJiraAccount()]);
      setGitlabOAuthStatus(gitlabStatus);
      setJiraConnection({ projectKey: jiraAccount.projectKey, tokenConfigured: jiraAccount.tokenConfigured });
      const projectsResponse = gitlabStatus.connected ? await listGitLabProjects({ page: 1, perPage: 50 }) : { projects: [] };
      setGitlabProjects(projectsResponse.projects);
      setConfiguredProjects(inspectionResponse.projects);
      setInspectionProfiles(inspectionRulesResponse.profiles);
      setRuns(runsResponse.runs);
      setSelectedProjectId((current) => current && projectsResponse.projects.some((project) => project.id === current) ? current : inspectionResponse.projects[0]?.projectId ?? projectsResponse.projects[0]?.id ?? null);
      setSelectedRunId((current) => current && runsResponse.runs.some((run) => run.id === current) ? current : null);
      setLoadError(null);
      onError(null);
    } catch (error) {
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [getGitLabOAuthStatus, getJiraAccount, listGitLabProjects, onError, sessionReady]);

  const handleGitLabStatusChange = useCallback((status: GitLabOAuthStatus) => {
    setGitlabOAuthStatus(status);
    void load(true);
  }, [load]);

  const refreshRuns = useCallback(async () => {
    const response = await listInspectionRuns();
    setRuns(response.runs);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!sessionReady) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshRuns().catch((error) => onError(errorMessage(error)));
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [onError, refreshRuns, sessionReady]);
  useEffect(() => {
    if (configurationProjectId) {
      setActiveTab("projects");
      return;
    }
    setActiveTab(configurationTab === "projects" ? "projects" : "overview");
  }, [configurationProjectId, configurationTab]);
  useEffect(() => {
    if (!configurationProjectId || !projectById.has(configurationProjectId)) return;
    setSelectedProjectId((current) => current === configurationProjectId ? current : configurationProjectId);
  }, [configurationProjectId, projectById]);
  useEffect(() => {
    setInspectionPromptOpen(false);
  }, [configurationProjectId]);
  useEffect(() => {
    const requestId = branchOptionsRequestRef.current + 1;
    branchOptionsRequestRef.current = requestId;
    if (!configurationProjectId) {
      setBranchOptions(null);
      setBranchOptionsLoading(false);
      return;
    }
    setBranchOptions(null);
    setBranchOptionsLoading(true);
    void getGitLabMergeRequestCreateOptions(configurationProjectId)
      .then((options) => {
        if (requestId !== branchOptionsRequestRef.current) return;
        setBranchOptions(options);
      })
      .catch((error) => {
        if (requestId !== branchOptionsRequestRef.current) return;
        setBranchOptions(null);
        onError(`GitLab 分支读取失败：${errorMessage(error)}`);
      })
      .finally(() => {
        if (requestId === branchOptionsRequestRef.current) setBranchOptionsLoading(false);
      });
  }, [configurationProjectId, onError]);
  useEffect(() => { void loadJiraOptions(); }, [loadJiraOptions]);
  useEffect(() => {
    const formProjectId = configurationProjectId ?? selectedProjectId;
    if (!formProjectId) {
      hydratedProjectIdRef.current = null;
      return;
    }
    if (hydratedProjectIdRef.current === formProjectId) return;
    const project = projectById.get(formProjectId);
    if (project) {
      setForm(formFromProject(project, configuredById.get(formProjectId)));
      hydratedProjectIdRef.current = formProjectId;
    }
  }, [configuredById, configurationProjectId, projectById, selectedProjectId]);
  useEffect(() => {
    const activeIds = activeRunKey ? activeRunKey.split(",") : [];
    if (activeIds.length === 0) return;
    const sources = activeIds.map((id) => subscribeToInspectionEvents(id, (event) => {
      setRuns((current) => current.map((run) => run.id === id ? mergeInspectionFinding(run, event) : run));
      if (event.kind === "result" || event.kind === "error") {
        void getInspectionRun(id).then(({ run: latest }) => {
          setRuns((current) => current.map((run) => run.id === id
            ? { ...latest, progress: mergeProgressEvents(run.progress, latest.progress) }
            : run));
        }).catch(() => undefined);
      }
    }));
    return () => sources.forEach((source) => source.close());
  }, [activeRunKey]);

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const selectProject = (project: GitLabProjectConfig) => {
    setSelectedProjectId(project.id);
    navigate(`${inspectionConfigPath(project.id)}?tab=projects`);
  };

  const openInspectionPrompts = () => {
    if (!configurationInspectionProfile) {
      onError("当前没有可用的巡检 Profile。");
      return;
    }
    setInspectionPromptOpen(true);
  };

  const saveSelectedProject = async () => {
    const project = configurationProject ?? selectedGitLabProject;
    if (!project || saving) return;
    setSaving(true);
    try {
      const body: UpsertInspectionProjectInput = {
        projectPath: project.pathWithNamespace,
        projectName: project.nameWithNamespace,
        branch: form.branch.trim() || project.defaultBranch || "main",
        findingLimit: parseFindingLimit(form.findingLimit),
        inspectionRuleIds: configurationInspectionProfile?.rules.filter((rule) => rule.enabled).map((rule) => rule.id) ?? [],
        enabled: form.enabled,
        scheduleEnabled: form.scheduleEnabled,
        scheduleCron: form.scheduleCron.trim() || "0 0 * * *",
        jiraMode: form.jiraMode,
        jiraComponent: form.jiraComponent.trim() || null,
        jiraFixVersion: form.jiraFixVersion.trim() || null,
      };
      const response = await saveInspectionProject(project.id, body);
      setConfiguredProjects((current) => [...current.filter((project) => project.projectId !== response.project.projectId), response.project]);
      onNotice("巡检项目配置已保存");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const runProject = async (projectId: string, findingLimitInput?: string) => {
    if (runningProjectId) return;
    if (!configuredById.has(projectId)) {
      setSelectedProjectId(projectId);
      navigate(inspectionConfigPath(projectId));
      onError("请先保存该项目的巡检配置");
      return;
    }
    let findingLimit: number | null | undefined;
    try {
      findingLimit = findingLimitInput === undefined ? undefined : parseFindingLimit(findingLimitInput);
    } catch (error) {
      onError(errorMessage(error));
      return;
    }
    setRunningProjectId(projectId);
    try {
      const response = await startInspection(projectId, findingLimit === undefined ? undefined : { findingLimit });
      setRuns((current) => [response.run, ...current.filter((run) => run.id !== response.run.id)]);
      setSelectedRunId(response.run.id);
      setRunDetailOpen(true);
      setActiveTab("runs");
      if (configurationProjectId) navigate(`${ASSISTANT_ROUTE_PATHS["inspection-workbench"]}?tab=runs`);
      onNotice(response.deduplicated ? "该项目已有巡检任务，已打开进行中的记录" : "巡检已启动，可在巡检记录中查看实时进度");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setRunningProjectId(null);
    }
  };

  const retryRun = async (run: InspectionRun) => {
    if (runningProjectId) return;
    setRunningProjectId(run.projectId);
    try {
      const response = await retryInspectionRun(run.id);
      setRuns((current) => [response.run, ...current.filter((item) => item.id !== response.run.id)]);
      setSelectedRunId(response.run.id);
      setRunDetailOpen(true);
      setActiveTab("runs");
      if (configurationProjectId) navigate(`${ASSISTANT_ROUTE_PATHS["inspection-workbench"]}?tab=runs`);
      onNotice("已复用当前巡检记录并重新启动，可在巡检记录中查看实时进度");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setRunningProjectId(null);
    }
  };

  const confirmFindingOwner = async (run: InspectionRun, finding: InspectionFinding) => {
    if (run.maintainerId !== maintainerId) { onError(`请登录维护人员 ${run.maintainerName || "对应账号"} 后操作；历史未绑定记录请先重跑。`); return; }
    if (ownerBusyKey || ownerBatchBusy || jiraBusyKey || jiraBatchBusy || !isTerminalInspectionStatus(run.status) || !needsOwnerConfirmation(finding)) return;
    setOwnerBusyKey(`${run.id}:${finding.id}`);
    onError(null);
    try {
      const response = await resolveInspectionFindingOwner(run.id, finding.id);
      setRuns((current) => current.map((item) => item.id === response.run.id ? response.run : item));
      const updated = findingList(response.run).find((item) => item.id === finding.id);
      if (updated && hasInspectionFindingOwner(updated)) onNotice(`负责人已确认：${updated.jira.assigneeName || updated.jira.ownership?.assignee}`);
      else onError(updated?.jira.ownership?.reason || "AI 暂未确认负责人，请稍后重试。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setOwnerBusyKey(null);
    }
  };

  const resolveOwners = async (run: InspectionRun) => {
    if (run.maintainerId !== maintainerId) { onError(`请登录维护人员 ${run.maintainerName || "对应账号"} 后操作；历史未绑定记录请先重跑。`); return; }
    if (resolvingOwnersRunId || ownerBusyKey || ownerBatchBusy || jiraBusyKey || jiraBatchBusy || !isTerminalInspectionStatus(run.status)) return;
    setResolvingOwnersRunId(run.id);
    onError(null);
    try {
      const beforeCount = findingList(run).filter((finding) => !needsOwnerConfirmation(finding)).length;
      const response = await resolveInspectionRunOwners(run.id);
      setRuns((current) => current.map((item) => item.id === response.run.id ? response.run : item));
      const afterFindings = findingList(response.run);
      const resolvedCount = afterFindings.filter((finding) => !needsOwnerConfirmation(finding)).length;
      const unresolvedCount = afterFindings.filter(needsOwnerConfirmation).length;
      const addedCount = Math.max(0, resolvedCount - beforeCount);
      onNotice(addedCount > 0
        ? `AI 已确认 ${addedCount} 个问题负责人${unresolvedCount ? `，仍有 ${unresolvedCount} 个待确认` : ""}`
        : unresolvedCount ? `AI 仍有 ${unresolvedCount} 个问题无法确认负责人，请查看问题详情。` : "问题负责人已确认，无需重试。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setResolvingOwnersRunId(null);
    }
  };

  const cancelRun = async (run: InspectionRun) => {
    if (cancelingRunId || (run.status !== "queued" && run.status !== "running")) return;
    setCancelingRunId(run.id);
    onError(null);
    try {
      const canceled = await cancelInspectionRun(run.id);
      setRuns((current) => current.map((item) => item.id === canceled.id ? canceled : item));
      onNotice("巡检已取消");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setCancelingRunId(null);
    }
  };

  const deleteRun = async (run: InspectionRun) => {
    if (deletingRunId || !isTerminalInspectionStatus(run.status)) return;
    if (!window.confirm(`确定删除 ${run.projectName} 的巡检记录吗？删除后不可恢复。`)) return;
    setDeletingRunId(run.id);
    onError(null);
    try {
      const response = await deleteInspectionRun(run.id);
      if (!response.deleted) return;
      setRuns((current) => current.filter((item) => item.id !== run.id));
      if (selectedRunId === run.id) {
        setSelectedRunId(null);
        setRunDetailOpen(false);
      }
      onNotice("巡检记录已删除");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDeletingRunId(null);
    }
  };

  const createJira = async (run: InspectionRun, finding: InspectionFinding) => {
    if (run.maintainerId !== maintainerId) { onError(`请登录维护人员 ${run.maintainerName || "对应账号"} 后操作；历史未绑定记录请先重跑。`); return; }
    if (needsOwnerConfirmation(finding)) { onError("请先确认负责人，再创建 Jira。"); return; }
    if (ownerBusyKey || ownerBatchBusy || jiraBusyKey || jiraBatchBusy) return;
    setJiraBusyKey(`${run.id}:${finding.id}`);
    try {
      const response = await createInspectionJira(run.id, finding.id);
      setRuns((current) => current.map((item) => item.id === response.run.id ? response.run : item));
      const updated = findingList(response.run).find((item) => item.id === finding.id);
      if (updated?.jira.status === "created") onNotice("Jira 问题已生成");
      else if (updated?.jira.status === "skipped") onError(updated.jira.error || "Jira 未生成，请先确认负责人后重试。");
      else onError(updated?.jira.error || "Jira 未生成，请稍后重试。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setJiraBusyKey(null);
    }
  };

  const openBatchResolveOwners = () => {
    if (ownerBatchBusy || ownerBusyKey || jiraBatchBusy || jiraBusyKey) return;
    if (!jiraConnected) {
      onError("请先连接 Jira，再确认负责人。");
      return;
    }
    if (ownerBatchCandidates.length === 0) {
      onNotice("所有问题负责人已确认");
      return;
    }
    setOwnerBatchConfirmOpen(true);
  };

  const batchResolveOwners = async (): Promise<string | null> => {
    if (ownerBatchBusy || ownerBusyKey || jiraBatchBusy || jiraBusyKey) return null;
    const targets = [...ownerBatchCandidates];
    if (targets.length === 0) {
      setOwnerBatchConfirmOpen(false);
      return null;
    }
    setOwnerBatchConfirmOpen(false);
    setOwnerBatchBusy(true);
    onError(null);
    let resolvedCount = 0;
    let unresolvedCount = 0;
    let failedCount = 0;
    const targetsByRun = new Map<string, FindingEntry[]>();
    for (const target of targets) {
      const current = targetsByRun.get(target.run.id) ?? [];
      current.push(target);
      targetsByRun.set(target.run.id, current);
    }
    for (const [runId, runTargets] of targetsByRun) {
      try {
        const response = await resolveInspectionRunOwners(runId);
        setRuns((current) => current.map((item) => item.id === response.run.id ? response.run : item));
        const targetIds = new Set(runTargets.map(({ finding }) => finding.id));
        const nextFindings = findingList(response.run).filter((finding) => targetIds.has(finding.id));
        resolvedCount += nextFindings.filter((finding) => !needsOwnerConfirmation(finding)).length;
        unresolvedCount += nextFindings.filter(needsOwnerConfirmation).length;
      } catch {
        failedCount += runTargets.length;
      }
    }
    setOwnerBatchBusy(false);
    if (failedCount > 0) {
      onError(`批量确认负责人完成：已确认 ${resolvedCount} 个，仍待确认 ${unresolvedCount + failedCount} 个，请查看问题详情后重试。`);
    } else {
      onNotice(`批量确认负责人完成：已确认 ${resolvedCount} 个${unresolvedCount ? `，仍有 ${unresolvedCount} 个待确认` : ""}。确认后请单独创建 Jira。`);
    }
    return null;
  };

  const openBatchCreateJira = () => {
    if (ownerBatchBusy || ownerBusyKey || jiraBatchBusy || jiraBusyKey) return;
    if (!jiraConnected) {
      onError("请先连接 Jira，再批量生成问题。");
      return;
    }
    if (pendingJiraFindings.length === 0) {
      onNotice("所有问题都已生成 Jira");
      return;
    }
    if (ownerBatchCandidates.length > 0 && jiraBatchCandidates.length === 0) {
      onError("请先确认负责人，再批量创建 Jira。");
      return;
    }
    if (jiraBatchCandidates.length === 0) {
      onError("待生成的问题所在项目尚未完成 Jira 模块和修复版本配置。");
      return;
    }
    setJiraBatchConfirmOpen(true);
  };

  const batchCreateJira = async (): Promise<string | null> => {
    if (ownerBatchBusy || ownerBusyKey || jiraBatchBusy || jiraBusyKey) return null;
    const targets = [...jiraBatchCandidates];
    if (targets.length === 0) {
      setJiraBatchConfirmOpen(false);
      return null;
    }
    setJiraBatchConfirmOpen(false);
    setJiraBatchBusy(true);
    setJiraBatchProgress({ completed: 0, total: targets.length });
    onError(null);
    let createdCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    for (const { run, finding } of targets) {
      try {
        const response = await createInspectionJira(run.id, finding.id);
        setRuns((current) => current.map((item) => item.id === response.run.id ? response.run : item));
        const nextFinding = findingList(response.run).find((item) => item.id === finding.id);
        if (nextFinding?.jira.status === "created") createdCount += 1;
        else if (nextFinding?.jira.status === "skipped") skippedCount += 1;
        else failedCount += 1;
      } catch {
        failedCount += 1;
      }
      setJiraBatchProgress({ completed: createdCount + failedCount + skippedCount, total: targets.length });
    }
    setJiraBatchBusy(false);
    if (failedCount === 0) {
      onNotice(`批量创建 Jira 完成：成功 ${createdCount} 个${skippedCount ? `，${skippedCount} 个问题暂未创建，已保留待处理` : ""}`);
    } else {
      onError(`批量生成完成：成功 ${createdCount} 个，待确认 ${skippedCount} 个，失败 ${failedCount} 个，请查看问题卡片后重试。`);
    }
    return null;
  };

  const loadJiraIssueData = useCallback(async (key: string, clearCurrent: boolean) => {
    if (clearCurrent) {
      setJiraDetail(null);
      setJiraTransitions([]);
    }
    setJiraTransitionsError(null);
    setJiraDetailLoading(true);
    setJiraTransitionsLoading(true);
    const [detailResult, transitionsResult] = await Promise.allSettled([getJiraIssue(key), getJiraIssueTransitions(key)]);
    if (detailResult.status === "fulfilled") {
      setSelectedJiraIssue(detailResult.value);
      setJiraDetail(detailResult.value);
      void refreshRuns().catch((error) => onError(errorMessage(error)));
    } else {
      onError(errorMessage(detailResult.reason));
    }
    if (transitionsResult.status === "fulfilled") {
      setJiraTransitions(transitionsResult.value.transitions);
    } else {
      const message = errorMessage(transitionsResult.reason);
      setJiraTransitionsError(message);
      onError(`Jira 状态选项读取失败：${message}`);
    }
    setJiraDetailLoading(false);
    setJiraTransitionsLoading(false);
  }, [onError, refreshRuns]);

  const openJiraIssue = async (issueOrKey: JiraIssue | string, url?: string | null, source?: InspectionAiSource) => {
    const issue = typeof issueOrKey === "string" ? jiraIssuePlaceholder(issueOrKey, url) : issueOrKey;
    setSelectedJiraSource(source ?? null);
    setSelectedJiraIssue(issue);
    await loadJiraIssueData(issue.key, true);
  };

  const refreshJiraIssue = async () => {
    if (selectedJiraIssue) await loadJiraIssueData(selectedJiraIssue.key, false);
  };

  const changeJiraStatus = async (transitionId: string) => {
    if (!selectedJiraIssue) return;
    const issueKey = selectedJiraIssue.key;
    const nextDetail = await transitionJiraIssue(issueKey, transitionId);
    setSelectedJiraIssue(nextDetail);
    setJiraDetail(nextDetail);
    onNotice(`${issueKey} 状态已更新`);
    await loadJiraIssueData(issueKey, false);
  };

  const handleJiraCreated = async (issue: JiraIssueDetails) => {
    setJiraCreateOpen(false);
    await openJiraIssue(issue);
  };

  const gitlabConnected = gitlabOAuthStatus?.connected === true;
  const jiraConnected = jiraConnection?.tokenConfigured === true;

  if (!sessionReady) return <InspectionState icon={<ShieldCheck />} title="正在等待页面会话" detail="连接服务后即可配置巡检项目。" className="inspection-page-state" />;
  if (loading) return <InspectionState icon={<LoaderCircle className="is-spinning" />} title="正在加载巡检工作台" detail="正在读取 GitLab 项目、巡检提示词和历史记录。" className="inspection-page-state" />;
  if (loadError) return <InspectionState icon={<CircleAlert />} title="巡检工作台暂时无法读取" detail={loadError} action={<Button variant="outline" size="sm" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" />重新读取</Button>} className="inspection-page-state" />;

  return <>
    <section className="review-workbench-page inspection-workbench-page" aria-label="巡检工作台">
      <header className="review-workbench-heading">
        <div className="review-workbench-heading-copy"><div className="review-workbench-title-row"><span className="review-workbench-brand-mark inspection-brand-mark" aria-hidden="true"><ClipboardCheck /></span><div><p>GitLab 项目巡检，问题同步至 Jira。</p></div></div></div>
        <div className="review-workbench-heading-actions jira-workbench-heading-actions"><Button variant="outline" size="sm" className={`jira-action-button jira-connection-button inspection-connection-chip ${gitlabConnected ? "is-connected" : ""}`} type="button" aria-haspopup="dialog" onClick={() => setGitlabSettingsOpen(true)}><GitBranch aria-hidden="true" /><i aria-hidden="true" />GitLab {gitlabConnected ? "已连接" : gitlabOAuthStatus ? "未连接" : "检查中"}</Button><Button variant="outline" size="sm" className={`jira-action-button jira-connection-button inspection-connection-chip ${jiraConnected ? "is-connected" : ""}`} type="button" aria-haspopup="dialog" onClick={() => setJiraSettingsOpen(true)}><Ticket aria-hidden="true" /><i aria-hidden="true" />Jira {jiraConnected ? "已连接" : jiraConnection ? "未连接" : "检查中"}</Button>{activeTab !== "projects" && activeTab !== "runs" && <Button className="jira-action-button inspection-refresh-button" variant="outline" size="icon" type="button" aria-label="刷新巡检工作台" title="刷新巡检工作台" onClick={() => void load(true)} disabled={refreshing}><RefreshCw aria-hidden="true" className={refreshing ? "is-spinning" : ""} /></Button>}</div>
      </header>

      {!gitlabConnected && <div className="inspection-connection-notice is-error" role="alert"><CircleAlert aria-hidden="true" /><span>{gitlabOAuthStatus?.configured === false ? "GitLab 授权尚未配置，请联系管理员完成配置。" : "当前维护人员的 GitLab 连接已失效，请重新连接后再选择项目。"}</span><Button variant="link" size="sm" onClick={() => navigate("/inspection-workbench?accounts=1")}>{gitlabOAuthStatus?.configured === false ? "查看账号连接" : "重新连接 GitLab"}</Button></div>}

      <nav className="review-workbench-tabs inspection-workbench-tabs" aria-label="巡检工作台菜单" role="tablist"><div className="review-workbench-tab-list">{INSPECTION_TABS.map(({ id, label, icon: Icon }) => <Button key={id} variant="ghost" role="tab" aria-selected={activeTab === id} className={activeTab === id ? "is-active" : ""} type="button" onClick={() => setActiveTab(id)}><Icon aria-hidden="true" /><span><strong>{label}</strong></span>{id === "projects" && configuredProjects.length > 0 && <em>{configuredProjects.length}</em>}{id === "runs" && activeRuns.length > 0 && <em>{activeRuns.length}</em>}{id === "findings" && attentionCount > 0 && <em>{attentionCount}</em>}</Button>)}</div></nav>

      {activeTab === "overview" && <div className="review-workbench-content inspection-workbench-content inspection-overview-content"><div className="gitlab-metrics-grid" aria-label="巡检概览"><GitLabMetric label="已配置项目" value={configuredProjects.length} note="可手动或定期运行" tone="tone-blue" icon={<CalendarClock aria-hidden="true" />} onClick={() => setActiveTab("projects")} /><GitLabMetric label="进行中" value={activeRuns.length} note="实时接收执行进度" tone="tone-purple" icon={<Play aria-hidden="true" />} onClick={() => setActiveTab("runs")} /><GitLabMetric label="待关注问题" value={attentionCount} note="每个项目最近一次完成结果" tone="tone-red" icon={<AlertTriangle aria-hidden="true" />} onClick={() => setActiveTab("findings")} /><GitLabMetric label="自动创建 Jira" value={autoJiraCount} note="项目级 Jira 策略" tone="tone-green" icon={<Ticket aria-hidden="true" />} onClick={() => setActiveTab("projects")} /></div><section className="gitlab-workbench-panel inspection-recent-runs-panel"><div className="gitlab-panel-heading"><div><strong>最近巡检</strong><small>点击记录打开完整执行详情。</small></div><Button variant="ghost" size="sm" type="button" onClick={() => setActiveTab("runs")}>查看全部</Button></div><InspectionRunList runs={recentRuns} selectedRunId={selectedRunId} onSelect={(run) => { setSelectedRunId(run.id); setRunDetailOpen(true); }} onCancel={(run) => void cancelRun(run)} cancelingId={cancelingRunId} onDelete={(run) => void deleteRun(run)} deletingId={deletingRunId} emptyTitle="还没有巡检记录" emptyDetail="先在项目配置中保存一个项目，再启动第一次扫描。" limit={6} /></section></div>}

      {activeTab === "projects" && <div className="review-workbench-content inspection-workbench-content inspection-projects-content"><div className="inspection-projects-layout"><section className="gitlab-workbench-panel inspection-project-list-panel"><div className="gitlab-panel-heading"><div><strong>GitLab 项目</strong><small>项目来源和权限来自 GitLab；点击“配置巡检”打开巡检配置侧栏。</small></div><div className="gitlab-section-page-meta inspection-project-count"><strong>{configuredProjects.length}</strong><span>个已接入</span></div></div><div className="gitlab-filter-bar inspection-project-filter"><div className="gitlab-search-control"><Search aria-hidden="true" /><Input aria-label="搜索 GitLab 项目" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="按项目名或路径搜索…" /></div><Button variant="ghost" size="sm" type="button" onClick={() => void load(true)} disabled={refreshing}><RefreshCw aria-hidden="true" className={refreshing ? "is-spinning" : ""} />刷新项目</Button></div><div className="inspection-gitlab-project-list">{gitlabConnected ? <GitLabProjectList projects={filteredProjects} selectedProjectId={configurationProjectId} onSelect={selectProject} /> : <div className="gitlab-empty-state inspection-project-auth-empty" role="status"><CircleAlert aria-hidden="true" /><strong>{gitlabOAuthStatus?.configured === false ? "GitLab 授权未配置" : "GitLab 连接已失效"}</strong><span>{gitlabOAuthStatus?.configured === false ? "完成 GitLab 授权配置后，才能读取项目。" : "请重新连接当前维护人员的 GitLab 账号，再读取项目。"}</span><Button variant="outline" size="sm" type="button" onClick={() => navigate("/inspection-workbench?accounts=1")}>{gitlabOAuthStatus?.configured === false ? "查看账号连接" : "重新连接 GitLab"}</Button></div>}</div></section></div></div>}

      {activeTab === "runs" && <div className="review-workbench-content inspection-workbench-content inspection-runs-content"><section className="gitlab-workbench-panel inspection-run-list-panel"><div className="gitlab-panel-heading"><div><strong>执行历史</strong><small>查看手动和定期巡检的执行状态、进度事件、结果摘要和问题证据。</small></div><div className="inspection-run-panel-meta"><div className="gitlab-section-page-meta inspection-project-count"><strong>{visibleRuns.length}</strong><span>条记录</span></div><span>{activeRuns.length ? `${activeRuns.length} 个进行中` : "暂无进行中任务"}</span></div></div><div className="gitlab-filter-bar inspection-run-filter"><label className="gitlab-select-control"><Select value={runProjectFilter} onValueChange={setRunProjectFilter}><SelectTrigger className="gitlab-select-trigger" aria-label="按项目筛选巡检记录"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部项目</SelectItem>{runProjects.map(([projectId, projectPath]) => <SelectItem key={projectId} value={projectId}>{projectPath}</SelectItem>)}</SelectContent></Select></label><Button variant="ghost" size="sm" type="button" onClick={() => void load(true)} disabled={refreshing}><RefreshCw aria-hidden="true" className={refreshing ? "is-spinning" : ""} />刷新记录</Button></div><InspectionRunList runs={visibleRuns} selectedRunId={selectedRunId} onSelect={(run) => { setSelectedRunId(run.id); setRunDetailOpen(true); }} onCancel={(run) => void cancelRun(run)} cancelingId={cancelingRunId} onDelete={(run) => void deleteRun(run)} deletingId={deletingRunId} emptyTitle="还没有匹配的巡检记录" emptyDetail="调整项目筛选，或先从项目配置中启动一次巡检。" /></section></div>}

      {activeTab === "findings" && <div className="review-workbench-content inspection-workbench-content inspection-findings-content"><section className="gitlab-workbench-panel inspection-findings-panel"><div className="inspection-findings-toolbar"><div className="inspection-findings-title"><strong>问题清单</strong><span className="gitlab-panel-count">{visibleFindings.length}</span></div><div className="inspection-section-page-actions"><Button className="jira-action-button inspection-batch-owner-button" variant="outline" size="sm" type="button" onClick={openBatchResolveOwners} disabled={Boolean(ownerBusyKey) || ownerBatchBusy || Boolean(jiraBusyKey) || jiraBatchBusy || !jiraConnected || ownerBatchCandidates.length === 0} title={!jiraConnected ? "请先连接 Jira" : ownerBatchCandidates.length === 0 ? "所有问题负责人已确认" : undefined}>{ownerBatchBusy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <UserRound aria-hidden="true" />}{ownerBatchBusy ? "确认中…" : ownerBatchCandidates.length > 0 ? `批量确认负责人（${ownerBatchCandidates.length}）` : "负责人已全部确认"}</Button><Button className="jira-action-button inspection-batch-jira-button" variant="outline" size="sm" type="button" onClick={openBatchCreateJira} disabled={Boolean(ownerBusyKey) || ownerBatchBusy || Boolean(jiraBusyKey) || jiraBatchBusy || !jiraConnected || pendingJiraFindings.length === 0 || jiraBatchCandidates.length === 0} title={!jiraConnected ? "请先连接 Jira" : pendingJiraFindings.length === 0 ? "没有待生成的 Jira 问题" : ownerBatchCandidates.length > 0 ? "请先确认负责人" : jiraBatchCandidates.length === 0 ? "先完成项目的 Jira 模块和修复版本配置" : undefined}>{jiraBatchBusy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Ticket aria-hidden="true" />}{jiraBatchBusy ? `创建中 ${jiraBatchProgress.completed}/${jiraBatchProgress.total}` : jiraBatchCandidates.length > 0 ? `批量创建 Jira（${jiraBatchCandidates.length}）` : pendingJiraFindings.length === 0 ? "已全部生成" : "暂无可创建 Jira"}</Button><Button className="jira-action-button" variant="outline" size="sm" type="button" onClick={() => navigate("/inspection-workbench?accounts=1")}><Ticket aria-hidden="true" />巡检账号设置<ExternalLink aria-hidden="true" /></Button></div></div><div className="gitlab-filter-bar inspection-findings-filter"><div className="gitlab-filter-tabs">{([ ["pending", `待处理 ${attentionCount}`], ["done", `已完成 ${completedFindingCount}`], ["blocking", "阻断问题"], ["jira", "待同步 Jira"], ["all", "全部问题"] ] as const).map(([value, label]) => <Button key={value} variant="ghost" className={findingFilter === value ? "is-active" : ""} type="button" aria-pressed={findingFilter === value} onClick={() => setFindingFilter(value)}>{label}</Button>)}</div></div>{visibleFindings.length === 0 ? <InspectionState icon={<CheckCircle2 />} title="当前没有匹配的问题" detail={findingFilter === "done" ? "Jira 或 AI 修复 MR 完成后，对应问题会自动归入这里。" : attentionCount === 0 && completedFindingCount > 0 ? "关联的问题已完成，可切换到“已完成”查看。" : "换一个筛选条件查看其它问题。"} className="inspection-panel-empty" /> : <InspectionFindingList entries={visibleFindings} onResolveOwner={(entryRun, entryFinding) => void confirmFindingOwner(entryRun, entryFinding)} onCreateJira={(entryRun, entryFinding) => void createJira(entryRun, entryFinding)} onOpenJira={(key, url, source) => void openJiraIssue(key, url, source)} onOpenRun={(entryRun) => { setSelectedRunId(entryRun.id); setRunDetailOpen(true); }} ownerBusyKey={ownerBusyKey} jiraBusyKey={jiraBusyKey} ownerBatchBusy={ownerBatchBusy} jiraBatchBusy={jiraBatchBusy} isJiraConfigured={(entryRun) => hasInspectionJiraConfiguration(configuredById.get(entryRun.projectId))} />}</section></div>}
      {ownerBatchConfirmOpen && <InspectionBatchActionDialog mode="owner" findings={ownerBatchCandidates.map(({ finding }) => finding)} busy={ownerBatchBusy} onClose={() => setOwnerBatchConfirmOpen(false)} onConfirm={batchResolveOwners} />}
      {jiraBatchConfirmOpen && <InspectionBatchActionDialog mode="jira" findings={jiraBatchCandidates.map(({ finding }) => finding)} busy={jiraBatchBusy} onClose={() => setJiraBatchConfirmOpen(false)} onConfirm={batchCreateJira} />}
    </section>
    <InspectionProjectConfigDrawer open={Boolean(configurationProjectId)} project={configurationProject} config={configurationProjectConfig} profile={configurationInspectionProfile} form={form} branchOptions={branchOptions} branchOptionsLoading={branchOptionsLoading} jiraOptions={jiraOptions} jiraOptionsLoading={jiraOptionsLoading} jiraOptionsError={jiraOptionsError} onRetryJiraOptions={() => void loadJiraOptions()} jiraConnected={jiraConnected} saving={saving} running={runningProjectId === configurationProjectId} profileActionBusy={false} onChange={updateForm} onSave={() => void saveSelectedProject()} onRun={() => { if (configurationProjectId) void runProject(configurationProjectId, form.findingLimit); }} onOpenGitLab={() => navigate("/inspection-workbench?accounts=1")} onOpenProfile={openInspectionPrompts} onClose={() => navigate(`${ASSISTANT_ROUTE_PATHS["inspection-workbench"]}?tab=projects`)} />
    <InspectionPromptDrawer open={inspectionPromptOpen} profile={configurationInspectionProfile} onClose={() => setInspectionPromptOpen(false)} onProfileChange={(nextProfile) => setInspectionProfiles((current) => current.map((profile) => profile.name === nextProfile.name ? nextProfile : profile))} onNotice={onNotice} onError={onError} />
    <InspectionRunDetailDrawer run={runDetailOpen ? selectedRun : null} onClose={() => setRunDetailOpen(false)} onOpenGitLab={() => navigate("/inspection-workbench?accounts=1")} onCancel={(run) => void cancelRun(run)} canceling={Boolean(cancelingRunId)} onResolveOwners={(run) => void resolveOwners(run)} resolvingOwners={Boolean(resolvingOwnersRunId)} onResolveOwner={(run, finding) => void confirmFindingOwner(run, finding)} ownerBusyKey={ownerBusyKey} ownerBatchBusy={ownerBatchBusy} onRerun={(run) => void retryRun(run)} rerunning={Boolean(runningProjectId)} onDelete={(run) => void deleteRun(run)} deleting={Boolean(deletingRunId)} onCreateJira={(run, finding) => void createJira(run, finding)} onOpenJira={(key, url, source) => void openJiraIssue(key, url, source)} jiraBusyKey={jiraBusyKey} jiraBatchBusy={jiraBatchBusy} jiraConfigured={hasInspectionJiraConfiguration(selectedRun ? configuredById.get(selectedRun.projectId) : undefined)} />
    <JiraIssueDetailPanel actions={selectedJiraSource && selectedJiraIssue ? <InspectionAiAction key={`${selectedJiraSource.runId}:${selectedJiraSource.findingId}`} source={selectedJiraSource} jiraKey={selectedJiraIssue.key} onError={onError} onNotice={onNotice} onResolved={refreshRuns} /> : undefined} issue={selectedJiraIssue} detail={jiraDetail} transitions={jiraTransitions} transitionsLoading={jiraTransitionsLoading} transitionsError={jiraTransitionsError} loading={jiraDetailLoading} onClose={() => { setSelectedJiraIssue(null); setJiraDetail(null); setJiraTransitions([]); }} onRefresh={refreshJiraIssue} onStatusChange={changeJiraStatus} onNotice={onNotice} onError={onError} />
    {jiraConnection?.projectKey && <JiraCreateIssueDrawer open={jiraCreateOpen} projectKey={jiraConnection.projectKey} onClose={() => setJiraCreateOpen(false)} onCreated={handleJiraCreated} onNotice={onNotice} onError={onError} />}
    <GitLabOAuthDrawer inspection open={gitlabSettingsOpen} sessionReady={sessionReady} onClose={() => setGitlabSettingsOpen(false)} onStatusChange={handleGitLabStatusChange} onNotice={onNotice} onError={onError} />
    <JiraAccountDrawer open={jiraSettingsOpen} sessionReady={sessionReady} inspection productUsername={maintainerName} onClose={() => setJiraSettingsOpen(false)} onSaved={async () => { await loadConnections(); setJiraSettingsOpen(false); }} onNotice={onNotice} onError={onError} />
  </>;
}
