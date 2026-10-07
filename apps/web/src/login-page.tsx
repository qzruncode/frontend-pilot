import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, login } from "./api";
import { errorMessage } from "./review-ui-utils";

type LoginPageProps = {
  onAuthenticated: (username: string | null, role: "admin" | "user" | null) => void;
};

const productHighlights = [
  { label: "统一工作台", detail: "把研发协作入口集中到一个清晰的空间" },
  { label: "实时进度", detail: "任务状态、审查过程和结果一目了然" },
  { label: "安全会话", detail: "登录后由服务端会话保护工作区数据" },
];

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      setError("请输入账号和密码");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await login(normalizedUsername, password);
      onAuthenticated(response.username, response.role);
    } catch (loginError) {
      if (loginError instanceof ApiError && loginError.status === 401) {
        setError("账号或密码错误，请重新输入");
      } else if (loginError instanceof ApiError && loginError.status === 503) {
        setError(typeof loginError.details === "string" ? loginError.details : "登录服务尚未配置");
      } else {
        setError(errorMessage(loginError));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-orb auth-orb-top" aria-hidden="true" />
      <div className="auth-orb auth-orb-bottom" aria-hidden="true" />
      <section className="auth-card" aria-label="Frontend Pilot 登录">
        <div className="auth-brand-panel">
          <div className="auth-brand-mark" aria-hidden="true"><Sparkles /></div>
          <div className="auth-brand-copy">
            <strong>Frontend Pilot</strong>
            <span>研发智能工作台</span>
          </div>
          <div className="auth-brand-content">
            <p className="auth-eyebrow">WELCOME BACK</p>
            <h1>让每一次研发协作，<em>更快进入状态。</em></h1>
            <p className="auth-brand-description">从任务、审查到协作信息，在一个专注的工作台里保持清晰、专注和可追踪。</p>
          </div>
          <div className="auth-highlight-list">
            {productHighlights.map((highlight, index) => (
              <div className="auth-highlight" key={highlight.label}>
                <span className="auth-highlight-index">0{index + 1}</span>
                <div><strong>{highlight.label}</strong><small>{highlight.detail}</small></div>
              </div>
            ))}
          </div>
          <span className="auth-brand-footer">BUILD WITH CLARITY</span>
        </div>

        <div className="auth-form-panel">
          <div className="auth-form-heading">
            <div className="auth-form-icon" aria-hidden="true"><LockKeyhole /></div>
            <p className="auth-eyebrow">账户登录</p>
            <h2>欢迎回来</h2>
            <p>登录后继续使用你的研发工作台。</p>
          </div>

          <form className="auth-form" onSubmit={submit} noValidate>
            <div className="auth-field">
              <Label htmlFor="login-username"><UserRound aria-hidden="true" />账号</Label>
              <Input
                id="login-username"
                name="username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="请输入账号"
                autoComplete="username"
                autoFocus
                disabled={submitting}
              />
            </div>
            <div className="auth-field">
              <Label htmlFor="login-password"><LockKeyhole aria-hidden="true" />密码</Label>
              <div className="auth-password-field">
                <Input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  disabled={submitting}
                />
                <Button
                  className="auth-password-toggle"
                  variant="ghost"
                  size="icon"
                  type="button"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  title={showPassword ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowPassword((visible) => !visible)}
                  disabled={submitting}
                >
                  {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
              </div>
            </div>

            {error && <p className="auth-error" role="alert">{error}</p>}

            <Button className="auth-submit-button" type="submit" disabled={submitting}>
              {submitting ? "正在登录…" : "登录工作台"}
              {!submitting && <ArrowRight aria-hidden="true" />}
            </Button>
          </form>

          <div className="auth-security-note"><ShieldCheck aria-hidden="true" /><span>登录信息仅用于当前产品，不会发送到第三方平台。</span></div>
        </div>
      </section>
    </main>
  );
}
