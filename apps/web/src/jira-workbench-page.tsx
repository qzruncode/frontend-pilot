import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, ClipboardList, Clock3, ExternalLink, FileText, LayoutDashboard, ListFilter, LoaderCircle, Plus, RefreshCw, Search, Settings2, X } from "lucide-react";
import type { JiraBoardColumnId, JiraBoardResponse, JiraIssue, JiraIssueDetails, JiraIssueTransition, JiraOverviewResponse, OrdinaryJiraAiPrecheckSummary, OrdinaryJiraAiTask, OrdinaryJiraAiTaskSummary } from "@contracts";
import { getJiraAccount, getJiraBoard, getJiraIssue, getJiraIssueTransitions, getJiraOverview, getOrdinaryJiraAiTaskSummaries, listJiraIssues, transitionJiraIssue, type JiraIssueListQuery } from "./api";
import { JiraAccountDrawer } from "./assistant-jira-account";
import { JiraCreateIssueDrawer } from "./jira-create-issue-drawer";
import { JiraBoardView } from "./jira-board-components";
import { InspectionAiAction, useInspectionJiraAiSource } from "./inspection-ai-action";
import { OrdinaryJiraAiAction } from "./ordinary-jira-ai-action";
import { IntegrationApiContext } from "./integration-api-context";
import { JiraIssueDetailPanel, JiraIssueList, JiraMetric } from "./jira-workbench-components";
import { isOrdinaryJiraAiTaskProcessing } from "./jira-ai-task-status";
import { errorMessage } from "./review-ui-utils";
import { PaginationBar } from "./user-activity-components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type JiraTab = "overview" | "board" | "issues";
const defaultQuery: JiraIssueListQuery = { scope: "assigned_to_me", state: "todo", page: 1, perPage: 25 };

function uniqueIssues(groups: JiraIssue[][]): JiraIssue[] {
  const seen = new Set<string>();
  return groups.flat().filter((issue) => seen.has(issue.key) ? false : (seen.add(issue.key), true));
}

function scopeLabel(scope: JiraIssueListQuery["scope"]): string {
  return scope === "assigned_to_me" ? "分配给我" : scope === "reported_by_me" ? "我报告的" : "全部问题";
}

function stateLabel(state: JiraIssueListQuery["state"]): string {
  return ({ review: "评审/设计", todo: "待办", in_progress: "处理中", acceptance: "验收中", done: "已完成", all: "全部状态" })[state];
}

