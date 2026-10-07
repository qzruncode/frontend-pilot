import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type FeedbackToastVariant = "error" | "success";

export function FeedbackToast({
  title,
  message,
  variant,
  onDismiss,
}: {
  title: string;
  message: string;
  variant: FeedbackToastVariant;
  onDismiss: () => void;
}) {
  const Icon = variant === "error" ? CircleAlert : CheckCircle2;
  return (
    <div className={cn("feedback-toast", `is-${variant}`)} role={variant === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="feedback-toast-close"
        type="button"
        aria-label="关闭消息提示"
        title="关闭消息提示"
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
