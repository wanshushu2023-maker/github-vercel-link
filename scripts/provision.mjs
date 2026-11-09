#!/usr/bin/env node
// 打通「GitHub 推送 → Vercel 自动部署」：
//   1. 校验 GitHub / Vercel token
//   2. 创建 GitHub 仓库（已存在则复用）
//   3. 本地 git 提交并 push（无 git 时回退到 Git Data API）
//   4. 创建 Vercel 项目并绑定 GitHub 仓库
//   5. 等待 push 触发的部署 READY，并验证线上 /api/hello 返回的 commit sha
//
// 用法:
//   node scripts/provision.mjs --tokens-file .secrets/tokens.json \
//     [--repo github-vercel-link] [--project github-vercel-link] [--private]
//     [--org <org>] [--team <teamId>] [--message "msg"] [--force] [--api-push]
//     [--store-credentials]
//
// token 文件格式: { "githubToken": "ghp_xxx", "vercelToken": "xxx" }
// 也支持环境变量 GH_TOKEN / VERCEL_TOKEN。

import fs from 'node:fs/promises';
import fsSync, { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GH = 'https://api.github.com';
const VERCEL = 'https://api.vercel.com';

// API 兜底推送时上传的文件白名单
const API_FILES = ['index.html', 'styles.css', 'api/hello.js', 'package.json', 'README.md', '.gitignore'];

const DEFAULT_REPO = 'github-vercel-link';

// ---------- 参数 ----------

function parseArgs(argv) {
  const out = { private: false, message: 'chore: initial commit from automation', force: false, apiPush: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail('参数 ' + a + ' 缺少取值');
      return v;
    };
    if (a === '--tokens-file') out.tokensFile = next();
    else if (a === '--repo') out.repo = next();
    else if (a === '--project') out.project = next();
    else if (a === '--message') out.message = next();
    else if (a === '--org') out.org = next();
    else if (a === '--team') out.team = next();
    else if (a === '--private') out.private = true;
    else if (a === '--force') out.force = true;
    else if (a === '--api-push') out.apiPush = true;
    else if (a === '--store-credentials') out.storeCredentials = true;
    else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else fail('未知参数: ' + a);
  }
  out.repo ||= process.env.REPO_NAME || DEFAULT_REPO;
  out.project ||= process.env.PROJECT_NAME || out.repo;
  return out;
}

function usage() {
  return [
    '用法: node scripts/provision.mjs --tokens-file .secrets/tokens.json [选项]',
    '',
    '  --tokens-file <path>   token JSON 文件（默认读环境变量 GH_TOKEN / VERCEL_TOKEN）',
    '  --repo <name>          GitHub 仓库名（默认 github-vercel-link）',
    '  --project <name>       Vercel 项目名（默认同仓库名）',
    '  --org <name>           建在 GitHub 组织下（默认个人账号）',
    '  --team <id>            Vercel 团队 id（token 属于团队时）',
    '  --private              创建私有仓库（默认 public）',
    '  --message <msg>        提交信息',
    '  --force                远端历史分叉时强制覆盖（--force-with-lease）',
    '  --api-push             不用本地 git，改走 GitHub Git Data API 推送',
    '  --store-credentials    把 token 存进 .secrets/.git-credentials，方便之后 git push'
  ].join('\n');
}

// ---------- 日志 ----------

const log = {
  step: (n, msg) => console.log('\n[' + n + '] ' + msg),
  ok: (msg) => console.log('    ✓ ' + msg),
  info: (msg) => console.log('    · ' + msg),
  warn: (msg) => console.log('    ! ' + msg)
};

function fail(msg) {
  console.error('\n✗ ' + msg);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const mask = (t) => (t ? t.slice(0, 4) + '…' + t.slice(-4) + ' (' + t.length + ' chars)' : '(none)');

// ---------- HTTP ----------

async function request(url, { token, method = 'GET', body, headers = {}, accept = 'application/json' } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: accept,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      'Content-Type': 'application/json',
      'User-Agent': 'github-vercel-link-provisioner',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, ok: res.ok, json, text };
}

