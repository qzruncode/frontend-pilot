import { LogOut, Sparkles, X } from "lucide-react";
import { settingsItems, type SettingsItem } from "./assistant-settings";
import { Button } from "@/components/ui/button";

type AssistantNavigationDrawerProps = {
  open: boolean;
  inspectionAccess?: boolean;
  activeItem?: SettingsItem["id"];
  isAdmin: boolean;
  username: string | null;
  loggingOut: boolean;
  onClose: () => void;
  onSelectItem: (item: SettingsItem) => void;
  onLogout: () => void;
};

function userInitial(username: string | null): string {
  const normalized = username?.trim();
  return normalized ? Array.from(normalized)[0]?.toUpperCase() ?? "U" : "U";
}

export function AssistantNavigationDrawer({ inspectionAccess = false, open, activeItem, isAdmin, username, loggingOut, onClose, onSelectItem, onLogout }: AssistantNavigationDrawerProps) {
  return (
    <div className={`assistant-navigation-layer ${open ? "is-open" : ""}`} role="presentation" aria-hidden={!open ? "true" : undefined}>
      {open && <Button variant="ghost" className="assistant-navigation-dismiss" type="button" aria-label="关闭主菜单" onClick={onClose} />}
      <aside className="assistant-navigation-drawer" aria-label="主菜单">
        <header className="assistant-navigation-header">
          <div className="assistant-identity"><div className="assistant-brand-icon"><Sparkles aria-hidden="true" /></div><strong>Frontend Pilot</strong></div>
          <Button variant="ghost" size="icon" className="assistant-navigation-close" type="button" aria-label="关闭主菜单" title="关闭主菜单" onClick={onClose}><X aria-hidden="true" /></Button>
        </header>
        <nav className="assistant-navigation-list" aria-label="菜单">
          {settingsItems.filter((item) => (!item.adminOnly || isAdmin) && (item.id !== "inspection-workbench" || inspectionAccess || isAdmin)).map((item) => {
            const Icon = item.icon;
            const selected = item.id === activeItem;
            return (
              <Button
                variant="ghost"
                className={`assistant-navigation-item ${selected ? "is-selected" : ""}`}
                type="button"
                key={item.id}
                aria-current={selected ? "page" : undefined}
                onClick={() => onSelectItem(item)}
              >
                <span className="assistant-settings-item-icon"><Icon aria-hidden="true" /></span>
                <span>{item.label}</span>
              </Button>
            );
          })}
        </nav>
        <footer className="assistant-navigation-account" aria-label="当前登录用户">
          <div className="assistant-navigation-account-avatar" aria-hidden="true">{userInitial(username)}</div>
          <div className="assistant-navigation-account-copy">
            <strong title={username ?? "当前用户"}>{username ?? "当前用户"}</strong>
            <span>Frontend Pilot · 已登录</span>
          </div>
          <Button
            variant="outline"
            className="assistant-navigation-logout"
            type="button"
            aria-label={loggingOut ? "正在退出登录" : "退出登录"}
            title="退出登录"
            disabled={loggingOut}
            onClick={onLogout}
          >
            <LogOut aria-hidden="true" />
            <span>{loggingOut ? "退出中…" : "退出登录"}</span>
          </Button>
        </footer>
      </aside>
    </div>
  );
}
