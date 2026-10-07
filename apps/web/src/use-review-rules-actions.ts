import type { Dispatch, SetStateAction } from "react";
import type { ReviewRuleProfile } from "@contracts";
import {
  createReviewProfile,
  createReviewRule,
  deleteReviewProfile,
  deleteReviewRule,
  reorderReviewRules,
  saveReviewRule,
} from "./api";
import { displayProfileName, errorMessage, moveRuleTo, type ReviewRuleDraft } from "./review-rule-utils";

export type NewReviewRule = { name: string; description: string; content: string; enabled: boolean };

type ReviewRulesActionState = {
  profiles: ReviewRuleProfile[];
  setProfiles: Dispatch<SetStateAction<ReviewRuleProfile[]>>;
  selectedName: string | null;
  setSelectedName: Dispatch<SetStateAction<string | null>>;
  selectedProfile: ReviewRuleProfile | null;
  selectedRule: ReviewRuleProfile["rules"][number] | null;
  setSelectedRuleId: Dispatch<SetStateAction<string | null>>;
  draft: ReviewRuleDraft | null;
  setDraft: Dispatch<SetStateAction<ReviewRuleDraft | null>>;
  newProfilePath: string;
  setNewProfilePath: Dispatch<SetStateAction<string>>;
  newProfileName: string;
  setNewProfileName: Dispatch<SetStateAction<string>>;
  newRule: NewReviewRule;
  setNewRule: Dispatch<SetStateAction<NewReviewRule>>;
  setProfileDetailOpen: Dispatch<SetStateAction<boolean>>;
  setProfileFormOpen: Dispatch<SetStateAction<boolean>>;
  setRuleFormOpen: Dispatch<SetStateAction<boolean>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  saving: boolean;
  setSaving: Dispatch<SetStateAction<boolean>>;
  reordering: boolean;
  setReordering: Dispatch<SetStateAction<boolean>>;
  togglingRuleId: string | null;
  setTogglingRuleId: Dispatch<SetStateAction<string | null>>;
  setLoadError: Dispatch<SetStateAction<string | null>>;
  loadProfiles: () => Promise<void>;
};