class ApiError extends Error {
  constructor(service, status, detail) {
    super(service + ' API 失败 (HTTP ' + status + '): ' + detail);
    this.service = service;
    this.status = status;
    this.detail = detail;
  }
}

async function gh(token, endpoint, options = {}) {
  const r = await request(GH + endpoint, {
    token,
    ...options,
    accept: 'application/vnd.github+json',
    headers: { 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) }
  });
  if (!r.ok) {
    const detail = r.json?.message || r.text.slice(0, 300);
    throw new ApiError('GitHub', r.status, detail + (r.json?.errors ? ' ' + JSON.stringify(r.json.errors) : ''));
  }
  return r.json;
}

let TEAM_ID = null;

async function vercel(token, endpoint, options = {}) {
  let url = VERCEL + endpoint;
  if (TEAM_ID) url += (url.includes('?') ? '&' : '?') + 'teamId=' + encodeURIComponent(TEAM_ID);
  const r = await request(url, { token, ...options });
  if (!r.ok) {
    const err = r.json?.error || {};
    const detail = [err.code, err.message || r.text.slice(0, 300)].filter(Boolean).join(' — ');
    const e = new ApiError('Vercel', r.status, detail);
    e.code = err.code;
    throw e;
  }
  return r.json;
}

// ---------- token ----------

async function loadTokens(opts) {
  const file = opts.tokensFile || process.env.TOKENS_FILE;
  let githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  let vercelToken = process.env.VERCEL_TOKEN;

  if (file) {
    const abs = path.resolve(ROOT, file);
    let raw;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch {
      fail('读不到 token 文件: ' + abs);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('token 文件不是合法 JSON: ' + abs);
    }
    githubToken ||= parsed.githubToken || parsed.github || parsed.ghToken;
    vercelToken ||= parsed.vercelToken || parsed.vercel;
  }

  if (!githubToken) fail('缺少 GitHub token（--tokens-file 里的 githubToken 或 GH_TOKEN）');
  if (!vercelToken) fail('缺少 Vercel token（--tokens-file 里的 vercelToken 或 VERCEL_TOKEN）');
  return { githubToken: githubToken.trim(), vercelToken: vercelToken.trim() };
}

// ---------- git ----------

function findGit() {
  const local = path.join(ROOT, '.tools', 'git', 'cmd', 'git.exe');
  if (existsSync(local)) return local;
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? 'git' : null;
}

// 注意：本机沙箱不允许子进程通过管道(stdio pipe)回传输出（会 EPERM），
// 所以这里把 stdout/stderr 重定向到文件描述符再读取。
function gitRun(git, args, { env = {}, allowFail = false } = {}) {
  const cacheDir = path.join(ROOT, '.tools', 'cache');
  fsSync.mkdirSync(cacheDir, { recursive: true });
  const logFile = path.join(cacheDir, 'git-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + '.log');
  const fd = fsSync.openSync(logFile, 'w');
  let r;
  try {
    r = spawnSync(git, args, {
      cwd: ROOT,
      timeout: 180000,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd]
    });
  } finally {
    fsSync.closeSync(fd);
  }
  let out = '';
  try {
    out = fsSync.readFileSync(logFile, 'utf8').trim();
  } catch {
    /* 忽略 */
  }
  try {
    fsSync.unlinkSync(logFile);
  } catch {
    /* 忽略 */
  }
  const why = r.error ? r.error.message : '退出码 ' + r.status;
  if (r.status !== 0 && !allowFail) throw new Error('git ' + args[0] + ' 失败: ' + (out || why));
  return { status: r.status, out, why };
}

