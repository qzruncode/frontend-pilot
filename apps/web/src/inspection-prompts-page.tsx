import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, FileText, LoaderCircle, RotateCcw, Save } from "lucide-react";
import type { InspectionPrompt, InspectionPromptSummary } from "@contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getInspectionPrompt, getInspectionPrompts, saveInspectionPrompt } from "./api";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { ReviewListRow } from "./review-list";
import { errorMessage } from "./review-ui-utils";

type Props = {
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

export function InspectionPromptsPage({ onNotice, onError }: Props) {
  const [prompts, setPrompts] = useState<InspectionPromptSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<InspectionPrompt | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedSummary = useMemo(() => prompts.find((prompt) => prompt.id === selectedId) ?? null, [prompts, selectedId]);
  const dirty = draft !== savedContent;

  useLayoutEffect(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.overflowY = "hidden";
    const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
    const nextHeight = Math.min(textarea.scrollHeight, Number.isFinite(maxHeight) ? maxHeight : textarea.scrollHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > nextHeight ? "auto" : "hidden";
  }, [draft, detailOpen, selectedPrompt?.id]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getInspectionPrompts();
      setPrompts(response.prompts);
      setSelectedId((current) => response.prompts.some((prompt) => prompt.id === current) ? current : response.prompts[0]?.id ?? null);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!detailOpen || !selectedId) {
      setSelectedPrompt(null);
      setDetailLoading(false);
      return;
    }
    let canceled = false;
    setSelectedPrompt(null);
    setDetailLoading(true);
    setDetailError(null);
    void getInspectionPrompt(selectedId)
      .then(({ prompt }) => {
        if (canceled) return;
        setSelectedPrompt(prompt);
        setDraft(prompt.content);
        setSavedContent(prompt.content);
      })
      .catch((error) => {
        if (!canceled) setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (!canceled) setDetailLoading(false);
      });
    return () => { canceled = true; };
  }, [detailOpen, detailReloadKey, selectedId]);

  const openDetail = (id: string) => {
    if (saving) return;
    if (!prompts.some((prompt) => prompt.id === id)) return;
    if (dirty && id !== selectedId) {
      onError("当前提示词有未保存修改，请先保存或放弃修改。");
      return;
    }
    setSelectedId(id);
    setDetailOpen(true);
    onError(null);
  };

  const closeDetail = () => {
    if (saving) return;
    if (dirty) {
      onError("当前提示词有未保存修改，请先保存或放弃修改。");
      return;
    }
    setDetailOpen(false);
    onError(null);
  };

  const save = async () => {
    if (!selectedPrompt || !dirty || saving || !draft.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const response = await saveInspectionPrompt(selectedPrompt.id, draft);
      setSelectedPrompt(response.prompt);
      setDraft(response.prompt.content);
      setSavedContent(response.prompt.content);
      onNotice(`提示词“${response.prompt.name}”已保存`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading && prompts.length === 0) {
    return <div className="user-management-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取提示词列表…</div>;
  }

  if (loadError && prompts.length === 0) {
    return <div className="user-management-state is-error" role="alert"><CircleAlert aria-hidden="true" /><span>{loadError}</span><Button type="button" variant="outline" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</Button></div>;
  }

  return <main className="inspection-prompts-page">
    <section className="inspection-prompts-list-card" aria-label="提示词列表">
      {prompts.length > 0 ? <div className="inspection-prompts-list" aria-label="提示词列表">
        {prompts.map((prompt) => <ReviewListRow
          key={prompt.id}
          className="inspection-prompt-list-row"
          ariaLabel={`查看 ${prompt.name} 提示词详情`}
          selected={detailOpen && prompt.id === selectedId}
          onSelect={() => openDetail(prompt.id)}
          main={<span className="review-history-row-main inspection-prompt-list-main"><span className="inspection-prompt-item-icon"><FileText aria-hidden="true" /></span><span className="inspection-prompt-item-copy"><strong>{prompt.name}</strong><small>{prompt.description}</small><code>{prompt.id}</code></span></span>}
        />)}
      </div> : <div className="inspection-prompts-empty"><FileText aria-hidden="true" /><strong>暂无提示词</strong><span>提示词注册后会显示在这里。</span></div>}
      {loadError && <p className="inspection-prompts-inline-error" role="alert"><CircleAlert aria-hidden="true" />{loadError}</p>}
    </section>
    {detailOpen && selectedSummary && <ReviewDrawerShell size="compact" eyebrow="提示词详情" title={selectedSummary.name} titleId="inspection-prompt-detail-title" closeLabel="关闭提示词详情" isClosing={false} onRequestClose={closeDetail} contentClassName="inspection-prompt-detail-drawer-content">
      {detailLoading ? <div className="inspection-prompt-detail-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取提示词详情…</div> : detailError || !selectedPrompt ? <div className="inspection-prompt-detail-state is-error" role="alert"><CircleAlert aria-hidden="true" /><span>{detailError ?? "提示词详情暂时无法读取"}</span><Button type="button" variant="outline" onClick={() => setDetailReloadKey((current) => current + 1)}><RotateCcw aria-hidden="true" />重新读取</Button></div> : <div className="inspection-prompt-detail">
        <div className="inspection-prompt-detail-editor-heading"><label htmlFor="inspection-prompt-content">提示词正文</label><span>{draft.length.toLocaleString("zh-CN")} 字符</span></div>
        <Textarea ref={promptTextareaRef} id="inspection-prompt-content" className="inspection-prompt-detail-textarea" value={draft} onChange={(event) => { setDraft(event.target.value); onError(null); }} spellCheck={false} aria-label="提示词正文" />
        <p className="inspection-prompt-detail-note">保存后只影响之后使用该提示词的新巡检任务。</p>
        <footer className="inspection-prompt-detail-actions"><Button variant="ghost" type="button" onClick={() => { setDraft(savedContent); onError(null); }} disabled={!dirty || saving}><RotateCcw aria-hidden="true" />放弃修改</Button><Button type="button" onClick={() => void save()} disabled={!dirty || saving || !draft.trim()}>{saving ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Save aria-hidden="true" />}{saving ? "保存中…" : "保存提示词"}</Button></footer>
      </div>}
    </ReviewDrawerShell>}
  </main>;
}
