import type { ReviewRule, ReviewRuleProfile } from "@contracts";
import { ApiError } from "./api";

export type ReviewRuleDraft = Pick<ReviewRule, "name" | "description" | "enabled" | "content">;

export function draftFromRule(rule: ReviewRule): ReviewRuleDraft {
  return { name: rule.name, description: rule.description, enabled: rule.enabled, content: rule.content };
}

export function moveRuleTo(rules: ReviewRule[], sourceId: string, targetId: string): ReviewRule[] {
  const sourceIndex = rules.findIndex((rule) => rule.id === sourceId);
  const targetIndex = rules.findIndex((rule) => rule.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceId === targetId) return rules;

  const next = [...rules];
  const moved = next.splice(sourceIndex, 1)[0];
  if (!moved) return rules;
  next.splice(targetIndex, 0, moved);
  return next.map((rule, order) => ({ ...rule, order }));
}

export function displayProfileName(profile: Pick<ReviewRuleProfile, "name" | "displayName">): string {
  return profile.displayName || (profile.name === "default" ? "默认 profile" : profile.name);
}

export function profileDescription(profile: ReviewRuleProfile): string {
  return profile.isDefault ? "没有仓库匹配时使用" : "按 MR 仓库路径自动匹配";
}

export function ruleDescription(rule: ReviewRule): string {
  return rule.description || "未填写规则说明";
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "页面会话已失效，请刷新页面后重试。";
    if (error.status === 403) return "当前页面来源未被服务端允许。";
    if (typeof error.details === "string") return error.details;
    return error.message;
  }
  return error instanceof Error ? error.message : "审查规则操作失败";
}

export function displayErrorMessage(message: string): string {
  return message === "invalid_trigger_token" ? "页面会话已失效，请刷新页面后重试。" : message;
}
