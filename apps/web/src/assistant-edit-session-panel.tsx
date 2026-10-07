import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock3, Code2, GitBranch, LoaderCircle, Pin, PinOff, RefreshCw, X } from "lucide-react";
import {
  ApiError,
  closeAssistantEditSession,
  createAssistantEditSession,
  getAssistantEditSession,
  listGitLabProjects,
  setAssistantEditSessionRetention,
  type AssistantEditSession,
} from "./api";
import { AssistantAuthCard } from "./assistant-auth-card";
import { AssistantWorkspaceDiffCard } from "./assistant-edit-operation-card";
import type { AssistantAuthCard as AssistantAuthCardData, GitLabProjectConfig } from "@contracts";
import { Button } from "@/components/ui/button";
import { GitLabSearchableSelect } from "./gitlab-searchable-select";

const GITLAB_AUTH_CARD: AssistantAuthCardData = {
  kind: "auth_required",
  provider: "gitlab",
  title: "需要连接 GitLab",
  description: "编辑代码需要读取你的 GitLab 项目，请先连接或重新连接 GitLab 账号。",
  actionLabel: "去连接 GitLab",
  actionPath: "/gitlab-workbench",
};

type AssistantEditSessionPanelProps = {
  open: boolean;
  session: AssistantEditSession | null;
  onSessionChange: (session: AssistantEditSession | null) => void;
  onNotice: (message: string) => void;
  onClose: () => void;
};

function sessionStatusLabel(status: AssistantEditSession["status"]): string {
  if (status === "active") return "可编辑";
  if (status === "approval_pending") return "有历史修改待处理";
  if (status === "closed") return "已关闭";
  if (status === "expired") return "已过期";
  return "工作区异常";
}

function formatSessionExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "24 小时后自动清理";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function AssistantEditSessionPanel({ open, session, onSessionChange, onNotice, onClose }: AssistantEditSessionPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<GitLabProjectConfig[]>([]);
  const [projectId, setProjectId] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [gitlabAuthRequired, setGitlabAuthRequired] = useState(false);
  const [searchingProjects, setSearchingProjects] = useState(false);
  const [busy, setBusy] = useState(false);
  const projectSearchRequestRef = useRef(0);
  const projectSearchTimerRef = useRef<number | null>(null);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projectId, projects]);
  const projectOptions = useMemo(() => projects.map((project) => ({
    value: project.id,
    label: project.pathWithNamespace || project.name,
    searchText: project.name,
  })), [projects]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (target instanceof Element && (target.closest("[data-assistant-edit-trigger=\"true\"]") || target.closest(".gitlab-create-mr-select-content"))) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".gitlab-create-mr-select-content")) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  const loadProjects = useCallback((search = "") => {
    const normalizedSearch = search.trim();
    const requestId = ++projectSearchRequestRef.current;
    setLoadingProjects(!normalizedSearch);
    setSearchingProjects(Boolean(normalizedSearch));
    setGitlabAuthRequired(false);
    void listGitLabProjects({ search: normalizedSearch || undefined, perPage: 50 })
      .then((response) => {
        if (requestId !== projectSearchRequestRef.current) return;
        setProjects(response.projects);
        if (!normalizedSearch) {
          setProjectId((current) => response.projects.some((project) => project.id === current) ? current : response.projects[0]?.id ?? "");
          const selected = response.projects.find((project) => project.id === projectId) ?? response.projects[0];
          setBaseRef(selected?.defaultBranch ?? "main");
        }
      })
      .catch((error) => {
        if (requestId !== projectSearchRequestRef.current) return;
        if (error instanceof ApiError && error.status === 428) {
          setProjects([]);
          setProjectId("");
          setBaseRef("");
          setGitlabAuthRequired(true);
          return;
        }
        onNotice(error instanceof Error ? error.message : "无法读取 GitLab 项目");
      })
      .finally(() => {
        if (requestId !== projectSearchRequestRef.current) return;
        setLoadingProjects(false);
        if (!normalizedSearch) setProjectsLoaded(true);
        setSearchingProjects(false);
      });
  }, [onNotice, projectId]);

  const searchProjects = useCallback((search: string) => {
    if (projectSearchTimerRef.current !== null) window.clearTimeout(projectSearchTimerRef.current);
    if (!search.trim()) {
      loadProjects();
      return;
    }
    setSearchingProjects(true);
    projectSearchTimerRef.current = window.setTimeout(() => {
      projectSearchTimerRef.current = null;
      loadProjects(search);
    }, 220);
  }, [loadProjects]);

  useEffect(() => {
    if (!open) {
      projectSearchRequestRef.current += 1;
      if (projectSearchTimerRef.current !== null) window.clearTimeout(projectSearchTimerRef.current);
      projectSearchTimerRef.current = null;
      setProjectsLoaded(false);
      setGitlabAuthRequired(false);
      setSearchingProjects(false);
      setProjects([]);
      setProjectId("");
      setBaseRef("");
      return;
    }
    if (session || projects.length > 0 || projectsLoaded || loadingProjects) return;
    loadProjects();
  }, [loadProjects, loadingProjects, open, projects.length, projectsLoaded, session]);

  useEffect(() => {
    if (!selectedProject) return;
    setBaseRef((current) => current || selectedProject.defaultBranch || "main");
  }, [selectedProject]);

  useEffect(() => {
    if (!open || !session) return;
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const response = await getAssistantEditSession(session.id);
        if (active) onSessionChange(response.session);
      } catch {
        // Keep the last known session state visible while the panel is open.
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [onSessionChange, open, session?.id]);

  if (!open) return null;

  const createSession = () => {
    if (!selectedProject || busy) return;
    setBusy(true);
    void createAssistantEditSession({ projectId: selectedProject.id, projectPath: selectedProject.pathWithNamespace, baseRef: baseRef.trim() || selectedProject.defaultBranch || "main" })
      .then((response) => {
        onSessionChange(response.session);
        onNotice(`已创建 ${response.session.projectPath} 的隔离编辑工作区`);
        onClose();
      })
      .catch((error) => onNotice(error instanceof Error ? error.message : "创建编辑工作区失败"))
      .finally(() => setBusy(false));
  };

  const refreshSession = () => {
    if (!session || busy) return;
    setBusy(true);
    void getAssistantEditSession(session.id)
      .then((response) => onSessionChange(response.session))
      .catch((error) => onNotice(error instanceof Error ? error.message : "刷新编辑会话失败"))
      .finally(() => setBusy(false));
  };

  const updateRetentionMode = (retentionMode: AssistantEditSession["retentionMode"]) => {
    if (!session || busy || session.retentionMode === retentionMode) return;
    setBusy(true);
    void setAssistantEditSessionRetention(session.id, retentionMode)
      .then((response) => {
        onSessionChange(response.session);
        onNotice(retentionMode === "pinned" ? "已关闭自动清理，编辑工作区将一直保留" : "已恢复 24 小时自动清理");
      })
      .catch((error) => onNotice(error instanceof Error ? error.message : "更新工作区保留设置失败"))
      .finally(() => setBusy(false));
  };

  const closeSession = () => {
    if (!session || busy) return;
    setBusy(true);
    void closeAssistantEditSession(session.id)
      .then(() => {
        onSessionChange(null);
        onNotice("编辑工作区已关闭");
      })
      .catch((error) => onNotice(error instanceof Error ? error.message : "关闭编辑工作区失败"))
      .finally(() => setBusy(false));
  };

  return (
    <div ref={panelRef} className="assistant-edit-session-panel" role="dialog" aria-label="编辑代码设置">
      <div className="assistant-edit-session-heading">
        <div className="assistant-edit-session-heading-main">
          <span className="assistant-edit-session-heading-icon"><Code2 aria-hidden="true" /></span>
          <div>
            <strong>{session ? "正在编辑代码" : "编辑代码"}</strong>
            <span>{session ? `${sessionStatusLabel(session.status)} · ${session.changedFiles} 个变更文件` : "让助手在隔离工作区里帮你修改代码"}</span>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="assistant-edit-session-close" type="button" onClick={onClose} aria-label="关闭编辑代码设置" title="关闭"><X aria-hidden="true" /></Button>
      </div>
      {session ? (
        <div className="assistant-edit-session-live">
          <div className="assistant-edit-session-project">
            <span className="assistant-edit-session-status-dot" aria-hidden="true" />
            <div>
              <strong title={session.projectPath}>{session.projectPath}</strong>
              <span><GitBranch aria-hidden="true" />{session.baseRef}<i />隔离工作区</span>
            </div>
          </div>
          <div className="assistant-edit-session-stats">
            <span>{session.changedFiles} 个变更文件</span>
          </div>
          <div className={`assistant-edit-session-retention ${session.retentionMode === "pinned" ? "is-pinned" : "is-expiring"}`} role="status">
            <div className="assistant-edit-session-retention-copy">
              <span className="assistant-edit-session-retention-icon" aria-hidden="true">{session.retentionMode === "pinned" ? <Pin /> : <Clock3 />}</span>
              <div>
                <strong>{session.retentionMode === "pinned" ? "已开启长期保留" : `将于 ${formatSessionExpiry(session.expiresAt)} 自动清理`}</strong>
                <span>{session.retentionMode === "pinned" ? "不会因时间到期清理，直到你主动结束编辑。" : "未提交的修改也会一并清理；需要更长时间请开启长期保留。"}</span>
              </div>
            </div>
            <Button variant="outline" size="sm" type="button" onClick={() => updateRetentionMode(session.retentionMode === "pinned" ? "auto" : "pinned")} disabled={busy}>
              {session.retentionMode === "pinned" ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              {session.retentionMode === "pinned" ? "恢复自动清理" : "长期保留"}
            </Button>
          </div>
          <div className="assistant-edit-session-live-actions">
            <Button variant="ghost" size="sm" type="button" onClick={refreshSession} disabled={busy}><RefreshCw className={busy ? "is-spinning" : ""} aria-hidden="true" />刷新状态</Button>
            <Button variant="ghost" size="sm" type="button" onClick={closeSession} disabled={busy} title="结束编辑会清理隔离工作区"><X aria-hidden="true" />结束编辑</Button>
          </div>
          {session.changedFiles > 0 && <AssistantWorkspaceDiffCard sessionId={session.id} changedFiles={session.changedFiles} live />}
          <p className="assistant-edit-session-note">修改会直接写入隔离工作区；提交、推送和 MR 由后端统一处理。</p>
        </div>
      ) : gitlabAuthRequired ? (
        <div className="assistant-edit-session-auth">
          <AssistantAuthCard card={GITLAB_AUTH_CARD} />
          <p className="assistant-edit-session-auth-hint">连接完成后回到这里，点击“重新检查”即可加载项目。</p>
          <Button variant="outline" size="sm" type="button" className="assistant-edit-session-auth-retry" onClick={() => loadProjects()} disabled={loadingProjects}>
            {loadingProjects ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}重新检查
          </Button>
        </div>
      ) : (
        <form className="assistant-edit-session-form" onSubmit={(event) => { event.preventDefault(); createSession(); }}>
          <div className="assistant-edit-session-project-field">
            <span>选择项目</span>
            <GitLabSearchableSelect ariaLabel="GitLab 项目" value={projectId} options={projectOptions} emptyLabel="暂无可用项目" placeholder={projectsLoaded ? "搜索并选择 GitLab 项目" : "正在读取项目…"} searchPlaceholder="搜索 GitLab 项目…" showEmptyOption={false} searchLoading={searchingProjects} disabled={loadingProjects || busy || (!projectsLoaded && projects.length === 0)} onSearchChange={searchProjects} onChange={(value) => { setProjectId(value); setBaseRef(""); }} />
          </div>
          <label className="assistant-edit-session-branch-field">
            <span>从哪个分支开始</span>
            <span className="assistant-edit-session-branch-input"><GitBranch aria-hidden="true" /><input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="main" disabled={!selectedProject || busy} /></span>
          </label>
          <div className="assistant-edit-session-form-footer">
            <p className="assistant-edit-session-note">默认 24 小时后自动清理，未提交修改也会清理；开始后可开启“长期保留”。</p>
            <Button type="submit" disabled={!selectedProject || busy}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Code2 aria-hidden="true" />}{busy ? "准备中…" : "开始编辑"}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
