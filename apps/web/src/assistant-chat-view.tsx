import { useState, type RefObject } from "react";
import { Activity, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ClipboardList, Code2, Copy, ExternalLink, GitBranch, GitPullRequest, History, Link2, ListChecks, Maximize2, Menu, Minimize2, MoreHorizontal, Pencil, Plus, RotateCcw, Search, ShieldCheck, Sparkles, Square, Trash2, X } from "lucide-react";
import { AssistantActivityPanel } from "./assistant-activity";
import { AssistantAuthCard } from "./assistant-auth-card";
import { AssistantEditOperationCard } from "./assistant-edit-operation-card";
import { AssistantEditSessionPanel } from "./assistant-edit-session-panel";
import { AssistantMarkdown } from "./assistant-markdown";
import { AssistantReviewTaskCard } from "./assistant-review-task-card";
import type { ChatMessage, Conversation } from "./assistant-types";
import type { AssistantEditSession } from "./api";
import type { ReviewJob } from "@contracts";
import type { AssistantFocusContext } from "@contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const associatedProducts: Array<{ label: string; href: string }> = [];

type AssistantChatViewProps = {
  activeConversation?: Conversation;
  showWelcome: boolean;
  canSend: boolean;
  sending: boolean;
  draft: string;
  assistantStatus: string | null;
  showScrollToLatest: boolean;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onScrollToLatest: () => void;
  onDraftChange: (value: string) => void;
  focusContext?: AssistantFocusContext;
  onClearFocusContext: () => void;
  onSend: (value?: string) => void;
  onStop: () => void;
  onOpenReviewTools: () => void;
  onOpenReviewRun: (reviewId: string) => void;
  reviewJobs: ReviewJob[];
  onCopy: (message: ChatMessage) => void;
  onRetry: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onCancelEdit: () => void;
  editingMessageId: string | null;
  messageActionBusy: boolean;
  messageActionStatus: string | null;
  onNewConversation: () => void;
  onOpenSidebar: () => void;
  navigationMenuOpen: boolean;
  onOpenNavigationMenu: () => void;
  editSession: AssistantEditSession | null;
  editPanelOpen: boolean;
  onToggleEditPanel: () => void;
  onEditSessionChange: (session: AssistantEditSession | null) => void;
  onNotice: (message: string) => void;
};

