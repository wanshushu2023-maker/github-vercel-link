# github-vercel-link

一个**零依赖**的最小项目，用来验证「GitHub 推送 → Vercel 自动部署」这条链路。

- `index.html` / `styles.css`：静态页面，展示部署链路和 `api/hello` 的实时响应
- `api/hello.js`：Serverless Function，回显 Vercel 从 GitHub 注入的提交信息
  （`VERCEL_GIT_REPO_SLUG`、`VERCEL_GIT_COMMIT_REF`、`VERCEL_GIT_COMMIT_SHA` 等）
- `scripts/dev-server.mjs`：本地预览，用和 Vercel 相同的 handler 签名模拟 `/api/*`
- `scripts/install-git.mjs`：把便携版 Git（MinGit）装进 `.tools/git`，不需管理员权限
- `scripts/provision.mjs`：建 GitHub 仓库 → `git push` → 建 Vercel 项目并绑定仓库 → 等待部署 READY

## 本地运行

```bash
node scripts/dev-server.mjs --port 4317
# 打开 http://127.0.0.1:4317
```

无依赖、无构建步骤：Vercel 会把它识别为静态站点 + `api/` 下的 Serverless Function。

## 一次性打通 GitHub → Vercel

1. 把两个 token 填进 `.secrets/tokens.json`（已被 `.gitignore` 忽略）：

```json
{ "githubToken": "ghp_...", "vercelToken": "..." }
```

2. 运行：

```bash
node scripts/provision.mjs --tokens-file .secrets/tokens.json \
  --repo github-vercel-link --project github-vercel-link --store-credentials
```

3. 结果写入 `.provision-result.json`（仓库地址、commit、项目 id、线上地址、部署状态）。

之后 `git push` 到 `main`，Vercel 会自动重新部署。

## 本机 Git 说明

本机原本没有 git。`scripts/install-git.mjs` 会：

1. 从 git-for-windows 官方发布页解析最新 MinGit 包名；
2. 从 npmmirror / 华为云两个镜像下载；
3. 校验：两镜像 SHA-256 一致 + 与 GitHub 官方 CDN 分片抽样逐字节一致；
4. 解压到 `.tools/git`，并写入 `http.sslBackend=openssl` + 自带 CA bundle
   （本机沙箱下 schannel 不可用，必须走 OpenSSL 后端）。

用完整路径调用：`.tools\git\cmd\git.exe`。