async function pushWithGit({ git, token, owner, repo, author, message, force, storeCredentials }) {
  if (!existsSync(path.join(ROOT, '.git'))) {
    gitRun(git, ['init', '-b', 'main']);
    log.info('已初始化本地 git 仓库（.git）');
  }
  gitRun(git, ['config', 'user.name', author.name]);
  gitRun(git, ['config', 'user.email', author.email]);
  gitRun(git, ['config', 'core.autocrlf', 'false']);

  const remoteUrl = 'https://github.com/' + owner + '/' + repo + '.git';
  const remotes = gitRun(git, ['remote'], { allowFail: true }).out.split(/\s+/).filter(Boolean);
  if (remotes.includes('origin')) gitRun(git, ['remote', 'set-url', 'origin', remoteUrl]);
  else gitRun(git, ['remote', 'add', 'origin', remoteUrl]);
  log.info('远端: ' + remoteUrl);

  if (storeCredentials) {
    // 只影响本仓库；token 存在 workspace 内且被 .gitignore 忽略
    const credFile = path.join(ROOT, '.secrets', '.git-credentials');
    await fs.mkdir(path.join(ROOT, '.secrets'), { recursive: true });
    await fs.writeFile(credFile, 'https://x-access-token:' + token + '@github.com\n', { encoding: 'utf8', mode: 0o600 });
    const rel = path.relative(ROOT, credFile).replace(/\\/g, '/');
    gitRun(git, ['config', 'credential.helper', 'store --file=' + rel]);
    log.info('凭据已存: ' + rel + '（之后 git push 无需再输 token）');
  }

  gitRun(git, ['add', '-A']);
  const staged = gitRun(git, ['diff', '--cached', '--name-only']).out;
  const hasHead = gitRun(git, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).status === 0;
  if (!hasHead) {
    gitRun(git, ['commit', '-m', message]);
    log.ok('已创建首个提交');
  } else if (staged) {
    gitRun(git, ['commit', '-m', message]);
    log.ok('已创建新提交');
  } else {
    log.info('工作区无改动，复用已有提交');
  }
  if (staged) log.info('改动文件: ' + staged.split('\n').filter(Boolean).join(', '));

  const headSha = gitRun(git, ['rev-parse', 'HEAD']).out.trim();
  const auth = 'AUTHORIZATION: basic ' + b64('x-access-token:' + token);
  const pushEnv = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: auth
  };

  const remoteHeads = gitRun(git, ['ls-remote', '--heads', 'origin', 'main'], { env: pushEnv }).out;
  if (!remoteHeads) {
    log.info('远端为空 → 首次推送 main');
    gitRun(git, ['push', '-u', 'origin', 'main'], { env: pushEnv });
  } else {
    log.info('远端已有 main，检查是否需要同步');
    gitRun(git, ['fetch', 'origin', 'main'], { env: pushEnv });
    const base = gitRun(git, ['merge-base', 'HEAD', 'origin/main'], { allowFail: true });
    if (base.status === 0) {
      const ahead = gitRun(git, ['rev-list', '--count', 'origin/main..HEAD']).out.trim();
      if (ahead === '0') {
        log.info('远端已是最新，无需推送');
      } else {
        log.info('本地领先远端 ' + ahead + ' 个提交 → 推送');
        gitRun(git, ['push', 'origin', 'main'], { env: pushEnv });
      }
    } else if (force) {
      log.warn('本地与远端历史分叉 → --force-with-lease 覆盖');
      gitRun(git, ['push', '--force-with-lease', 'origin', 'main'], { env: pushEnv });
    } else {
      throw new Error('本地与远端历史分叉，已停止。加 --force 可强制覆盖远端。');
    }
  }

  const pushed = gitRun(git, ['rev-parse', 'HEAD']).out.trim();
  log.ok('推送完成 ' + pushed.slice(0, 7) + ' → origin/main');
  return pushed;
}

// API 兜底：用 Git Data API 提交（无需本机 git）
async function collectFiles() {
  const entries = [];
  for (const rel of API_FILES) {
    const abs = path.join(ROOT, rel);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      entries.push({ path: rel, buf: await fs.readFile(abs) });
    } catch {
      log.warn('跳过不存在的文件: ' + rel);
    }
  }
  if (!entries.length) fail('没有任何可提交的文件');
  return entries;
}

