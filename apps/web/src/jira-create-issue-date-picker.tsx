import { useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDismissMenu } from "./jira-create-issue-pickers";
import {
  formatJiraDate,
  formatJiraDateDisplay,
  formatJiraDateLabel,
  getJiraCalendarDays,
  isSameJiraDate,
  parseJiraDate,
  shiftJiraMonth,
  startOfJiraMonth,
} from "./jira-create-issue-date-picker-utils";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" });

function today(): Date {
  const current = new Date();
  current.setHours(0, 0, 0, 0);
  return current;
}

export function JiraDatePicker({ id, ariaLabel, value, disabled, onChange }: {
  id: string;
  ariaLabel: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedDate = parseJiraDate(value);
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => startOfJiraMonth(selectedDate ?? today()));
  useDismissMenu(open, setOpen, rootRef);

  const togglePicker = () => {
    if (disabled) return;
    if (!open) setViewDate(startOfJiraMonth(selectedDate ?? today()));
    setOpen((current) => !current);
  };

  const selectDate = (date: Date) => {
    onChange(formatJiraDate(date));
    setViewDate(startOfJiraMonth(date));
    setOpen(false);
  };

  const clearDate = () => {
    onChange("");
    setOpen(false);
  };

  const monthLabel = MONTH_LABEL_FORMATTER.format(viewDate);
  const calendarDays = getJiraCalendarDays(viewDate);
  const currentMonth = viewDate.getMonth();
  const currentYear = viewDate.getFullYear();

  return <div className="jira-create-issue-date-picker" ref={rootRef}>
    <Button
      id={id}
      type="button"
      variant="outline"
      className="jira-create-issue-select-trigger jira-create-issue-date-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={`${id}-calendar`}
      disabled={disabled}
      onClick={togglePicker}
    >
      <span className={selectedDate ? undefined : "is-placeholder"}>{selectedDate ? formatJiraDateDisplay(selectedDate) : "年/月/日"}</span>
      <CalendarDays aria-hidden="true" />
    </Button>
    {open && <div id={`${id}-calendar`} className="jira-create-issue-date-menu" role="dialog" aria-label={`${ariaLabel}日期选择`}>
      <div className="jira-create-issue-date-header">
        <Button type="button" variant="ghost" aria-label="上个月" title="上个月" onClick={() => setViewDate((current) => shiftJiraMonth(current, -1))}><ChevronLeft aria-hidden="true" /></Button>
        <strong>{monthLabel}</strong>
        <Button type="button" variant="ghost" aria-label="下个月" title="下个月" onClick={() => setViewDate((current) => shiftJiraMonth(current, 1))}><ChevronRight aria-hidden="true" /></Button>
      </div>
      <div className="jira-create-issue-date-grid" role="grid" aria-label={monthLabel}>
        {WEEKDAYS.map((weekday) => <span key={weekday} role="columnheader">{weekday}</span>)}
        {calendarDays.map((date) => {
          const inCurrentMonth = date.getMonth() === currentMonth && date.getFullYear() === currentYear;
          const selected = isSameJiraDate(selectedDate, date);
          const dateLabel = formatJiraDateLabel(date);
          return <Button
            key={formatJiraDate(date)}
            type="button"
            variant="ghost"
            className={`jira-create-issue-date-day${inCurrentMonth ? "" : " is-outside-month"}${selected ? " is-selected" : ""}`}
            aria-label={dateLabel}
            aria-pressed={selected}
            onClick={() => selectDate(date)}
          >{date.getDate()}</Button>;
        })}
      </div>
      <div className="jira-create-issue-date-footer">
        <Button type="button" variant="ghost" onClick={() => selectDate(today())}>今天</Button>
        {value && <Button type="button" variant="ghost" onClick={clearDate}>清除</Button>}
      </div>
    </div>}
  </div>;
}
