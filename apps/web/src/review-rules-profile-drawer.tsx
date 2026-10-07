import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ReviewRuleProfile } from "@contracts";
import { displayProfileName } from "./review-rule-utils";
import { ReviewDrawerShell } from "./review-drawer-shell";

const DRAWER_EXIT_DURATION_MS = 220;

export function ReviewRulesProfileDrawer({
  open,
  profile,
  onClose,
  children,
}: {
  open: boolean;
  profile: ReviewRuleProfile | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const [renderedProfile, setRenderedProfile] = useState<ReviewRuleProfile | null>(open ? profile : null);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (!open || !profile) return;
    setRenderedProfile(profile);
    setIsClosing(false);
  }, [open, profile]);

  useEffect(() => {
    if (!open && renderedProfile && !isClosing) setIsClosing(true);
  }, [isClosing, open, renderedProfile]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = window.setTimeout(() => setRenderedProfile(null), DRAWER_EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [isClosing]);

  const requestClose = useCallback(() => {
    if (isClosing) return;
    onClose();
    setIsClosing(true);
  }, [isClosing, onClose]);

  if (!renderedProfile) return null;
  return (
    <ReviewDrawerShell
      eyebrow="仓库 profile"
      title={displayProfileName(renderedProfile)}
      titleId="review-rules-profile-drawer-title"
      closeLabel="关闭审查规则详情"
      isClosing={isClosing}
      onRequestClose={requestClose}
      contentClassName="review-rules-profile-drawer-content"
    >
      {children}
    </ReviewDrawerShell>
  );
}
