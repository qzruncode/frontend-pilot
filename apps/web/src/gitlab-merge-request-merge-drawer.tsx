import { useIntegrationApi } from "./integration-api-context";
import { useEffect, useState, type FormEvent } from "react";
import type { GitLabMergeMergeRequestInput, GitLabMergeRequest, GitLabMergeRequestDetails } from "@contracts";
import { CircleAlert, GitMerge, LoaderCircle } from "lucide-react";
import { GitLabMergeMergeRequestInputSchema } from "@contracts";

import { errorMessage } from "./review-ui-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type GitLabMergeRequestMergeDrawerProps = {
  detail: GitLabMergeRequestDetails;
  onMerged: (mergeRequest: GitLabMergeRequest) => void | Promise<void>;
  onError: (message: string | null) => void;
};

type MergeDraft = Omit<GitLabMergeMergeRequestInput, "sha">;

function MergeRequestMergeForm({ detail, onMerged, onError }: GitLabMergeRequestMergeDrawerProps) {
  const { mergeGitLabMergeRequest } = useIntegrationApi();
  const showAutoMerge = detail.pipelines.some((pipeline) => pipeline.status !== "success" && pipeline.status !== "skipped");
  const [draft, setDraft] = useState<MergeDraft>({
    mergeWhenPipelineSucceeds: false,
    shouldRemoveSourceBranch: true,
    squash: false,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    setDraft({ mergeWhenPipelineSucceeds: false, shouldRemoveSourceBranch: true, squash: false });
    setFormError(null);
  }, [detail.iid, detail.projectId]);

  const updateDraft = (patch: Partial<MergeDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFormError(null);
    onError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (merging) return;
    const payload: GitLabMergeMergeRequestInput = { ...draft, mergeWhenPipelineSucceeds: showAutoMerge && draft.mergeWhenPipelineSucceeds, sha: detail.headSha ?? undefined };
    const parsed = GitLabMergeMergeRequestInputSchema.safeParse(payload);
    if (!parsed.success) {
      const message = [...new Set(parsed.error.issues.map((issue) => issue.message).filter(Boolean))].join("；") || "请检查合并选项";
      setFormError(message);
      onError(message);
      return;
    }
    setMerging(true);
    setFormError(null);
    onError(null);
    try {
      const merged = await mergeGitLabMergeRequest(detail.projectId, detail.iid, parsed.data);
      await onMerged(merged);
    } catch (error) {
      const message = errorMessage(error);
      setFormError(message);
      if (draft.squash && /squash|压缩/i.test(message)) {
        setDraft((current) => ({ ...current, squash: false }));
      }
      onError(message);
    } finally {
      setMerging(false);
    }
  };

  return <form className="gitlab-merge-mr-panel" onSubmit={(event) => void submit(event)} noValidate>
    <div className="gitlab-merge-mr-panel-heading"><div><strong>合并</strong><span>{detail.sourceBranch || "未知源分支"} → {detail.targetBranch || "未知目标分支"}</span></div></div>
    <div className="gitlab-merge-mr-options"><label><Checkbox className="gitlab-merge-mr-checkbox" checked={draft.shouldRemoveSourceBranch} disabled={merging} onCheckedChange={(checked) => updateDraft({ shouldRemoveSourceBranch: checked === true })} /><span>删除源分支</span></label><label><Checkbox className="gitlab-merge-mr-checkbox" checked={draft.squash} disabled={merging} onCheckedChange={(checked) => updateDraft({ squash: checked === true })} /><span>压缩提交</span></label>{showAutoMerge && <label><Checkbox className="gitlab-merge-mr-checkbox" checked={draft.mergeWhenPipelineSucceeds} disabled={merging} onCheckedChange={(checked) => updateDraft({ mergeWhenPipelineSucceeds: checked === true })} /><span>流水线成功后合并</span></label>}</div>
    {formError && <div className="gitlab-merge-mr-error" role="alert"><CircleAlert aria-hidden="true" /><span>{formError}</span></div>}
    <footer className="gitlab-merge-mr-panel-footer"><span>{showAutoMerge && draft.mergeWhenPipelineSucceeds ? "流水线通过后自动合并" : "GitLab 会在提交时再次检查合并条件"}</span><Button type="submit" size="sm" disabled={merging}>{merging ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <GitMerge aria-hidden="true" />}{merging ? "合并中…" : showAutoMerge && draft.mergeWhenPipelineSucceeds ? "设置自动合并" : "合并"}</Button></footer>
  </form>;
}

export function GitLabMergeRequestMergeDrawer(props: GitLabMergeRequestMergeDrawerProps) {
  return <MergeRequestMergeForm detail={props.detail} onMerged={props.onMerged} onError={props.onError} />;
}
