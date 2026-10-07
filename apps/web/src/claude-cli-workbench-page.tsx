import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { GitLabProjectConfig } from "@contracts";
import { ChevronDown, CircleAlert, ExternalLink, Folder, FolderGit2, LoaderCircle, MessageSquare, Plus, RefreshCw, Search, Square, Terminal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssistantDeleteDialog } from "./assistant-delete-dialog";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import { Tooltip } from "./components/ui/tooltip";
import { claudeCliTerminalUrl, createClaudeCliProject, createClaudeCliSession, deleteClaudeCliProject, deleteClaudeCliSession, listClaudeCliPreviewPorts, listClaudeCliProjects, renameClaudeCliProject, renameClaudeCliSession, stopClaudeCliSession, type ClaudeCliPreviewPort, type ClaudeCliProject, type ClaudeCliSession, type GitLabOAuthStatus } from "./api";
import { GitLabOAuthPanel } from "./assistant-gitlab-oauth";
import { useIntegrationApi } from "./integration-api-context";
import { GitLabProjectList } from "./gitlab-workbench-components";
import { errorMessage } from "./review-ui-utils";

type ClaudeCliWorkbenchPageProps = {
  sessionReady: boolean;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

type TerminalEvent =
  | { type: "ready"; project: ClaudeCliProject }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string };

type RenameTarget =
  | { type: "project"; projectId: string }
  | { type: "session"; projectId: string; sessionId: string }
  | null;

function statusLabel(status: ClaudeCliProject["status"]): string {
  return status === "running" ? "运行中" : "已停止";
}

function renameKey(target: Exclude<RenameTarget, null>): string {
  return target.type === "project" ? `project:${target.projectId}` : `session:${target.projectId}:${target.sessionId}`;
}