async function pushWithApi({ token, owner, repo, message, author }) {
  const files = await collectFiles();
  // 空仓库时 GitHub 返回 404 或 409("Git Repository is empty")，都视为没有父提交
  let parentRef = null;
  try {
    parentRef = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/main`);
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
  }
  const parent = parentRef?.object?.sha || null;

  const tree = [];
  for (const f of files) {
    const blob = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: { content: b64(f.buf.toString('utf8')), encoding: 'base64' }
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    log.info('blob ' + f.path + ' → ' + blob.sha.slice(0, 7));
  }

  const treeBody = { tree };
  if (parent) {
    const pc = await gh(token, `/repos/${owner}/${repo}/git/commits/${parent}`);
    treeBody.base_tree = pc.tree.sha;
  }
  const t = await gh(token, `/repos/${owner}/${repo}/git/trees`, { method: 'POST', body: treeBody });
  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: t.sha, author, committer: author, ...(parent ? { parents: [parent] } : {}) }
  });

  if (parent) {
    await gh(token, `/repos/${owner}/${repo}/git/refs/heads/main`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: true }
    });
  } else {
    await gh(token, `/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/main', sha: commit.sha }
    });
  }
  log.ok('API 推送完成 ' + commit.sha.slice(0, 7) + '（' + files.length + ' 个文件）');
  return commit.sha;
}

// ---------- GitHub ----------

