# github-vercel-link

一个**零依赖**的最小项目，用来打通并验证「GitHub 推送 → 自动部署」这条链路，同时接了两个平台。

| 平台 | 线上地址 | 函数目录 |
|---|---|---|
| Vercel | <https://github-vercel-link.vercel.app> | `api/hello.js` |
| Cloudflare Pages | <https://github-vercel-link.pages.dev> | `functions/api/hello.js` |

- 仓库：<https://github.com/wanshushu2023-maker/github-vercel-link>
- 一次 `git push`，Vercel 和 Cloudflare Pages 各自自动部署；页面会根据 `/api/hello` 返回的
  `host` 自动显示当前托管方。

## 结构

- `index.html` / `styles.css`：静态页面，展示部署链路和 `api/hello` 的实时响应
- `api/hello.js`：Serverless Function，回显 Vercel 从 GitHub 注入的提交信息
  （`VERCEL_GIT_REPO_SLUG`、`VERCEL_GIT_COMMIT_REF`、`VERCEL_GIT_COMMIT_SHA` 等）
- `scripts/dev-server.mjs`：本地预览，用和 Vercel 相同的 handler 签名模拟 `/api/*`
- `scripts/install-git.mjs`：把便携版 Git（MinGit）装进 `.tools/git`，无需管理员权限
- `scripts/provision.mjs`：建 GitHub 仓库 → `git push` → 建 Vercel 项目并绑定仓库 → 触发/等待部署
- `scripts/verify.mjs`：等最新部署 READY，校验线上 `/api/hello` 的 sha 与页面内容
- `scripts/cloudflare-pages.mjs`：建 Pages 项目、绑定 GitHub 仓库、触发首次部署、验证线上函数
- `scripts/check-tokens.mjs`：校验 `.secrets/tokens.json` 里的 token

## 本地运行

```bash
node scripts/dev-server.mjs --port 4317
# 打开 http://127.0.0.1:4317
```

无依赖、无构建步骤：Vercel 会把它识别为静态站点 + `api/` 下的 Serverless Function。

## 日常开发 → 自动部署

改代码后：

```bash
git add -A
git commit -m "feat: xxx"
git push
```

Vercel 的 GitHub App 收到 webhook 后自动构建并发布到
<https://github-vercel-link.vercel.app>，通常 30-60 秒。

验证一次：

```bash
node scripts/verify.mjs --marker "build v1.0.1"
```

它会等本地 HEAD 对应的部署 READY，再检查线上 `/api/hello` 的 `gitSha` 是否等于本地
HEAD、首页是否包含指定内容标记。

## 首次打通（已执行过，留作复现）

1. 把两个 token 填进 `.secrets/tokens.json`（已被 `.gitignore` 忽略）：

   ```json
   { "githubToken": "ghp_...", "vercelToken": "..." }
   ```

2. 运行：

   ```bash
   node scripts/provision.mjs --tokens-file .secrets/tokens.json --store-credentials
   ```

   结果写入 `.provision-result.json`（仓库、commit、项目 id、线上地址、部署状态）。

## 本机 Git 说明

本机原本没有 git。`scripts/install-git.mjs` 会：

1. 从 git-for-windows 官方发布页解析最新 MinGit 包名；
2. 从 npmmirror / 华为云两个镜像下载；
3. 校验：两镜像 SHA-256 一致 + 与 GitHub 官方 CDN 分片抽样逐字节一致；
4. 解压到 `.tools/git`（已加入用户 PATH），并写入 `http.sslBackend=openssl` + 自带
   CA bundle（本机沙箱下 schannel 不可用，必须走 OpenSSL 后端）。

## 安全提醒

- `.secrets/`、`.tools/`、`assets/` 都在 `.gitignore` 里，不会被提交。
- 推送凭据写在**本仓库**的 `.git/config`（`http.https://github.com/.extraheader`），
  只存在本机、不进 git、不进远端。不需要时可执行：

  ```bash
  git config --unset http.https://github.com/.extraheader
  ```

- 两个 token 建议在验证完成后吊销：GitHub Settings → Applications，Vercel Account → Tokens。
