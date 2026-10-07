import { useState, type FormEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { Bug, CheckCircle2, Lightbulb, LoaderCircle, MessageSquarePlus, Send, Sparkles, Star } from "lucide-react";
import type { FeedbackCategory } from "@contracts";
import { ApiError, submitFeedback, type SubmitFeedbackInput } from "./api";
import { FeedbackImageUpload } from "./feedback-image-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type FeedbackPageProps = {
  sessionReady: boolean;
  sessionLoading: boolean;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

type FeedbackFormState = {
  category: FeedbackCategory;
  rating: number | null;
  message: string;
  contact: string;
};

type FeedbackCategoryOption = {
  value: FeedbackCategory;
  label: string;
  description: string;
  icon: LucideIcon;
};

const MAX_MESSAGE_LENGTH = 4_000;

const categoryOptions: FeedbackCategoryOption[] = [
  { value: "experience", label: "使用体验", description: "流程、交互或整体感受", icon: Sparkles },
  { value: "bug", label: "遇到问题", description: "功能异常或页面报错", icon: Bug },
  { value: "feature", label: "功能建议", description: "希望新增或改进的能力", icon: Lightbulb },
  { value: "other", label: "其他想法", description: "任何值得告诉我们的事", icon: MessageSquarePlus },
];

const ratingOptions = [
  { value: 1, label: "很不满意" },
  { value: 2, label: "不太满意" },
  { value: 3, label: "一般" },
  { value: 4, label: "满意" },
  { value: 5, label: "非常满意" },
];

const emptyForm: FeedbackFormState = {
  category: "experience",
  rating: null,
  message: "",
  contact: "",
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "页面会话已失效，请刷新页面后重试。";
    if (typeof error.details === "string") return error.details;
    return error.status >= 500 ? "意见暂时无法提交，请稍后重试。" : error.message;
  }
  return error instanceof Error ? error.message : "意见暂时无法提交，请稍后重试。";
}

function validateFeedback(form: FeedbackFormState): string | null {
  if (form.rating === null) return "请先选择一个满意度。";
  if (!form.message.trim()) return "请写下你的具体意见，哪怕一句话也可以。";
  return null;
}

export function FeedbackPage({ sessionReady, sessionLoading, onNotice, onError }: FeedbackPageProps) {
  const [form, setForm] = useState<FeedbackFormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [images, setImages] = useState<File[]>([]);
  const [imageResetToken, setImageResetToken] = useState(0);

  const clearImages = () => {
    setImages([]);
    setImageResetToken((current) => current + 1);
  };

  const updateForm = (patch: Partial<FeedbackFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setValidationError(null);
    onError(null);
  };

  const resetForm = () => {
    setForm(emptyForm);
    clearImages();
    setSubmitted(false);
    setValidationError(null);
    onError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionReady) {
      onError(sessionLoading ? "页面正在连接服务，请稍候再提交。" : "页面会话尚未建立，请刷新页面后重试。");
      return;
    }
    const validation = validateFeedback(form);
    if (validation) {
      setValidationError(validation);
      onError(null);
      return;
    }
    if (form.rating === null) return;

    const body: SubmitFeedbackInput = {
      category: form.category,
      rating: form.rating,
      message: form.message.trim(),
      ...(form.contact.trim() ? { contact: form.contact.trim() } : {}),
    };
    setSubmitting(true);
    setValidationError(null);
    onError(null);
    try {
      await submitFeedback(body, images);
      clearImages();
      setSubmitted(true);
      onNotice("反馈已提交，感谢你帮助我们改进。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="feedback-page" aria-labelledby="feedback-page-title">
      <div className="feedback-page-inner">
        <header className="feedback-page-heading">
          <h3 id="feedback-page-title">让 Frontend Pilot 更好用</h3>
          <p>你正在试用的每一个瞬间，都会帮助我们决定下一步该把时间花在哪里。</p>
        </header>

        <form className="feedback-form feedback-form-solo" onSubmit={(event) => void submit(event)}>
            {submitted ? (
              <div className="feedback-success" role="status" aria-live="polite">
                <div className="feedback-success-icon"><CheckCircle2 aria-hidden="true" /></div>
                <h4>收到你的反馈了</h4>
                <p>谢谢你把体验告诉我们。我们会把这些意见带回产品迭代。</p>
                <Button variant="outline" type="button" onClick={resetForm}>再提交一条意见</Button>
              </div>
            ) : (
              <>
                <div className="feedback-form-heading">
                  <h4>告诉我们你的体验</h4>
                </div>

                <fieldset className="feedback-fieldset">
                  <legend>这次想反馈什么？<em>必填</em></legend>
                  <div className="feedback-category-grid">
                    {categoryOptions.map((option) => {
                      const Icon = option.icon;
                      const selected = form.category === option.value;
                      return (
                        <button
                          className={`feedback-category-option ${selected ? "is-selected" : ""}`}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          key={option.value}
                          onClick={() => updateForm({ category: option.value })}
                        >
                          <span className="feedback-category-icon"><Icon aria-hidden="true" /></span>
                          <span><strong>{option.label}</strong><small>{option.description}</small></span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <fieldset className="feedback-fieldset">
                  <legend>这次使用体验如何？<em>必填</em></legend>
                  <div className="feedback-rating-group" role="radiogroup" aria-label="使用满意度">
                    {ratingOptions.map((option) => {
                      const selected = form.rating === option.value;
                      return (
                        <button
                          className={`feedback-rating-option ${selected ? "is-selected" : ""}`}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={`${option.value} 分，${option.label}`}
                          key={option.value}
                          onClick={() => updateForm({ rating: option.value })}
                        >
                          <Star aria-hidden="true" />
                          <span>{option.value}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="feedback-rating-caption"><span>很不满意</span><span>{form.rating ? ratingOptions[form.rating - 1]?.label : "请选择"}</span><span>非常满意</span></div>
                </fieldset>

                <div className="feedback-form-field feedback-comment-field">
                  <label className="feedback-form-label" htmlFor="feedback-message"><span>具体说说吧<em>必填</em></span></label>
                  <FeedbackImageUpload
                    disabled={submitting}
                    resetToken={imageResetToken}
                    onFilesChange={setImages}
                    onInteraction={() => onError(null)}
                  >
                    <Textarea id="feedback-message" value={form.message} maxLength={MAX_MESSAGE_LENGTH} rows={6} placeholder="例如：我在查看 Review 记录时，希望能更快定位到失败原因……" onChange={(event) => updateForm({ message: event.target.value })} />
                  </FeedbackImageUpload>
                  <small className="feedback-field-hint">描述得越具体，我们越容易复现和改进。{form.message.length}/{MAX_MESSAGE_LENGTH}</small>
                </div>

                <label className="feedback-form-field" htmlFor="feedback-contact">
                  <span>方便联系你吗？<small>可选</small></span>
                  <Input id="feedback-contact" value={form.contact} maxLength={200} placeholder="邮箱、微信或其他联系方式" autoComplete="email" onChange={(event) => updateForm({ contact: event.target.value })} />
                  <small className="feedback-field-hint">仅用于跟进你的反馈，不会展示给其他试用者。</small>
                </label>

                {validationError && <p className="feedback-validation-error" role="alert">{validationError}</p>}
                <div className="feedback-form-footer">
                  <Button className="feedback-submit-button" type="submit" disabled={submitting || !sessionReady}>
                    {submitting ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Send aria-hidden="true" />}
                    {submitting ? "提交中…" : "提交意见"}
                  </Button>
                </div>
              </>
            )}
        </form>
      </div>
    </section>
  );
}