async function ensureRepo(token, owner, opts) {
  try {
    const repo = await gh(token, '/repos/' + owner + '/' + opts.repo);
    log.ok('仓库已存在，复用: ' + repo.full_name);
    return repo;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const payload = {
    name: opts.repo,
    description: 'GitHub push -> Vercel auto deploy demo',
    private: opts.private,
    auto_init: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false
  };
  const endpoint = opts.org ? '/orgs/' + opts.org + '/repos' : '/user/repos';
  const repo = await gh(token, endpoint, { method: 'POST', body: payload });
  log.ok('已创建仓库: ' + repo.html_url + ' (' + (repo.private ? 'private' : 'public') + ')');
  return repo;
}

async function setDefaultBranch(token, owner, repo) {
  try {
    await gh(token, `/repos/${owner}/${repo}`, { method: 'PATCH', body: { default_branch: 'main' } });
  } catch (e) {
    log.warn('设置默认分支失败（通常不影响部署）: ' + e.message);
  }
}

// ---------- Vercel ----------

async function findProject(token, name) {
  try {
    return await vercel(token, '/v9/projects/' + encodeURIComponent(name));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function ensureVercelProject(token, name, owner, repo) {
  const existing = await findProject(token, name);
  if (existing) {
    const link = existing.link || {};
    if (link.type === 'github' && link.repo === owner + '/' + repo) {
      log.ok('Vercel 项目已存在且已绑定 GitHub: ' + existing.name);
      return existing;
    }
    log.info('Vercel 项目已存在 (' + existing.name + ')，尝试绑定 GitHub 仓库…');
    try {
      const linked = await vercel(token, '/v9/projects/' + existing.id + '/link', {
        method: 'POST',
        body: { type: 'github', repo: owner + '/' + repo }
      });
      log.ok('已绑定 ' + owner + '/' + repo);
      return { ...existing, ...(linked.project || linked) };
    } catch (e) {
      handleGitHubIntegrationError(e);
    }
  }

  try {
    const project = await vercel(token, '/v11/projects', {
      method: 'POST',
      body: { name, gitRepository: { type: 'github', repo: owner + '/' + repo } }
    });
    log.ok('已创建 Vercel 项目: ' + project.name + '（绑定 ' + owner + '/' + repo + '）');
    return project;
  } catch (e) {
    handleGitHubIntegrationError(e);
  }
}

function handleGitHubIntegrationError(e) {
  const msg = (e.detail || '') + ' ' + (e.code || '');
  const isIntegration = /integration|installation|not connected|git_repository_not_found|not found|forbidden|unauthorized/i.test(msg);
  if (isIntegration) {
    console.error('');
    console.error('✗ Vercel 访问不到这个 GitHub 仓库：Vercel 的 GitHub App 还没授权你的账号。');
    console.error('  一次性授权步骤（约 1 分钟）：');
    console.error('    1) 打开 https://github.com/apps/vercel/installations/new');
    console.error('    2) 选择账号 → 仓库范围选 All repositories（或勾选该仓库）→ Install');
    console.error('    3) 打开 https://vercel.com/account/integrations 确认 GitHub 显示已连接');
    console.error('    4) 重新运行本脚本');
    console.error('');
    console.error('  原始错误: ' + e.message);
    process.exit(2);
  }
  throw e;
}

async function triggerDeployment(token, projectId, projectName, repoId, sha) {
  log.info('未检测到部署，主动用 gitSource 触发一次…');
  try {
    const dep = await vercel(token, '/v13/deployments', {
      method: 'POST',
      body: {
        name: projectName,
        project: projectId,
        target: 'production',
        gitSource: { type: 'github', ref: 'main', sha, repoId: String(repoId) }
      }
    });
    log.ok('已触发部署: ' + (dep.url || dep.id));
    return dep;
  } catch (e) {
    log.warn('主动触发失败: ' + e.message);
    return null;
  }
}

async function waitForDeployment(token, projectId, commitSha, projectName, repoId) {
  const deadline = Date.now() + 300000;
  let last = '';
  let triggered = false;
  let waited = 0;
  while (Date.now() < deadline) {
    const list = await vercel(token, '/v6/deployments?projectId=' + projectId + '&limit=10');
    const deps = list.deployments || [];
    const dep = deps.find((d) => d.meta?.githubCommitSha === commitSha) || null;
    if (dep) {
      if (dep.readyState !== last) {
        last = dep.readyState;
        log.info('部署状态: ' + dep.readyState + (dep.url ? '  https://' + dep.url : ''));
      }
      if (dep.readyState === 'READY') return dep;
      if (dep.readyState === 'ERROR' || dep.readyState === 'CANCELED') {
        fail('Vercel 部署失败 (' + dep.readyState + ')，构建日志: ' + (dep.inspectorUrl || 'https://vercel.com/' + projectName));
      }
    } else if (!triggered && waited > 40000) {
      triggered = true;
      await triggerDeployment(token, projectId, projectName, repoId, commitSha);
    }
    await sleep(4000);
    waited += 4000;
  }
  fail('等待部署超时（5 分钟）。可到 Vercel 面板查看，或重跑本脚本查询状态。');
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  TEAM_ID = opts.team || process.env.VERCEL_TEAM_ID || null;
  const git = opts.apiPush ? null : findGit();

  console.log('=== GitHub → Vercel 打通 ===');
  console.log('仓库: ' + (opts.org ? opts.org + '/' : '') + opts.repo +
    '  |  项目: ' + opts.project + '  |  ' + (opts.private ? 'private' : 'public') +
    (TEAM_ID ? '  |  teamId ' + TEAM_ID : '') +
    '  |  推送方式: ' + (git ? 'git' : 'API'));

  log.step(1, '校验 token');
  const { githubToken, vercelToken } = await loadTokens(opts);
  log.info('GitHub token: ' + mask(githubToken));
  log.info('Vercel token: ' + mask(vercelToken));

  let ghUser;
  try {
    ghUser = await gh(githubToken, '/user');
  } catch (e) {
    if (e.status === 401) fail('GitHub token 无效或已过期（401）。请重新生成 token。');
    throw e;
  }
  log.ok('GitHub: ' + ghUser.login + (ghUser.name ? ' (' + ghUser.name + ')' : ''));

  let vUser;
  try {
    vUser = await vercel(vercelToken, '/v2/user');
  } catch (e) {
    if (e.status === 401 || e.status === 403) fail('Vercel token 无效或权限不足（' + e.status + '）。');
    throw e;
  }
  log.ok('Vercel: ' + (vUser.user?.username || vUser.user?.email || vUser.user?.id));

  const author = {
    name: ghUser.name || ghUser.login,
    email: ghUser.email || ghUser.id + '+' + ghUser.login + '@users.noreply.github.com'
  };
  const owner = opts.org || ghUser.login;

  log.step(2, '准备 GitHub 仓库');
  const repo = await ensureRepo(githubToken, owner, opts);

  log.step(3, '提交并推送代码');
  let commitSha;
  if (git) {
    try {
      commitSha = await pushWithGit({
        git, token: githubToken, owner, repo: repo.name, author,
        message: opts.message, force: opts.force, storeCredentials: opts.storeCredentials
      });
    } catch (e) {
      log.warn('git 推送失败，回退到 API 推送: ' + e.message);
      commitSha = await pushWithApi({ token: githubToken, owner, repo: repo.name, message: opts.message, author });
    }
  } else {
    log.info('未找到 git，使用 GitHub Git Data API 推送');
    commitSha = await pushWithApi({ token: githubToken, owner, repo: repo.name, message: opts.message, author });
  }
  await setDefaultBranch(githubToken, owner, repo.name);

  log.step(4, '创建 Vercel 项目并绑定 GitHub 仓库');
  const project = await ensureVercelProject(vercelToken, opts.project, owner, repo.name);

  log.step(5, '等待 GitHub 提交触发的部署');
  const dep = await waitForDeployment(vercelToken, project.id, commitSha, project.name, repo.id);

  let domains = [];
  try {
    const r = await vercel(vercelToken, '/v9/projects/' + project.id + '/domains');
    domains = (r.domains || []).filter((d) => d.verified !== false).map((d) => d.name);
  } catch {
    /* 用默认域名 */
  }
  const prodHost = project.alias?.[0] || domains[0] || project.name + '.vercel.app';
  const prodUrl = 'https://' + prodHost;

  log.step(6, '验证线上访问');
  let hello = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const r = await request(prodUrl + '/api/hello');
      if (r.ok && r.json?.ok) {
        hello = r.json;
        break;
      }
    } catch {
      /* 域名还在生效 */
    }
    await sleep(3000);
  }
  if (hello) {
    log.ok('/api/hello: gitRepo=' + hello.gitRepo + ' ref=' + hello.gitRef + ' sha=' + hello.gitSha + ' env=' + hello.env);
    if (hello.gitSha && hello.gitSha !== commitSha.slice(0, 7)) {
      log.warn('线上 sha(' + hello.gitSha + ') 与本地提交(' + commitSha.slice(0, 7) + ') 不一致，可能命中了旧部署');
    }
  } else {
    log.warn('/api/hello 暂未返回 200，但部署已是 READY，稍后刷新页面即可。');
  }

  const result = {
    githubUser: ghUser.login,
    repo: repo.full_name,
    repoUrl: repo.html_url,
    branch: 'main',
    commit: commitSha,
    commitShort: commitSha.slice(0, 7),
    pushMethod: git ? 'git' : 'api',
    project: project.name,
    projectId: project.id,
    productionUrl: prodUrl,
    deploymentUrl: dep.url ? 'https://' + dep.url : null,
    deploymentId: dep.uid || dep.id || null,
    deploymentState: dep.readyState,
    hello,
    checkedAt: new Date().toISOString()
  };

  const outFile = path.join(ROOT, '.provision-result.json');
  await fs.writeFile(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log('\n=== 完成 ===');
  console.log('GitHub 仓库   : ' + result.repoUrl);
  console.log('提交          : ' + result.commitShort + ' @ main (' + result.pushMethod + ' push)');
  console.log('Vercel 项目   : ' + project.name + '  (id ' + project.id + ')');
  console.log('生产地址      : ' + prodUrl);
  console.log('部署状态      : ' + dep.readyState);
  console.log('结果文件      : ' + outFile);
  console.log('\n之后每次 push 到 main，Vercel 都会自动重新部署。');
}

main().catch((e) => {
  if (e instanceof ApiError) fail(e.message);
  fail(e.stack || e.message);
});