function formatSyncTime(value: string | null): string {
  if (!value) return "尚未同步";
  return `上次同步 ${new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

async function fetchJiraIssueData(key: string) {
  const [detailResult, transitionsResult] = await Promise.allSettled([getJiraIssue(key), getJiraIssueTransitions(key)]);
  if (detailResult.status === "rejected") throw detailResult.reason;
  return {
    detail: detailResult.value,
    transitions: transitionsResult.status === "fulfilled" ? transitionsResult.value.transitions : [],
    transitionsError: transitionsResult.status === "rejected" ? errorMessage(transitionsResult.reason) : null,
  };
}

export function JiraWorkbenchPage({ sessionReady, username, onNotice, onError }: { sessionReady: boolean; username: string | null; onNotice: (message: string) => void; onError: (message: string | null) => void }) {
  const [connection, setConnection] = useState<{ baseUrl: string; projectKey: string; tokenConfigured: boolean } | null>(null);
  const [overview, setOverview] = useState<JiraOverviewResponse | null>(null);
  const [board, setBoard] = useState<JiraBoardResponse | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [total, setTotal] = useState(0);
  const [activeTab, setActiveTab] = useState<JiraTab>("board");
  const [boardMember, setBoardMember] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState<JiraIssueListQuery>(defaultQuery);
  const [searchDraft, setSearchDraft] = useState("");
  const [selectedIssue, setSelectedIssue] = useState<JiraIssue | null>(null);
  const [detail, setDetail] = useState<JiraIssueDetails | null>(null);
  const [transitions, setTransitions] = useState<JiraIssueTransition[]>([]);
  const [loadingConnection, setLoadingConnection] = useState(true);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [transitionsLoading, setTransitionsLoading] = useState(false);
  const [transitionsError, setTransitionsError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiTaskSummaries, setAiTaskSummaries] = useState<Record<string, OrdinaryJiraAiTaskSummary>>({});
  const [aiPrecheckSummaries, setAiPrecheckSummaries] = useState<Record<string, OrdinaryJiraAiPrecheckSummary>>({});
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const issueRequestId = useRef(0);
  const boardRequestId = useRef(0);
  const aiTaskSummaryRequestId = useRef(0);
  const restoredJiraKeyRef = useRef<string | null>(null);
  const restoreJiraKey = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("jiraKey");
  const inspectionAiSourceState = useInspectionJiraAiSource(selectedIssue?.key ?? null);
  const inspectionAiContext = inspectionAiSourceState.context;

  const loadConnection = useCallback(async () => {
    setLoadingConnection(true);
    try {
      const next = await getJiraAccount();
      setConnection({ baseUrl: next.baseUrl, projectKey: next.projectKey, tokenConfigured: next.tokenConfigured });
      setLoadError(null);
    } catch (error) {
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      setLoadingConnection(false);
    }
  }, [onError]);

  const handleAccountSaved = useCallback(async () => {
    await loadConnection();
    setConnectionSettingsOpen(false);
  }, [loadConnection]);

  const loadOverview = useCallback(async () => {
    if (!sessionReady || !connection?.tokenConfigured) return;
    setLoadingOverview(true);
    try {
      setOverview(await getJiraOverview());
      setLastSyncedAt(new Date().toISOString());
      setLoadError(null);
    } catch (error) {
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      setLoadingOverview(false);
    }
  }, [connection?.tokenConfigured, onError, sessionReady]);

  const loadIssues = useCallback(async () => {
    if (!sessionReady || !connection?.tokenConfigured) return;
    const requestId = ++issueRequestId.current;
    setLoadingIssues(true);
    try {
      const result = await listJiraIssues({ ...query, search: query.search || undefined, projectKey: connection.projectKey });
      if (requestId !== issueRequestId.current) return;
      setIssues(result.issues);
      setTotal(result.total);
      setLoadError(null);
    } catch (error) {
      if (requestId !== issueRequestId.current) return;
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      if (requestId === issueRequestId.current) setLoadingIssues(false);
    }
  }, [connection?.projectKey, connection?.tokenConfigured, onError, query, sessionReady]);

  const loadBoard = useCallback(async () => {
    if (!sessionReady || !connection?.tokenConfigured) return;
    const requestId = ++boardRequestId.current;
    setLoadingBoard(true);
    try {
      const next = await getJiraBoard(boardMember ?? "all");
      if (requestId !== boardRequestId.current) return;
      setBoard(next);
      setLastSyncedAt(new Date().toISOString());
      setLoadError(null);
    } catch (error) {
      if (requestId !== boardRequestId.current) return;
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      if (requestId === boardRequestId.current) setLoadingBoard(false);
    }
  }, [boardMember, connection?.tokenConfigured, onError, sessionReady]);

  const cardIssueKeys = useMemo(() => uniqueIssues([
    overview?.assigned ?? [],
    overview?.reported ?? [],
    overview?.recent ?? [],
    board?.columns.flatMap((column) => column.issues) ?? [],
    issues,
  ]).map((issue) => issue.key), [board, issues, overview]);
  const cardIssueKeySignature = cardIssueKeys.join("\u0000");
  const cardAiProcessing = useMemo(() => Object.values(aiTaskSummaries).some((task) => isOrdinaryJiraAiTaskProcessing(task.status)) || Object.values(aiPrecheckSummaries).some((precheck) => precheck.status === "processing"), [aiPrecheckSummaries, aiTaskSummaries]);

  useEffect(() => {
    if (!sessionReady || !connection?.tokenConfigured || cardIssueKeys.length === 0) {
      aiTaskSummaryRequestId.current += 1;
      setAiTaskSummaries({});
      setAiPrecheckSummaries({});
      return;
    }
    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    const requestId = ++aiTaskSummaryRequestId.current;
    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const response = await getOrdinaryJiraAiTaskSummaries(cardIssueKeys, controller.signal);
        if (!active || controller.signal.aborted || requestId !== aiTaskSummaryRequestId.current) return;
        setAiTaskSummaries(Object.fromEntries(response.tasks.map((task) => [task.jiraKey.trim().toLowerCase(), task])));
        setAiPrecheckSummaries(Object.fromEntries(response.prechecks.map((precheck) => [precheck.jiraKey.trim().toLowerCase(), precheck])));
      } catch {
        // AI status is supplementary to Jira data; keep the last known card state when it cannot be refreshed.
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), cardAiProcessing ? 3_000 : 15_000);
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => { active = false; controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [cardAiProcessing, cardIssueKeySignature, connection?.tokenConfigured, sessionReady]);

  useEffect(() => { if (sessionReady) void loadConnection(); }, [loadConnection, sessionReady]);
  useEffect(() => {
    const oauthState = new URLSearchParams(window.location.search).get("oauth");
    if (oauthState === "connected") {
      onNotice("Jira 账号已连接，工作台现在使用你的权限");
      void loadConnection();
    }
    if (oauthState === "error") onError("Jira 登录未完成，请重试");
    if (oauthState) {
      const url = new URL(window.location.href);
      url.searchParams.delete("oauth");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [loadConnection, onError, onNotice]);
  useEffect(() => {
    if (!sessionReady || !connection?.tokenConfigured || !restoreJiraKey || restoredJiraKeyRef.current === restoreJiraKey) return;
    restoredJiraKeyRef.current = restoreJiraKey;
    setActiveTab("issues");
    setDetailLoading(true);
    setTransitionsLoading(true);
    void fetchJiraIssueData(restoreJiraKey)
      .then((result) => {
        setSelectedIssue(result.detail);
        setDetail(result.detail);
        setTransitions(result.transitions);
        setTransitionsError(result.transitionsError);
        if (result.transitionsError) onError(`状态选项读取失败：${result.transitionsError}`);
        const url = new URL(window.location.href);
        url.searchParams.delete("jiraKey");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      })
      .catch((error) => onError(errorMessage(error)))
      .finally(() => { setDetailLoading(false); setTransitionsLoading(false); });
  }, [connection?.tokenConfigured, onError, restoreJiraKey, sessionReady]);
  useEffect(() => { if (connection?.tokenConfigured) void loadOverview(); }, [connection?.tokenConfigured, loadOverview]);
  useEffect(() => {
    if (overview && boardMember === undefined) setBoardMember(overview.user.username || null);
  }, [boardMember, overview]);
  useEffect(() => { if (activeTab === "board" && connection?.tokenConfigured && boardMember !== undefined) void loadBoard(); }, [activeTab, boardMember, connection?.tokenConfigured, loadBoard]);
  useEffect(() => { if (activeTab === "issues" && connection?.tokenConfigured) void loadIssues(); }, [activeTab, connection?.tokenConfigured, loadIssues]);
  useEffect(() => {
    if (activeTab !== "board" || boardMember === undefined) return;
    document.querySelector<HTMLElement>(".jira-workbench-page")?.closest<HTMLElement>("main")?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeTab, boardMember]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery((current) => ({ ...current, search: searchDraft.trim() || undefined, page: 1 })), 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const loadIssueData = async (key: string, clearCurrent = false) => {
    if (clearCurrent) {
      setDetail(null);
      setTransitions([]);
    }
    setTransitionsError(null);
    setDetailLoading(true);
    setTransitionsLoading(true);
    try {
      const result = await fetchJiraIssueData(key);
      setDetail(result.detail);
      setTransitions(result.transitions);
      setTransitionsError(result.transitionsError);
      if (result.transitionsError) onError(`状态选项读取失败：${result.transitionsError}`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDetailLoading(false);
      setTransitionsLoading(false);
    }
  };

  const openIssue = async (issue: JiraIssue, switchToIssues = false) => {
    if (switchToIssues) setActiveTab("issues");
    setSelectedIssue(issue);
    await loadIssueData(issue.key, true);
  };

  const refreshDetail = async () => {
    if (!selectedIssue) return;
    await loadIssueData(selectedIssue.key);
  };

  const handleOrdinaryAiTaskChange = useCallback((task: OrdinaryJiraAiTask | null, jiraKey: string) => {
    const normalizedKey = jiraKey.trim().toLowerCase();
    if (!normalizedKey) return;
    setAiTaskSummaries((current) => {
      const next = { ...current };
      if (!task) delete next[normalizedKey];
      else next[normalizedKey] = { id: task.id, jiraKey: task.jiraKey, status: task.status, phase: task.phase, updatedAt: task.updatedAt, hasMr: Boolean(task.mr) };
      return next;
    });
  }, []);

  const closeIssue = async () => {
    if (!selectedIssue) return;
    setSelectedIssue(null);
    setDetail(null);
    setTransitions([]);
    setTransitionsError(null);
    await loadIssues();
  };

  const changeIssueStatus = async (transitionId: string) => {
    if (!selectedIssue) return;
    const key = selectedIssue.key;
    const nextDetail = await transitionJiraIssue(key, transitionId);
    setDetail(nextDetail);
    setSelectedIssue((current) => current ? { ...current, ...nextDetail } : current);
    setTransitionsError(null);
    setTransitionsLoading(true);
    try {
      const nextTransitions = await getJiraIssueTransitions(key);
      setTransitions(nextTransitions.transitions);
    } catch (error) {
      setTransitions([]);
      const message = errorMessage(error);
      setTransitionsError(message);
      onError(`状态选项读取失败：${message}`);
    } finally {
      setTransitionsLoading(false);
    }
    await Promise.allSettled([loadOverview(), loadBoard(), loadIssues()]);
    onNotice(`${key} 状态已更新为 ${nextDetail.status}`);
  };

  const handleIssueCreated = useCallback(async (created: JiraIssueDetails) => {
    setCreateIssueOpen(false);
    setQuery({ ...defaultQuery, scope: "all", state: "all", search: created.key, page: 1 });
    setSearchDraft(created.key);
    setActiveTab("issues");
    setSelectedIssue(created);
    setDetail(created);
    setTransitions([]);
    setTransitionsError(null);
    setTransitionsLoading(true);
    try {
      const nextTransitions = await getJiraIssueTransitions(created.key);
      setTransitions(nextTransitions.transitions);
    } catch (error) {
      setTransitionsError(errorMessage(error));
      onError(`状态选项读取失败：${errorMessage(error)}`);
    } finally {
      setTransitionsLoading(false);
    }
    await Promise.allSettled([loadOverview(), loadBoard()]);
  }, [loadBoard, loadOverview, onError]);

  const attentionIssues = useMemo(() => uniqueIssues([overview?.assigned ?? [], overview?.reported ?? []]), [overview]);
  const openBoardIssue = (issue: JiraIssue) => {
    void openIssue(issue);
  };
  const openBoardColumn = (state: JiraBoardColumnId) => {
    setQuery({ ...defaultQuery, scope: "all", state, page: 1 });
    setActiveTab("issues");
  };
  const refreshAll = () => { void loadOverview(); if (activeTab === "board") void loadBoard(); if (activeTab === "issues") void loadIssues(); };
  const hasFilters = query.scope !== defaultQuery.scope || query.state !== defaultQuery.state || Boolean(query.search);
  const clearFilters = () => { setSearchDraft(""); setQuery(defaultQuery); };
  const inspectionAiActions = selectedIssue && inspectionAiContext ? <IntegrationApiContext.Provider value={inspectionAiContext.api}><InspectionAiAction key={`${inspectionAiContext.source.runId}:${inspectionAiContext.source.findingId}`} source={inspectionAiContext.source} jiraKey={selectedIssue.key} onError={(message) => onError(message)} onNotice={(message) => onNotice(message)} /></IntegrationApiContext.Provider> : undefined;
  const jiraAiActions = selectedIssue && detail && !inspectionAiSourceState.loading && !inspectionAiSourceState.unavailable
    ? inspectionAiContext
      ? inspectionAiActions
      : <OrdinaryJiraAiAction key={selectedIssue.key} issue={selectedIssue} sessionReady={sessionReady} onError={(message) => onError(message)} onNotice={onNotice} onTaskChange={handleOrdinaryAiTaskChange} />
    : undefined;

  if (!sessionReady || loadingConnection) return <div className="jira-workbench-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在检查 Jira 连接</strong><span>读取当前项目的 Jira 配置。</span></div>;
  if (!connection?.tokenConfigured) return <><section className="jira-workbench-page" aria-label="Jira 工作台"><div className="jira-connect-state"><span className="jira-connect-state-icon"><Settings2 aria-hidden="true" /></span><span className="jira-content-eyebrow">JIRA / PERSONAL ACCOUNT</span><h2>先连接你的 Jira 账号</h2><p>连接后，助手和 Jira 工作台会使用你的 Jira 权限查询待办、进度、问题详情和评论操作。</p><Button type="button" onClick={() => setConnectionSettingsOpen(true)}><Settings2 aria-hidden="true" />连接我的 Jira</Button></div></section><JiraAccountDrawer open={connectionSettingsOpen} sessionReady={sessionReady} productUsername={username} onClose={() => setConnectionSettingsOpen(false)} onSaved={handleAccountSaved} onNotice={onNotice} onError={onError} /></>;

  return (
    <>
      <section className="jira-workbench-page" aria-label="Jira 工作台">
      <header className="jira-workbench-heading"><div className="jira-workbench-heading-copy"><div className="jira-workbench-title-row"><span className="jira-workbench-brand-mark" aria-hidden="true"><ClipboardList /></span><div><h2>{overview?.user.name || "我的 Jira"}</h2><p>以当前项目为中心，集中处理问题、进度和反馈。</p></div></div></div><div className="jira-workbench-heading-actions"><span className="jira-workbench-sync"><i aria-hidden="true" />Jira 已连接</span><Button className="jira-action-button jira-create-button" size="sm" type="button" onClick={() => setCreateIssueOpen(true)}><Plus aria-hidden="true" />新建问题</Button><Button className="jira-action-button jira-connection-button" variant="outline" size="sm" type="button" onClick={() => setConnectionSettingsOpen(true)}><Settings2 aria-hidden="true" />连接设置</Button></div></header>
      <nav className="jira-workbench-tabs" aria-label="Jira 工作台菜单"><div className="jira-workbench-tab-list"><Button variant="ghost" className={activeTab === "overview" ? "is-active" : ""} type="button" aria-current={activeTab === "overview" ? "page" : undefined} onClick={() => setActiveTab("overview")}><LayoutDashboard aria-hidden="true" /><span><strong>概览</strong><small>今日工作</small></span></Button><Button variant="ghost" className={activeTab === "board" ? "is-active" : ""} type="button" aria-current={activeTab === "board" ? "page" : undefined} onClick={() => setActiveTab("board")}><ClipboardList aria-hidden="true" /><span><strong>团队看板</strong><small>成员协作</small></span>{board && board.total > 0 && <em>{board.total.toLocaleString("zh-CN")}</em>}</Button><Button variant="ghost" className={activeTab === "issues" ? "is-active" : ""} type="button" aria-current={activeTab === "issues" ? "page" : undefined} onClick={() => setActiveTab("issues")}><ListFilter aria-hidden="true" /><span><strong>问题库</strong><small>查询与处理</small></span>{total > 0 && <em>{total.toLocaleString("zh-CN")}</em>}</Button></div></nav>
      {loadError && <div className="jira-workbench-error" role="alert"><CircleAlert aria-hidden="true" /><span>{loadError}</span><Button variant="ghost" size="sm" type="button" onClick={refreshAll}>重新读取</Button></div>}
      {activeTab === "overview" && <div className="jira-workbench-content jira-overview-content"><div className="jira-overview-intro"><div><p>{overview ? `你有 ${overview.assignedTotal.toLocaleString("zh-CN")} 个待办问题待处理，${overview.recentTotal.toLocaleString("zh-CN")} 个问题最近有更新。` : "正在整理你的 Jira 工作概览…"}</p></div><div className="jira-overview-actions"><span>{formatSyncTime(lastSyncedAt)}</span><a href={`${connection.baseUrl}/secure/RapidBoard.jspa?projectKey=${encodeURIComponent(connection.projectKey)}`} target="_blank" rel="noreferrer">打开 Jira 看板<ExternalLink aria-hidden="true" /></a></div></div><div className="jira-metrics-grid"><JiraMetric label="分配给我" value={overview?.assignedTotal ?? "—"} note="待办问题" tone="tone-blue" icon={ClipboardList} onClick={() => { setQuery({ ...defaultQuery, scope: "assigned_to_me" }); setActiveTab("issues"); }} /><JiraMetric label="我报告的" value={overview?.reportedTotal ?? "—"} note="待办问题" tone="tone-purple" icon={FileText} onClick={() => { setQuery({ ...defaultQuery, scope: "reported_by_me" }); setActiveTab("issues"); }} /><JiraMetric label="最近更新" value={overview?.recentTotal ?? "—"} note="项目最新问题" tone="tone-green" icon={Clock3} onClick={() => { setQuery({ ...defaultQuery, scope: "all", state: "all" }); setActiveTab("issues"); }} /></div><div className="jira-overview-grid"><section className="jira-workbench-panel"><div className="jira-panel-heading"><div><strong>需要你留意</strong><small>分配给你或由你报告的待办问题</small></div><Button variant="ghost" size="sm" type="button" onClick={() => { setQuery({ ...defaultQuery, scope: "assigned_to_me" }); setActiveTab("issues"); }}>查看全部</Button></div><JiraIssueList items={attentionIssues.slice(0, 8)} selectedKey={selectedIssue?.key ?? null} onSelect={(issue) => void openIssue(issue, true)} loading={loadingOverview} aiTasks={aiTaskSummaries} aiPrechecks={aiPrecheckSummaries} /></section><section className="jira-workbench-panel"><div className="jira-panel-heading"><div><strong>最近更新</strong><small>项目中最近发生变化的问题</small></div><Button variant="ghost" size="sm" type="button" onClick={() => { setQuery({ ...defaultQuery, scope: "all", state: "all" }); setActiveTab("issues"); }}>进入问题库</Button></div><JiraIssueList items={(overview?.recent ?? []).slice(0, 8)} selectedKey={selectedIssue?.key ?? null} onSelect={(issue) => void openIssue(issue, true)} loading={loadingOverview} aiTasks={aiTaskSummaries} aiPrechecks={aiPrecheckSummaries} /></section></div></div>}
      {activeTab === "board" && <div className="jira-workbench-content"><JiraBoardView board={board} loading={loadingBoard} selectedMember={boardMember ?? null} onMemberChange={setBoardMember} onRefresh={() => void loadBoard()} onSelectIssue={openBoardIssue} onOpenIssues={openBoardColumn} aiTasks={aiTaskSummaries} aiPrechecks={aiPrecheckSummaries} /></div>}
      {activeTab === "issues" && <div className="jira-workbench-content"><div className="jira-filter-bar"><div className="jira-filter-tabs" role="tablist" aria-label="Jira 问题范围">{([ ["assigned_to_me", "分配给我"], ["reported_by_me", "我报告的"], ["all", "全部问题"] ] as const).map(([value, label]) => <Button key={value} variant="ghost" className={query.scope === value ? "is-active" : ""} type="button" role="tab" aria-selected={query.scope === value} onClick={() => setQuery((current) => ({ ...current, scope: value, page: 1 }))}>{label}</Button>)}</div><label className="jira-select-control"><Select value={query.state} onValueChange={(value) => setQuery((current) => ({ ...current, state: value as JiraIssueListQuery["state"], page: 1 }))}><SelectTrigger aria-label="Jira 问题状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="review">评审/设计</SelectItem><SelectItem value="todo">待办</SelectItem><SelectItem value="in_progress">处理中</SelectItem><SelectItem value="acceptance">验收中</SelectItem><SelectItem value="done">已完成</SelectItem><SelectItem value="all">全部状态</SelectItem></SelectContent></Select></label><label className="jira-search-control"><Search aria-hidden="true" /><Input aria-label="搜索 Jira 问题" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="搜索标题、描述或 Key…" /></label>{hasFilters && <Button variant="ghost" type="button" className="jira-clear-filters" onClick={clearFilters}><X aria-hidden="true" />清除筛选</Button>}<Button variant="outline" type="button" onClick={() => void loadIssues()} disabled={loadingIssues}><RefreshCw aria-hidden="true" className={loadingIssues ? "is-spinning" : ""} />刷新</Button></div><div className="jira-filter-summary"><span>当前视图：{scopeLabel(query.scope)} · {stateLabel(query.state)}</span>{query.search && <span>关键词：{query.search}</span>}<span className="jira-filter-summary-sync">{formatSyncTime(lastSyncedAt)}</span></div><div className={`jira-issues-split-view ${selectedIssue ? "has-selection" : ""}`}><section className="jira-issues-results-panel" aria-label="Jira 问题结果"><div className="jira-results-heading"><strong>问题结果</strong><span>{loadingIssues ? "正在同步…" : `${issues.length} / ${total.toLocaleString("zh-CN")}`}</span></div><JiraIssueList items={issues} selectedKey={selectedIssue?.key ?? null} onSelect={(issue) => void openIssue(issue)} loading={loadingIssues} aiTasks={aiTaskSummaries} aiPrechecks={aiPrecheckSummaries} /><PaginationBar label="Jira 问题分页" page={query.page ?? 1} pageSize={query.perPage ?? 25} total={total} disabled={loadingIssues} pageSizeOptions={[25, 50]} onPageSizeChange={(perPage) => setQuery((current) => ({ ...current, perPage, page: 1 }))} onPageChange={(page) => setQuery((current) => ({ ...current, page }))} /></section><JiraIssueDetailPanel actions={jiraAiActions} issue={selectedIssue} detail={detail} transitions={transitions} transitionsError={transitionsError} transitionsLoading={transitionsLoading} loading={detailLoading} onClose={closeIssue} onRefresh={refreshDetail} onStatusChange={changeIssueStatus} onNotice={onNotice} onError={onError} /></div></div>}
      {activeTab === "board" && <JiraIssueDetailPanel actions={jiraAiActions} issue={selectedIssue} detail={detail} transitions={transitions} transitionsError={transitionsError} transitionsLoading={transitionsLoading} loading={detailLoading} onClose={closeIssue} onRefresh={refreshDetail} onStatusChange={changeIssueStatus} onNotice={onNotice} onError={onError} />}
    </section>
      <JiraAccountDrawer open={connectionSettingsOpen} sessionReady={sessionReady} productUsername={username} onClose={() => setConnectionSettingsOpen(false)} onSaved={handleAccountSaved} onNotice={onNotice} onError={onError} />
      <JiraCreateIssueDrawer open={createIssueOpen} projectKey={connection.projectKey} onClose={() => setCreateIssueOpen(false)} onCreated={handleIssueCreated} onNotice={onNotice} onError={onError} />
    </>
  );
}
