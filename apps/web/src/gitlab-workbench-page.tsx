import { InspectionAccessPage } from "./inspection-access-page";
import { useIntegrationApi } from "./integration-api-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { GitLabMergeRequest, GitLabMergeRequestDetails, GitLabPipeline, GitLabPipelineJob, GitLabOverviewResponse, GitLabProjectsResponse, GitLabProjectConfig } from "@contracts";
import { CircleAlert, GitBranch, GitMerge, LayoutDashboard, LoaderCircle, MessageSquare, Plus, RefreshCw, Search, Settings2 } from "lucide-react";
import {
  createReviewProfile,
  type GitLabMergeRequestListQuery,
  type GitLabOAuthStatus,
} from "./api";
import { errorMessage } from "./review-ui-utils";
import { GitLabOAuthDrawer, GitLabOAuthPanel } from "./assistant-gitlab-oauth";
import { GitLabMergeRequestDrawer, GitLabMergeRequestList, GitLabMetric, GitLabPipelineDetails, GitLabPipelineList, GitLabProjectList, pipelineStatusLabel } from "./gitlab-workbench-components";
import { GitLabCreateMergeRequestDrawer } from "./gitlab-create-merge-request-drawer";
import type { ReviewJob } from "@contracts";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type GitLabWorkbenchTab = "overview" | "merge-requests" | "pipelines" | "projects";

type ProjectSearchFormValues = {
  search: string;
};

