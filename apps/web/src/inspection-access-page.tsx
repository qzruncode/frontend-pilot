import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowRightLeft, Bot, ClipboardCheck, Eye, EyeOff, Link2, LoaderCircle, LockKeyhole, ShieldCheck, UserRound, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { InspectionAuthStatusSchema, InspectionLoginResponseSchema, type InspectionAuthStatus, UserListResponseSchema, UserResponseSchema, type CreateUserInput, type UpdateUserInput } from "@contracts";
import { ApiError, request, createIntegrationApi } from "./api";
import { IntegrationApiContext } from "./integration-api-context";
import { InspectionWorkbenchPage } from "./inspection-workbench-page";
import { InspectionPromptsPage } from "./inspection-prompts-page";
import { UserManagementPage } from "./user-management-page";
import { GitLabOAuthPanel } from "./assistant-gitlab-oauth";
import { JiraAccountPanel } from "./assistant-jira-account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "./review-ui-utils";

const base = "/api/v1/inspections";
const INSPECTION_SESSION_RENEW_INTERVAL_MS = 15 * 60_000;
const INSPECTION_SESSION_ACTIVITY_WINDOW_MS = 30 * 60_000;
function accessError(error: unknown): string {
  return error instanceof ApiError && typeof error.details === "string" ? error.details : errorMessage(error);
}
const accountApi = {
  listUsers: () => request(`${base}/maintainers`, UserListResponseSchema),
  createUser: (body: CreateUserInput) => request(`${base}/maintainers`, UserResponseSchema, { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, body: UpdateUserInput) => request(`${base}/maintainers/${encodeURIComponent(id)}`, UserResponseSchema, { method: "PATCH", body: JSON.stringify(body) }),
  deleteUser: (id: string) => request(`${base}/maintainers/${encodeURIComponent(id)}`, z.object({ deleted: z.boolean() }), { method: "DELETE" }),
};
type Props = { children?: ReactNode; requiredMaintainerId?: string;  sessionReady: boolean; isAdmin: boolean; onNotice: (message: string) => void; onError: (message: string | null) => void };
export function InspectionAccessPage(props: Props) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<InspectionAuthStatus | null>(null);
  const integrationApi = useMemo(() => createIntegrationApi(base, status?.maintainer?.id), [status?.maintainer?.id]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useSearchParams();
  const pageRef = useRef<HTMLDivElement>(null);
  const sessionRenewInFlight = useRef(false);
  const lastSessionActivityAt = useRef(Date.now());
  const manage = search.get("maintainers") === "1";
  const accountsOpen = search.get("accounts") === "1";
  const promptsOpen = search.get("prompts") === "1";
  const openPage = (page: "workbench" | "accounts" | "maintainers" | "prompts" | "login") => setSearch((current) => {
    current.delete("accounts"); current.delete("maintainers"); current.delete("prompts"); current.delete("oauth");
    if (page === "accounts") current.set("accounts", "1");
    if (page === "maintainers") current.set("maintainers", "1");
    if (page === "prompts") current.set("prompts", "1");
    return current;
  });
  const load = useCallback(async () => {
    try { setStatus(await request(`${base}/auth/status`, InspectionAuthStatusSchema, { cache: "no-store" })); setError(null); }
    catch (error) { setStatus(null); setError(accessError(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { pageRef.current?.scrollIntoView({ block: "start", behavior: "instant" }); }, [manage, accountsOpen, promptsOpen, status?.maintainer?.id, Boolean(status)]);
  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);
  useEffect(() => {
    if (!status?.maintainer) return;
    const markActivity = () => { lastSessionActivityAt.current = Date.now(); };
    const renewIfActive = async () => {
      if (document.visibilityState !== "visible" || Date.now() - lastSessionActivityAt.current > INSPECTION_SESSION_ACTIVITY_WINDOW_MS || sessionRenewInFlight.current) return;
      sessionRenewInFlight.current = true;
      try {
        const result = await request(`${base}/auth/refresh`, InspectionLoginResponseSchema, { method: "POST", cache: "no-store" });
        setStatus((current) => current ? { ...current, maintainer: result.maintainer } : current);
        setError(null);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 428)) {
          setStatus((current) => current ? { ...current, maintainer: null } : current);
          setError("巡检登录已过期，请重新登录维护人员账号。");
        }
      } finally {
        sessionRenewInFlight.current = false;
      }
    };
    const renewFromVisible = () => {
      if (document.visibilityState !== "visible") return;
      markActivity();
      void renewIfActive();
    };
    const activityEvents: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
    activityEvents.forEach((event) => window.addEventListener(event, markActivity, { passive: true }));
    document.addEventListener("visibilitychange", renewFromVisible);
    window.addEventListener("focus", renewFromVisible);
    markActivity();
    void renewIfActive();
    const timer = window.setInterval(() => void renewIfActive(), INSPECTION_SESSION_RENEW_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      activityEvents.forEach((event) => window.removeEventListener(event, markActivity));
      document.removeEventListener("visibilitychange", renewFromVisible);
      window.removeEventListener("focus", renewFromVisible);
    };
  }, [status?.maintainer?.id]);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await request(`${base}/auth/login`, InspectionLoginResponseSchema, { method: "POST", body: JSON.stringify({ username, password }) });
      setPassword(""); openPage(props.children ? "workbench" : "accounts"); await load();
    } catch (error) { setError(accessError(error)); } finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try { await request(`${base}/auth/logout`, z.object({ loggedOut: z.boolean() }), { method: "POST" }); openPage("login"); await load(); }
    catch (error) { setError(accessError(error)); } finally { setBusy(false); }
  };
  if (loading) return <div className="user-management-state" role="status">正在检查巡检登录状态…</div>;
  if (!status) return <div className="user-management-state is-error" role="alert">{error}<Button onClick={() => void load()}>重试</Button></div>;
  return <IntegrationApiContext.Provider value={integrationApi}>
    <div className="inspection-access-page" ref={pageRef}>
    {(status.maintainer || manage) && <header className="inspection-access-header">
      <div className="inspection-access-session">
        <div className="inspection-access-identity"><span className="inspection-login-avatar" aria-hidden="true"><UserRound /></span><div><strong>{status.maintainer?.username ?? status.operator.username}</strong><span>{status.maintainer ? "当前维护人员" : "系统管理员"}</span></div></div>
        <div className="inspection-access-operator"><span>系统账号 <strong>{status.operator.username}</strong></span>{status.maintainer && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void logout()}><ArrowRightLeft aria-hidden="true" />切换维护人员</Button>}</div>
      </div>
      <nav className="inspection-access-nav" aria-label="巡检页面导航">
        {status.maintainer ? <><Button variant="ghost" aria-current={!manage && !accountsOpen && !promptsOpen ? "page" : undefined} onClick={() => props.children ? navigate("/inspection-workbench") : openPage("workbench")}><ClipboardCheck aria-hidden="true" />巡检任务</Button><Button variant="ghost" aria-current={!manage && accountsOpen ? "page" : undefined} onClick={() => openPage("accounts")}><Link2 aria-hidden="true" />账号连接</Button></> : <Button variant="ghost" onClick={() => openPage("login")}><ArrowLeft aria-hidden="true" />返回登录</Button>}
        {status.canManage && <Button variant="ghost" aria-current={manage ? "page" : undefined} onClick={() => openPage("maintainers")}><Users aria-hidden="true" />维护人员</Button>}
        {status.maintainer && <Button variant="ghost" aria-current={!manage && promptsOpen ? "page" : undefined} onClick={() => openPage("prompts")}><Bot aria-hidden="true" />提示词管理</Button>}
      </nav>
    </header>}
    {error && (status.maintainer || manage) && <div className="user-management-state is-error" role="alert">{error}</div>}
    {manage ? <UserManagementPage inspection accountApi={accountApi} currentUsername={status.maintainer?.username ?? null} isAdmin={status.canManage} onNotice={(message) => { props.onNotice(message); void load(); }} onError={props.onError} />
      : promptsOpen && status.maintainer ? <InspectionPromptsPage onNotice={props.onNotice} onError={props.onError} />
      : (!status.maintainer || (props.requiredMaintainerId && status.maintainer.id !== props.requiredMaintainerId)) ? <div className="inspection-login-stage">
        <section className="inspection-secondary-login" aria-labelledby="inspection-login-title">
          <header className="inspection-login-heading">
            <div className="auth-form-icon" aria-hidden="true"><ShieldCheck /></div>
            <span className="inspection-login-eyebrow">维护人员入口</span>
            <h2 id="inspection-login-title">登录巡检工作台</h2>
            <p>{props.requiredMaintainerId ? "请登录创建此 MR 的维护人员账号。" : "使用维护人员账号，开始代码巡检。"}</p>
          </header>
          <form className="auth-form" onSubmit={(event) => void login(event)}>
            <div className="auth-field">
              <Label htmlFor="inspection-username"><UserRound aria-hidden="true" />维护人员账号</Label>
              <Input id="inspection-username" name="inspection-username" placeholder="输入维护人员账号" autoComplete="section-inspection username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy} required />
            </div>
            <div className="auth-field">
              <Label htmlFor="inspection-password"><LockKeyhole aria-hidden="true" />密码</Label>
              <div className="auth-password-field">
                <Input id="inspection-password" name="inspection-password" type={showPassword ? "text" : "password"} placeholder="输入登录密码" autoComplete="section-inspection current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} required />
                <Button className="auth-password-toggle" variant="ghost" size="icon" type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword((visible) => !visible)} disabled={busy}>{showPassword ? <EyeOff /> : <Eye />}</Button>
              </div>
            </div>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <Button className="auth-submit-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : null}{busy ? "正在登录…" : "登录巡检工作台"}{!busy && <ArrowRight aria-hidden="true" />}</Button>
          </form>
          <div className="inspection-login-session">
            <span className="inspection-login-avatar" aria-hidden="true"><UserRound /></span>
            <div><span>当前系统账号</span><strong>{status.operator.username}</strong></div>
            <span className="inspection-login-session-status"><i aria-hidden="true" />已登录</span>
          </div>
          <p className="inspection-login-note">巡检使用独立的 Jira / GitLab 授权</p>
          {status.canManage && <footer className="inspection-login-footer"><span>首次使用？</span><Button variant="link" size="sm" onClick={() => openPage("maintainers")}><Users aria-hidden="true" />管理维护人员<ArrowRight aria-hidden="true" /></Button></footer>}
        </section>
      </div>
      : accountsOpen ? <div key={status.maintainer.id} className="inspection-account-settings">
        <header className="inspection-section-heading-copy"><h2>账号连接</h2><p>为 {status.maintainer.username} 连接巡检所需的服务。</p></header>
        {search.get("oauth") === "error" && <p className="auth-error" role="alert">GitLab 授权未完成，请重新连接；若仍失败，请联系管理员检查授权配置。</p>}
        <div className="inspection-account-grid">
          <GitLabOAuthPanel inspection sessionReady onNotice={props.onNotice} onError={props.onError} />
          <JiraAccountPanel inspection sessionReady productUsername={status.maintainer.username} onNotice={props.onNotice} onError={props.onError} />
        </div>
        <p className="inspection-account-scope"><ShieldCheck aria-hidden="true" />授权归属当前维护人员，仅用于巡检。定时任务使用项目绑定的维护人员账号。</p>
      </div>
      : props.children ? <div key={status.maintainer.id}>{props.children}</div> : <InspectionWorkbenchPage key={status.maintainer.id} {...props} maintainerId={status.maintainer.id} maintainerName={status.maintainer.username} />}
    </div>
  </IntegrationApiContext.Provider>;
}
