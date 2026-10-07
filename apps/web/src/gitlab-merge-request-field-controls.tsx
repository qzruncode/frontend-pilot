import { useState, type ReactNode } from "react";
import type { GitLabIdentity, GitLabLabelOption, GitLabMergeRequestCreateOptions, GitLabMilestoneOption } from "@contracts";
import { Search, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { GitLabSearchableMultiSelect, GitLabSearchableSelect } from "./gitlab-searchable-select";

export function GitLabMergeRequestFieldLabel({ children, required, hint, htmlFor }: { children: ReactNode; required?: boolean; hint?: string; htmlFor?: string }) {
  return <label className="gitlab-create-mr-field-label" htmlFor={htmlFor}><span>{children}{required && <em aria-label="必填">*</em>}</span>{hint && <small>{hint}</small>}</label>;
}

function selectableMembers(options: GitLabMergeRequestCreateOptions | null): GitLabIdentity[] {
  if (!options) return [];
  return [...new Map([options.currentUser, ...options.members].filter((member) => member.id).map((member) => [member.id, member])).values()];
}

function memberOption(member: GitLabIdentity) {
  return {
    value: member.id ?? member.username,
    label: member.name || member.username,
    searchText: `${member.name} ${member.username}`,
  };
}

export function GitLabMergeRequestMemberSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: GitLabMergeRequestCreateOptions | null; disabled: boolean; onChange: (value: string) => void }) {
  const memberOptions = selectableMembers(options).map(memberOption);
  return <div className="gitlab-create-mr-field"><GitLabMergeRequestFieldLabel>{label}</GitLabMergeRequestFieldLabel><GitLabSearchableSelect ariaLabel={label} value={value} options={memberOptions} emptyLabel="未指定" placeholder="未指定" searchPlaceholder={`搜索${label}…`} disabled={disabled} onChange={onChange} /></div>;
}

export function GitLabMergeRequestMemberMultiSelect({ label, values, options, disabled, onChange }: { label: string; values: string[]; options: GitLabMergeRequestCreateOptions | null; disabled: boolean; onChange: (values: string[]) => void }) {
  const memberOptions = selectableMembers(options).map(memberOption);
  return <div className="gitlab-create-mr-field"><GitLabMergeRequestFieldLabel hint={values.length ? `${values.length} 个已选` : "可选"}>{label}</GitLabMergeRequestFieldLabel><GitLabSearchableMultiSelect ariaLabel={label} values={values} options={memberOptions} emptyLabel="未指定" placeholder="未指定" searchPlaceholder={`搜索${label}…`} disabled={disabled} onChange={onChange} /></div>;
}

export function GitLabMergeRequestMilestoneSelect({ value, options, disabled, onChange }: { value: string; options: GitLabMilestoneOption[]; disabled: boolean; onChange: (value: string) => void }) {
  const milestoneOptions = options.map((milestone) => ({ value: milestone.id, label: `${milestone.title}${milestone.state !== "active" ? ` · ${milestone.state}` : ""}` }));
  return <div className="gitlab-create-mr-field"><GitLabMergeRequestFieldLabel hint="可选">Milestone</GitLabMergeRequestFieldLabel><GitLabSearchableSelect ariaLabel="Milestone" value={value} options={milestoneOptions} emptyLabel="无 Milestone" placeholder="无 Milestone" searchPlaceholder="搜索 Milestone…" disabled={disabled} onChange={onChange} /></div>;
}

export function GitLabMergeRequestLabelPicker({ options, value, disabled, onChange }: { options: GitLabLabelOption[]; value: string[]; disabled: boolean; onChange: (value: string[]) => void }) {
  const [search, setSearch] = useState("");
  const toggle = (name: string) => onChange(value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const visibleOptions = normalizedSearch ? options.filter((label) => `${label.name} ${label.description ?? ""}`.toLocaleLowerCase("zh-CN").includes(normalizedSearch)) : options;
  return <details className="gitlab-create-mr-label-picker"><summary><span><Tag aria-hidden="true" />Labels</span><strong>{value.length ? `${value.length} 个已选` : "未指定"}</strong></summary><div className="gitlab-create-mr-label-list"><div className="gitlab-create-mr-label-search" onKeyDown={(event) => event.stopPropagation()}><Search aria-hidden="true" /><Input aria-label="搜索 Labels" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Labels…" autoComplete="off" /></div>{options.length === 0 ? <p>当前项目暂无可选 Label</p> : visibleOptions.length === 0 ? <p>没有匹配的 Label</p> : visibleOptions.map((label) => <label key={label.id} className="gitlab-create-mr-label-option"><Checkbox checked={value.includes(label.name)} disabled={disabled} onCheckedChange={() => toggle(label.name)} /><span className="gitlab-create-mr-label-swatch" aria-hidden="true" /><span title={label.description ?? undefined}>{label.name}</span></label>)}</div></details>;
}
