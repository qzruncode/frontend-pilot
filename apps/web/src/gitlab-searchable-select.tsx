import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const EMPTY_VALUE = "__none__";

export type GitLabSearchableSelectOption = {
  value: string;
  label: string;
  searchText?: string;
  content?: ReactNode;
};

type GitLabSearchableSelectProps = {
  ariaLabel: string;
  value: string;
  options: readonly GitLabSearchableSelectOption[];
  emptyLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  disabled?: boolean;
  showEmptyOption?: boolean;
  searchLoading?: boolean;
  onSearchChange?: (value: string) => void;
  onChange: (value: string) => void;
};

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function GitLabSearchableSelect({ ariaLabel, value, options, emptyLabel, placeholder, searchPlaceholder, disabled = false, showEmptyOption = true, searchLoading = false, onSearchChange, onChange }: GitLabSearchableSelectProps) {
  const [search, setSearch] = useState("");
  const normalizedSearch = normalizeSearch(search);
  const filteredOptions = useMemo(
    () => normalizedSearch ? options.filter((option) => normalizeSearch(`${option.label} ${option.searchText ?? ""}`).includes(normalizedSearch)) : options,
    [normalizedSearch, options],
  );

  const handleSearchChange = (value: string) => {
    setSearch(value);
    onSearchChange?.(value);
  };

  return <Select value={value || (showEmptyOption ? EMPTY_VALUE : undefined)} onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)} onOpenChange={(open) => { if (!open) setSearch(""); }} disabled={disabled}>
    <SelectTrigger className="gitlab-create-mr-select-trigger" aria-label={ariaLabel}>
      <SelectValue placeholder={placeholder} />
    </SelectTrigger>
    <SelectContent className="gitlab-create-mr-select-content">
      <div className="gitlab-create-mr-select-search" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <Search aria-hidden="true" />
        <Input aria-label={searchPlaceholder} value={search} onChange={(event) => handleSearchChange(event.target.value)} onKeyDown={(event) => event.stopPropagation()} placeholder={searchPlaceholder} autoComplete="off" />
      </div>
      {showEmptyOption && <SelectItem value={EMPTY_VALUE}>{emptyLabel}</SelectItem>}
      {filteredOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.content ?? option.label}</SelectItem>)}
      {searchLoading ? <p className="gitlab-create-mr-select-loading">正在搜索项目…</p> : filteredOptions.length === 0 && <p className="gitlab-create-mr-select-empty">没有匹配的选项</p>}
    </SelectContent>
  </Select>;
}

type GitLabSearchableMultiSelectProps = {
  ariaLabel: string;
  values: readonly string[];
  options: readonly GitLabSearchableSelectOption[];
  emptyLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  disabled?: boolean;
  onChange: (values: string[]) => void;
};

export function GitLabSearchableMultiSelect({ ariaLabel, values, options, emptyLabel, placeholder, searchPlaceholder, disabled = false, onChange }: GitLabSearchableMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const normalizedSearch = normalizeSearch(search);
  const selectedOptions = options.filter((option) => values.includes(option.value));
  const filteredOptions = useMemo(
    () => normalizedSearch ? options.filter((option) => normalizeSearch(`${option.label} ${option.searchText ?? ""}`).includes(normalizedSearch)) : options,
    [normalizedSearch, options],
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggleValue = (nextValue: string) => {
    onChange(values.includes(nextValue) ? values.filter((value) => value !== nextValue) : [...values, nextValue]);
  };
  const displayName = selectedOptions.length > 0 ? selectedOptions.map((option) => option.label).join("、") : placeholder;

  return <div className="gitlab-create-mr-multi-select" ref={rootRef}>
    <Button type="button" variant="outline" className="gitlab-create-mr-select-trigger gitlab-create-mr-multi-select-trigger" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${ariaLabel}-multi-select`} disabled={disabled} onClick={() => { setSearch(""); setOpen((current) => !current); }}>
      <span title={selectedOptions.length > 0 ? displayName : undefined}>{displayName}</span>
      <ChevronDown aria-hidden="true" />
    </Button>
    {open && <div id={`${ariaLabel}-multi-select`} className="gitlab-create-mr-multi-select-menu" role="listbox" aria-label={`${ariaLabel}选项`} aria-multiselectable="true">
      <div className="gitlab-create-mr-multi-select-search" onKeyDown={(event) => event.stopPropagation()}><Search aria-hidden="true" /><Input aria-label={searchPlaceholder} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchPlaceholder} autoFocus /></div>
      {!search.trim() && <Button type="button" variant="ghost" className="gitlab-create-mr-multi-select-option" role="option" aria-selected={values.length === 0} onClick={() => onChange([])}><span className="gitlab-create-mr-multi-select-check">{values.length === 0 && <Check aria-hidden="true" />}</span><span>{emptyLabel}</span></Button>}
      {filteredOptions.map((option) => {
        const selected = values.includes(option.value);
        return <Button key={option.value} type="button" variant="ghost" className="gitlab-create-mr-multi-select-option" role="option" aria-selected={selected} onClick={() => toggleValue(option.value)}><span className={`gitlab-create-mr-multi-select-check${selected ? " is-selected" : ""}`}>{selected && <Check aria-hidden="true" />}</span><span>{option.content ?? option.label}</span></Button>;
      })}
      {filteredOptions.length === 0 && <p className="gitlab-create-mr-select-empty">没有匹配的选项</p>}
      {values.length > 0 && <Button type="button" variant="ghost" className="gitlab-create-mr-multi-select-clear" onClick={() => onChange([])}>清除已选</Button>}
    </div>}
  </div>;
}