export function AssistantChatView({
  activeConversation,
  showWelcome,
  canSend,
  sending,
  draft,
  assistantStatus,
  showScrollToLatest,
  chatScrollRef,
  onScroll,
  onScrollToLatest,
  onDraftChange,
  focusContext,
  onClearFocusContext,
  onSend,
  onStop,
  onOpenReviewTools,
  onOpenReviewRun,
  reviewJobs,
  onCopy,
  onRetry,
  onEdit,
  onDelete,
  onCancelEdit,
  editingMessageId,
  messageActionBusy,
  messageActionStatus,
  onNewConversation,
  onOpenSidebar,
  navigationMenuOpen,
  onOpenNavigationMenu,
  editSession,
  editPanelOpen,
  onToggleEditPanel,
  onEditSessionChange,
  onNotice,
}: AssistantChatViewProps) {
  const [composerExpanded, setComposerExpanded] = useState(false);
  const reviewJobsById = new Map(reviewJobs.map((job) => [job.id, job]));
  const messageActionsDisabled = messageActionBusy || sending;
  return (
    <main className="assistant-main">
      <header className="assistant-main-header">
        <Button variant="ghost" size="icon" className="assistant-navigation-menu" type="button" aria-label={navigationMenuOpen ? "收起主菜单" : "打开主菜单"} title={navigationMenuOpen ? "收起主菜单" : "打开主菜单"} aria-expanded={navigationMenuOpen} onClick={onOpenNavigationMenu}><Menu aria-hidden="true" /></Button>
        <div className="assistant-main-title"><div className="assistant-main-avatar"><Sparkles aria-hidden="true" /></div><strong>Frontend Pilot</strong></div>
        <div className="assistant-main-header-actions">
          <div className="assistant-header-actions-list">
            <Button variant="outline" size="sm" className="assistant-header-new" type="button" onClick={onNewConversation}><Plus aria-hidden="true" /><span>新对话</span></Button>
            <Button variant="outline" size="sm" className="assistant-history-button" type="button" aria-label="历史" title="历史" onClick={onOpenSidebar}><History aria-hidden="true" /><span>历史</span></Button>
            <div className="assistant-edit-session-control">
              <Button variant={editPanelOpen || editSession ? "default" : "outline"} size="sm" className="assistant-edit-button" type="button" data-assistant-edit-trigger="true" aria-pressed={editPanelOpen} aria-expanded={editPanelOpen} aria-haspopup="dialog" title={editSession ? "管理代码编辑工作区" : "开始编辑代码"} onClick={onToggleEditPanel}><Code2 aria-hidden="true" /><span className="assistant-edit-button-label">{editSession ? "编辑中" : "编辑代码"}</span></Button>
            </div>
            <div className="assistant-associated-products">
              <Button variant="ghost" size="sm" className="assistant-associated-products-trigger" type="button" aria-label="关联" aria-haspopup="menu" title="关联产品">
                <Link2 aria-hidden="true" /><span>关联</span><ChevronDown aria-hidden="true" />
              </Button>
              <div className="assistant-associated-products-menu" role="menu" aria-label="关联产品">
                {associatedProducts.map((product) => (
                  <a className="assistant-associated-product" href={product.href} key={product.href} target="_blank" rel="noreferrer" role="menuitem">
                    <span>{product.label}</span><ExternalLink aria-hidden="true" />
                  </a>
                ))}
              </div>
            </div>
          </div>
          <div className="assistant-header-actions-more">
            <Button variant="outline" size="icon" className="assistant-header-actions-more-trigger" type="button" aria-label="更多操作" aria-haspopup="menu" title="更多操作"><MoreHorizontal aria-hidden="true" /></Button>
            <div className="assistant-header-actions-more-menu" role="menu" aria-label="更多操作">
              <Button variant="ghost" size="sm" className="assistant-header-action-menu-item" type="button" role="menuitem" onClick={onNewConversation}><Plus aria-hidden="true" /><span>新对话</span></Button>
              <Button variant="ghost" size="sm" className="assistant-header-action-menu-item" type="button" role="menuitem" onClick={onOpenSidebar}><History aria-hidden="true" /><span>历史</span></Button>
              <Button variant="ghost" size="sm" className={`assistant-header-action-menu-item ${editPanelOpen || editSession ? "is-active" : ""}`} type="button" role="menuitem" data-assistant-edit-trigger="true" aria-pressed={editPanelOpen} aria-expanded={editPanelOpen} aria-haspopup="dialog" onClick={onToggleEditPanel}><Code2 aria-hidden="true" /><span>{editSession ? "编辑中" : "编辑代码"}</span></Button>
              {associatedProducts.length > 0 && <div className="assistant-header-action-menu-section"><span>关联产品</span>{associatedProducts.map((product) => <a className="assistant-header-action-menu-item" href={product.href} key={product.href} target="_blank" rel="noreferrer" role="menuitem"><Link2 aria-hidden="true" /><span>{product.label}</span><ExternalLink aria-hidden="true" /></a>)}</div>}
            </div>
          </div>
          <AssistantEditSessionPanel open={editPanelOpen} session={editSession} onSessionChange={onEditSessionChange} onNotice={onNotice} onClose={onToggleEditPanel} />
        </div>
      </header>
      <section className="assistant-chat" aria-label="助手对话">
        <div className="assistant-chat-scroll" ref={chatScrollRef} onScroll={onScroll}>
          {showWelcome && <WelcomeContent canSend={canSend} onSend={onSend} />}
          {!showWelcome && (
            <div className="assistant-message-list" key={activeConversation?.id ?? "empty"}>
              {(activeConversation?.messages ?? []).map((message) => {
                const isStreaming = message.status === "streaming";
                const isAssistant = message.role === "assistant";
                const isEditing = !isAssistant && editingMessageId === message.id;
                return (
                  <article className={`assistant-chat-message ${isAssistant ? "is-assistant" : "is-user"} ${message.status ? `is-${message.status}` : ""}`} key={message.id}>
                    {isAssistant && <div className="assistant-chat-message-avatar"><Sparkles aria-hidden="true" /></div>}
                    <div className="assistant-chat-message-body">
                      {isAssistant && <div className="assistant-chat-message-label"><span>Frontend Pilot</span>{isStreaming && <em>正在生成</em>}</div>}
                      {isAssistant && message.activities && message.activities.length > 0 && <AssistantActivityPanel activities={message.activities} streaming={isStreaming} hasError={message.status === "error"} />}
                      {isStreaming && !message.text ? (
                        <div className="assistant-generation-bubble" role="status" aria-label="助手正在生成回复"><span className="assistant-generation-dots"><i /><i /><i /></span><span>正在整理你的问题</span></div>
                      ) : (
                        <div className="assistant-message-content">
                          {isEditing ? (
                            <form className="assistant-inline-message-editor" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
                              <Textarea
                                autoFocus
                                value={draft}
                                onChange={(event) => onDraftChange(event.target.value)}
                                disabled={!canSend || messageActionBusy}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    if (draft.trim()) onSend();
                                  }
                                }}
                                rows={3}
                                aria-label="修改消息"
                              />
                              <div className="assistant-inline-message-actions">
                                <Button variant="ghost" size="sm" type="button" onClick={onCancelEdit} disabled={messageActionBusy}>取消</Button>
                                <Button size="sm" type="submit" disabled={!draft.trim() || !canSend || messageActionBusy}><ArrowUp aria-hidden="true" />发送</Button>
                              </div>
                            </form>
                          ) : (
                            <>
                              {isAssistant && message.cards?.map((card) => card.kind === "auth_required" ? <AssistantAuthCard key={`${card.provider}-${card.actionPath}`} card={card} /> : null)}
                              {isAssistant ? <AssistantMarkdown text={message.text} /> : <p>{message.text}</p>}
                              {isAssistant && message.editOperations?.map((operation) => <AssistantEditOperationCard key={operation.id} operation={operation} />)}
                              {isStreaming && <span className="assistant-streaming-caret" aria-hidden="true" />}
                            </>
                          )}
                        </div>
                      )}
                      {isAssistant && message.activities?.flatMap((activity) => activity.reviewTask ? [activity.reviewTask] : []).filter((task, index, tasks) => tasks.findIndex((item) => item.id === task.id && item.action === task.action) === index).map((task) => {
                        const currentJob = reviewJobsById.get(task.id);
                        const currentTask = currentJob ? { ...task, projectPath: currentJob.projectPath, status: currentJob.status, headSha: currentJob.headSha, targetBranch: currentJob.targetBranch, error: currentJob.error ?? task.error } : task;
                        return <AssistantReviewTaskCard key={`${task.action}-${task.id}`} task={currentTask} onOpen={onOpenReviewRun} />;
                      })}
                      {message.status === "error" && <div className="assistant-message-error-actions"><span>这次回复没有完成</span><Button variant="ghost" size="sm" type="button" disabled={messageActionsDisabled} onClick={() => onRetry(message.id)}><RotateCcw aria-hidden="true" />重试</Button><Button variant="ghost" size="sm" type="button" disabled={messageActionsDisabled} onClick={() => onDelete(message.id)}><Trash2 aria-hidden="true" />删除</Button></div>}
                      {!isEditing && !isStreaming && message.text && message.status !== "error" && (
                        <div className="assistant-message-actions">
                          {isAssistant ? <>
                            <Button variant="ghost" size="sm" type="button" disabled={messageActionsDisabled} onClick={() => onRetry(message.id)}><RotateCcw aria-hidden="true" />{message.status === "stopped" ? "继续" : "重试"}</Button>
                            <Button variant="ghost" size="sm" type="button" disabled={messageActionsDisabled} onClick={() => onDelete(message.id)}><Trash2 aria-hidden="true" />删除</Button>
                            <Button variant="ghost" size="icon" type="button" aria-label="复制回复" title="复制回复" disabled={messageActionsDisabled} onClick={() => onCopy(message)}><Copy aria-hidden="true" /></Button>
                          </> : <>
                            <Button variant="ghost" size="sm" type="button" disabled={messageActionsDisabled} onClick={() => onEdit(message.id)}><Pencil aria-hidden="true" />修改</Button>
                            <Button variant="ghost" size="sm" type="button" disabled={messageActionsDisabled} onClick={() => onDelete(message.id)}><Trash2 aria-hidden="true" />删除</Button>
                          </>}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {showWelcome && <div className="assistant-quick-actions"><span>也可以直接告诉我你要做什么</span><div><span>例如：这个 MR 有哪些风险？</span><span>为什么这个任务还在排队？</span></div></div>}
        </div>
        {showScrollToLatest && <Button variant="outline" size="sm" className="assistant-scroll-latest" type="button" onClick={onScrollToLatest}><ArrowDown aria-hidden="true" /><span>回到最新</span></Button>}
        {editingMessageId ? (
          <div className="assistant-composer-wrap assistant-composer-editing-wrap">
            <div className="assistant-composer-editing-hint"><Pencil aria-hidden="true" /><span>请在上方消息气泡中修改，点击“发送”重新生成回复。</span></div>
          </div>
        ) : (
          <div className="assistant-composer-wrap">
            <div className="assistant-composer-context"><div className="assistant-composer-context-left"><span><ShieldCheck aria-hidden="true" />Frontend Pilot</span>{editSession && <span className="assistant-editing-context" title={`${editSession.projectPath} · ${editSession.baseRef}`}><Code2 aria-hidden="true" /><span>编辑中 · {editSession.projectPath}</span><Button variant="ghost" size="sm" type="button" onClick={onToggleEditPanel}>管理</Button></span>}</div>{focusContext && <span className="assistant-focus-context"><span>当前上下文：{focusContext.provider === "gitlab" ? "GitLab MR" : "Jira 问题"} {focusContext.resourceId}</span><Button variant="ghost" size="icon" type="button" aria-label="移除工作台上下文" title="移除工作台上下文" onClick={onClearFocusContext}><X aria-hidden="true" /></Button></span>}</div>
            <form className={`assistant-composer ${composerExpanded ? "is-expanded" : ""}`} onSubmit={(event) => { event.preventDefault(); onSend(); }}>
              <Button variant="ghost" size="icon" className="assistant-composer-tool" type="button" aria-label="打开 Review 工具" title="打开 Review 工具" onClick={onOpenReviewTools}><ListChecks aria-hidden="true" /></Button>
              <Textarea
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                disabled={!canSend}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    onSend();
                  }
                }}
                placeholder={canSend ? "输入消息，开始对话…" : "助手正在准备…"}
                rows={1}
                aria-label="输入消息"
              />
              <Button variant="ghost" size="icon" className="assistant-composer-expand" type="button" aria-label={composerExpanded ? "收起输入框" : "展开输入框"} title={composerExpanded ? "收起输入框" : "展开输入框"} aria-pressed={composerExpanded} disabled={!canSend} onClick={() => setComposerExpanded((expanded) => !expanded)}>
                {composerExpanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </Button>
              {sending ? <Button size="icon" className="assistant-send-button is-stop" type="button" aria-label="停止生成" onClick={onStop}><Square aria-hidden="true" /></Button> : <Button size="icon" className="assistant-send-button" type="submit" aria-label="发送消息" disabled={!draft.trim() || !canSend}><ArrowUp aria-hidden="true" /></Button>}
            </form>
            {(sending || messageActionBusy) && <div className="assistant-composer-meta"><p className="assistant-composer-note">{messageActionStatus ?? assistantStatus ?? "正在回复…"}</p></div>}
          </div>
        )}
      </section>
    </main>
  );
}

function WelcomeContent({ canSend, onSend }: { canSend: boolean; onSend: (value: string) => void }) {
  return (
    <div className="assistant-welcome">
      <h1>让复杂工作，都有清晰的下一步。</h1>
      <p className="assistant-welcome-subtitle">我会结合当前上下文，帮你理解问题、梳理进展，并给出可执行的处理建议。</p>
      <div className="assistant-scope-list"><Badge variant="outline" className="assistant-scope-badge"><CheckCircle2 aria-hidden="true" />结合上下文</Badge><Badge variant="outline" className="assistant-scope-badge"><Activity aria-hidden="true" />面向研发工作</Badge></div>
      <div className="assistant-capability-grid">
        <Button variant="outline" className="assistant-capability-card" type="button" disabled={!canSend} onClick={() => onSend("请帮我分析这个 MR")}><GitPullRequest aria-hidden="true" /><span><strong>分析一个 MR</strong><small>从变更里找高价值风险</small></span><ArrowUp aria-hidden="true" /></Button>
        <Button variant="outline" className="assistant-capability-card" type="button" disabled={!canSend} onClick={() => onSend("查看最近任务状态")}><ListChecks aria-hidden="true" /><span><strong>查看任务状态</strong><small>了解排队、审查和结果</small></span><ArrowUp aria-hidden="true" /></Button>
        <Button variant="outline" className="assistant-capability-card" type="button" disabled={!canSend} onClick={() => onSend("帮我定位高价值问题")}><Search aria-hidden="true" /><span><strong>定位高价值问题</strong><small>优先处理真正影响交付的点</small></span><ArrowUp aria-hidden="true" /></Button>
        <Button variant="outline" className="assistant-capability-card" type="button" disabled={!canSend} onClick={() => onSend("帮我总结上周的工作任务")}><GitBranch aria-hidden="true" /><span><strong>总结上周工作</strong><small>按 GitLab 提交整理工作简报</small></span><ArrowUp aria-hidden="true" /></Button>
        <Button variant="outline" className="assistant-capability-card" type="button" disabled={!canSend} onClick={() => onSend("列下我的待办 Jira")}><ClipboardList aria-hidden="true" /><span><strong>查看 Jira 待办</strong><small>列出当前需要我处理的问题</small></span><ArrowUp aria-hidden="true" /></Button>
        <Button variant="outline" className="assistant-capability-card" type="button" disabled={!canSend} onClick={() => onSend("帮我新建一个 Jira 问题")}><Plus aria-hidden="true" /><span><strong>新建 Jira 问题</strong><small>按当前项目选项快速创建</small></span><ArrowUp aria-hidden="true" /></Button>
        <Button variant="outline" className="assistant-capability-card" type="button" disabled={!canSend} onClick={() => onSend("帮我新建一个 GitLab MR")}><GitPullRequest aria-hidden="true" /><span><strong>新建 GitLab MR</strong><small>按项目分支和成员选项创建</small></span><ArrowUp aria-hidden="true" /></Button>
      </div>
    </div>
  );
}
