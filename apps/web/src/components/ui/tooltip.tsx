import type { ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";

type TooltipProps = {
  children: ReactNode;
  content: ReactNode;
  className?: string;
  tooltipId?: string;
};

export function Tooltip({ children, content, className, tooltipId }: TooltipProps) {
  const generatedId = useId().replace(/:/g, "");
  const id = tooltipId ?? `tooltip-${generatedId}`;

  return (
    <span className={cn("app-tooltip-trigger", className)} tabIndex={0} aria-describedby={id}>
      {children}
      <span id={id} className="app-tooltip-content" role="tooltip">{content}</span>
    </span>
  );
}
