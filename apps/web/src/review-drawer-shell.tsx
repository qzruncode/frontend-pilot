import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReviewDrawerShell({
  eyebrow,
  title,
  titleId,
  closeLabel,
  isClosing,
  onRequestClose,
  children,
  contentClassName,
  size = "default",
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  titleId: string;
  closeLabel: string;
  isClosing: boolean;
  onRequestClose: () => void;
  children: ReactNode;
  contentClassName?: string;
  size?: "default" | "compact";
}) {
  useEffect(() => {
    if (isClosing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onRequestClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isClosing, onRequestClose]);

  return createPortal(
    <div className={`review-session-drawer-layer ${isClosing ? "is-closing" : ""}`}>
      <Button variant="ghost" className="review-session-drawer-overlay" type="button" aria-label={closeLabel} onClick={onRequestClose} />
      <aside className={`review-session-drawer-panel${size === "compact" ? " is-compact" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="review-session-drawer-header">
          <div className="review-session-drawer-title-copy">
            {eyebrow ? <span>{eyebrow}</span> : null}
            <strong id={titleId}>{title}</strong>
          </div>
          <Button variant="outline" size="icon" className="review-session-drawer-close" type="button" aria-label={closeLabel} title="关闭" onClick={onRequestClose}>
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className={`review-session-drawer-content ${contentClassName ?? ""}`}>{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
