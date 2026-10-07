import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, UserRoundCheck, UserRoundX, Users } from "lucide-react";
import type { UserListItem } from "@contracts";
import { createUser, deleteUser, listUsers, updateUser } from "./api";
import { errorMessage } from "./review-ui-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const systemUserApi = { createUser, deleteUser, listUsers, updateUser };
type UserManagementPageProps = {
  accountApi?: typeof systemUserApi;
  inspection?: boolean;
  currentUsername: string | null;
  isAdmin: boolean;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

function userInitial(username: string): string {
  return Array.from(username.trim())[0]?.toUpperCase() ?? "U";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function replaceUser(users: UserListItem[], next: UserListItem): UserListItem[] {
  return users.map((user) => user.id === next.id ? next : user);
}

export function UserManagementPage({ accountApi = systemUserApi, inspection = false, currentUsername, isAdmin, onNotice, onError }: UserManagementPageProps) {
  const { createUser, deleteUser, listUsers, updateUser } = accountApi;
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const editingUser = users.find((user) => user.id === editId);
  const deletingUser = users.find((user) => user.id === pendingDeleteId);
  const editorBusy = submitting || Boolean(editId && busyId === editId);
  const closeEditor = () => {
    if (editorBusy) return;
    setCreateOpen(false); setEditId(null); setPassword(""); setEditPassword(""); setFormError(null);
  };

  const loadUsers = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listUsers();
      setUsers(result.users);
      setTotal(result.total);
      onError(null);
    } catch (loadError) {
      const message = errorMessage(loadError);
      setError(message);
      onError(message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, listUsers, onError]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const submitUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < 8) {
      setFormError("密码至少需要 8 位。");
      onError("密码至少需要 8 位。");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    onError(null);
    try {
      const result = await createUser({ username: username.trim(), password });
      setUsers((current) => [...current, result.user]);
      setTotal((current) => current + 1);
      setUsername("");
      setPassword("");
      setCreateOpen(false);
      onNotice(`账号 ${result.user.username} 已创建。`);
    } catch (createError) {
      setFormError(errorMessage(createError));
      onError(errorMessage(createError));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleUser = async (user: UserListItem) => {
    setBusyId(user.id);
    onError(null);
    try {
      const result = await updateUser(user.id, { enabled: !user.enabled });
      setUsers((current) => replaceUser(current, result.user));
      onNotice(result.user.enabled ? `账号 ${user.username} 已启用。` : `账号 ${user.username} 已停用。`);
    } catch (updateError) {
      onError(errorMessage(updateError));
    } finally {
      setBusyId(null);
    }
  };

  const submitUserEdit = async (event: FormEvent<HTMLFormElement>, user: UserListItem) => {
    event.preventDefault();
    const nextUsername = editUsername.trim();
    if (!nextUsername) {
      setFormError("用户名不能为空。");
      onError("用户名不能为空。");
      return;
    }
    if (editPassword && editPassword.length < 8) {
      setFormError("密码至少需要 8 位。");
      onError("密码至少需要 8 位。");
      return;
    }
    setBusyId(user.id);
    setFormError(null);
    onError(null);
    try {
      const result = await updateUser(user.id, { username: nextUsername, ...(editPassword ? { password: editPassword } : {}) });
      setUsers((current) => replaceUser(current, result.user));
      setEditId(null);
      setEditUsername("");
      setEditPassword("");
      onNotice(`账号 ${result.user.username} 已更新。`);
    } catch (updateError) {
      setFormError(errorMessage(updateError));
      onError(errorMessage(updateError));
    } finally {
      setBusyId(null);
    }
  };

  const removeUser = async (user: UserListItem) => {
    setBusyId(user.id);
    onError(null);
    try {
      await deleteUser(user.id);
      setUsers((current) => current.filter((item) => item.id !== user.id));
      setTotal((current) => Math.max(0, current - 1));
      setPendingDeleteId(null);
      onNotice(`账号 ${user.username} 已删除。`);
    } catch (deleteError) {
      onError(errorMessage(deleteError));
    } finally {
      setBusyId(null);
    }
  };

  if (!isAdmin) {
    return <section className="user-management-page"><div className="user-management-inner"><div className="user-management-state is-error" role="alert"><UserRoundX aria-hidden="true" /><span>只有管理员可以访问用户管理。</span></div></div></section>;
  }

  return <>
    <section className="user-management-page" aria-labelledby="user-management-title">
      <div className="user-management-inner">
        <header className="user-management-heading">
          <div><h3 id="user-management-title">{inspection ? "维护人员" : "用户管理"}</h3><p>{inspection ? "管理巡检账号及其使用状态，服务授权由各维护人员独立保存。" : "管理系统登录账号、密码和使用权限。"}</p></div>
          <Button onClick={() => { setUsername(""); setPassword(""); setFormError(null); setCreateOpen(true); }}><Plus aria-hidden="true" />{inspection ? "新增维护人员" : "新增账号"}</Button>
        </header>
        <section className="user-management-list-panel" aria-labelledby="user-list-title">
          <header className="user-management-list-heading">
            <div className="user-management-section-heading"><Users aria-hidden="true" /><h4 id="user-list-title">账号列表</h4><span className="user-management-count">{total}</span></div>
            <div className="user-management-list-actions"><span>{users.filter((user) => user.enabled).length} 个已启用</span><Button variant="ghost" size="sm" type="button" aria-label="刷新账号列表" onClick={() => void loadUsers()} disabled={loading}><RefreshCw className={loading ? "is-spinning" : ""} aria-hidden="true" />刷新</Button></div>
          </header>
          {loading && users.length === 0 ? <div className="user-management-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取账号…</div>
            : error ? <div className="user-management-state is-error" role="alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => void loadUsers()}>重新读取</Button></div>
              : users.length === 0 ? <div className="user-management-empty"><span className="user-management-avatar"><Users aria-hidden="true" /></span><strong>{inspection ? "还没有维护人员" : "还没有账号"}</strong><p>{inspection ? "添加第一个维护人员，即可登录巡检并连接服务。" : "添加账号后即可登录系统。"}</p><Button variant="outline" onClick={() => { setFormError(null); setCreateOpen(true); }}><Plus aria-hidden="true" />创建第一个账号</Button></div>
                : <div className="user-management-items">{users.map((user) => {
                  const isCurrentUser = user.username === currentUsername;
                  const busy = busyId === user.id;
                  const StatusIcon = user.enabled ? UserRoundX : UserRoundCheck;
                  return <article className={`user-management-item ${user.enabled ? "" : "is-disabled"}`} key={user.id}>
                    <div className="user-management-avatar" aria-hidden="true">{userInitial(user.username)}</div>
                    <div className="user-management-copy"><div><strong title={user.username}>{user.username}</strong>{isCurrentUser && <span className="user-management-current">当前账号</span>}</div><small>创建于 {formatDate(user.createdAt)}</small></div>
                    <span className={`user-management-role ${user.role}`}><ShieldCheck aria-hidden="true" />{user.role === "admin" ? "管理员" : inspection ? "维护人员" : "普通用户"}</span>
                    <span className={`user-management-status ${user.enabled ? "is-enabled" : "is-disabled"}`}><i aria-hidden="true" />{user.enabled ? "已启用" : "已停用"}</span>
                    <div className="user-management-actions">
                      {!inspection && <Button variant="ghost" size="sm" aria-label={`${user.inspectionAccess ? "撤销" : "授予"} ${user.username} 的巡检权限`} title={user.role === "admin" ? "管理员默认可巡检" : user.inspectionAccess ? "撤销巡检权限" : "授予巡检权限"} disabled={busy || user.role === "admin"} onClick={async () => {
                        setBusyId(user.id);
                        try { const result = await updateUser(user.id, { inspectionAccess: !user.inspectionAccess }); setUsers((current) => replaceUser(current, result.user)); onNotice(result.user.inspectionAccess ? "已授予巡检权限。" : "已撤销巡检权限。"); }
                        catch (error) { onError(errorMessage(error)); } finally { setBusyId(null); }
                      }}><ShieldCheck aria-hidden="true" />{user.role === "admin" ? "默认可巡检" : user.inspectionAccess ? "撤销巡检" : "允许巡检"}</Button>}
                      <Button variant="ghost" size="sm" aria-label={`编辑 ${user.username}`} title={`编辑 ${user.username}`} onClick={() => { setCreateOpen(false); setFormError(null); setEditId(user.id); setEditUsername(user.username); setEditPassword(inspection ? "" : user.password ?? ""); }} disabled={busy}><Pencil aria-hidden="true" />编辑</Button>
                      <Button variant="ghost" size="sm" aria-label={`${user.enabled ? "停用" : "启用"} ${user.username}`} title={`${user.enabled ? "停用" : "启用"} ${user.username}`} onClick={() => void toggleUser(user)} disabled={busy || isCurrentUser}><StatusIcon aria-hidden="true" />{user.enabled ? "停用" : "启用"}</Button>
                      {!isCurrentUser && <Button variant="ghost" size="sm" className="user-management-delete" aria-label={`删除 ${user.username}`} title={`删除 ${user.username}`} onClick={() => setPendingDeleteId(user.id)} disabled={busy}><Trash2 aria-hidden="true" />删除</Button>}
                    </div>
                  </article>;
                })}</div>}
        </section>
      </div>
    </section>
    {(createOpen || editingUser) && <ReviewDrawerShell size="compact" eyebrow={inspection ? "维护人员管理" : "用户管理"} title={editingUser ? "编辑账号" : inspection ? "新增维护人员" : "新增账号"} titleId="user-editor-title" closeLabel="关闭账号编辑" isClosing={false} onRequestClose={closeEditor} contentClassName="user-management-drawer-content">
      <form className="user-management-editor" onSubmit={(event) => { if (editingUser) void submitUserEdit(event, editingUser); else void submitUser(event); }}>
        <div className="user-management-editor-intro"><span className="user-management-avatar" aria-hidden="true"><UserRound /></span><div><strong>{editingUser?.username ?? "创建登录账号"}</strong><p>{editingUser ? "更新账号信息，密码留空则保持不变。" : inspection ? "创建后可登录巡检，并连接专属的 GitLab 和 Jira。" : "新账号默认是普通用户。"}</p></div></div>
        <div className="auth-field"><Label htmlFor="user-editor-name">用户名</Label><Input id="user-editor-name" value={editingUser ? editUsername : username} onChange={(event) => editingUser ? setEditUsername(event.target.value) : setUsername(event.target.value)} placeholder={inspection ? "例如：maintenance-01" : "例如：pilot-user-02"} autoComplete="off" disabled={editorBusy || Boolean(editingUser && editingUser.username === currentUsername)} autoFocus required /></div>
        <div className="auth-field"><Label htmlFor="user-editor-password">{editingUser ? "登录密码" : "初始密码"}</Label><Input id="user-editor-password" type={editingUser && !inspection ? "text" : "password"} value={editingUser ? editPassword : password} onChange={(event) => editingUser ? setEditPassword(event.target.value) : setPassword(event.target.value)} placeholder={editingUser ? "留空保留当前密码" : "至少 8 位"} autoComplete="new-password" disabled={editorBusy} minLength={8} required={!editingUser} /><small>{editingUser ? "填写新密码后，原密码将失效。" : "请将账号和初始密码交给使用人员。"}</small></div>
        {formError && <p className="auth-error" role="alert">{formError}</p>}
        <div className="user-management-editor-actions"><Button variant="outline" type="button" onClick={closeEditor} disabled={editorBusy}>取消</Button><Button type="submit" disabled={editorBusy || !(editingUser ? editUsername.trim() : username.trim() && password)}>{editorBusy && <LoaderCircle className="is-spinning" aria-hidden="true" />}{editorBusy ? "保存中…" : editingUser ? "保存修改" : "创建账号"}</Button></div>
      </form>
    </ReviewDrawerShell>}
    <AlertDialog open={Boolean(deletingUser)} onOpenChange={(open) => { if (!open && !busyId) setPendingDeleteId(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除账号 {deletingUser?.username}？</AlertDialogTitle><AlertDialogDescription>删除后无法使用此账号登录{inspection ? "巡检工作台，关联的服务授权也会移除" : "系统"}，此操作无法撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel asChild><Button variant="outline" disabled={Boolean(busyId)}>取消</Button></AlertDialogCancel><Button variant="destructive" onClick={() => { if (deletingUser) void removeUser(deletingUser); }} disabled={Boolean(busyId)}>{busyId ? "删除中…" : "确认删除"}</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </>;
}
