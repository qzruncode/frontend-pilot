import { allSettingsItems, type SettingsItem } from "./assistant-settings";

export type AssistantNavigationState = {
  activeItem: SettingsItem["id"];
  reviewHistoryFocusId: string | null;
};

export const ASSISTANT_HOME_PATH = "/";

export const ASSISTANT_ROUTE_PATHS: Record<SettingsItem["id"], string> = {
  models: "/model-settings",
  "claude-cli": "/claude-cli",
  "review-workbench": "/review-workbench",
  "inspection-workbench": "/inspection-workbench",
  "review-tools": "/review-tools",
  "gitlab-workbench": "/gitlab-workbench",
  "jira-workbench": "/jira-workbench",
  "review-settings": "/review-settings",
  runs: "/review-history",
  gitlab: "/gitlab-settings",
  jira: "/jira-settings",
  rules: "/review-rules",
  feedback: "/feedback",
  "feedback-admin": "/feedback-admin",
  users: "/user-management",
  "user-activity": "/user-activity",
};

export const INSPECTION_CONFIG_ROUTE = `${ASSISTANT_ROUTE_PATHS["inspection-workbench"]}/configure/:projectId`;

export function inspectionConfigPath(projectId: string): string {
  return `${ASSISTANT_ROUTE_PATHS["inspection-workbench"]}/configure/${encodeURIComponent(projectId)}`;
}

export function assistantPathForNavigation(state: AssistantNavigationState): string {
  const basePath = ASSISTANT_ROUTE_PATHS[state.activeItem];
  if (state.activeItem === "runs" && state.reviewHistoryFocusId) {
    return `${basePath}/${encodeURIComponent(state.reviewHistoryFocusId)}`;
  }
  return basePath;
}

export function readLegacyAssistantNavigationState(search: string): AssistantNavigationState | null {
  const params = new URLSearchParams(search);
  const activeItem = params.get("settings");
  const selectedItem = allSettingsItems.find((item) => item.id === activeItem);
  if (!selectedItem) return null;
  return {
    activeItem: selectedItem.id,
    reviewHistoryFocusId: selectedItem.id === "runs"
      ? params.get("review")
      : null,
  };
}
