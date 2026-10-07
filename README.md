# Frontend Pilot

Frontend Pilot 是基于 React、Fastify、SQLite 和 Claude Agent SDK 的 AI 研发工作台，包含 GitLab Merge Request 审查、助手对话、GitLab/Jira 工作台、代码巡检和 Claude CLI 会话。

`prod` 是对外分享源码的专用分支，采用 MIT 许可证。此分支不包含公司部署流水线、私有镜像或内网连接配置，也不自动发布包、镜像或部署服务。GitHub 作为代码托管平台；当前业务集成仍面向 GitLab 和 Jira Server / Data Center。

## 本地运行

使用 Node.js 24（见 `.nvmrc`）。`node-pty` 可能需要 Python 3、make 和 C++ 编译器；macOS 可通过 Xcode Command Line Tools 提供编译工具，Linux 可安装发行版的构建工具包。交互式 CLI 另需安装 [Claude Code](https://code.claude.com/docs/en/setup)，或用 `CLAUDE_CLI_PATH` 指定已安装的程序。

```bash
nvm install
nvm use
npm ci
cp .env.example .env
```

编辑 `.env`，至少设置以下值。密码和令牌应分别使用独立的随机值，不能使用示例字符串：

```env
FRONTEND_PILOT_LOGIN_USERNAME=your-user
FRONTEND_PILOT_LOGIN_PASSWORD=your-private-password
FRONTEND_PILOT_ADMIN_PASSWORD=your-separate-admin-password
REVIEW_SERVICE_TOKEN=your-random-service-token
AUTH_SESSION_SECRET=your-separate-random-session-secret
```

然后启动开发服务：

```bash
./dev.sh start
# 查看启动输出中的实际端口，默认页面 http://localhost:5173
./dev.sh stop
```

开发脚本支持 macOS/Linux，使用 `MR_REVIEW_WEB_PORT` 固定前端端口。普通账号使用上面的用户名；管理员账号固定为 `pilot-admin`，使用管理员密码。

`.env.example` 默认 `REVIEW_DRY_RUN=true`，可先检查登录和页面流程。执行真实审查前配置自己的 GitLab 地址、bot Token、模型 API Key 和模型名称，再设为 `false`：

```env
GITLAB_BASE_URL=https://your-gitlab.example.com
GITLAB_API_BASE_URL=https://your-gitlab.example.com/api/v4
GITLAB_TOKEN=your-private-gitlab-token
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=your-private-api-key
ANTHROPIC_MODEL=your-supported-model
REVIEW_DRY_RUN=false
```

模型配置在首次启动时从环境初始化到 SQLite，之后由管理员在模型配置页维护。GitLab bot 连接由管理员维护，供后台审查使用；个人 GitLab 连接通过 OAuth 按产品用户隔离，需自行注册 OAuth 应用并设置 `GITLAB_OAUTH_CLIENT_ID`、`GITLAB_OAUTH_CLIENT_SECRET` 和匹配页面地址的回调 URI。

Jira 为可选集成，配置 `JIRA_BASE_URL`、`JIRA_API_BASE_URL`、`JIRA_PROJECT_KEY` 和服务端或个人凭据后启用。当前实现面向 Server / Data Center REST API v2；未宣称 Jira Cloud 兼容。自定义字段由 Jira 元数据发现，不预设某个公司的字段 ID。

## 构建和容器示例

本地构建后运行（先确保上述 `.env` 已配置）：

```bash
npm run build
WEB_ORIGIN=http://localhost:8080 npm start
```

打开 http://localhost:8080。容器示例使用公共 Node 镜像和 npm 官方源，包含 Git、Python、ripgrep、pnpm 和 Claude Code；配置保存在本地 `.env`，数据保存在命名卷中：

```bash
WEB_ORIGIN=http://localhost:8080 docker compose -f deploy/compose.yaml up --build -d
# 停止容器，保留数据卷
docker compose -f deploy/compose.yaml down
```

容器端口默认仅绑定本机。需要团队访问时由部署方配置 HTTPS、反向代理和正确的 `WEB_ORIGIN`；不要把开发环境直接作为公开服务。首次实际使用时应自行验证容器构建和所连接服务的认证。

## 结构和运行边界

- `src/`：API、认证、SQLite 存储、GitLab/Jira 客户端和 Agent 服务。
- `src/contracts.ts`：前后端共享的类型与 Zod 契约。
- `apps/web/`：React + Vite 控制台。
- `config/skills/`：通用审查与巡检规则；`config/review-profiles.json` 默认只保留通用 profile，可按自己的仓库配置。
- `test/`：Vitest 单元和 API 测试；涉及外部服务的测试使用 mock。

数据库、会话记录、临时工作区和日志保存在 `var/`、`.dev/` 等被忽略的目录。审查队列由单个 API 进程管理；当前部署方式不支持通过多个实例共享执行队列。

普通登录用户读取模型配置时只获得密钥掩码，读取 bot 连接时只获得地址和凭据是否配置。查看密钥、修改配置、执行模型或 bot 连接测试均需要管理员权限。个人 OAuth Token 不返回给浏览器。

Claude CLI 是运行在服务端的交互式终端，Agent 工具也可能执行命令；工作区目录并不是操作系统安全沙箱。本项目适合受信任用户的自托管工作台，不应作为对不受信任用户开放的多租户执行平台。

## 验证与贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。按改动范围运行相应测试，例如：

```bash
npm exec -- vitest run test/config.test.ts test/user-management.test.ts
```

完整检查命令为 `npm run check`、`npm test`、`npm run build`，按需要执行。本分支不启用自动发布或部署流水线。

## 许可证与依赖

项目代码采用 [MIT](LICENSE)。依赖仍遵循各自许可证和服务条款，项目 MIT 声明不会覆盖依赖。尤其 Claude Agent SDK 和 Claude Code 受 Anthropic 的许可及商业服务条款约束，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`prod` 使用独立的源码快照历史，原 `dev` 开发历史不随此分支分享。也可使用 `git archive prod` 导出源码；不要将包含旧环境配置的开发仓库整体镜像到公开仓库。安全问题的报告方式见 [SECURITY.md](SECURITY.md)。