export function ClaudeCliWorkbenchPage({ sessionReady, onNotice, onError }: ClaudeCliWorkbenchPageProps) {
  const { getGitLabOAuthStatus, listGitLabProjects } = useIntegrationApi();
  const [projects, setProjects] = useState<ClaudeCliProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [gitlabOAuthStatus, setGitlabOAuthStatus] = useState<GitLabOAuthStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingSessionProjectId, setCreatingSessionProjectId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [pendingDeleteProject, setPendingDeleteProject] = useState<ClaudeCliProject | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{ project: ClaudeCliProject; session: ClaudeCliSession } | null>(null);
  const [deletingSessionKey, setDeletingSessionKey] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [gitlabProjects, setGitlabProjects] = useState<GitLabProjectConfig[]>([]);
  const [gitlabProjectSearch, setGitlabProjectSearch] = useState("");
  const [selectedGitLabProject, setSelectedGitLabProject] = useState<GitLabProjectConfig | null>(null);
  const [loadingGitLabProjects, setLoadingGitLabProjects] = useState(false);
  const [searchingGitLabProjects, setSearchingGitLabProjects] = useState(false);
  const [gitlabProjectPickerError, setGitlabProjectPickerError] = useState<string | null>(null);
  const [terminalRevision, setTerminalRevision] = useState(0);
  const [terminalState, setTerminalState] = useState<"idle" | "connecting" | "connected" | "disconnected">("idle");
  const [terminalHostReady, setTerminalHostReady] = useState(false);
  const [previewPorts, setPreviewPorts] = useState<ClaudeCliPreviewPort[]>([]);
  const restartTerminalRef = useRef(false);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitTerminalRef = useRef<(() => void) | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeSessionKeyRef = useRef<string | null>(null);
  const gitlabProjectRequestRef = useRef(0);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameCommitRef = useRef(false);
  const setTerminalHost = useCallback((node: HTMLDivElement | null) => {
    terminalHostRef.current = node;
    setTerminalHostReady(Boolean(node));
  }, []);

  useEffect(() => {
    if (!sessionReady) {
      setGitlabOAuthStatus(null);
      return;
    }
    let active = true;
    void getGitLabOAuthStatus()
      .then((next) => {
        if (active) {
          setGitlabOAuthStatus(next);
          onError(null);
        }
      })
      .catch((error) => {
        if (active) {
          setGitlabOAuthStatus({ configured: false, connected: false, identity: null });
          onError(errorMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, [getGitLabOAuthStatus, onError, sessionReady]);

  useEffect(() => {
    const oauthState = new URLSearchParams(window.location.search).get("oauth");
    if (oauthState === "connected") onNotice("GitLab 账号已连接，Claude CLI 工作台现在可以拉取代码");
    if (oauthState === "error") onError("GitLab 登录未完成，请重试");
    if (oauthState) window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, [onError, onNotice]);

  const loadProjects = useCallback(async () => {
    if (!sessionReady || gitlabOAuthStatus?.connected !== true) return;
    setLoading(true);
    try {
      const result = await listClaudeCliProjects();
      setProjects(result.projects);
      setExpandedProjectIds((current) => current.length > 0 ? current.filter((id) => result.projects.some((project) => project.id === id)) : result.projects.map((project) => project.id));
      setActiveProjectId((current) => {
        const nextProjectId = current && result.projects.some((project) => project.id === current) ? current : result.projects[0]?.id ?? null;
        const nextProject = result.projects.find((project) => project.id === nextProjectId);
        setActiveSessionId((currentSessionId) => currentSessionId && nextProject?.sessions.some((session) => session.id === currentSessionId) ? currentSessionId : nextProject?.sessions[0]?.id ?? null);
        return nextProjectId;
      });
      onError(null);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [gitlabOAuthStatus?.connected, onError, sessionReady]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const loadGitLabProjects = useCallback(async (search = "") => {
    const normalizedSearch = search.trim();
    const requestId = ++gitlabProjectRequestRef.current;
    setLoadingGitLabProjects(!normalizedSearch);
    setSearchingGitLabProjects(Boolean(normalizedSearch));
    setGitlabProjectPickerError(null);
    try {
      const response = await listGitLabProjects({ search: normalizedSearch || undefined, page: 1, perPage: 30 });
      if (requestId !== gitlabProjectRequestRef.current) return;
      setGitlabProjects(response.projects);
      onError(null);
    } catch (error) {
      if (requestId !== gitlabProjectRequestRef.current) return;
      const message = errorMessage(error);
      setGitlabProjects([]);
      setGitlabProjectPickerError(message);
      onError(message);
    } finally {
      if (requestId !== gitlabProjectRequestRef.current) return;
      setLoadingGitLabProjects(false);
      setSearchingGitLabProjects(false);
    }
  }, [listGitLabProjects, onError]);

  useEffect(() => {
    if (!projectPickerOpen) return;
    const timer = window.setTimeout(() => void loadGitLabProjects(gitlabProjectSearch), gitlabProjectSearch.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [gitlabProjectSearch, loadGitLabProjects, projectPickerOpen]);

  useEffect(() => {
    if (gitlabOAuthStatus?.connected !== true || !terminalHostReady || !terminalHostRef.current) return;
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 8_000,
      theme: {
        background: "#12212a",
        foreground: "#d8eee7",
        cursor: "#7ce1bf",
        black: "#12212a",
        brightBlack: "#6e8188",
        green: "#65d7aa",
        brightGreen: "#8ae9c4",
        cyan: "#72d6dc",
        brightCyan: "#9de9ed",
        blue: "#8eb9ff",
        brightBlue: "#b9d2ff",
        yellow: "#e8cf85",
        brightYellow: "#f5e2a4",
        red: "#f08c91",
        brightRed: "#ffafb1",
        magenta: "#d0a3ef",
        brightMagenta: "#e3c2fa",
        white: "#d8eee7",
        brightWhite: "#f5fffb",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    if (terminalHostRef.current) {
      terminal.open(terminalHostRef.current);
      terminal.focus();
    }

    let disposed = false;
    let nextFitFrame = 0;
    const fitTerminal = () => {
      if (disposed) return;
      fitAddon.fit();
      const terminalHost = terminalHostRef.current;
      const terminalElement = terminal.element ?? terminalHost?.querySelector<HTMLElement>(".xterm");
      const screen = terminalElement?.querySelector<HTMLElement>(".xterm-screen");
      if (terminalElement && terminalHost && screen && terminal.cols > 0 && terminal.rows > 0) {
        const screenRect = screen.getBoundingClientRect();
        const cellWidth = screenRect.width / terminal.cols;
        const cellHeight = screenRect.height / terminal.rows;
        const hostStyle = window.getComputedStyle(terminalHost);
        const paddingHorizontal = Number.parseFloat(hostStyle.paddingLeft) + Number.parseFloat(hostStyle.paddingRight);
        const paddingVertical = Number.parseFloat(hostStyle.paddingTop) + Number.parseFloat(hostStyle.paddingBottom);
        const cols = Math.max(2, Math.floor((terminalHost.clientWidth - paddingHorizontal) / cellWidth));
        const rows = Math.max(1, Math.floor((terminalHost.clientHeight - paddingVertical) / cellHeight));
        if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
      }
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    fitTerminalRef.current = fitTerminal;
    fitTerminal();
    const fitFrame = requestAnimationFrame(() => {
      fitTerminal();
      nextFitFrame = requestAnimationFrame(fitTerminal);
    });
    void document.fonts?.ready.then(fitTerminal);
    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
    });
    if (terminalHostRef.current) resizeObserver.observe(terminalHostRef.current);
    const inputSubscription = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(fitFrame);
      cancelAnimationFrame(nextFitFrame);
      resizeObserver.disconnect();
      inputSubscription.dispose();
      socketRef.current?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitTerminalRef.current = null;
    };
  }, [gitlabOAuthStatus?.connected, terminalHostReady, terminalRevision]);

  useEffect(() => {
    const terminal = terminalRef.current;
    socketRef.current?.close();
    socketRef.current = null;
    const activeSessionKey = activeProjectId && activeSessionId ? `${activeProjectId}:${activeSessionId}` : null;
    activeSessionKeyRef.current = activeSessionKey;
    if (!activeProjectId || !activeSessionId || !terminal) {
      terminal?.reset();
      setTerminalState("idle");
      return;
    }

    terminal.reset();
    terminal.focus();
    fitTerminalRef.current?.();
    setTerminalState("connecting");
    const restart = restartTerminalRef.current;
    restartTerminalRef.current = false;
    const socket = new WebSocket(claudeCliTerminalUrl(activeProjectId, activeSessionId, terminal.cols, terminal.rows, restart));
    socketRef.current = socket;
    socket.onopen = () => {
      fitTerminalRef.current?.();
      terminal.focus();
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    };
    socket.onmessage = (message) => {
      let event: TerminalEvent;
      try {
        event = JSON.parse(String(message.data)) as TerminalEvent;
      } catch {
        terminal.write("\r\n\x1b[38;5;203m终端返回了无法识别的数据。\x1b[0m\r\n");
        return;
      }
      if (event.type === "ready") {
        setProjects((current) => current.map((project) => project.id === event.project.id ? event.project : project));
      } else if (event.type === "output") {
        setTerminalState("connected");
        terminal.write(event.data);
      } else if (event.type === "exit") {
        setTerminalState("disconnected");
        terminal.write(`\r\n\x1b[38;5;221m终端已退出（code ${event.exitCode}）。点击“重连”重新启动终端。\x1b[0m\r\n`);
      } else {
        setTerminalState("disconnected");
        terminal.write(`\r\n\x1b[38;5;203m${event.message}\x1b[0m\r\n`);
      }
    };
    socket.onerror = () => {
      setTerminalState("disconnected");
    };
    socket.onclose = () => {
      if (activeSessionKeyRef.current === activeSessionKey) setTerminalState("disconnected");
    };
    return () => {
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [activeProjectId, activeSessionId, terminalRevision]);

  useEffect(() => {
    let active = true;
    const loadPreviewPorts = async () => {
      if (!activeProjectId || !activeSessionId) {
        if (active) setPreviewPorts([]);
        return;
      }
      try {
        const result = await listClaudeCliPreviewPorts(activeProjectId, activeSessionId);
        if (active) setPreviewPorts(result.ports);
      } catch {
        if (active) setPreviewPorts([]);
      }
    };
    void loadPreviewPorts();
    if (!activeProjectId || !activeSessionId) return () => { active = false; };
    const timer = window.setInterval(() => void loadPreviewPorts(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeProjectId, activeSessionId]);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeSession = activeProject?.sessions.find((session) => session.id === activeSessionId) ?? null;

  useEffect(() => {
    if (!renameTarget) return;
    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renameTarget]);

  const openProjectPicker = () => {
    if (creating) return;
    setGitlabProjectSearch("");
    setGitlabProjects([]);
    setSelectedGitLabProject(null);
    setGitlabProjectPickerError(null);
    setProjectPickerOpen(true);
  };

  const handleProjectPickerOpenChange = (open: boolean) => {
    if (creating) return;
    setProjectPickerOpen(open);
    if (!open) {
      gitlabProjectRequestRef.current += 1;
      setGitlabProjectSearch("");
      setGitlabProjects([]);
      setSelectedGitLabProject(null);
      setGitlabProjectPickerError(null);
    }
  };

  const selectProject = (project: ClaudeCliProject) => {
    setActiveProjectId(project.id);
    setActiveSessionId(project.sessions[0]?.id ?? null);
    setExpandedProjectIds((current) => current.includes(project.id) ? current : [...current, project.id]);
  };

  const selectSession = (project: ClaudeCliProject, sessionId: string) => {
    setActiveProjectId(project.id);
    setActiveSessionId(sessionId);
    setExpandedProjectIds((current) => current.includes(project.id) ? current : [...current, project.id]);
  };

  const startRenameProject = (project: ClaudeCliProject) => {
    setRenameTarget({ type: "project", projectId: project.id });
    setRenameValue(project.name);
  };

  const startRenameSession = (project: ClaudeCliProject, session: ClaudeCliSession) => {
    setRenameTarget({ type: "session", projectId: project.id, sessionId: session.id });
    setRenameValue(session.name);
  };

  const commitRename = async () => {
    const target = renameTarget;
    if (!target || renamingKey || renameCommitRef.current) return;
    const project = projects.find((item) => item.id === target.projectId);
    const currentName = target.type === "project" ? project?.name : project?.sessions.find((session) => session.id === target.sessionId)?.name;
    const normalizedName = renameValue.trim();
    if (!currentName) {
      setRenameTarget(null);
      return;
    }
    if (!normalizedName) {
      onError(target.type === "project" ? "项目名称不能为空" : "会话名称不能为空");
      return;
    }
    if (normalizedName === currentName) {
      setRenameTarget(null);
      return;
    }
    const key = renameKey(target);
    renameCommitRef.current = true;
    setRenamingKey(key);
    try {
      const result = target.type === "project"
        ? await renameClaudeCliProject(target.projectId, normalizedName)
        : await renameClaudeCliSession(target.projectId, target.sessionId, normalizedName);
      setProjects((current) => current.map((item) => item.id === result.project.id ? result.project : item));
      setRenameTarget(null);
      onNotice(`${target.type === "project" ? "项目" : "会话"}已重命名为“${normalizedName}”。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      renameCommitRef.current = false;
      setRenamingKey(null);
    }
  };

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setRenameTarget(null);
    }
  };

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjectIds((current) => current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]);
  };

  const handleCreate = async () => {
    const selectedProject = selectedGitLabProject;
    if (!selectedProject || creating) return;
    setCreating(true);
    try {
      const result = await createClaudeCliProject(selectedProject.id);
      setProjects((current) => [result.project, ...current]);
      setActiveProjectId(result.project.id);
      setActiveSessionId(result.project.sessions[0]?.id ?? null);
      setExpandedProjectIds((current) => [result.project.id, ...current]);
      setProjectPickerOpen(false);
      setSelectedGitLabProject(null);
      onNotice(`项目“${result.project.name}”已创建，Git 已初始化。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const handleCreateSession = async (project: ClaudeCliProject) => {
    if (creatingSessionProjectId) return;
    setCreatingSessionProjectId(project.id);
    try {
      const result = await createClaudeCliSession(project.id);
      setProjects((current) => current.map((item) => item.id === project.id ? { ...item, sessions: [...item.sessions, result.session] } : item));
      setActiveProjectId(project.id);
      setActiveSessionId(result.session.id);
      setExpandedProjectIds((current) => current.includes(project.id) ? current : [...current, project.id]);
      onNotice(`项目“${project.name}”已创建${result.session.name}。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setCreatingSessionProjectId(null);
    }
  };

  const handleDeleteSession = async () => {
    const pending = pendingDeleteSession;
    if (!pending || deletingSessionKey) return;
    const key = `${pending.project.id}:${pending.session.id}`;
    setDeletingSessionKey(key);
    try {
      const result = await deleteClaudeCliSession(pending.project.id, pending.session.id);
      const deletingActiveSession = activeProjectId === pending.project.id && activeSessionId === pending.session.id;
      if (deletingActiveSession) {
        socketRef.current?.close();
        socketRef.current = null;
        activeSessionKeyRef.current = null;
      }
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      if (deletingActiveSession) setActiveSessionId(result.project.sessions[0]?.id ?? null);
      setPendingDeleteSession(null);
      onNotice(`${pending.session.name} 已删除，项目工作区文件仍然保留。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDeletingSessionKey(null);
    }
  };

  const handleStop = async () => {
    if (!activeProject || !activeSession || stopping) return;
    setStopping(true);
    try {
      const result = await stopClaudeCliSession(activeProject.id, activeSession.id);
      socketRef.current?.close();
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      setTerminalState("disconnected");
      onNotice(`${activeSession.name} 已停止，工作区文件仍然保留。你可以稍后重连。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setStopping(false);
    }
  };

  const handleDeleteProject = async () => {
    const project = pendingDeleteProject;
    if (!project || deletingProjectId) return;
    setDeletingProjectId(project.id);
    try {
      await deleteClaudeCliProject(project.id);
      const nextProjects = projects.filter((item) => item.id !== project.id);
      const deletingActiveProject = activeProjectId === project.id;
      const nextActiveProjectId = deletingActiveProject ? nextProjects[0]?.id ?? null : activeProjectId;
      const nextActiveProject = nextProjects.find((item) => item.id === nextActiveProjectId);
      if (deletingActiveProject) {
        socketRef.current?.close();
        socketRef.current = null;
      }
      setProjects(nextProjects);
      if (deletingActiveProject) {
        setActiveProjectId(nextActiveProjectId);
        setActiveSessionId(nextActiveProject?.sessions[0]?.id ?? null);
      }
      setPendingDeleteProject(null);
      onNotice(`项目“${project.name}”已删除，本地工作区也已清理。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDeletingProjectId(null);
    }
  };

  if (!sessionReady) return <div className="gitlab-workbench-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在等待页面会话</strong><span>建立服务会话后即可使用 Claude CLI 工作台。</span></div>;
  if (!gitlabOAuthStatus) return <div className="gitlab-workbench-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在检查 GitLab 登录状态</strong><span>确认当前工作台账号后再打开代码工作区。</span></div>;
  if (!gitlabOAuthStatus.connected) return <section className="gitlab-workbench-page claude-cli-auth-page" aria-label="Claude CLI 工作台">
    <div className="gitlab-workbench-account-content">
      <div className="gitlab-workbench-account-intro">
        <span className="gitlab-content-eyebrow">CLAUDE CLI / GITLAB</span>
        <h2>{gitlabOAuthStatus.configured ? "先连接你的 GitLab 账号" : "GitLab 登录暂不可用"}</h2>
        <p>{gitlabOAuthStatus.configured ? "连接后，工作台会用你的 GitLab 权限拉取仓库代码，并让终端里的 git pull、push 使用同一个账号。" : "当前工作区还没有完成个人 GitLab 登录配置，请先完成 GitLab OAuth 配置。"}</p>
      </div>
      <GitLabOAuthPanel sessionReady={sessionReady} returnTo="/claude-cli" onStatusChange={setGitlabOAuthStatus} onNotice={onNotice} onError={onError} />
    </div>
  </section>;

  return (
    <div className="claude-cli-page">
      <div className="claude-cli-layout">
        <aside className="claude-cli-project-panel">
          <div className="claude-cli-panel-heading">
            <div><strong>我的项目</strong><small>每个项目都有独立工作目录和 Git</small></div>
            <span>{projects.length}</span>
          </div>
          <div className="claude-cli-create-row">
            <Button type="button" className="claude-cli-create-trigger" onClick={openProjectPicker} disabled={creating}><Plus aria-hidden="true" />选择 GitLab 仓库创建项目</Button>
          </div>
          <div className="claude-cli-project-list">
            {loading ? <div className="claude-cli-list-state"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>正在读取项目…</span></div> : projects.length === 0 ? <div className="claude-cli-list-state"><FolderGit2 aria-hidden="true" /><strong>还没有项目</strong><span>选择一个 GitLab 仓库创建 Claude 工作区。</span></div> : projects.map((project) => (
              <div className="claude-cli-project-group" key={project.id}>
                <div className={`claude-cli-project-item ${project.id === activeProjectId && !activeSessionId ? "is-active" : ""}`}>
                  <Button variant="ghost" size="icon" className="claude-cli-project-expand" type="button" aria-label={`${expandedProjectIds.includes(project.id) ? "收起" : "展开"}项目 ${project.name}`} aria-expanded={expandedProjectIds.includes(project.id)} onClick={() => toggleProjectExpanded(project.id)}><ChevronDown aria-hidden="true" /></Button>
                  {renameTarget?.type === "project" && renameTarget.projectId === project.id ? <div className="claude-cli-project-select claude-cli-name-editing">
                    <span className="claude-cli-project-icon"><Folder aria-hidden="true" /></span>
                    <Input ref={renameInputRef} className="claude-cli-name-input" aria-label={`重命名项目 ${project.name}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={handleRenameKeyDown} onBlur={() => void commitRename()} disabled={Boolean(renamingKey)} maxLength={128} />
                  </div> : <button type="button" className="claude-cli-project-select" title={`${project.cwd}（双击重命名）`} onClick={() => selectProject(project)} onDoubleClick={() => startRenameProject(project)}>
                    <span className="claude-cli-project-icon"><Folder aria-hidden="true" /></span>
                    <span className="claude-cli-project-copy"><strong>{project.name}</strong><small>{project.cwd}</small></span>
                  </button>}
                  <Button variant="ghost" size="icon" className="claude-cli-session-add" type="button" aria-label={`在项目 ${project.name} 中新建会话`} title="新建会话" onClick={() => void handleCreateSession(project)} disabled={Boolean(creatingSessionProjectId)}><Plus aria-hidden="true" /></Button>
                  <Button variant="ghost" size="icon" className="claude-cli-project-delete" type="button" aria-label={`删除项目 ${project.name}`} title="删除项目" onClick={() => setPendingDeleteProject(project)} disabled={Boolean(deletingProjectId)}><Trash2 aria-hidden="true" /></Button>
                </div>
                {expandedProjectIds.includes(project.id) && <div className="claude-cli-session-list">
                  {project.sessions.length === 0 ? <span className="claude-cli-session-empty">还没有会话</span> : project.sessions.map((session) => (
                    <div className={`claude-cli-session-item ${activeProjectId === project.id && activeSessionId === session.id ? "is-active" : ""}`} key={session.id}>
                      {renameTarget?.type === "session" && renameTarget.projectId === project.id && renameTarget.sessionId === session.id ? <div className="claude-cli-session-select claude-cli-name-editing">
                        <span className="claude-cli-session-icon"><MessageSquare aria-hidden="true" /></span>
                        <Input ref={renameInputRef} className="claude-cli-name-input" aria-label={`重命名会话 ${session.name}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={handleRenameKeyDown} onBlur={() => void commitRename()} disabled={Boolean(renamingKey)} maxLength={128} />
                        <span className={`claude-cli-project-state ${session.status === "running" ? "is-running" : ""}`}>{statusLabel(session.status)}</span>
                      </div> : <button type="button" className="claude-cli-session-select" title="双击重命名" onClick={() => selectSession(project, session.id)} onDoubleClick={() => startRenameSession(project, session)}>
                        <span className="claude-cli-session-icon"><MessageSquare aria-hidden="true" /></span>
                        <span className="claude-cli-session-copy"><strong>{session.name}</strong><small>Claude CLI 会话</small></span>
                        <span className={`claude-cli-project-state ${session.status === "running" ? "is-running" : ""}`}>{statusLabel(session.status)}</span>
                      </button>}
                      <Button variant="ghost" size="icon" className="claude-cli-session-delete" type="button" aria-label={`删除会话 ${session.name}`} title="删除会话" onClick={() => setPendingDeleteSession({ project, session })} disabled={Boolean(deletingSessionKey)}><Trash2 aria-hidden="true" /></Button>
                    </div>
                  ))}
                </div>}
              </div>
            ))}
          </div>
          <Button variant="ghost" size="sm" type="button" className="claude-cli-refresh" onClick={() => void loadProjects()} disabled={loading}><RefreshCw aria-hidden="true" className={loading ? "is-spinning" : ""} />刷新项目</Button>
        </aside>

        <main className="claude-cli-terminal-panel">
          <div className="claude-cli-terminal-heading">
            <div><strong>{activeProject && activeSession ? `${activeProject.name} / ${activeSession.name}` : activeProject?.name ?? "选择一个项目"}</strong>{activeProject ? <Tooltip className="claude-cli-terminal-path" content={<code>{activeProject.cwd}</code>}><small className="claude-cli-terminal-path-label">{activeProject.cwd}</small></Tooltip> : <small>创建或选择项目后，Claude CLI 会在这里启动</small>}</div>
            <div className="claude-cli-terminal-actions">
              {activeProject && activeSession && <Button variant="outline" size="sm" type="button" onClick={() => { restartTerminalRef.current = true; setTerminalState("connecting"); setTerminalRevision((current) => current + 1); }} disabled={terminalState === "connecting"}><RefreshCw aria-hidden="true" />重连</Button>}
              {activeProject && activeSession && <Button variant="outline" size="sm" type="button" onClick={() => void handleStop()} disabled={stopping || terminalState === "idle"}><Square aria-hidden="true" />{stopping ? "停止中…" : "停止会话"}</Button>}
            </div>
          </div>
          {activeProject && activeSession && <div className="claude-cli-preview-bar" aria-label="项目预览">
            <span className="claude-cli-preview-label"><ExternalLink aria-hidden="true" />预览</span>
            {previewPorts.length === 0 ? <span className="claude-cli-preview-empty">在终端运行 pnpm dev 后，会自动显示可访问端口</span> : <div className="claude-cli-preview-actions">
              {previewPorts.map((previewPort) => <Button key={previewPort.port} variant="outline" size="sm" asChild><a href={previewPort.url} aria-label={`打开端口 ${previewPort.port} 预览`}>:{previewPort.port}<ExternalLink aria-hidden="true" /></a></Button>)}
            </div>}
          </div>}
          <div className="claude-cli-terminal-shell" onMouseDown={() => terminalRef.current?.focus()} onClick={() => terminalRef.current?.focus()}>
            <div ref={setTerminalHost} className="claude-cli-terminal" aria-label="Claude CLI 终端" />
            {terminalState === "connecting" && <div className="claude-cli-terminal-loading" role="status" aria-live="polite"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在连接 Claude CLI</strong><span>{activeSession ? `正在切换到${activeSession.name}…` : "正在准备终端…"}</span></div>}
            {!activeProject && <div className="claude-cli-terminal-empty"><Terminal aria-hidden="true" /><strong>先创建一个项目</strong><span>项目会自动执行 git init，然后启动真实 Claude CLI。</span></div>}
            {activeProject && !activeSession && <div className="claude-cli-terminal-empty"><MessageSquare aria-hidden="true" /><strong>先创建一个会话</strong><span>点击项目右侧的加号，新建一个 Claude CLI 会话。</span></div>}
          </div>
          {activeProject && activeSession && <div className="claude-cli-terminal-footer"><span><span className={`claude-cli-status-dot ${terminalState === "connected" ? "is-connected" : ""}`} aria-hidden="true" />{terminalState === "connected" ? `输入会发送到${activeSession.name}` : terminalState === "connecting" ? "正在建立终端连接…" : "终端已断开"}</span><span className="claude-cli-shortcut-hint">Ctrl/Cmd + C 等快捷键按本地终端方式工作</span></div>}
        </main>
      </div>
      {!activeProject && !loading && projects.length === 0 && <div className="claude-cli-inline-note"><CircleAlert aria-hidden="true" /><span>这是一个本地工作区版本：先在这里创建项目，之后可以直接在 Claude CLI 中运行 git、安装依赖和提交代码。</span></div>}
      <AlertDialog open={projectPickerOpen} onOpenChange={handleProjectPickerOpenChange}>
        <AlertDialogContent className="claude-cli-project-picker-dialog">
          <AlertDialogHeader className="claude-cli-project-picker-header">
            <AlertDialogTitle>选择 GitLab 仓库</AlertDialogTitle>
            <AlertDialogDescription>选择一个可访问的 GitLab 仓库，Claude 项目会直接使用仓库名称创建。</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="claude-cli-project-picker-body">
            <div className="claude-cli-project-picker-search">
              <Search aria-hidden="true" />
              <Input aria-label="搜索 GitLab 仓库" value={gitlabProjectSearch} onChange={(event) => setGitlabProjectSearch(event.target.value)} placeholder="按仓库名或路径搜索…" autoComplete="off" />
            </div>
            <div className="claude-cli-project-picker-list">
              {loadingGitLabProjects ? <div className="claude-cli-list-state"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>正在读取 GitLab 仓库…</span></div> : gitlabProjectPickerError ? <div className="claude-cli-list-state"><CircleAlert aria-hidden="true" /><strong>无法读取 GitLab 仓库</strong><span>{gitlabProjectPickerError}</span><Button variant="outline" size="sm" type="button" onClick={() => void loadGitLabProjects(gitlabProjectSearch)}>重新读取</Button></div> : <>
                <div className="claude-cli-project-picker-list-heading"><strong>可访问仓库</strong><span>{searchingGitLabProjects ? "搜索中…" : `${gitlabProjects.length} 个`}</span></div>
                <GitLabProjectList projects={gitlabProjects} selectedProjectId={selectedGitLabProject?.id ?? null} onSelect={setSelectedGitLabProject} selectionActionLabel={{ idle: "选择", selected: "已选择" }} />
              </>}
            </div>
          </div>
          <AlertDialogFooter className="claude-cli-project-picker-footer">
            <AlertDialogCancel asChild><Button variant="ghost" type="button" disabled={creating}>取消</Button></AlertDialogCancel>
            <Button type="button" onClick={() => void handleCreate()} disabled={!selectedGitLabProject || creating}>{creating ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Plus aria-hidden="true" />}{creating ? "创建中…" : selectedGitLabProject ? `使用“${selectedGitLabProject.name}”创建` : "选择仓库后创建"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AssistantDeleteDialog
        open={Boolean(pendingDeleteProject)}
        title={`删除项目“${pendingDeleteProject?.name ?? ""}”？`}
        description="删除后会停止该项目下所有 Claude CLI 会话，并永久删除本地工作区和其中的文件，此操作无法撤销。"
        busy={Boolean(deletingProjectId)}
        onCancel={() => setPendingDeleteProject(null)}
        onConfirm={() => void handleDeleteProject()}
      />
      <AssistantDeleteDialog
        open={Boolean(pendingDeleteSession)}
        title={`删除${pendingDeleteSession?.session.name ?? "会话"}？`}
        description="只会停止并删除这个 Claude CLI 会话，项目工作区和 Git 文件都会保留，此操作无法撤销。"
        busy={Boolean(deletingSessionKey)}
        onCancel={() => setPendingDeleteSession(null)}
        onConfirm={() => void handleDeleteSession()}
      />
    </div>
  );
}
