import { type ReactNode } from "react";
import type {
  GitLabBranchOption,
  GitLabMergeRequestCreateOptions,
  GitLabProject,
} from "@contracts";
import { GitBranch, GitMerge, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { GitLabMarkdownEditor, type GitLabMarkdownEditorMode } from "./gitlab-markdown";
import { GitLabSearchableSelect } from "./gitlab-searchable-select";
import { GitLabMergeRequestFieldLabel as FieldLabel, GitLabMergeRequestLabelPicker as LabelPicker, GitLabMergeRequestMemberMultiSelect as MemberMultiSelect, GitLabMergeRequestMemberSelect as MemberSelect, GitLabMergeRequestMilestoneSelect as MilestoneSelect } from "./gitlab-merge-request-field-controls";

export type GitLabMergeRequestDraft = {
  sourceProjectId: string;
  sourceBranch: string;
  targetProjectId: string;
  targetBranch: string;
  jiraKey: string;
  title: string;
  description: string;
  assigneeId: string;
  reviewerIds: string[];
  milestoneId: string;
  labels: string[];
  removeSourceBranch: boolean;
  squash: boolean;
};

type FieldsProps = {
  step: "branches" | "details";
  draft: GitLabMergeRequestDraft;
  projects: GitLabProject[];
  sourceOptions: GitLabMergeRequestCreateOptions | null;
  targetOptions: GitLabMergeRequestCreateOptions | null;
  descriptionMode: GitLabMarkdownEditorMode;
  optionsLoading: boolean;
  projectSearchLoading: boolean;
  disabled: boolean;
  onDescriptionModeChange: (mode: GitLabMarkdownEditorMode) => void;
  onBackToBranches: () => void;
  onProjectSearchChange: (value: string) => void;
  onChange: (patch: Partial<GitLabMergeRequestDraft>) => void;
  onGenerateDescription: () => void;
  generatingDescription: boolean;
};

function projectLabel(project: GitLabProject): string {
  return project.pathWithNamespace || project.name;
}

function branchLabel(branch: GitLabBranchOption): ReactNode {
  return <>{branch.name}{branch.isDefault ? " · 默认" : ""}{branch.isProtected ? " · 受保护" : ""}</>;
}

function ProjectSelect({ label, value, projects, disabled, searchLoading, onSearchChange, onChange }: { label: string; value: string; projects: GitLabProject[]; disabled: boolean; searchLoading: boolean; onSearchChange: (value: string) => void; onChange: (value: string) => void }) {
  const options = projects.map((project) => ({ value: project.id, label: projectLabel(project), searchText: project.name }));
  return <div className="gitlab-create-mr-field"><FieldLabel>{label}</FieldLabel><GitLabSearchableSelect ariaLabel={label} value={value} options={options} emptyLabel="选择项目" placeholder="选择项目" searchPlaceholder={`搜索${label}…`} searchLoading={searchLoading} onSearchChange={onSearchChange} disabled={disabled} onChange={onChange} /></div>;
}

function BranchSelect({ label, value, options, disabled, required, onChange }: { label: string; value: string; options: GitLabMergeRequestCreateOptions | null; disabled: boolean; required?: boolean; onChange: (value: string) => void }) {
  const branchOptions = options?.branches.map((branch) => ({ value: branch.name, label: branch.name, content: branchLabel(branch) })) ?? [];
  return <div className="gitlab-create-mr-field"><FieldLabel required={required}>{label}</FieldLabel><GitLabSearchableSelect ariaLabel={label} value={value} options={branchOptions} emptyLabel="选择分支" placeholder={options ? "选择分支" : "正在读取分支…"} searchPlaceholder={`搜索${label}…`} disabled={disabled || !options} onChange={onChange} /></div>;
}

function CompareCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="gitlab-create-mr-compare-card"><div className="gitlab-create-mr-compare-card-heading"><span>{icon}</span><strong>{title}</strong></div>{children}</section>;
}

function BranchStep({ draft, projects, sourceOptions, targetOptions, optionsLoading, projectSearchLoading, disabled, onProjectSearchChange, onChange }: FieldsProps) {
  const sameBranch = draft.sourceProjectId === draft.targetProjectId && draft.sourceBranch && draft.sourceBranch === draft.targetBranch;
  return <section className="gitlab-create-mr-section"><div className="gitlab-create-mr-section-heading"><div><h4>选择源分支和目标分支</h4><p>当前工作台创建同项目 MR，目标项目会随源项目同步；分支只从 GitLab 当前项目读取。</p></div><GitMerge aria-hidden="true" /></div><div className="gitlab-create-mr-compare-grid"><CompareCard title="源分支" icon={<GitBranch aria-hidden="true" />}><ProjectSelect label="源项目" value={draft.sourceProjectId} projects={projects} disabled={disabled || optionsLoading} searchLoading={projectSearchLoading} onSearchChange={onProjectSearchChange} onChange={(value) => onChange({ sourceProjectId: value, targetProjectId: value, sourceBranch: "", targetBranch: "", title: "", description: "", assigneeId: "", reviewerIds: [], milestoneId: "", labels: [] })} /><BranchSelect label="源分支" required value={draft.sourceBranch} options={sourceOptions} disabled={disabled || optionsLoading} onChange={(value) => { const branch = sourceOptions?.branches.find((item) => item.name === value); onChange({ sourceBranch: value, title: draft.title || branch?.commitTitle || "" }); }} /></CompareCard><CompareCard title="目标分支" icon={<GitMerge aria-hidden="true" />}><ProjectSelect label="目标项目" value={draft.sourceProjectId} projects={projects} disabled searchLoading={projectSearchLoading} onSearchChange={onProjectSearchChange} onChange={(value) => onChange({ targetProjectId: value, targetBranch: "" })} /><BranchSelect label="目标分支" required value={draft.targetBranch} options={targetOptions} disabled={disabled || optionsLoading} onChange={(value) => onChange({ targetBranch: value })} /></CompareCard></div>{sameBranch && <p className="gitlab-create-mr-inline-error" role="alert">源分支和目标分支不能相同，请选择要比较的两个分支。</p>}</section>;
}

