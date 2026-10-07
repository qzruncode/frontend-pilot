import type { ReactNode } from "react";
import { Tooltip } from "./components/ui/tooltip";

type AdminPermissionTooltipProps = {
  isAdmin: boolean;
  tooltipId: string;
  children: ReactNode;
};

export function AdminPermissionTooltip({ isAdmin, tooltipId, children }: AdminPermissionTooltipProps) {
  if (isAdmin) return <>{children}</>;
  return <Tooltip className="admin-permission-tooltip-trigger" tooltipId={tooltipId} content="当前账号不是管理员，无法保存配置。">{children}</Tooltip>;
}
