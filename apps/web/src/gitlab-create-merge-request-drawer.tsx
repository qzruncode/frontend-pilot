import { useIntegrationApi } from "./integration-api-context";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CircleAlert, GitBranch, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { GitLabCreateMergeRequestInputSchema } from "@contracts";
import type { GitLabBranchOption, GitLabCreateMergeRequestInput, GitLabMergeRequest, GitLabMergeRequestCreateOptions, GitLabProject, GitLabProjectConfig, GitLabRecentPush } from "@contracts";

import { errorMessage } from "./review-ui-utils";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { GitLabCreateMergeRequestFields, type GitLabMergeRequestDraft } from "./gitlab-create-merge-request-fields";
import type { GitLabMarkdownEditorMode } from "./gitlab-markdown";
import { JIRA_KEY_PATTERN, titleWithJiraKey } from "./gitlab-mr-prompt-utils";
import { Button } from "@/components/ui/button";

const DRAWER_EXIT_DURATION_MS = 220;

type GitLabCreateMergeRequestDrawerProps = {
  open: boolean;
  projects: GitLabProjectConfig[];
  defaultProjectId: string | null;
  onClose: () => void;
  onCreated: (mergeRequest: GitLabMergeRequest) => void | Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

function firstProjectId(projects: GitLabProjectConfig[], preferred: string | null): string {
  return preferred && projects.some((project) => project.id === preferred) ? preferred : projects[0]?.id ?? "";
}

function projectDefaultBranch(projects: GitLabProjectConfig[], projectId: string, options: GitLabMergeRequestCreateOptions | null): string {
  const project = projects.find((item) => item.id === projectId);
  return project?.defaultBranch && options?.branches.some((branch) => branch.name === project.defaultBranch)
    ? project.defaultBranch
    : options?.branches.find((branch) => branch.isDefault)?.name ?? options?.branches[0]?.name ?? "";
}

type LoadedOptionsProjects = {
  sourceProjectId: string;
  targetProjectId: string;
};

function initialDraft(projectId: string): GitLabMergeRequestDraft {
  return {
    sourceProjectId: projectId,
    sourceBranch: "",
    targetProjectId: projectId,
    targetBranch: "",
    jiraKey: "",
    title: "",
    description: "",
    assigneeId: "",
    reviewerIds: [],
    milestoneId: "",
    labels: [],
    removeSourceBranch: true,
    squash: false,
  };
}

function createPayload(draft: GitLabMergeRequestDraft): GitLabCreateMergeRequestInput {
  return {
    targetProjectId: draft.targetProjectId,
    sourceProjectId: draft.sourceProjectId,
    sourceBranch: draft.sourceBranch,
    targetBranch: draft.targetBranch,
    title: titleWithJiraKey(draft.title, draft.jiraKey),
    description: draft.description,
    assigneeIds: draft.assigneeId ? [draft.assigneeId] : [],
    reviewerIds: draft.reviewerIds,
    milestoneId: draft.milestoneId || undefined,
    labels: draft.labels,
    removeSourceBranch: draft.removeSourceBranch,
    squash: draft.squash,
  };
}

function recentPushTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "最近";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function commitDescription(branch: GitLabBranchOption | undefined): string {
  const message = branch?.commitMessage?.trim() ?? "";
  if (!message) return "";
  const title = branch?.commitTitle?.trim();
  const lines = message.split(/\r?\n/);
  return title && lines[0]?.trim() === title ? lines.slice(1).join("\n").trim() : message;
}

function CreateMergeRequestForm({ open, projects, defaultProjectId, onClose, onCreated, onNotice, onError }: GitLabCreateMergeRequestDrawerProps) {
  const { createGitLabMergeRequest, generateGitLabMergeRequestDescription, getGitLabMergeRequestCreateOptions, getGitLabRecentPush, listGitLabProjects } = useIntegrationApi();
  const [step, setStep] = useState<"branches" | "details">("branches");
  const [draft, setDraft] = useState<GitLabMergeRequestDraft>(() => initialDraft(firstProjectId(projects, defaultProjectId)));
  const [sourceOptions, setSourceOptions] = useState<GitLabMergeRequestCreateOptions | null>(null);
  const [targetOptions, setTargetOptions] = useState<GitLabMergeRequestCreateOptions | null>(null);
  const [loadedOptionsProjects, setLoadedOptionsProjects] = useState<LoadedOptionsProjects | null>(null);
  const [optionsReloadKey, setOptionsReloadKey] = useState(0);
  const [descriptionMode, setDescriptionMode] = useState<GitLabMarkdownEditorMode>("source");
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [recentPush, setRecentPush] = useState<GitLabRecentPush | null>(null);
  const [recentPushLoading, setRecentPushLoading] = useState(false);
  const [recentPushError, setRecentPushError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const [projectSearchLoading, setProjectSearchLoading] = useState(false);
  const [searchedProjects, setSearchedProjects] = useState<GitLabProjectConfig[]>([]);
  const requestRef = useRef(0);
  const recentPushRequestRef = useRef(0);
  const projectSearchRequestRef = useRef(0);
  const projectSearchTimerRef = useRef<number | null>(null);
  const userChangedRef = useRef(false);
  const descriptionEditedRef = useRef(false);

  const applyRecentPush = useCallback((push: GitLabRecentPush) => {
    requestRef.current += 1;
    setOptionsReloadKey((key) => key + 1);
    setSourceOptions(null);
    setTargetOptions(null);
    descriptionEditedRef.current = false;
    setDraft((current) => ({
      ...current,
      sourceProjectId: push.project.id,
      sourceBranch: push.sourceBranch,
      targetProjectId: push.project.id,
      targetBranch: push.project.defaultBranch ?? "",
      title: current.title || push.commitTitle || "",
      description: "",
    }));
    setFormError(null);
  }, []);

  const loadOptions = useCallback(async (sourceProjectId: string, targetProjectId: string) => {
    if (!sourceProjectId || !targetProjectId) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoadedOptionsProjects(null);
    setSourceOptions(null);
    setTargetOptions(null);
    setOptionsLoading(true);
    setOptionsError(null);
    try {
      const targetRequest = getGitLabMergeRequestCreateOptions(targetProjectId);
      const [source, target] = await Promise.all([sourceProjectId === targetProjectId ? targetRequest : getGitLabMergeRequestCreateOptions(sourceProjectId), targetRequest]);
      if (requestId !== requestRef.current) return;
      setSourceOptions(source);
      setTargetOptions(target);
      setLoadedOptionsProjects({ sourceProjectId, targetProjectId });
      setFormError(null);
      onError(null);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      const message = errorMessage(error);
      setOptionsError(message);
      onError(message);
    } finally {
      if (requestId === requestRef.current) setOptionsLoading(false);
    }
  }, [onError]);

  const loadRecentPush = useCallback(async () => {
    const requestId = recentPushRequestRef.current + 1;
    recentPushRequestRef.current = requestId;
    setRecentPushLoading(true);
    setRecentPushError(null);
    try {
      const next = await getGitLabRecentPush();
      if (requestId !== recentPushRequestRef.current) return;
      setRecentPush(next);
      if (next && !userChangedRef.current) applyRecentPush(next);
    } catch {
      if (requestId !== recentPushRequestRef.current) return;
      setRecentPush(null);
      setRecentPushError("最近推送识别失败，可手动选择分支。");
    } finally {
      if (requestId === recentPushRequestRef.current) setRecentPushLoading(false);
    }
  }, [applyRecentPush]);

  useEffect(() => {
    if (!open) return;
    const projectId = firstProjectId(projects, defaultProjectId);
    setStep("branches");
    setDraft(initialDraft(projectId));
    setSourceOptions(null);
    setTargetOptions(null);
    setLoadedOptionsProjects(null);
    setOptionsReloadKey(0);
    setDescriptionMode("source");
    setOptionsError(null);
    setFormError(null);
    setRecentPush(null);
    setRecentPushLoading(false);
    setRecentPushError(null);
    setGeneratingDescription(false);
    recentPushRequestRef.current += 1;
    projectSearchRequestRef.current += 1;
    if (projectSearchTimerRef.current !== null) window.clearTimeout(projectSearchTimerRef.current);
    projectSearchTimerRef.current = null;
    setProjectSearchLoading(false);
    setSearchedProjects([]);
    userChangedRef.current = false;
    descriptionEditedRef.current = false;
    onError(null);
  }, [defaultProjectId, onError, open]);

  useEffect(() => {
    if (!open) return;
    void loadRecentPush();
    return () => {
      recentPushRequestRef.current += 1;
    };
  }, [loadRecentPush, open]);

  useEffect(() => {
    if (!open || !draft.sourceProjectId || !draft.targetProjectId) return;
    void loadOptions(draft.sourceProjectId, draft.targetProjectId);
    return () => {
      requestRef.current += 1;
    };
  }, [draft.sourceProjectId, draft.targetProjectId, loadOptions, open, optionsReloadKey]);

  useEffect(() => {
    if (!open || !sourceOptions || !targetOptions || !loadedOptionsProjects
      || loadedOptionsProjects.sourceProjectId !== draft.sourceProjectId
      || loadedOptionsProjects.targetProjectId !== draft.targetProjectId) return;
    setDraft((current) => {
      const targetBranch = current.targetBranch && targetOptions.branches.some((branch) => branch.name === current.targetBranch)
        ? current.targetBranch
        : projectDefaultBranch(projects, current.targetProjectId, targetOptions);
      const sourceBranch = current.sourceBranch && sourceOptions.branches.some((branch) => branch.name === current.sourceBranch)
        ? current.sourceBranch
        : "";
      const sourceBranchOption = sourceOptions.branches.find((branch) => branch.name === sourceBranch);
      const branchTitle = sourceBranchOption?.commitTitle ?? "";
      const branchDescription = descriptionEditedRef.current ? current.description : commitDescription(sourceBranchOption);
      const assigneeId = current.assigneeId || targetOptions.currentUser.id || "";
      if (current.sourceBranch === sourceBranch && current.targetBranch === targetBranch && current.title && current.assigneeId === assigneeId && current.description === branchDescription) return current;
      return { ...current, sourceBranch, targetBranch, title: current.title || branchTitle, description: branchDescription, assigneeId };
    });
  }, [draft.sourceProjectId, draft.targetProjectId, loadedOptionsProjects, open, projects, sourceOptions, targetOptions]);

  const selectableProjects = useMemo<GitLabProject[]>(() => {
    const initialProjects = recentPush && !projects.some((project) => project.id === recentPush.project.id) ? [recentPush.project, ...projects] : projects;
    const byId = new Map(initialProjects.map((project) => [project.id, project]));
    for (const project of searchedProjects) byId.set(project.id, project);
    return [...byId.values()];
  }, [projects, recentPush, searchedProjects]);

  const generateDescription = async () => {
    const jiraKey = draft.jiraKey.trim().toUpperCase();
    if (!JIRA_KEY_PATTERN.test(jiraKey)) {
      const message = "请输入有效的 Jira key，例如 DEMO-123";
      setFormError(message);
      onError(message);
      return;
    }
    if (!draft.title.trim()) {
      const message = "请先填写 Merge Request 标题";
      setFormError(message);
      onError(message);
      return;
    }
    const project = selectableProjects.find((item) => item.id === draft.targetProjectId || item.id === draft.sourceProjectId);
    const branch = sourceOptions?.branches.find((item) => item.name === draft.sourceBranch);
    setGeneratingDescription(true);
    setFormError(null);
    onError(null);
    try {
      const response = await generateGitLabMergeRequestDescription({
        projectPath: project?.pathWithNamespace || project?.name || draft.targetProjectId,
        jiraKey,
        sourceBranch: draft.sourceBranch,
        targetBranch: draft.targetBranch,
        title: titleWithJiraKey(draft.title, jiraKey),
        commitTitle: branch?.commitTitle,
        commitMessage: branch?.commitMessage,
        jiraDescription: null,
      });
      descriptionEditedRef.current = true;
      setDraft((current) => ({ ...current, jiraKey, title: titleWithJiraKey(current.title, jiraKey), description: response.description }));
      onNotice("已生成规范 MR 描述，可继续编辑");
    } catch (error) {
      const message = errorMessage(error);
      setFormError(message);
      onError(message);
    } finally {
      setGeneratingDescription(false);
    }
  };

  const loadProjectSearch = useCallback(async (search: string) => {
    const normalizedSearch = search.trim();
    const requestId = ++projectSearchRequestRef.current;
    if (!normalizedSearch) {
      setSearchedProjects([]);
      setProjectSearchLoading(false);
      return;
    }
    setProjectSearchLoading(true);
    try {
      const response = await listGitLabProjects({ search: normalizedSearch, page: 1, perPage: 50 });
      if (requestId !== projectSearchRequestRef.current) return;
      setSearchedProjects(response.projects);
      onError(null);
    } catch (error) {
      if (requestId !== projectSearchRequestRef.current) return;
      onError(errorMessage(error));
    } finally {
      if (requestId === projectSearchRequestRef.current) setProjectSearchLoading(false);
    }
  }, [onError]);

  const searchProjects = useCallback((search: string) => {
    if (projectSearchTimerRef.current !== null) window.clearTimeout(projectSearchTimerRef.current);
    if (!search.trim()) {
      projectSearchRequestRef.current += 1;
      projectSearchTimerRef.current = null;
      setSearchedProjects([]);
      setProjectSearchLoading(false);
      return;
    }
    setProjectSearchLoading(true);
    projectSearchTimerRef.current = window.setTimeout(() => {
      projectSearchTimerRef.current = null;
      void loadProjectSearch(search);
    }, 220);
  }, [loadProjectSearch]);

  useEffect(() => () => {
    projectSearchRequestRef.current += 1;
    if (projectSearchTimerRef.current !== null) window.clearTimeout(projectSearchTimerRef.current);
  }, []);

  const updateDraft = (patch: Partial<GitLabMergeRequestDraft>) => {
    const effectivePatch = patch.sourceProjectId !== undefined
      ? { ...patch, targetProjectId: patch.sourceProjectId, targetBranch: "" }
      : patch;
    userChangedRef.current = true;
    if (effectivePatch.sourceProjectId !== undefined) descriptionEditedRef.current = false;
    if (effectivePatch.description !== undefined && effectivePatch.sourceBranch === undefined && effectivePatch.sourceProjectId === undefined) descriptionEditedRef.current = true;
    setDraft((current) => {
      if (effectivePatch.sourceBranch !== undefined && !descriptionEditedRef.current) {
        const branch = sourceOptions?.branches.find((item) => item.name === effectivePatch.sourceBranch);
        return { ...current, ...effectivePatch, description: commitDescription(branch) };
      }
      return { ...current, ...effectivePatch };
    });
    setFormError(null);
    onError(null);
  };

  const continueToDetails = () => {
    if (!draft.sourceBranch || !draft.targetBranch) {
      setFormError("请选择源分支和目标分支");
      return;
    }
    if (draft.sourceProjectId === draft.targetProjectId && draft.sourceBranch === draft.targetBranch) {
      setFormError("源分支和目标分支不能相同");
      return;
    }
    setFormError(null);
    setStep("details");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || step !== "details") return;
    if (!JIRA_KEY_PATTERN.test(draft.jiraKey.trim())) {
      const message = "请填写有效的 Jira key，所有 MR 都必须关联 Jira";
      setFormError(message);
      onError(message);
      return;
    }
    if (!draft.description.trim()) {
      const message = "请先生成或填写规范 MR 描述";
      setFormError(message);
      onError(message);
      return;
    }
    const parsed = GitLabCreateMergeRequestInputSchema.safeParse(createPayload(draft));
    if (!parsed.success) {
      const message = [...new Set(parsed.error.issues.map((issue) => issue.message).filter(Boolean))].join("；") || "请检查表单内容";
      setFormError(message);
      onError(message);
      return;
    }
    setSaving(true);
    setFormError(null);
    onError(null);
    try {
      const created = await createGitLabMergeRequest(parsed.data);
      await onCreated(created);
      onNotice(`!${created.iid} 已创建，已打开 Merge Request 详情`);
    } catch (error) {
      const message = errorMessage(error);
      setFormError(message);
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  const retryOptions = () => void loadOptions(draft.sourceProjectId, draft.targetProjectId);
  const useDetectedRecentPush = () => {
    if (!recentPush) return;
    userChangedRef.current = true;
    applyRecentPush(recentPush);
  };
  const recentPushApplied = Boolean(recentPush && draft.sourceProjectId === recentPush.project.id && draft.sourceBranch === recentPush.sourceBranch);
  const canContinue = Boolean(sourceOptions && targetOptions && draft.sourceBranch && draft.targetBranch && !(draft.sourceProjectId === draft.targetProjectId && draft.sourceBranch === draft.targetBranch));

  const content = <>
    <div className="gitlab-create-mr-intro"><p>分支、项目成员和标签均读取自当前 GitLab 账号可访问的数据。</p></div>
    {recentPushLoading && <div className="gitlab-create-mr-status" role="status"><LoaderCircle aria-hidden="true" className="is-spinning" /><span>正在识别最近一次 GitLab 推送…</span></div>}
    {recentPushError && <div className="gitlab-create-mr-status is-warning" role="status"><CircleAlert aria-hidden="true" /><span>{recentPushError}</span><Button type="button" variant="ghost" size="sm" onClick={() => void loadRecentPush()} disabled={recentPushLoading}><RefreshCw aria-hidden="true" />重新识别</Button></div>}
    {recentPush && <div className="gitlab-create-mr-recent-push" role="status"><GitBranch aria-hidden="true" /><div className="gitlab-create-mr-recent-push-copy"><strong>已识别最近一次推送</strong><span><code>{recentPush.project.pathWithNamespace || recentPush.project.name}</code><b>·</b><code>{recentPush.sourceBranch}</code><b>→</b><code>{recentPush.project.defaultBranch || "默认分支"}</code></span><small>{recentPushTimeLabel(recentPush.createdAt)}{recentPush.commitTitle ? ` · ${recentPush.commitTitle}` : ""}</small></div><Button type="button" variant={recentPushApplied ? "ghost" : "outline"} size="sm" onClick={useDetectedRecentPush} disabled={optionsLoading || recentPushApplied}>{recentPushApplied ? "已自动填入" : "使用此推送"}</Button></div>}
    {optionsLoading && <div className="gitlab-create-mr-status" role="status"><LoaderCircle aria-hidden="true" className="is-spinning" /><span>正在读取项目分支和可选项…</span></div>}
    {optionsError && <div className="gitlab-create-mr-status is-error" role="alert"><CircleAlert aria-hidden="true" /><span>{optionsError}</span><Button type="button" variant="ghost" size="sm" onClick={retryOptions} disabled={optionsLoading}><RefreshCw aria-hidden="true" />重新读取</Button></div>}
    <GitLabCreateMergeRequestFields step={step} draft={draft} projects={selectableProjects} sourceOptions={sourceOptions} targetOptions={targetOptions} descriptionMode={descriptionMode} optionsLoading={optionsLoading} projectSearchLoading={projectSearchLoading} disabled={saving || generatingDescription} onDescriptionModeChange={setDescriptionMode} onBackToBranches={() => setStep("branches")} onProjectSearchChange={searchProjects} onChange={updateDraft} onGenerateDescription={() => void generateDescription()} generatingDescription={generatingDescription} />
    {formError && <div className="gitlab-create-mr-form-error" role="alert"><CircleAlert aria-hidden="true" /><span>{formError}</span></div>}
    <footer className="gitlab-create-mr-footer"><Button type="button" variant="ghost" onClick={onClose} disabled={saving}><X aria-hidden="true" />取消</Button>{step === "details" && <Button type="button" variant="outline" onClick={() => setStep("branches")} disabled={saving}>返回选择分支</Button>}{step === "branches" ? <Button type="button" onClick={continueToDetails} disabled={optionsLoading || !canContinue}><GitMergeIcon />比较分支并继续</Button> : <Button type="submit" disabled={saving || optionsLoading || !draft.title.trim()}>{saving ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Plus aria-hidden="true" />}{saving ? "创建中…" : "创建 Merge Request"}</Button>}</footer>
  </>;

  return step === "details"
    ? <form className="gitlab-create-mr-form" onSubmit={(event) => void submit(event)} noValidate>{content}</form>
    : <div className="gitlab-create-mr-form">{content}</div>;
}

function GitMergeIcon() {
  return <Plus aria-hidden="true" />;
}

export function GitLabCreateMergeRequestDrawer(props: GitLabCreateMergeRequestDrawerProps) {
  const [rendered, setRendered] = useState(props.open);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (props.open) {
      setRendered(true);
      setIsClosing(false);
    } else if (rendered && !isClosing) {
      setIsClosing(true);
    }
  }, [isClosing, props.open, rendered]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = window.setTimeout(() => setRendered(false), DRAWER_EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [isClosing]);

  const requestClose = useCallback(() => {
    if (isClosing) return;
    props.onClose();
    setIsClosing(true);
  }, [isClosing, props]);

  if (!rendered) return null;
  return <ReviewDrawerShell eyebrow={null} title="新建 Merge Request" titleId="gitlab-create-mr-drawer-title" closeLabel="关闭新建 Merge Request" isClosing={isClosing} onRequestClose={requestClose} contentClassName="gitlab-create-mr-drawer-content"><CreateMergeRequestForm {...props} onClose={requestClose} /></ReviewDrawerShell>;
}