function DetailsStep({ draft, targetOptions, descriptionMode, disabled, onDescriptionModeChange, onBackToBranches, onChange, onGenerateDescription, generatingDescription }: Pick<FieldsProps, "draft" | "targetOptions" | "descriptionMode" | "disabled" | "onDescriptionModeChange" | "onBackToBranches" | "onChange" | "onGenerateDescription" | "generatingDescription">) {
  const options = targetOptions ?? { currentUser: { id: null, username: "", name: "", webUrl: null, avatarUrl: null }, branches: [], members: [], milestones: [], labels: [] };
  return <><section className="gitlab-create-mr-section"><div className="gitlab-create-mr-compare-summary"><span>From</span><code>{draft.sourceBranch}</code><span>into</span><code>{draft.targetBranch}</code><Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onBackToBranches}>更改分支</Button></div><div className="gitlab-create-mr-field gitlab-create-mr-field-wide"><FieldLabel required htmlFor="gitlab-create-mr-jira-key">关联 Jira</FieldLabel><Input id="gitlab-create-mr-jira-key" value={draft.jiraKey} onChange={(event) => onChange({ jiraKey: event.target.value })} placeholder="例如 DEMO-123" maxLength={128} aria-required="true" disabled={disabled} /></div><div className="gitlab-create-mr-field gitlab-create-mr-field-wide"><FieldLabel required htmlFor="gitlab-create-mr-title">标题</FieldLabel><Input id="gitlab-create-mr-title" value={draft.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="输入 Merge Request 标题" maxLength={255} aria-required="true" disabled={disabled} /></div><div className="gitlab-create-mr-field gitlab-create-mr-field-wide"><div className="gitlab-create-mr-field-heading"><FieldLabel hint="支持 Markdown">描述</FieldLabel><Button type="button" variant="outline" size="sm" onClick={onGenerateDescription} disabled={disabled || generatingDescription || !draft.jiraKey.trim() || !draft.title.trim()}>{generatingDescription ? "生成中…" : <><Sparkles aria-hidden="true" />生成规范描述</>}</Button></div><div className="gitlab-create-mr-editor"><GitLabMarkdownEditor value={draft.description} mode={descriptionMode} onChange={(value) => onChange({ description: value })} onModeChange={onDescriptionModeChange} placeholder="描述本次变更的目标、影响和需要 Reviewer 关注的内容…" rows={8} ariaLabel="Merge Request 描述 Markdown 源码" /></div><small className="gitlab-create-mr-field-note">生成后仍可手动修改，创建前请补充真实验证结果。</small></div></section><section className="gitlab-create-mr-section"><div className="gitlab-create-mr-section-heading"><div><h4>参与人和标签</h4><p>Assignee 和 Reviewers 从目标项目成员中选择，可搜索并保留多个 Reviewer。</p></div><ShieldCheck aria-hidden="true" /></div><div className="gitlab-create-mr-fields"><MemberSelect label="Assignee" value={draft.assigneeId} options={targetOptions} disabled={disabled} onChange={(value) => onChange({ assigneeId: value })} /><MemberMultiSelect label="Reviewers" values={draft.reviewerIds} options={targetOptions} disabled={disabled} onChange={(reviewerIds) => onChange({ reviewerIds })} /><MilestoneSelect value={draft.milestoneId} options={options.milestones} disabled={disabled} onChange={(value) => onChange({ milestoneId: value })} /><LabelPicker options={options.labels} value={draft.labels} disabled={disabled} onChange={(value) => onChange({ labels: value })} /></div></section><section className="gitlab-create-mr-section"><div className="gitlab-create-mr-section-heading"><div><h4>合并选项</h4></div><GitMerge aria-hidden="true" /></div><div className="gitlab-create-mr-options"><label><Checkbox checked={draft.removeSourceBranch} disabled={disabled} onCheckedChange={(checked) => onChange({ removeSourceBranch: checked === true })} /><span>MR 接受后删除源分支</span></label><label><Checkbox checked={draft.squash} disabled={disabled} onCheckedChange={(checked) => onChange({ squash: checked === true })} /><span>MR 接受后压缩提交</span></label></div></section></>;
}

export function GitLabCreateMergeRequestFields(props: FieldsProps) {
  return props.step === "branches" ? <BranchStep {...props} /> : <DetailsStep {...props} />;
}
