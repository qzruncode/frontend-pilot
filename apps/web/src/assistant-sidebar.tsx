import { ListChecks, MessageSquare, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import type { Conversation } from "./assistant-types";
import { formatConversationTime } from "./assistant-conversation-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

type AssistantSidebarProps = {
  conversations: Conversation[];
  activeConversationId: string | undefined;
  visibleConversations: Conversation[];
  query: string;
  selectionMode: boolean;
  selectedConversationIds: Set<string>;
  sidebarOpen: boolean;
  onQueryChange: (value: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onToggleSelection: (conversationId: string, checked: boolean) => void;
  onToggleSelectionMode: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onDeleteSelected: () => void;
  conversationDeleteBusy: boolean;
  onNewConversation: () => void;
};

export function AssistantSidebar({
  visibleConversations,
  activeConversationId,
  query,
  selectionMode,
  selectedConversationIds,
  sidebarOpen,
  onQueryChange,
  onSelectConversation,
  onToggleSelection,
  onToggleSelectionMode,
  onDeleteConversation,
  onDeleteSelected,
  conversationDeleteBusy,
  onNewConversation,
}: AssistantSidebarProps) {
  const visibleIds = visibleConversations.map((conversation) => conversation.id);
  const selectedVisibleCount = visibleIds.filter((id) => selectedConversationIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  return (
    <aside className={`assistant-sidebar ${sidebarOpen ? "is-open" : ""}`}>
      <div className="assistant-sidebar-header">
        <div className="assistant-identity">
          <div className="assistant-brand-icon"><Sparkles aria-hidden="true" /></div>
          <strong>Frontend Pilot</strong>
        </div>
        <div className="assistant-sidebar-actions">
          {selectionMode ? (
            <Button variant="ghost" size="sm" className="assistant-sidebar-done-button" type="button" disabled={conversationDeleteBusy} onClick={onToggleSelectionMode}>完成</Button>
          ) : (
            <Button variant="outline" size="sm" className="assistant-sidebar-manage-button" type="button" aria-label="批量管理会话" title="批量管理会话" disabled={conversationDeleteBusy} onClick={onToggleSelectionMode}>
              <ListChecks aria-hidden="true" /><span>批量</span>
            </Button>
          )}
          {!selectionMode && <Button variant="ghost" size="icon" className="icon-button" type="button" aria-label="新对话" title="新对话" disabled={conversationDeleteBusy} onClick={onNewConversation}><Plus aria-hidden="true" /></Button>}
        </div>
      </div>
      <label className="assistant-search">
        <Search aria-hidden="true" />
        <Input className="assistant-search-input" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索对话" aria-label="搜索对话" />
      </label>
      {selectionMode && <div className="assistant-bulk-toolbar" aria-label="批量管理会话">
        <div className="assistant-bulk-selection">
          <Button
            variant="ghost"
            size="sm"
            className="assistant-select-all-button"
            type="button"
            disabled={visibleConversations.length === 0 || conversationDeleteBusy}
            onClick={() => visibleIds.forEach((id) => onToggleSelection(id, !allVisibleSelected))}
          >
            {allVisibleSelected ? "取消全选" : "全选当前"}
          </Button>
          <span>已选 {selectedConversationIds.size} 个</span>
        </div>
        <Button variant="ghost" size="sm" className="assistant-bulk-delete-button" type="button" disabled={selectedConversationIds.size === 0 || conversationDeleteBusy} onClick={() => onDeleteSelected()}>
          <Trash2 aria-hidden="true" />{conversationDeleteBusy ? "删除中…" : "删除已选"}
        </Button>
      </div>}
      <div className="assistant-conversation-section">
        <div className="assistant-section-label">会话记录</div>
        <div className="assistant-conversation-list">
          {visibleConversations.length === 0 ? (
            <div className="assistant-list-empty">没有匹配的会话</div>
          ) : visibleConversations.map((conversation) => (
            <div className={`assistant-conversation-item ${conversation.id === activeConversationId ? "is-active" : ""}`} key={conversation.id}>
              {selectionMode && <Checkbox
                className="assistant-conversation-checkbox"
                checked={selectedConversationIds.has(conversation.id)}
                aria-label={`选择会话：${conversation.title}`}
                disabled={conversationDeleteBusy}
                onCheckedChange={(checked) => onToggleSelection(conversation.id, checked === true)}
              />}
              <Button
                variant="ghost"
                className={`assistant-conversation-main ${selectionMode && selectedConversationIds.has(conversation.id) ? "is-selection-selected" : ""}`}
                type="button"
                disabled={conversationDeleteBusy}
                aria-pressed={selectionMode ? selectedConversationIds.has(conversation.id) : undefined}
                onClick={() => selectionMode ? onToggleSelection(conversation.id, !selectedConversationIds.has(conversation.id)) : onSelectConversation(conversation.id)}
              >
                <MessageSquare aria-hidden="true" />
                <span className="assistant-conversation-title">{conversation.title}</span>
                <time>{formatConversationTime(conversation.updatedAt)}</time>
              </Button>
              {!selectionMode && <Button
                variant="ghost"
                size="icon"
                className="assistant-conversation-delete"
                type="button"
                aria-label={`删除会话：${conversation.title}`}
                title={`删除会话：${conversation.title}`}
                disabled={conversationDeleteBusy}
                onClick={(event) => { event.stopPropagation(); onDeleteConversation(conversation.id); }}
              ><Trash2 aria-hidden="true" /></Button>}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
