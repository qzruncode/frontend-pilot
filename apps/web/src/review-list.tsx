import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ReviewListRowProps = {
  ariaLabel: string;
  main: ReactNode;
  onSelect: () => void;
  selected?: boolean;
  actions?: ReactNode;
  actionsLabel?: string;
  className?: string;
};

export function ReviewListRow({
  ariaLabel,
  main,
  onSelect,
  selected = false,
  actions,
  actionsLabel,
  className,
}: ReviewListRowProps) {
  return (
    <div className={["review-history-row", selected ? "is-selected" : "", className].filter(Boolean).join(" ")}>
      <Button
        variant="ghost"
        className="review-history-row-select"
        type="button"
        aria-pressed={selected}
        aria-label={ariaLabel}
        onClick={onSelect}
      >
        {main}
        <ChevronRight className="review-history-row-chevron" aria-hidden="true" />
      </Button>
      {actions ? <div className="review-history-row-actions" aria-label={actionsLabel ?? `${ariaLabel} 操作`}>{actions}</div> : null}
    </div>
  );
}
