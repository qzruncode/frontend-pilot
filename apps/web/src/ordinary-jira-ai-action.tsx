import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, CircleAlert, Code2, ExternalLink, GitBranch, GitMerge, LoaderCircle, RotateCcw, Sparkles, Square, XCircle } from "lucide-react";
import type { GitLabOAuthStatus, GitLabProjectConfig, JiraIssue, OrdinaryJiraAiPrecheck, OrdinaryJiraAiSupplement, OrdinaryJiraAiTask, OrdinaryJiraAiTaskDetail } from "@contracts";
import { AssistantActivityPanel, assistantActivitiesFromRuns, assistantErrorMessage, ReviewProgressPanel } from "./assistant-activity";
import { AssistantEditOperationCard, AssistantWorkspaceDiffCard } from "./assistant-edit-operation-card";
import { AssistantMarkdown } from "./assistant-markdown";
import { ApiError, cancelOrdinaryJiraAi, confirmOrdinaryJiraAiSupplement, getGitLabMergeRequestCreateOptions, getOrdinaryJiraAiPrecheck, getOrdinaryJiraAiTask, getOrdinaryJiraAiTaskDetail, listGitLabProjects, precheckOrdinaryJiraAi, retryOrdinaryJiraAi, startOrdinaryJiraAi, suggestOrdinaryJiraAiSupplement } from "./api";
import { GitLabSearchableSelect } from "./gitlab-searchable-select";
import { GitLabOAuthPanel } from "./assistant-gitlab-oauth";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { isOrdinaryJiraAiTaskProcessing } from "./jira-ai-task-status";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const isProcessing = (task: OrdinaryJiraAiTask | null): boolean => Boolean(task && isOrdinaryJiraAiTaskProcessing(task.status));
const briefLabels: Record<keyof OrdinaryJiraAiPrecheck["implementationBrief"], string> = {
  problem: "问题现象",
  expected: "期望结果",
  scope: "影响范围 / 位置",
  reproduction: "复现条件 / 环境",
  acceptance: "验收标准",
  constraints: "兼容性 / 约束",
};

function projectOptions(projects: GitLabProjectConfig[]) {
  return projects.map((project) => ({ value: project.id, label: project.pathWithNamespace || project.name, searchText: project.name }));
}

function statusLabel(task: OrdinaryJiraAiTask | null, precheck: OrdinaryJiraAiPrecheck | null, busy: boolean): string {
  if (busy) return "处理中…";
  if (precheck?.status === "needs_input") return "需补充 Jira";
  if (task?.status === "merged") return "已合并";
  if (task?.status === "closed") return "MR 已关闭";
  if (task?.status === "failed") return "处理失败";
  if (task?.status === "canceled") return "已停止";
  if (task?.mr) return "MR详情";
  if (task) return "处理中";
  return "AI处理";
}

function statusNote(task: OrdinaryJiraAiTask | null): string {
  if (!task) return "普通 Jira 先做内容预检查；检查通过并经你确认后，才会创建隔离工作区和 MR。";
  if (task.status === "failed" && task.mr) return "同一个 MR 的 Pipeline 或 Pipeline Review 未通过，反馈和改动已保留，可以继续处理。";
  if (task.status === "failed") return "已有执行记录已保留，排除问题后可以继续处理。";
  if (task.status === "canceled") return "已有改动和执行记录已保留，可以继续处理。";
  if (task.status === "preparing" && task.editSessionId) return "正在恢复已有工作区，已有代码改动和执行记录会保留。";
  if (task.status === "pipeline_pending") return "正在等待当前提交的 Pipeline；只有最新提交验证通过才会结束。";
  if (task.status === "review_pending") return "正在等待当前提交的 Pipeline Review 报告和机器人评论确认。";
  if (task.status === "review_fixing") return "机器人发现了问题，正在同一个分支和 MR 上修复后重新验证。";
  if (task.status === "mr_open") return "Pipeline 与 Pipeline Review 均已通过，等待维护人员审阅和合并。";
  if (task.status === "merged") return "代码已合并，可前往 GitLab 查看详情。";
  return task.phase;
}

