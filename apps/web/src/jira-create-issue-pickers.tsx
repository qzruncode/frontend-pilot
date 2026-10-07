import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { ChevronDown } from "lucide-react";
import type { JiraCreateIssueOption, JiraIdentity } from "@contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

const MAX_JIRA_LABELS = 20;
const MAX_VISIBLE_JIRA_OPTIONS = 80;

export function useDismissMenu(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>, rootRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, rootRef, setOpen]);
}

function uniqueAssignees(assignees: JiraIdentity[]): JiraIdentity[] {
  return [...new Map(assignees.map((assignee) => [assignee.username, assignee])).values()];
}

export function JiraOptionPicker({ options, value, disabled, onChange, id, ariaLabel, placeholder, searchPlaceholder, noneLabel, valueKey = "name" }: {
  options: JiraCreateIssueOption[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  id: string;
  ariaLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  noneLabel?: string;
  valueKey?: "id" | "name";
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissMenu(open, setOpen, rootRef);

  const optionValue = (option: JiraCreateIssueOption) => option[valueKey];
  const selected = options.find((option) => optionValue(option) === value);
  const matchingOptions = options.filter((option) => option.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const visibleOptions = matchingOptions.slice(0, MAX_VISIBLE_JIRA_OPTIONS);
  const displayName = selected?.name ?? (!value && noneLabel ? noneLabel : placeholder);
  const selectOption = (nextValue: string) => {
    onChange(nextValue);
    setSearch("");
    setOpen(false);
  };

  return <div className="jira-create-issue-searchable-picker" ref={rootRef}>
    <Button
      id={id}
      type="button"
      variant="outline"
      className="jira-create-issue-select-trigger jira-create-issue-label-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => { setSearch(""); setOpen((current) => !current); }}
    >
      <span>{displayName}</span>
      <ChevronDown aria-hidden="true" />
    </Button>
    {open && <div className="jira-create-issue-searchable-menu" role="listbox" aria-label={`${ariaLabel}选项`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      <Input className="jira-create-issue-menu-search" aria-label={`搜索${ariaLabel}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchPlaceholder} autoFocus />
      {noneLabel && !search.trim() && <Button type="button" variant="ghost" className="jira-create-issue-option-row" role="option" aria-selected={!value} onClick={() => selectOption("")}><span>{noneLabel}</span></Button>}
      {visibleOptions.map((option) => <Button type="button" variant="ghost" className="jira-create-issue-option-row" role="option" aria-selected={optionValue(option) === value} key={option.id} onClick={() => selectOption(optionValue(option))}><span>{option.name}</span></Button>)}
      {visibleOptions.length === 0 && (!noneLabel || search.trim()) && <p className="jira-create-issue-label-empty">没有匹配的选项</p>}
      {matchingOptions.length > visibleOptions.length && <small className="jira-create-issue-menu-hint">已显示前 {visibleOptions.length} 项，请继续输入缩小范围。</small>}
    </div>}
  </div>;
}

export function JiraMultiOptionPicker({ options, value, disabled, onChange, id, ariaLabel, placeholder, searchPlaceholder, maxSelected = MAX_JIRA_LABELS }: {
  options: JiraCreateIssueOption[];
  value: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
  id: string;
  ariaLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  maxSelected?: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissMenu(open, setOpen, rootRef);

  const matchingOptions = options.filter((option) => option.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const visibleOptions = matchingOptions.slice(0, MAX_VISIBLE_JIRA_OPTIONS);
  const toggleOption = (option: JiraCreateIssueOption, checked: boolean) => {
    if (checked && value.length >= maxSelected) {
      if (maxSelected === 1) onChange([option.name]);
      return;
    }
    onChange(checked ? [...value, option.name] : value.filter((current) => current !== option.name));
  };

  return <div className="jira-create-issue-label-picker" ref={rootRef}>
    <Button
      id={id}
      type="button"
      variant="outline"
      className="jira-create-issue-select-trigger jira-create-issue-label-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => { setSearch(""); setOpen((current) => !current); }}
    >
      <span>{value.length > 0 ? value.join("、") : placeholder}</span>
      <ChevronDown aria-hidden="true" />
    </Button>
    {open && <div className="jira-create-issue-label-menu" role="listbox" aria-label={`${ariaLabel}选项`} aria-multiselectable="true" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      <Input className="jira-create-issue-menu-search" aria-label={`搜索${ariaLabel}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchPlaceholder} autoFocus />
      {options.length === 0 ? <p className="jira-create-issue-label-empty">当前项目暂无可选项</p> : visibleOptions.length === 0 ? <p className="jira-create-issue-label-empty">没有匹配的选项</p> : visibleOptions.map((option) => <label className="jira-create-issue-label-option" key={option.id} role="option" aria-selected={value.includes(option.name)}>
        <Checkbox checked={value.includes(option.name)} disabled={!value.includes(option.name) && value.length >= maxSelected && maxSelected !== 1} onCheckedChange={(checked) => toggleOption(option, checked === true)} aria-label={`选择${ariaLabel} ${option.name}`} />
        <span>{option.name}</span>
      </label>)}
      {matchingOptions.length > visibleOptions.length && <small className="jira-create-issue-menu-hint">已显示前 {visibleOptions.length} 项，请继续输入缩小范围。</small>}
    </div>}
  </div>;
}

export function JiraLabelPicker({ options, value, disabled, onChange }: {
  options: string[];
  value: string[];
  disabled: boolean;
  onChange: (labels: string[]) => void;
}) {
  return <JiraMultiOptionPicker
    id="jira-create-labels"
    ariaLabel="标签"
    options={options.map((name) => ({ id: name, name }))}
    value={value}
    disabled={disabled}
    onChange={onChange}
    placeholder="选择已有标签"
    searchPlaceholder="搜索标签…"
  />;
}

export function JiraAssigneePicker({ options, currentUser, value, disabled, onChange, onSearchChange, searchLoading = false, id = "jira-create-assignee", ariaLabel = "经办人 可选", placeholder = "自动分配", searchPlaceholder = "搜索姓名或账号…" }: {
  options: JiraIdentity[];
  currentUser?: JiraIdentity | null;
  value: string;
  disabled: boolean;
  onChange: (username: string) => void;
  onSearchChange?: (query: string) => void;
  searchLoading?: boolean;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissMenu(open, setOpen, rootRef);

  const assignees = uniqueAssignees(options);
  const selected = assignees.find((assignee) => assignee.username === value)
    ?? (currentUser?.username === value ? currentUser : undefined);
  const matchingAssignees = assignees.filter((assignee) => `${assignee.name} ${assignee.username}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const visibleAssignees = matchingAssignees.slice(0, MAX_VISIBLE_JIRA_OPTIONS);
  const displayName = selected ? `${selected.name || selected.username}（${selected.username}）` : placeholder;

  const changeSearch = (query: string) => { setSearch(query); onSearchChange?.(query); };

  const selectAssignee = (username: string) => {
    onChange(username);
    setSearch("");
    setOpen(false);
  };

  return <div className="jira-create-issue-searchable-picker" ref={rootRef}>
    <Button
      id={id}
      type="button"
      variant="outline"
      className="jira-create-issue-select-trigger jira-create-issue-label-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => { changeSearch(""); setOpen((current) => !current); }}
    >
      <span>{displayName}</span>
      <ChevronDown aria-hidden="true" />
    </Button>
    {open && <div className="jira-create-issue-searchable-menu" role="listbox" aria-label={`可选${ariaLabel}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      <Input className="jira-create-issue-menu-search" aria-label={`搜索${ariaLabel}`} value={search} onChange={(event) => changeSearch(event.target.value)} placeholder={searchPlaceholder} autoFocus />
      {!search.trim() && <Button type="button" variant="ghost" className="jira-create-issue-option-row" role="option" aria-selected={!value} onClick={() => selectAssignee("")}><span>{placeholder}</span></Button>}
      {visibleAssignees.map((assignee) => <Button type="button" variant="ghost" className="jira-create-issue-option-row" role="option" aria-selected={assignee.username === value} key={assignee.username} onClick={() => selectAssignee(assignee.username)}><span>{assignee.name || assignee.username}（{assignee.username}）</span></Button>)}
      {searchLoading && <p className="jira-create-issue-label-empty" role="status">正在搜索 Jira 人员…</p>}
      {!searchLoading && visibleAssignees.length === 0 && <p className="jira-create-issue-label-empty">没有匹配的经办人</p>}
      {matchingAssignees.length > visibleAssignees.length && <small className="jira-create-issue-menu-hint">已显示前 {visibleAssignees.length} 项，请继续输入缩小范围。</small>}
    </div>}
    {currentUser && <Button type="button" variant="link" className="jira-create-issue-assign-me" aria-pressed={currentUser.username === value} disabled={disabled || !currentUser.username} onClick={() => { selectAssignee(currentUser.username); }}>分配给我</Button>}
  </div>;
}
