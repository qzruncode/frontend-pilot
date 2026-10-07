const JIRA_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function parseJiraDate(value: string): Date | null {
  const match = JIRA_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function formatJiraDate(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

export function formatJiraDateDisplay(date: Date): string {
  return `${date.getFullYear()}/${padDatePart(date.getMonth() + 1)}/${padDatePart(date.getDate())}`;
}

export function formatJiraDateLabel(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function startOfJiraMonth(date: Date): Date {
  const month = new Date(date);
  month.setHours(0, 0, 0, 0);
  month.setDate(1);
  return month;
}

export function shiftJiraMonth(date: Date, offset: number): Date {
  const month = startOfJiraMonth(date);
  month.setMonth(month.getMonth() + offset);
  return month;
}

export function getJiraCalendarDays(viewDate: Date): Date[] {
  const firstOfMonth = startOfJiraMonth(viewDate);
  const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
  const firstCell = new Date(firstOfMonth);
  firstCell.setDate(1 - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(firstCell);
    day.setDate(firstCell.getDate() + index);
    return day;
  });
}

export function isSameJiraDate(left: Date | null, right: Date): boolean {
  return Boolean(left)
    && left?.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}