export function OrdinaryJiraAiAction({ issue, sessionReady, onError, onNotice, onTaskChange }: { issue: JiraIssue; sessionReady: boolean; onError: (message: string) => void; onNotice?: (message: string) => void; onTaskChange?: (task: OrdinaryJiraAiTask | null, jiraKey: string) => void }) {
  const navigate = useNavigate();
  const [task, setTask] = useState<OrdinaryJiraAiTask | null>(null);
  const [detail, setDetail] = useState<OrdinaryJiraAiTaskDetail | null>(null);
  const [precheck, setPrecheck] = useState<OrdinaryJiraAiPrecheck | null>(null);
  const [projects, setProjects] = useState<GitLabProjectConfig[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [projectId, setProjectId] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [open, setOpen] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [gitlabOAuthStatus, setGitlabOAuthStatus] = useState<GitLabOAuthStatus | null>(null);
  const previousGitLabConnected = useRef<boolean | null>(null);
  const [pending, setPending] = useState<"precheck" | "start" | "retry" | "cancel" | null>(null);
  const [precheckProcessing, setPrecheckProcessing] = useState(false);
  const [supplementingCheckId, setSupplementingCheckId] = useState<OrdinaryJiraAiSupplement["checkId"] | null>(null);
  const [supplement, setSupplement] = useState<OrdinaryJiraAiSupplement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutationPending = useRef(false);
  const requestVersion = useRef(0);
  const supplementVersion = useRef(0);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId) ?? null, [projectId, projects]);
  const processing = isProcessing(task);
  const busy = pending !== null || precheckProcessing || supplementingCheckId !== null;
  const taskId = task?.id ?? null;
  const setCurrentTask = (next: OrdinaryJiraAiTask | null) => {
    setTask(next);
    onTaskChange?.(next, issue.key);
  };
  const oauthReturnTo = useMemo(() => {
    if (typeof window === "undefined") return "/jira-workbench";
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("jiraKey", issue.key);
    return `${url.pathname}${url.search}`;
  }, [issue.key]);

  useEffect(() => {
    let active = true;
    supplementVersion.current += 1;
    setOpen(false);
    setTask(null);
    setDetail(null);
    setPrecheck(null);
    setPrecheckProcessing(false);
    setSupplementingCheckId(null);
    setSupplement(null);
    setProjects([]);
    setBranches([]);
    setProjectId("");
    setTargetBranch("");
    setProjectsLoaded(false);
    setProjectsError(null);
    setError(null);
    void Promise.all([
      getOrdinaryJiraAiTask(issue.key).catch(() => ({ task: null })),
      getOrdinaryJiraAiPrecheck(issue.key).catch(() => ({ status: "idle" as const, precheck: null, projectId: null })),
    ]).then(([taskResponse, precheckResponse]) => {
      if (!active) return;
      setCurrentTask(taskResponse.task);
      if (taskResponse.task) {
        setPrecheck(null);
        setPrecheckProcessing(false);
        return;
      }
      setPrecheckProcessing(precheckResponse.status === "processing");
      if (precheckResponse.precheck) {
        setPrecheck(precheckResponse.precheck);
        setProjectId(precheckResponse.projectId ?? "");
        setTargetBranch(precheckResponse.precheck.targetBranch);
        setPrecheckProcessing(false);
      }
    });
    return () => { active = false; };
  }, [issue.key, onTaskChange]);

  useEffect(() => {
    if (taskId || !precheckProcessing) return;
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const next = await getOrdinaryJiraAiPrecheck(issue.key);
        if (!active || next.status === "processing") return;
        setPrecheckProcessing(false);
        if (next.precheck) {
          setPrecheck(next.precheck);
          setProjectId(next.projectId ?? "");
          setTargetBranch(next.precheck.targetBranch);
        } else {
          setPrecheck(null);
        }
      } catch {
        // Keep the processing state and retry on the next interval.
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [issue.key, precheckProcessing, taskId]);

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    let inFlight = false;
    const version = requestVersion.current;
    const controller = new AbortController();
    const isCurrent = () => active && !controller.signal.aborted && !mutationPending.current && version === requestVersion.current;
    const load = async () => {
      if (!isCurrent() || inFlight) return;
      inFlight = true;
      try {
        const next = await getOrdinaryJiraAiTaskDetail(taskId, controller.signal);
        if (isCurrent()) { setCurrentTask(next.task); setDetail(next); setError(null); }
      } catch {
        // Detail refresh is best-effort. Keep the last task state during a
        // short API or dev-server interruption; mutation errors are surfaced
        // by their own handlers and the next poll will reconcile the detail.
      } finally { inFlight = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), processing ? 3_000 : 30_000);
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => { active = false; controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [busy, onTaskChange, processing, taskId]);

  useEffect(() => {
    const connected = gitlabOAuthStatus?.connected;
    if (connected === undefined || connected === previousGitLabConnected.current) return;
    const hasPreviousConnectionState = previousGitLabConnected.current !== null;
    previousGitLabConnected.current = connected;
    setProjects([]);
    setProjectsError(null);
    setProjectsLoaded(false);
    if (hasPreviousConnectionState) {
      setProjectId("");
      setBranches([]);
      setTargetBranch("");
      setPrecheck(null);
      setPrecheckProcessing(false);
      setSupplementingCheckId(null);
      setSupplement(null);
    }
    if (connected) setError(null);
  }, [gitlabOAuthStatus?.connected]);

  useEffect(() => {
    if (!open || projectsLoaded || projectsLoading || task || gitlabOAuthStatus?.connected !== true) return;
    setProjectsLoading(true);
    setProjectsError(null);
    void listGitLabProjects({ perPage: 50 })
      .then((response) => {
        setProjects(response.projects);
        setProjectId((current) => response.projects.some((project) => project.id === current) ? current : response.projects[0]?.id ?? "");
      })
      .catch((nextError) => setProjectsError(nextError instanceof ApiError && nextError.status === 428 ? "请先连接你的 GitLab 账号，再使用普通 Jira AI 处理。" : assistantErrorMessage(nextError)))
      .finally(() => { setProjectsLoaded(true); setProjectsLoading(false); });
  }, [gitlabOAuthStatus?.connected, open, projectsLoaded, projectsLoading, task]);

  useEffect(() => {
    if (!selectedProject || task) return;
    setBranchesLoading(true);
    void getGitLabMergeRequestCreateOptions(selectedProject.id)
      .then((response) => {
        const names = response.branches.map((branch) => branch.name);
        setBranches(names);
        setTargetBranch((current) => names.includes(current) ? current : names.find((name) => response.branches.find((branch) => branch.name === name)?.isDefault) ?? names[0] ?? selectedProject.defaultBranch ?? "main");
      })
      .catch(() => {
        setBranches([]);
        setTargetBranch((current) => current || selectedProject.defaultBranch || "main");
      })
      .finally(() => setBranchesLoading(false));
  }, [selectedProject, task]);

  const runPrecheck = () => {
    if (!selectedProject || !targetBranch.trim() || busy) {
      setError("请先选择 GitLab 项目和目标分支");
      return;
    }
    setPending("precheck");
    setPrecheckProcessing(true);
    supplementVersion.current += 1;
    setError(null);
    setPrecheck(null);
    setSupplement(null);
    void precheckOrdinaryJiraAi(issue.key, { projectId: selectedProject.id, projectPath: selectedProject.pathWithNamespace, targetBranch: targetBranch.trim() })
      .then((response) => { setPrecheck(response.precheck); if (response.precheck.status === "needs_input") onNotice?.("Jira 描述缺少 AI 处理所需信息，请补充后重新检查"); })
      .catch((nextError) => {
        setPrecheckProcessing(false);
        if (nextError instanceof ApiError && nextError.status === 409) setPrecheck(null);
        const message = assistantErrorMessage(nextError);
        setError(message);
        onError(message);
      })
      .finally(() => { setPrecheckProcessing(false); setPending(null); });
  };

  const requestSupplement = (check: OrdinaryJiraAiPrecheck["checks"][number]) => {
    if (!precheck || check.status !== "missing" || !projectId || supplementingCheckId !== null) return;
    const version = ++supplementVersion.current;
    setSupplementingCheckId(check.id);
    setSupplement(null);
    setError(null);
    void suggestOrdinaryJiraAiSupplement(issue.key, {
      projectId,
      projectPath: precheck.projectPath,
      targetBranch: precheck.targetBranch,
      precheckId: precheck.id,
      checkId: check.id,
    })
      .then((response) => {
        if (version !== supplementVersion.current) return;
        setSupplement(response.supplement);
        if (response.supplement.status === "needs_user") onNotice?.("AI 无法从当前 Jira 内容可靠判断，请补充后重新检查");
      })
      .catch((nextError) => {
        if (version !== supplementVersion.current) return;
        const message = assistantErrorMessage(nextError);
        setError(message);
        onError(message);
      })
      .finally(() => { if (version === supplementVersion.current) setSupplementingCheckId(null); });
  };

  const confirmSupplement = (checkId: OrdinaryJiraAiSupplement["checkId"]) => {
    if (!precheck || !supplement || supplement.checkId !== checkId || supplement.status !== "resolvable" || !projectId || supplementingCheckId !== null) return;
    const version = ++supplementVersion.current;
    setSupplementingCheckId(checkId);
    setError(null);
    void confirmOrdinaryJiraAiSupplement(issue.key, {
      projectId,
      projectPath: precheck.projectPath,
      targetBranch: precheck.targetBranch,
      precheckId: precheck.id,
      checkId,
      supplement: supplement.suggestion,
    })
      .then((response) => {
        if (version !== supplementVersion.current) return;
        setPrecheck(response.precheck);
        setSupplement(null);
        onNotice?.("AI 补充已写入 Jira，并完成重新检查");
      })
      .catch((nextError) => {
        if (version !== supplementVersion.current) return;
        const message = assistantErrorMessage(nextError);
        setError(message);
        onError(message);
      })
      .finally(() => { if (version === supplementVersion.current) setSupplementingCheckId(null); });
  };

  const retryProjects = () => {
    if (projectsLoading || gitlabOAuthStatus?.connected !== true) return;
    setProjectsError(null);
    setProjectsLoaded(false);
  };

  const start = () => {
    if (!precheck || precheck.status !== "passed" || !selectedProject || busy) return;
    mutationPending.current = true;
    requestVersion.current += 1;
    setPending("start");
    setError(null);
    void startOrdinaryJiraAi(issue.key, { projectId: selectedProject.id, projectPath: selectedProject.pathWithNamespace, targetBranch: targetBranch.trim(), precheckId: precheck.id, confirmed: true })
      .then((response) => { setCurrentTask(response.task); setOpen(true); onNotice?.("已确认 Jira 内容，AI 处理任务已启动"); })
      .catch((nextError) => { const message = assistantErrorMessage(nextError); setError(message); onError(message); })
      .finally(() => { mutationPending.current = false; setPending(null); });
  };

  const retry = () => {
    if (!task || busy) return;
    mutationPending.current = true;
    requestVersion.current += 1;
    setPending("retry");
    setError(null);
    void retryOrdinaryJiraAi(task.id)
      .then((response) => setCurrentTask(response.task))
      .catch((nextError) => { const message = assistantErrorMessage(nextError); setError(message); onError(message); })
      .finally(() => { mutationPending.current = false; setPending(null); });
  };

  const cancel = () => {
    if (!task || busy) return;
    mutationPending.current = true;
    requestVersion.current += 1;
    setPending("cancel");
    void cancelOrdinaryJiraAi(task.id)
      .then((response) => setCurrentTask(response.task))
      .catch((nextError) => { const message = assistantErrorMessage(nextError); setError(message); onError(message); })
      .finally(() => { mutationPending.current = false; setPending(null); });
  };

  const openMr = () => {
    if (!task?.mr) return;
    navigate(`/gitlab-workbench?${new URLSearchParams({ projectId: task.mr.projectId, mrIid: task.mr.iid })}`);
  };

  const execution = detail && detail.execution?.id === task?.assistantRunId ? detail.execution : null;
  const executions = useMemo(() => {
    const history = detail?.executions ?? [];
    if (!execution) return history;
    return history.some((run) => run.id === execution.id)
      ? history.map((run) => run.id === execution.id ? execution : run)
      : [...history, execution];
  }, [detail?.executions, execution]);
  const activities = useMemo(() => assistantActivitiesFromRuns(executions), [executions]);
  const latestExecution = execution ?? [...executions].sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)).at(-1) ?? null;
  const answer = [...(latestExecution?.events ?? [])].reverse().find((event) => event.event === "done")?.payload.message;
  const operations = detail?.editSession?.operations ?? [];
  const changedFiles = detail?.editSession?.changedFiles ?? 0;
  const editSessionId = detail?.editSession?.id ?? task?.editSessionId ?? null;
  const taskError = error || (!busy && task?.error) || task?.syncError;

  const handleOpen = () => {
    setOpen(true);
    if (task?.mr) return;
    if (task) return;
    setError(null);
  };
  const label = statusLabel(task, precheck, busy || processing);
  const StatusIcon = busy || processing ? LoaderCircle : task?.status === "failed" || precheck?.status === "needs_input" ? CircleAlert : task?.status === "merged" ? CheckCircle2 : task?.mr ? GitMerge : Sparkles;

  return <>
    <Button variant={task || precheck ? "outline" : "default"} size="sm" type="button" onClick={handleOpen}><StatusIcon className={busy || processing ? "is-spinning" : undefined} aria-hidden="true" />{label}</Button>
    {task?.mr && <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(true)}>处理过程</Button>}
    {open && <ReviewDrawerShell eyebrow={`普通 Jira · ${issue.key}`} title="AI 处理" titleId={`ordinary-jira-ai-title-${issue.key}`} closeLabel="关闭 AI 处理过程" isClosing={false} onRequestClose={() => setOpen(false)} contentClassName="jira-detail-drawer-content inspection-ai-drawer-content">
      <div className="inspection-ai-process">
        <section className="inspection-ai-overview" aria-label="普通 Jira AI 处理">
          <h3>{issue.summary}</h3>
          {!task && <>
            <p className="ordinary-jira-ai-intro">普通 Jira 需要先检查描述和评论是否包含足够上下文。每个缺失项可以先让 AI 尝试补充；AI 无法可靠判断时，再回 Jira 补充。</p>
            <GitLabOAuthPanel
              sessionReady={sessionReady}
              returnTo={oauthReturnTo}
              hideWhenConnected
              onStatusChange={setGitlabOAuthStatus}
              onNotice={(message) => onNotice?.(message)}
              onError={(message) => { setError(message); if (message) onError(message); }}
            />
            <div className="ordinary-jira-ai-context-fields">
              <div><span>GitLab 项目</span><GitLabSearchableSelect ariaLabel="GitLab 项目" value={projectId} options={projectOptions(projects)} emptyLabel="暂无可用项目" placeholder={projectsLoading ? "正在读取项目…" : "选择 GitLab 项目"} searchPlaceholder="搜索 GitLab 项目…" showEmptyOption={false} disabled={projectsLoading || !projectsLoaded || Boolean(projectsError) || busy} onChange={(value) => { setProjectId(value); setTargetBranch(""); setPrecheck(null); setSupplement(null); }} />{projectsError && <div className="ordinary-jira-ai-project-error" role="alert"><CircleAlert aria-hidden="true" /><span>{projectsError}</span><Button variant="outline" size="sm" type="button" onClick={retryProjects} disabled={projectsLoading}>{projectsLoading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}重新读取项目</Button></div>}</div>
              <div><span>目标分支</span>{branches.length > 0 ? <Select value={targetBranch} onValueChange={(value) => { setTargetBranch(value); setPrecheck(null); setSupplement(null); }} disabled={branchesLoading || busy}><SelectTrigger aria-label="目标分支"><SelectValue placeholder="选择目标分支" /></SelectTrigger><SelectContent>{branches.map((branch) => <SelectItem key={branch} value={branch}>{branch}</SelectItem>)}</SelectContent></Select> : <span className="ordinary-jira-ai-branch-fallback"><GitBranch aria-hidden="true" /><input aria-label="目标分支" value={targetBranch} onChange={(event) => { setTargetBranch(event.target.value); setPrecheck(null); setSupplement(null); }} placeholder="main" disabled={!selectedProject || busy} /></span>}</div>
            </div>
            {!precheck && <Button type="button" onClick={runPrecheck} disabled={busy || !selectedProject || !targetBranch.trim()}>{pending === "precheck" || precheckProcessing ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{pending === "precheck" || precheckProcessing ? "正在检查 Jira…" : "开始预检查"}</Button>}
          </>}
          {taskError && <p className="inspection-ai-error" role="alert"><CircleAlert aria-hidden="true" />{taskError}</p>}
          {precheck && !task && <section className="ordinary-jira-ai-checklist" aria-label="Jira 内容预检查">
            <div className="ordinary-jira-ai-checklist-heading"><div><strong>{precheck.status === "passed" ? "预检查通过" : "需要补充 Jira 信息"}</strong><span>{precheck.summary}</span></div><span className={precheck.status === "passed" ? "is-passed" : "is-missing"}>{precheck.status === "passed" ? "可继续" : "未通过"}</span></div>
            <div className="ordinary-jira-ai-checks">
              {precheck.checks.map((check) => {
                const activeSupplement = supplement?.checkId === check.id ? supplement : null;
                return <div className={`ordinary-jira-ai-check ${check.status === "present" ? "is-present" : "is-missing"}`} key={check.id}>
                  {check.status === "present" ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
                  <div><strong>{check.label}</strong><span>{check.status === "present" ? check.evidence : check.detail}</span></div>
                  {check.status === "missing" && <div className="ordinary-jira-ai-check-actions">
                    <Button variant="ghost" size="sm" type="button" onClick={() => requestSupplement(check)} disabled={busy}>{supplementingCheckId === check.id ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{supplementingCheckId === check.id ? "AI 判断中…" : "AI 补充"}</Button>
                  </div>}
                  {activeSupplement && <div className={`ordinary-jira-ai-supplement-card ${activeSupplement.status === "needs_user" ? "is-needs-user" : ""}`} role="status">
                    {activeSupplement.status === "resolvable" ? <>
                      <strong>AI 建议补充</strong>
                      <p>{activeSupplement.suggestion}</p>
                      <span>依据：{activeSupplement.evidence}</span>
                      <small>确认后会作为 Jira 评论写入，并自动重新执行预检查。</small>
                      <div><Button size="sm" type="button" onClick={() => confirmSupplement(check.id)} disabled={busy}>{supplementingCheckId === check.id ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}{supplementingCheckId === check.id ? "正在写入并检查…" : "确认写入并重新检查"}</Button><Button variant="outline" size="sm" type="button" onClick={() => setSupplement(null)} disabled={busy}>取消</Button></div>
                    </> : <>
                      <p>AI 无法从当前 Jira 内容可靠判断：{activeSupplement.reason}</p>
                      <div><a href={issue.webUrl} target="_blank" rel="noreferrer">去 Jira 补充<ExternalLink aria-hidden="true" /></a><Button variant="outline" size="sm" type="button" onClick={() => requestSupplement(check)} disabled={busy}><RotateCcw aria-hidden="true" />再试一次</Button></div>
                    </>}
                  </div>}
                </div>;
              })}
            </div>
            {precheck.status === "passed" ? <div className="ordinary-jira-ai-confirm"><h4>AI 将按以下范围实现</h4><dl>{Object.entries(precheck.implementationBrief).map(([key, value]) => <div key={key}><dt>{briefLabels[key as keyof typeof briefLabels] ?? key}</dt><dd>{value || "按 Jira 已确认内容处理"}</dd></div>)}</dl><p>请确认以上整理与 Jira 一致。确认后才会创建隔离工作区并开始修改代码。</p><Button type="button" onClick={start} disabled={busy}>{pending === "start" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}{pending === "start" ? "正在启动…" : "确认并开始 AI处理"}</Button></div> : <div className="ordinary-jira-ai-missing-actions"><p>每个 × 项都可以先点“AI 补充”；AI 无法可靠判断的内容，再去 Jira 补充后重新检查。</p><div><a href={issue.webUrl} target="_blank" rel="noreferrer">去 Jira 补充<ExternalLink aria-hidden="true" /></a><Button variant="outline" size="sm" type="button" onClick={runPrecheck} disabled={busy}>{pending === "precheck" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}重新检查</Button></div></div>}
          </section>}
          {task && <div className="inspection-ai-status" data-status={task.status}><div className="inspection-ai-status-copy"><span className="inspection-ai-status-badge" role="status"><StatusIcon className={busy || processing ? "is-spinning" : undefined} aria-hidden="true" />{task.phase}</span><p>{statusNote(task)}</p></div><div className="inspection-ai-actions">{processing && <Button variant="outline" size="sm" type="button" onClick={cancel} disabled={busy}><Square aria-hidden="true" />{pending === "cancel" ? "正在停止…" : "停止处理"}</Button>}{task.mr && <Button size="sm" type="button" onClick={openMr}><GitMerge aria-hidden="true" />{task.status === "merged" ? "查看已合并 MR" : "MR详情"}</Button>}{["failed", "canceled"].includes(task.status) && <Button size="sm" type="button" onClick={retry} disabled={busy}><RotateCcw aria-hidden="true" />{pending === "retry" ? "正在继续…" : "继续处理"}</Button>}</div></div>}
          {task && <dl className="inspection-ai-context"><div><dt>项目</dt><dd>{task.projectPath}</dd></div><div><dt>合并目标</dt><dd><code>{task.targetBranch}</code></dd></div><div><dt>开发分支</dt><dd><code>{task.sourceBranch}</code></dd></div></dl>}
        </section>
        {task?.preReview && <section className="inspection-ai-section" aria-label="提交前 Review"><h4>提交前 Review{task.preReview.attempt > 0 && <span>已检查 {task.preReview.attempt} 轮</span>}</h4><dl className="inspection-ai-verification"><div><dt>状态</dt><dd>{task.preReview.status === "passed" ? "已通过" : task.preReview.status === "findings" ? "发现问题" : task.preReview.status === "pending" ? "检查中" : "执行失败"}</dd></div><div><dt>未满足 Jira 要求</dt><dd>{task.preReview.missingRequirementCount}</dd></div><div><dt>待 Pipeline 验证</dt><dd>{task.preReview.unclearRequirementCount}</dd></div><div><dt>阻断代码问题</dt><dd>{task.preReview.blockingFindingCount}</dd></div></dl><ReviewProgressPanel events={task.preReview.progress} live={task.preReview.status === "pending" && processing} />{task.preReview.report && <div className="inspection-ai-verification-report"><AssistantMarkdown text={task.preReview.report} /></div>}</section>}
        {task?.verification && <section className="inspection-ai-section" aria-label="Pipeline 验收"><h4>Pipeline 验收{task.verification.repairAttempts > 0 && <span>已自动修复 {task.verification.repairAttempts} 轮</span>}</h4><dl className="inspection-ai-verification"><div><dt>当前提交</dt><dd><code>{task.verification.headSha ?? "等待提交"}</code></dd></div><div><dt>Pipeline</dt><dd>{task.verification.pipelineWebUrl ? <a href={task.verification.pipelineWebUrl} target="_blank" rel="noreferrer">#{task.verification.pipelineId} · {task.verification.pipelineStatus ?? "等待中"}<ExternalLink aria-hidden="true" /></a> : task.verification.pipelineStatus ?? "等待中"}</dd></div><div><dt>Pipeline Review</dt><dd>{task.verification.reviewJobWebUrl ? <a href={task.verification.reviewJobWebUrl} target="_blank" rel="noreferrer">{task.verification.reviewJobName} · {task.verification.reviewStatus === "passed" ? "已通过" : task.verification.reviewJobStatus ?? "等待中"}<ExternalLink aria-hidden="true" /></a> : task.verification.reviewJobName ?? "等待执行"}</dd></div></dl>{task.verification.report && <div className="inspection-ai-verification-report"><AssistantMarkdown text={task.verification.report} /></div>}</section>}
        {activities.length > 0 && <section className="inspection-ai-section" aria-label="执行过程"><h4>执行过程{executions.length > 1 && <span>{executions.length} 轮</span>}</h4><AssistantActivityPanel activities={activities} streaming={execution?.status === "running" && processing} hasError={execution?.status === "failed"} stopped={task?.status === "canceled"} defaultOpen showCompleted /></section>}
        {task && detail && <section className="inspection-ai-section" aria-label="代码改动"><h4>代码改动{changedFiles > 0 ? <span>{changedFiles} 个文件</span> : operations.length > 0 ? <span>{operations.length} 处修改</span> : null}</h4>{operations.map((operation) => <AssistantEditOperationCard key={operation.id} operation={operation} published={Boolean(task.mr)} />)}{changedFiles > 0 && editSessionId ? <AssistantWorkspaceDiffCard sessionId={editSessionId} changedFiles={changedFiles} live={processing} published={Boolean(task.mr)} /> : operations.length === 0 ? <p className="inspection-ai-empty"><Code2 aria-hidden="true" />{processing ? "完成代码修改后，改动会显示在这里。" : "本次尚未产生代码改动。"}</p> : null}</section>}
        {typeof answer === "string" && <section className="inspection-ai-section" aria-label="处理结果"><h4>处理结果</h4><AssistantMarkdown text={answer} /></section>}
      </div>
    </ReviewDrawerShell>}
  </>;
}
