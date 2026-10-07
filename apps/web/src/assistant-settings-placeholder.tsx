import type { SettingsItem } from "./assistant-settings";

export function SettingsPlaceholder({ item }: { item: SettingsItem }) {
  const Icon = item.icon;
  return (
    <section className="settings-placeholder" aria-labelledby="settings-placeholder-title">
      <div className="settings-placeholder-icon"><Icon aria-hidden="true" /></div>
      <span className="model-settings-eyebrow">WORKSPACE SETTINGS</span>
      <h3 id="settings-placeholder-title">{item.label}</h3>
      <p>这个设置页还在整理中。你可以从左侧主菜单切换到其他工作区配置。</p>
    </section>
  );
}