type GitLabWorkbenchPageProps = {
  isAdmin?: boolean;
  inspection?: boolean;
  sessionReady: boolean;
  reviewJobs: ReviewJob[];
  onReviewChanged: () => void | Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

const defaultMergeRequestQuery: GitLabMergeRequestListQuery = { scope: "assigned_to_me", state: "opened", page: 1, perPage: 25 };

function mergeRequestKey(item: Pick<GitLabMergeRequest, "projectId" | "iid">): string {
  return `${item.projectId}:${item.iid}`;
}

function uniqueMergeRequests(items: GitLabMergeRequest[]): GitLabMergeRequest[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = mergeRequestKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function GitLabWorkbenchPage(props: GitLabWorkbenchPageProps) {
  const [search] = useSearchParams();
  if (search.get("inspection") === "1") return <InspectionAccessPage sessionReady={props.sessionReady} isAdmin={Boolean(props.isAdmin)} onNotice={props.onNotice} onError={props.onError} requiredMaintainerId={search.get("maintainerId") ?? undefined}>
    <GitLabWorkbenchContent {...props} inspection reviewJobs={[]} />
  </InspectionAccessPage>;
  return <GitLabWorkbenchContent {...props} />;
}

function GitLabWorkbenchContent({ inspection = false, sessionReady, reviewJobs, onReviewChanged, onNotice, onError }: GitLabWorkbenchPageProps) {
  const { cancelGitLabPipeline, getGitLabMergeRequest, getGitLabOverview, listGitLabPipelineJobs, listGitLabPipelines, listGitLabProjects, listGitLabMergeRequests, retryGitLabPipeline, getGitLabOAuthStatus } = useIntegrationApi();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const linkedProjectId = search.get("projectId");
  const linkedMrIid = search.get("mrIid");
  const mergeRequestRequestRef = useRef(0);
  const [activeTab, setActiveTab] = useState<GitLabWorkbenchTab>("overview");
  const [oauthDrawerOpen, setOauthDrawerOpen] = useState(false);
  const [createMergeRequestOpen, setCreateMergeRequestOpen] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<GitLabOAuthStatus | null>(null);
  const [overview, setOverview] = useState<GitLabOverviewResponse | null>(null);
  const [projectsResponse, setProjectsResponse] = useState<GitLabProjectsResponse | null>(null);
  const [mergeRequests, setMergeRequests] = useState<GitLabMergeRequest[]>([]);
  const [mergeRequestQuery, setMergeRequestQuery] = useState(defaultMergeRequestQuery);
  const [mergeRequestSearch, setMergeRequestSearch] = useState("");
  const [mergeRequestSearchDraft, setMergeRequestSearchDraft] = useState("");
  const projectSearchForm = useForm<ProjectSearchFormValues>({ defaultValues: { search: "" } });
  const projectSearchValue = projectSearchForm.watch("search");
  const [projectSearch, setProjectSearch] = useState("");
  const projectSearchRequestRef = useRef(0);
  const [selectedMrKey, setSelectedMrKey] = useState<string | null>(null);
  const [selectedMr, setSelectedMr] = useState<GitLabMergeRequest | null>(null);
  const [detail, setDetail] = useState<GitLabMergeRequestDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingMrs, setLoadingMrs] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<GitLabPipeline[]>([]);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineRef, setPipelineRef] = useState("");
  const [pipelineStatus, setPipelineStatus] = useState("");
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [pipelineJobs, setPipelineJobs] = useState<GitLabPipelineJob[]>([]);
  const [pipelineJobsLoading, setPipelineJobsLoading] = useState(false);
  const pipelineJobsRequestRef = useRef(0);
  const [pipelineActionId, setPipelineActionId] = useState<string | null>(null);
  const [creatingProfile, setCreatingProfile] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionReady) return;
    let active = true;
    void getGitLabOAuthStatus()
      .then((next) => {
        if (active) {
          setOauthStatus(next);
          onError(null);
        }
      })
      .catch((error) => {
        if (active) {
          setOauthStatus({ configured: false, connected: false, identity: null });
          onError(errorMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, [onError, sessionReady]);

  useEffect(() => {
    const oauthState = new URLSearchParams(window.location.search).get("oauth");
    if (oauthState === "connected") onNotice("GitLab 账号已连接，工作台现在使用你的权限");
    if (oauthState === "error") onError("GitLab 登录未完成，请重试");
    if (oauthState) window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, [onError, onNotice]);

  const loadOverview = useCallback(async () => {
    if (!sessionReady || oauthStatus?.connected !== true) return;
    setLoadingOverview(true);
    try {
      const next = await getGitLabOverview();
      setOverview(next);
      setMergeRequests((current) => current.length > 0 ? current : next.assigned);
      setLoadError(null);
    } catch (error) {
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      setLoadingOverview(false);
    }
  }, [oauthStatus?.connected, onError, sessionReady]);

  const loadProjects = useCallback(async (search = projectSearch) => {
    if (!sessionReady || oauthStatus?.connected !== true) return;
    const requestId = projectSearchRequestRef.current + 1;
    projectSearchRequestRef.current = requestId;
    setLoadingProjects(true);
    try {
      const next = await listGitLabProjects({ search, page: 1, perPage: 30 });
      if (requestId !== projectSearchRequestRef.current) return;
      setProjectsResponse(next);
      setSelectedProjectId((current) => current && next.projects.some((project) => project.id === current) ? current : next.projects[0]?.id ?? null);
      setLoadError(null);
    } catch (error) {
      if (requestId !== projectSearchRequestRef.current) return;
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      if (requestId === projectSearchRequestRef.current) setLoadingProjects(false);
    }
  }, [oauthStatus?.connected, onError, projectSearch, sessionReady]);

  const loadMergeRequests = useCallback(async (query = mergeRequestQuery, search = mergeRequestSearch) => {
    if (!sessionReady || oauthStatus?.connected !== true) return;
    const requestId = mergeRequestRequestRef.current + 1;
    mergeRequestRequestRef.current = requestId;
    setLoadingMrs(true);
    try {
      const next = await listGitLabMergeRequests({ ...query, search: search || undefined });
      if (requestId !== mergeRequestRequestRef.current) return;
      setMergeRequests(next.mergeRequests);
      setLoadError(null);
    } catch (error) {
      if (requestId !== mergeRequestRequestRef.current) return;
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      if (requestId === mergeRequestRequestRef.current) setLoadingMrs(false);
    }
  }, [mergeRequestQuery, mergeRequestSearch, oauthStatus?.connected, onError, sessionReady]);

  useEffect(() => {
    if (!sessionReady || oauthStatus?.connected !== true) return;
    void loadOverview();
  }, [loadOverview, oauthStatus?.connected, sessionReady]);

  useEffect(() => {
    if (!sessionReady || oauthStatus?.connected !== true) return;
    void loadProjects();
  }, [loadProjects, oauthStatus?.connected, sessionReady]);

  useEffect(() => {
    const nextSearch = mergeRequestSearchDraft.trim();
    const timer = window.setTimeout(() => {
      setMergeRequestSearch((current) => current === nextSearch ? current : nextSearch);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [mergeRequestSearchDraft]);

  useEffect(() => {
    const nextSearch = projectSearchValue.trim();
    const timer = window.setTimeout(() => {
      setProjectSearch((current) => current === nextSearch ? current : nextSearch);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [projectSearchValue]);

  useEffect(() => {
    if (activeTab === "merge-requests") void loadMergeRequests();
  }, [activeTab, loadMergeRequests]);

  const loadPipelineList = useCallback(async (ref = "", status = "") => {
    if (!selectedProjectId || !sessionReady || oauthStatus?.connected !== true) return;
    pipelineJobsRequestRef.current += 1;
    setPipelineLoading(true);
    try {
      const response = await listGitLabPipelines(selectedProjectId, { ref: ref || undefined, status: status || undefined, page: 1, perPage: 30 });
      setPipelines(response.pipelines);
      setSelectedPipelineId(null);
      setPipelineJobs([]);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPipelineLoading(false);
    }
  }, [oauthStatus?.connected, onError, selectedProjectId, sessionReady]);

  useEffect(() => {
    if (activeTab === "pipelines" && selectedProjectId) void loadPipelineList();
  }, [activeTab, loadPipelineList, selectedProjectId]);

  useEffect(() => {
    if (activeTab === "overview" && selectedProjectId && pipelines.length === 0) void loadPipelineList();
  }, [activeTab, loadPipelineList, pipelines.length, selectedProjectId]);

  const openMergeRequest = async (item: GitLabMergeRequest) => {
    setSelectedMr(item);
    setSelectedMrKey(mergeRequestKey(item));
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await getGitLabMergeRequest(item.projectId, item.iid));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async () => {
    if (!selectedMr) return;
    setDetailLoading(true);
    try {
      setDetail(await getGitLabMergeRequest(selectedMr.projectId, selectedMr.iid));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const selectPipeline = async (pipeline: GitLabPipeline) => {
    if (!selectedProjectId) return;
    const requestId = pipelineJobsRequestRef.current + 1;
    pipelineJobsRequestRef.current = requestId;
    if (selectedPipelineId === pipeline.id) {
      setSelectedPipelineId(null);
      setPipelineJobs([]);
      setPipelineJobsLoading(false);
      return;
    }
    setSelectedPipelineId(pipeline.id);
    setPipelineJobs([]);
    setPipelineJobsLoading(true);
    try {
      const response = await listGitLabPipelineJobs(selectedProjectId, pipeline.id);
      if (requestId !== pipelineJobsRequestRef.current) return;
      setPipelineJobs(response.jobs);
    } catch (error) {
      if (requestId !== pipelineJobsRequestRef.current) return;
      onError(errorMessage(error));
    } finally {
      if (requestId === pipelineJobsRequestRef.current) setPipelineJobsLoading(false);
    }
  };

  const changePipeline = async (pipeline: GitLabPipeline, action: "retry" | "cancel") => {
    if (!selectedProjectId) return;
    setPipelineActionId(pipeline.id);
    try {
      const next = action === "retry" ? await retryGitLabPipeline(selectedProjectId, pipeline.id) : await cancelGitLabPipeline(selectedProjectId, pipeline.id);
      setPipelines((current) => current.map((item) => item.id === next.id ? next : item));
      onNotice(action === "retry" ? `Pipeline #${next.id} 已重新执行` : `Pipeline #${next.id} 已取消`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPipelineActionId(null);
    }
  };

  const createProjectProfile = async (project: GitLabProjectConfig) => {
    setCreatingProfile(project.pathWithNamespace);
    try {
      await createReviewProfile({ profile: project.pathWithNamespace, displayName: project.name });
      onNotice(`已为 ${project.pathWithNamespace} 创建专属 Review profile`);
      await loadProjects();
      navigate(`/review-rules?profile=${encodeURIComponent(project.pathWithNamespace)}`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setCreatingProfile(null);
    }
  };

  const handleMergeRequestCreated = async (created: GitLabMergeRequest) => {
    setCreateMergeRequestOpen(false);
    setMergeRequestQuery({ ...defaultMergeRequestQuery, scope: "created_by_me" });
    setMergeRequestSearch("");
    setMergeRequestSearchDraft("");
    await loadMergeRequests({ ...defaultMergeRequestQuery, scope: "created_by_me" }, "");
    await openMergeRequest(created);
  };

  useEffect(() => {
    if (!oauthStatus?.connected || !linkedProjectId || !linkedMrIid) return;
    let active = true;
    setActiveTab("merge-requests"); setDetailLoading(true);
    void getGitLabMergeRequest(linkedProjectId, linkedMrIid).then((mr) => {
      if (active) { setSelectedMr(mr); setSelectedMrKey(mergeRequestKey(mr)); setDetail(mr); }
    }).catch((error) => { if (active) onError(errorMessage(error)); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [oauthStatus?.connected, linkedProjectId, linkedMrIid, getGitLabMergeRequest, onError]);

  const assignedCount = overview?.assigned.length ?? 0;
  const reviewRequestedCount = overview?.reviewRequested.length ?? 0;
  const createdCount = overview?.created.length ?? 0;
  const activeProject = projectsResponse?.projects.find((project) => project.id === selectedProjectId) ?? null;
  const overviewMerges = useMemo(() => uniqueMergeRequests([...(overview?.reviewRequested ?? []), ...(overview?.assigned ?? []), ...(overview?.created ?? [])]), [overview]);
  const currentReviewJob = detail ? reviewJobs.find((job) => job.projectId === detail.projectId && job.mrIid === detail.iid && (!detail.headSha || !job.headSha || job.headSha === detail.headSha)) ?? null : null;
  const activeReviewCount = reviewJobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const customProfileCount = projectsResponse?.projects.filter((project) => project.customReviewProfile).length ?? 0;
  const tabItems = [
    { id: "overview" as const, label: "概览", caption: "今日工作", icon: LayoutDashboard, count: null },
    { id: "merge-requests" as const, label: "Merge Requests", caption: "处理队列", icon: GitMerge, count: assignedCount + reviewRequestedCount },
    { id: "pipelines" as const, label: "Pipelines", caption: "构建状态", icon: RefreshCw, count: pipelines.length || null },
    { id: "projects" as const, label: "项目配置", caption: "Review 规则", icon: GitBranch, count: customProfileCount || null },
  ];

  if (!sessionReady) return <div className="gitlab-workbench-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在等待页面会话</strong><span>建立服务会话后即可读取 GitLab 数据。</span></div>;
  if (!oauthStatus) return <div className="gitlab-workbench-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在检查 GitLab 登录状态</strong><span>确认当前工作台账号后再读取数据。</span></div>;
  if (!oauthStatus.connected) return <section className="gitlab-workbench-page" aria-label="GitLab 工作台">
    <div className="gitlab-workbench-account-content">
      <div className="gitlab-workbench-account-intro">
        <h2>{oauthStatus.configured ? "先连接你的 GitLab 账号" : "GitLab 登录暂不可用"}</h2>
        <p>{oauthStatus.configured ? "连接个人账号后，工作台中的 MR、Pipeline 和 Review 操作都会使用你的 GitLab 权限。" : "当前工作区还没有完成个人 GitLab 登录配置。请先在连接设置中完成配置。"}</p>
        {!oauthStatus.configured && <Button type="button" onClick={() => navigate(inspection ? "/inspection-workbench?accounts=1" : "/gitlab-settings")}><Settings2 aria-hidden="true" />打开连接设置</Button>}
      </div>
      <GitLabOAuthPanel inspection={inspection} sessionReady={sessionReady} onStatusChange={setOauthStatus} onNotice={onNotice} onError={onError} />
    </div>
  </section>;

  return (
    <>
      <section className="gitlab-workbench-page" aria-label="GitLab 工作台">
      <header className="gitlab-workbench-heading">
      <div className="gitlab-workbench-heading-copy">
        <div className="gitlab-workbench-title-row"><h2>{overview?.user.name || overview?.user.username || "我的 GitLab"}</h2><span className="gitlab-workbench-sync"><i aria-hidden="true" />GitLab 已连接</span></div>
        <p>{inspection ? "使用当前维护人员的 GitLab 账号查看 MR、评论和流水线。" : "把 MR、Pipeline 和 Review 放在同一条交付路径上。"}</p>
      </div>
      <div className="gitlab-workbench-heading-actions">
        <div className="gitlab-workbench-action-group">
          <Button type="button" size="sm" onClick={() => setCreateMergeRequestOpen(true)} disabled={!projectsResponse || projectsResponse.projects.length === 0}><Plus aria-hidden="true" />新建 MR</Button>
          <Button variant="outline" size="sm" type="button" aria-haspopup="dialog" aria-expanded={oauthDrawerOpen} onClick={() => setOauthDrawerOpen(true)}><Settings2 aria-hidden="true" />连接设置</Button>
          <Button variant="outline" size="icon" type="button" aria-label="刷新 GitLab 数据" title="刷新 GitLab 数据" onClick={() => { void loadOverview(); void loadProjects(); }} disabled={loadingOverview || loadingProjects}><RefreshCw aria-hidden="true" className={loadingOverview || loadingProjects ? "is-spinning" : ""} /></Button>
        </div>
      </div>
    </header>
    <nav className="gitlab-workbench-tabs" aria-label="GitLab 工作台菜单">
      <div className="gitlab-workbench-tabs-label"><span>WORKSPACE</span><strong>GitLab</strong></div>
      <div className="gitlab-workbench-tab-list">{tabItems.filter((tab) => !inspection || tab.id !== "projects").map(({ id, label, caption, icon: Icon, count }) => <Button key={id} variant="ghost" className={activeTab === id ? "is-active" : ""} type="button" aria-current={activeTab === id ? "page" : undefined} onClick={() => setActiveTab(id)}><Icon aria-hidden="true" /><span><strong>{label}</strong><small>{caption}</small></span>{count !== null && <em>{count}</em>}</Button>)}</div>
    </nav>
    {loadError && <div className="gitlab-workbench-error" role="alert"><CircleAlert aria-hidden="true" /><span>{loadError}</span><Button variant="ghost" size="sm" type="button" onClick={() => { void loadOverview(); void loadProjects(); }}>重新读取</Button></div>}
    {activeTab === "overview" && <div className="gitlab-workbench-content">
      <div className="gitlab-overview-intro"><div><h3>先处理最重要的 MR</h3><p>{overviewMerges.length ? `当前有 ${overviewMerges.length} 个 MR 需要你留意。` : "当前没有待处理的开放 MR。"} {!inspection && (activeReviewCount > 0 ? `另有 ${activeReviewCount} 个 Review 正在运行。` : "Review 任务池目前空闲。")}</p></div><span className="gitlab-overview-time"><i aria-hidden="true" />数据实时同步</span></div>
      <div className="gitlab-metrics-grid"><GitLabMetric label="待我处理" value={assignedCount} note="已指派给我" tone="tone-blue" icon={<GitBranch aria-hidden="true" />} onClick={() => { setMergeRequestQuery({ ...defaultMergeRequestQuery, scope: "assigned_to_me" }); setActiveTab("merge-requests"); }} /><GitLabMetric label="请求审查" value={reviewRequestedCount} note="等待我的 Review" tone="tone-purple" icon={<GitMerge aria-hidden="true" />} onClick={() => { setMergeRequestQuery({ ...defaultMergeRequestQuery, scope: "review_requested" }); setActiveTab("merge-requests"); }} /><GitLabMetric label="我创建的" value={createdCount} note="当前开放 MR" tone="tone-green" icon={<MessageSquare aria-hidden="true" />} onClick={() => { setMergeRequestQuery({ ...defaultMergeRequestQuery, scope: "created_by_me" }); setActiveTab("merge-requests"); }} /><GitLabMetric label="Pipeline" value={pipelines.length || "—"} note={activeProject ? `${activeProject.name} 最近状态` : "打开 Pipeline 查看"} tone="tone-amber" icon={<RefreshCw aria-hidden="true" />} onClick={() => setActiveTab("pipelines")} /></div>
      <div className="gitlab-workbench-overview-grid"><section className="gitlab-workbench-panel gitlab-attention-panel"><div className="gitlab-panel-heading"><div><strong>需要你出手<span className="gitlab-queue-signal-inline"><i aria-hidden="true" />优先级已按更新时间排序</span></strong><small>请求审查和指派给你的开放 MR</small></div><span className="gitlab-panel-count">{overviewMerges.length} 个</span></div><GitLabMergeRequestList items={overviewMerges.slice(0, 8)} jobs={reviewJobs} selectedKey={selectedMrKey} onSelect={(item) => void openMergeRequest(item)} /></section></div>
    </div>}
    {activeTab === "merge-requests" && <div className="gitlab-workbench-content"><div className="gitlab-section-page-heading"><div><span className="gitlab-content-eyebrow">INBOX / MERGE REQUESTS</span><h3>Merge Requests</h3><p>{inspection ? "按职责和状态筛选，点击记录查看代码变更和评论。" : "按职责和状态筛选，点击一条记录查看变更、评论和 Review。"}</p></div><div className="gitlab-section-page-meta"><strong>{loadingMrs ? "正在读取…" : mergeRequests.length}</strong><span>条记录</span></div></div><div className="gitlab-filter-bar"><div className="gitlab-filter-tabs">{([ ["assigned_to_me", "指派给我"], ["review_requested", "请求我审查"], ["created_by_me", "我创建的"], ["all", "全部"] ] as const).map(([value, label]) => <Button key={value} variant="ghost" className={mergeRequestQuery.scope === value ? "is-active" : ""} type="button" onClick={() => setMergeRequestQuery((current) => ({ ...current, scope: value }))}>{label}</Button>)}</div><label className="gitlab-select-control"><span>状态</span><Select value={mergeRequestQuery.state} onValueChange={(value) => setMergeRequestQuery((current) => ({ ...current, state: value as GitLabMergeRequestListQuery["state"] }))}><SelectTrigger className="gitlab-select-trigger" aria-label="Merge Request 状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="opened">开放中</SelectItem><SelectItem value="merged">已合并</SelectItem><SelectItem value="closed">已关闭</SelectItem><SelectItem value="all">全部状态</SelectItem></SelectContent></Select></label><label className="gitlab-input-control gitlab-search-field"><span>关键词</span><div className="gitlab-search-control"><Search aria-hidden="true" /><Input aria-label="按标题搜索" value={mergeRequestSearchDraft} onChange={(event) => setMergeRequestSearchDraft(event.target.value)} placeholder="按标题搜索…" /></div></label></div><div className="gitlab-list-heading"><div><span className="gitlab-content-eyebrow">RESULTS</span><strong>{mergeRequestQuery.scope === "assigned_to_me" ? "指派给我" : mergeRequestQuery.scope === "review_requested" ? "请求我审查" : mergeRequestQuery.scope === "created_by_me" ? "我创建的" : "全部 Merge Requests"}</strong></div><Button variant="ghost" size="sm" type="button" onClick={() => void loadMergeRequests()} disabled={loadingMrs}><RefreshCw aria-hidden="true" className={loadingMrs ? "is-spinning" : ""} />刷新列表</Button></div>{loadingMrs && mergeRequests.length === 0 ? <div className="gitlab-workbench-state"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>正在读取 Merge Request</span></div> : <GitLabMergeRequestList items={mergeRequests} jobs={reviewJobs} selectedKey={selectedMrKey} onSelect={(item) => void openMergeRequest(item)} />}</div>}
    {activeTab === "pipelines" && <div className="gitlab-workbench-content"><div className="gitlab-section-page-heading"><div><span className="gitlab-content-eyebrow">CI / PIPELINES</span><h3>Pipeline 监控</h3><p>选择项目后，点击一条 Pipeline 查看具体详情和 Job 明细。</p></div><div className="gitlab-section-page-meta"><strong>{pipelineLoading ? "…" : pipelines.length}</strong><span>条记录</span></div></div><div className="gitlab-filter-bar gitlab-pipeline-filter-bar"><label className="gitlab-select-control gitlab-select-control-wide"><span>项目</span><Select value={selectedProjectId ?? "__none__"} onValueChange={(value) => setSelectedProjectId(value === "__none__" ? null : value)}><SelectTrigger className="gitlab-select-trigger" aria-label="选择项目"><SelectValue placeholder="选择项目" /></SelectTrigger><SelectContent><SelectItem value="__none__">选择项目</SelectItem>{projectsResponse?.projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.pathWithNamespace}</SelectItem>)}</SelectContent></Select></label><label className="gitlab-input-control"><span>Ref</span><Input value={pipelineRef} onChange={(event) => setPipelineRef(event.target.value)} placeholder="分支或 ref（可选）" /></label><label className="gitlab-select-control"><span>状态</span><Select value={pipelineStatus || "all"} onValueChange={(value) => setPipelineStatus(value === "all" ? "" : value)}><SelectTrigger className="gitlab-select-trigger" aria-label="Pipeline 状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="running">运行中</SelectItem><SelectItem value="success">成功</SelectItem><SelectItem value="failed">失败</SelectItem><SelectItem value="canceled">已取消</SelectItem></SelectContent></Select></label><Button type="button" onClick={() => void loadPipelineList(pipelineRef, pipelineStatus)} disabled={!selectedProjectId || pipelineLoading}><RefreshCw aria-hidden="true" className={pipelineLoading ? "is-spinning" : ""} />读取 Pipeline</Button></div>{!selectedProjectId ? <div className="gitlab-empty-state"><GitBranch aria-hidden="true" /><strong>选择一个项目开始</strong><span>项目的最近 Pipeline 和 Job 会显示在这里。</span></div> : pipelineLoading && pipelines.length === 0 ? <div className="gitlab-workbench-state"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>正在读取 Pipeline</span></div> : <><div className="gitlab-list-heading"><div><span className="gitlab-content-eyebrow">RECENT RUNS</span><strong>{activeProject?.pathWithNamespace || "项目 Pipeline"}</strong></div></div><GitLabPipelineList pipelines={pipelines} selectedId={selectedPipelineId} onSelect={(pipeline) => void selectPipeline(pipeline)} onRetry={(pipeline) => void changePipeline(pipeline, "retry")} onCancel={(pipeline) => void changePipeline(pipeline, "cancel")} busyId={pipelineActionId} expandedContent={(pipeline) => <GitLabPipelineDetails pipeline={pipeline} jobs={pipelineJobs} loadingJobs={pipelineJobsLoading} />} /></>}</div>}
    {activeTab === "projects" && <div className="gitlab-workbench-content"><div className="gitlab-section-page-heading"><div><h3>项目与 Review 规则</h3><p>把项目映射到专属规则，未配置的项目会使用默认 profile。</p></div><div className="gitlab-section-page-meta"><strong>{projectsResponse?.projects.length ?? 0}</strong><span>个项目</span></div></div><div className="gitlab-filter-bar"><div className="gitlab-search-control"><Search aria-hidden="true" /><Input value={projectSearchValue} onChange={(event) => projectSearchForm.setValue("search", event.target.value)} placeholder="按项目名或路径搜索…" /></div><Button variant="ghost" size="sm" type="button" onClick={() => void loadProjects()} disabled={loadingProjects}><RefreshCw aria-hidden="true" className={loadingProjects ? "is-spinning" : ""} />刷新列表</Button></div><div className="gitlab-list-heading"><div><strong>可访问项目</strong></div><span className="gitlab-list-note">{customProfileCount} 个已配置专属 profile</span></div>{loadingProjects && !projectsResponse ? <div className="gitlab-workbench-state"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>正在读取项目</span></div> : <GitLabProjectList projects={projectsResponse?.projects ?? []} onOpenRules={(project) => navigate(`/review-rules?profile=${encodeURIComponent(project.pathWithNamespace)}`)} onCreateProfile={(project) => void createProjectProfile(project)} creatingProfile={creatingProfile} />}</div>}
      <GitLabMergeRequestDrawer allowReview={!inspection} detail={detail} loading={detailLoading} reviewJob={currentReviewJob} onClose={() => { setSelectedMr(null); setDetail(null); setSelectedMrKey(null); setSearch((current) => { current.delete("mrIid"); current.delete("projectId"); return current; }, { replace: true }); }} onRefresh={refreshDetail} onListRefresh={loadMergeRequests} onReviewChanged={onReviewChanged} onNotice={onNotice} onError={onError} />
      </section>
      <GitLabCreateMergeRequestDrawer open={createMergeRequestOpen} projects={projectsResponse?.projects ?? []} defaultProjectId={selectedProjectId} onClose={() => setCreateMergeRequestOpen(false)} onCreated={handleMergeRequestCreated} onNotice={onNotice} onError={onError} />
      <GitLabOAuthDrawer inspection={inspection} open={oauthDrawerOpen} sessionReady={sessionReady} onClose={() => setOauthDrawerOpen(false)} onStatusChange={setOauthStatus} onNotice={onNotice} onError={onError} />
    </>
  );
}