export function useReviewRulesActions(state: ReviewRulesActionState, onNotice: (message: string) => void, onError: (message: string | null) => void) {
  const replaceProfile = (profile: ReviewRuleProfile) => {
    state.setProfiles((current) => current.map((item) => item.name === profile.name ? profile : item));
  };

  const updateDraft = (patch: Partial<ReviewRuleDraft>) => {
    state.setDraft((current) => current ? { ...current, ...patch } : current);
    state.setDirty(true);
    state.setLoadError(null);
    onError(null);
  };

  const selectProfile = (name: string) => {
    if (state.reordering || state.togglingRuleId || state.saving) return;
    if (state.dirty) {
      const message = "当前规则有未保存修改，请先保存或放弃修改。";
      state.setLoadError(message);
      onError(message);
      return;
    }
    state.setSelectedName(name);
    state.setRuleFormOpen(false);
    state.setProfileDetailOpen(true);
    state.setLoadError(null);
  };

  const closeProfileDetail = () => {
    if (state.dirty || state.saving || state.reordering || state.togglingRuleId) {
      const message = "当前规则有未保存修改或正在保存，请完成后再返回。";
      state.setLoadError(message);
      onError(message);
      return;
    }
    state.setProfileDetailOpen(false);
    state.setRuleFormOpen(false);
    state.setLoadError(null);
    onError(null);
  };

  const selectRule = (ruleId: string) => {
    if (ruleId === state.selectedRule?.id || state.reordering || state.togglingRuleId || state.saving) return;
    if (state.dirty) {
      const message = "当前规则有未保存修改，请先保存或放弃修改。";
      state.setLoadError(message);
      onError(message);
      return;
    }
    state.setSelectedRuleId(ruleId);
    state.setRuleFormOpen(false);
  };

  const resetDraft = () => {
    if (!state.selectedRule) return;
    state.setDraft({ name: state.selectedRule.name, description: state.selectedRule.description, content: state.selectedRule.content, enabled: state.selectedRule.enabled });
    state.setDirty(false);
    state.setLoadError(null);
    onError(null);
  };

  const createProfile = async () => {
    const profile = state.newProfilePath.trim();
    if (!profile) {
      state.setLoadError("请输入仓库路径，例如 aip/ui/so-chart。");
      return;
    }
    try {
      const response = await createReviewProfile({ profile, displayName: state.newProfileName.trim() || undefined });
      state.setProfiles((current) => [...current, response.profile]);
      state.setSelectedName(response.profile.name);
      state.setSelectedRuleId(null);
      state.setProfileDetailOpen(true);
      state.setProfileFormOpen(false);
      state.setNewProfilePath("");
      state.setNewProfileName("");
      onNotice(`已创建 ${response.profile.displayName}，Review 会按仓库路径自动使用它`);
    } catch (error) {
      const message = errorMessage(error);
      state.setLoadError(message);
      onError(message);
    }
  };

  const removeProfile = async (profileName?: string) => {
    const targetProfile = state.profiles.find((profile) => profile.name === (profileName ?? state.selectedName));
    if (!targetProfile || targetProfile.isDefault) return;
    if (targetProfile.name === state.selectedProfile?.name && (state.dirty || state.saving || state.reordering || state.togglingRuleId)) {
      const message = "当前规则有未保存修改，请先保存或放弃修改。";
      state.setLoadError(message);
      onError(message);
      return;
    }
    if (!window.confirm(`确定删除 ${targetProfile.displayName} 及其规则吗？`)) return;
    try {
      await deleteReviewProfile({ profile: targetProfile.name });
      const fallback = state.profiles.find((profile) => profile.name !== targetProfile.name && profile.isDefault)?.name ?? state.profiles.find((profile) => profile.name !== targetProfile.name)?.name ?? null;
      state.setProfiles((current) => current.filter((profile) => profile.name !== targetProfile.name));
      if (targetProfile.name === state.selectedName) {
        state.setSelectedName(fallback);
        state.setSelectedRuleId(null);
        state.setProfileDetailOpen(false);
        state.setRuleFormOpen(false);
      }
      onNotice(`${targetProfile.displayName} 已删除`);
    } catch (error) {
      const message = errorMessage(error);
      state.setLoadError(message);
      onError(message);
    }
  };

  const createRule = async () => {
    if (!state.selectedProfile) return;
    if (!state.newRule.name.trim() || !state.newRule.content.trim()) {
      state.setLoadError("规则名称和规则正文不能为空。");
      return;
    }
    try {
      const previousIds = new Set(state.selectedProfile.rules.map((rule) => rule.id));
      const response = await createReviewRule({ profile: state.selectedProfile.name, ...state.newRule });
      replaceProfile(response.profile);
      const created = response.profile.rules.find((rule) => !previousIds.has(rule.id));
      state.setSelectedRuleId(created?.id ?? null);
      state.setRuleFormOpen(false);
      state.setNewRule({ name: "", description: "", content: "", enabled: true });
      onNotice(`规则“${created?.name ?? state.newRule.name}”已创建`);
    } catch (error) {
      const message = errorMessage(error);
      state.setLoadError(message);
      onError(message);
    }
  };

  const save = async () => {
    if (!state.selectedProfile || !state.selectedRule || !state.draft) return;
    if (!state.draft.name.trim() || !state.draft.content.trim()) {
      state.setLoadError("规则名称和规则正文不能为空。");
      return;
    }
    state.setSaving(true);
    try {
      const response = await saveReviewRule({ profile: state.selectedProfile.name, ruleId: state.selectedRule.id, ...state.draft });
      replaceProfile(response.profile);
      state.setDirty(false);
      state.setLoadError(null);
      onError(null);
      onNotice(`规则“${state.draft.name}”已保存`);
    } catch (error) {
      const message = errorMessage(error);
      state.setLoadError(message);
      onError(message);
    } finally {
      state.setSaving(false);
    }
  };

  const toggleRule = async (ruleId: string, enabled: boolean) => {
    if (!state.selectedProfile || state.reordering || state.togglingRuleId) return;
    if (state.dirty) {
      const message = "当前规则有未保存修改，请先保存或放弃修改。";
      state.setLoadError(message);
      onError(message);
      return;
    }
    const rule = state.selectedProfile.rules.find((item) => item.id === ruleId);
    if (!rule) return;
    state.setTogglingRuleId(ruleId);
    replaceProfile({ ...state.selectedProfile, rules: state.selectedProfile.rules.map((item) => item.id === ruleId ? { ...item, enabled } : item) });
    state.setLoadError(null);
    onError(null);
    try {
      const response = await saveReviewRule({ profile: state.selectedProfile.name, ruleId, name: rule.name, description: rule.description, enabled, content: rule.content });
      replaceProfile(response.profile);
      onNotice(`规则“${rule.name}”已${enabled ? "启用" : "停用"}`);
    } catch (error) {
      const message = errorMessage(error);
      state.setLoadError(message);
      onError(message);
      await state.loadProfiles();
    } finally {
      state.setTogglingRuleId(null);
    }
  };

  const removeRule = async () => {
    if (!state.selectedProfile || !state.selectedRule) return;
    if (!window.confirm(`确定删除规则“${state.selectedRule.name}”吗？`)) return;
    try {
      const response = await deleteReviewRule({ profile: state.selectedProfile.name, ruleId: state.selectedRule.id });
      replaceProfile(response.profile);
      state.setSelectedRuleId(response.profile.rules[0]?.id ?? null);
      onNotice(`规则“${state.selectedRule.name}”已删除`);
    } catch (error) {
      const message = errorMessage(error);
      state.setLoadError(message);
      onError(message);
    }
  };

  const reorder = async (sourceId: string, targetId: string) => {
    if (!state.selectedProfile || state.reordering || sourceId === targetId) return;
    if (state.dirty) {
      const message = "当前规则有未保存修改，请先保存或放弃修改。";
      state.setLoadError(message);
      onError(message);
      return;
    }
    const orderedRules = moveRuleTo(state.selectedProfile.rules, sourceId, targetId);
    if (orderedRules === state.selectedProfile.rules) return;
    replaceProfile({ ...state.selectedProfile, rules: orderedRules });
    state.setReordering(true);
    state.setLoadError(null);
    onError(null);
    try {
      const response = await reorderReviewRules({ profile: state.selectedProfile.name, ruleIds: orderedRules.map((rule) => rule.id) });
      replaceProfile(response.profile);
      onNotice("规则顺序已保存，后续 Review 将按此顺序分析");
    } catch (error) {
      const message = errorMessage(error);
      state.setLoadError(message);
      onError(message);
      await state.loadProfiles();
    } finally {
      state.setReordering(false);
    }
  };

  return { closeProfileDetail, createProfile, createRule, removeProfile, removeRule, reorder, resetDraft, save, selectProfile, selectRule, toggleRule, updateDraft };
}
