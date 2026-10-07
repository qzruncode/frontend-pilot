import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, CircleAlert, CircleHelp, GitBranch, LoaderCircle, Plus, RotateCcw, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import type { ReviewRuleProfile } from "@contracts";
import { getReviewRules } from "./api";
import { displayErrorMessage, displayProfileName, draftFromRule, errorMessage, profileDescription, type ReviewRuleDraft } from "./review-rule-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ReviewListRow } from "./review-list";
import { RuleEditor, RuleList } from "./review-rule-editors";
import { ReviewRulesProfileDrawer } from "./review-rules-profile-drawer";
import { useReviewRulesActions } from "./use-review-rules-actions";

type ReviewRulesPageProps = {
  sessionReady: boolean;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

const emptyRule = { name: "", description: "", content: "", enabled: true };

export function ReviewRulesPage({ sessionReady, onNotice, onError }: ReviewRulesPageProps) {
  const [searchParams] = useSearchParams();
  const requestedProfile = searchParams.get("profile");
  const [profiles, setProfiles] = useState<ReviewRuleProfile[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [profileDetailOpen, setProfileDetailOpen] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReviewRuleDraft | null>(null);
  const [newProfilePath, setNewProfilePath] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [newRule, setNewRule] = useState(emptyRule);
  const [profileFormOpen, setProfileFormOpen] = useState(false);
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const selectedProfile = useMemo(() => profiles.find((profile) => profile.name === selectedName) ?? null, [profiles, selectedName]);
  const selectedRule = useMemo(() => selectedProfile?.rules.find((rule) => rule.id === selectedRuleId) ?? null, [selectedProfile, selectedRuleId]);

  const loadProfiles = useCallback(async () => {
    if (!sessionReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await getReviewRules();
      setProfiles(response.profiles);
      setSelectedName((current) => {
        if (requestedProfile && response.profiles.some((profile) => profile.name === requestedProfile)) return requestedProfile;
        return response.profiles.some((profile) => profile.name === current)
          ? current
          : response.profiles.find((profile) => profile.isDefault)?.name ?? response.profiles[0]?.name ?? null;
      });
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [requestedProfile, sessionReady]);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);
  useEffect(() => {
    if (requestedProfile && profiles.some((profile) => profile.name === requestedProfile)) setProfileDetailOpen(true);
  }, [profiles, requestedProfile]);
  useEffect(() => {
    setSelectedRuleId((current) => selectedProfile?.rules.some((rule) => rule.id === current) ? current : selectedProfile?.rules[0]?.id ?? null);
  }, [selectedProfile]);
  useEffect(() => {
    setDraft(selectedRule ? draftFromRule(selectedRule) : null);
    setDirty(false);
  }, [selectedRule]);

  const actions = useReviewRulesActions({
    profiles,
    setProfiles,
    selectedName,
    setSelectedName,
    selectedProfile,
    selectedRule,
    setSelectedRuleId,
    draft,
    setDraft,
    newProfilePath,
    setNewProfilePath,
    newProfileName,
    setNewProfileName,
    newRule,
    setNewRule,
    setProfileDetailOpen,
    setProfileFormOpen,
    setRuleFormOpen,
    dirty,
    setDirty,
    saving,
    setSaving,
    reordering,
    setReordering,
    togglingRuleId,
    setTogglingRuleId,
    setLoadError,
    loadProfiles,
  }, onNotice, onError);

  if (!sessionReady && !loading) {
    return <div className="review-rules-state" role="status"><ShieldCheck aria-hidden="true" /><strong>正在等待页面会话</strong><span>服务连接后即可管理仓库审查规则。</span></div>;
  }
  if (loading && profiles.length === 0) {
    return <div className="review-rules-state" role="status"><LoaderCircle aria-hidden="true" className="is-spinning" /><strong>正在读取审查规则</strong><span>正在加载仓库 profile 和规则。</span></div>;
  }
  if (loadError && profiles.length === 0) {
    return <div className="review-rules-state is-error" role="alert"><CircleAlert aria-hidden="true" /><strong>审查规则暂时无法读取</strong><span>{loadError}</span><Button variant="outline" size="sm" type="button" onClick={() => void loadProfiles()}><RotateCcw aria-hidden="true" />重新读取</Button></div>;
  }

  const ruleCount = profiles.reduce((total, profile) => total + profile.rules.length, 0);
  const enabledRuleCount = profiles.reduce((total, profile) => total + profile.rules.filter((rule) => rule.enabled).length, 0);
  return (
    <section className="review-rules-page" aria-label="审查规则">
      <div className="review-rules-heading"><span className="review-rules-tooltip-trigger review-rules-auto-match" tabIndex={0} aria-describedby="review-rules-auto-match-tip"><GitBranch aria-hidden="true" />按仓库自动匹配<CircleHelp className="review-rules-auto-match-help" aria-hidden="true" /><span id="review-rules-auto-match-tip" className="review-rules-tooltip" role="tooltip">Review 会根据 MR 所属仓库路径自动匹配 profile。</span></span></div>
      <div className="review-rules-stats" aria-label="审查规则概览"><div><span>仓库 profile</span><strong>{profiles.length}</strong><small>按 MR 仓库路径匹配</small></div><div className="is-enabled"><span>启用规则</span><strong>{enabledRuleCount}</strong><small>只影响新发起的审查</small></div><div><span>规则总数</span><strong>{ruleCount}</strong><small>可按 profile 自由增删</small></div></div>
      <div className="review-rules-workspace">
        <aside className="review-rules-profile-pane" aria-label="仓库 profile 列表">
          <div className="review-rules-pane-heading"><div><SlidersHorizontal aria-hidden="true" /><strong>仓库 profile</strong><span className="review-rules-tooltip-trigger review-rules-info-hint" tabIndex={0} aria-describedby="review-rules-profile-tip"><CircleHelp aria-hidden="true" /><span id="review-rules-profile-tip" className="review-rules-tooltip" role="tooltip">执行 Review 时使用 MR 的项目路径自动匹配；默认 profile 只作为兜底。</span></span></div></div>
          <nav className="review-rules-profile-list review-history-list">
            {profiles.map((profile) => (
              <ReviewListRow
                key={profile.name}
                className="review-rules-profile-row"
                ariaLabel={`查看 ${displayProfileName(profile)} 的审查规则`}
                selected={profileDetailOpen && profile.name === selectedName}
                onSelect={() => actions.selectProfile(profile.name)}
                actions={!profile.isDefault ? <Button variant="ghost" size="icon" className="review-history-row-action review-history-row-delete review-rules-profile-delete" type="button" aria-label={`删除 ${displayProfileName(profile)} profile`} title="删除 profile" onClick={() => void actions.removeProfile(profile.name)}><Trash2 aria-hidden="true" /></Button> : null}
                actionsLabel={`${displayProfileName(profile)} profile 操作`}
                main={(
                  <span className="review-history-row-main review-rules-profile-main">
                    <span className="review-rules-profile-icon"><GitBranch aria-hidden="true" /></span>
                    <span className="review-rules-profile-copy"><strong>{displayProfileName(profile)}</strong><small>{profileDescription(profile)} · {profile.rules.length} 条规则</small><code>{profile.name}</code></span>
                  </span>
                )}
              />
            ))}
          </nav>
          <div className="review-rules-pane-note"><CheckCircle2 aria-hidden="true" /><span>同一个规则文件可以被多个 profile 复用；新建规则默认创建独立 Markdown 文件。</span></div>
          {profileFormOpen ? <div className="review-rules-create-box"><strong>新建仓库 profile</strong><Input value={newProfilePath} onChange={(event) => setNewProfilePath(event.target.value)} placeholder="group/project" aria-label="仓库路径" /><Input value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} placeholder="显示名称（可选）" aria-label="profile 显示名称" /><div><Button size="sm" type="button" onClick={() => void actions.createProfile()}>创建</Button><Button variant="ghost" size="sm" type="button" onClick={() => setProfileFormOpen(false)}>取消</Button></div></div> : <Button variant="outline" size="sm" type="button" className="review-rules-create-profile" onClick={() => setProfileFormOpen(true)}><Plus aria-hidden="true" />新建 profile</Button>}
        </aside>
      </div>
      <ReviewRulesProfileDrawer open={profileDetailOpen} profile={selectedProfile} onClose={actions.closeProfileDetail}>
        <div className="review-rules-editor-pane" key={selectedProfile?.name ?? "empty"}>
          {!selectedProfile ? <div className="review-rules-empty-editor"><CircleAlert aria-hidden="true" /><strong>还没有仓库 profile</strong><span>先新建一个 profile，再添加该仓库专属规则。</span></div> : <>
            <div className="review-rules-editor-heading review-rules-profile-heading"><div><div className="review-rules-profile-title-row"><h4>{displayProfileName(selectedProfile)}</h4><span className="review-rules-tooltip-trigger review-rules-profile-match-hint" tabIndex={0} aria-describedby="review-rules-profile-match-tip"><CircleHelp aria-hidden="true" /><span id="review-rules-profile-match-tip" className="review-rules-tooltip" role="tooltip">仓库：{selectedProfile.name}。{selectedProfile.isDefault ? "未匹配到仓库 profile 时使用此默认 profile。" : "Review 会根据 MR 所属仓库路径自动匹配 profile。"}</span></span></div></div>{selectedProfile.isDefault && <span className="review-rules-default-label">默认兜底</span>}</div>
            <RuleList rules={selectedProfile.rules} selectedId={selectedRuleId} onSelect={actions.selectRule} onCreate={() => setRuleFormOpen(true)} onReorder={(sourceId, targetId) => void actions.reorder(sourceId, targetId)} onToggle={(ruleId, enabled) => void actions.toggleRule(ruleId, enabled)} reordering={reordering} togglingRuleId={togglingRuleId} />
            {ruleFormOpen ? <div className="review-rules-create-rule-box"><div><h5>新建审查规则</h5><p>保存后会作为独立规则分块参与该仓库的 Review。</p></div><div className="review-rules-rule-meta-grid"><Input value={newRule.name} onChange={(event) => setNewRule((current) => ({ ...current, name: event.target.value }))} placeholder="规则名称" aria-label="新规则名称" /><Input value={newRule.description} onChange={(event) => setNewRule((current) => ({ ...current, description: event.target.value }))} placeholder="规则说明（可选）" aria-label="新规则说明" /></div><Textarea className="review-rules-new-rule-textarea" value={newRule.content} onChange={(event) => setNewRule((current) => ({ ...current, content: event.target.value }))} placeholder="写下这条规则的检查边界、证据要求和排除项" aria-label="新规则正文" rows={8} /><div className="review-rules-footer-actions"><Button variant="ghost" size="sm" type="button" onClick={() => setRuleFormOpen(false)}>取消</Button><Button size="sm" type="button" onClick={() => void actions.createRule()}>创建规则</Button></div></div> : selectedRule && draft ? <RuleEditor key={selectedRule.id} rule={selectedRule} draft={draft} dirty={dirty} saving={saving} onChange={actions.updateDraft} onSave={() => void actions.save()} onReset={actions.resetDraft} onDelete={() => void actions.removeRule()} /> : <div className="review-rules-empty-editor"><Plus aria-hidden="true" /><strong>这个 profile 还没有规则</strong><span>点击“新建规则”添加第一条仓库审查规则。</span></div>}
          </>}
        </div>
      </ReviewRulesProfileDrawer>
      {loadError && <p className="review-rules-inline-error review-rules-page-error" role="alert"><CircleAlert aria-hidden="true" />{displayErrorMessage(loadError)}</p>}
    </section>
  );
}
