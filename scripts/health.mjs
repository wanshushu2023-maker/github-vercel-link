#!/usr/bin/env node
// 一键体检：本机环境 + 仓库 + 三个 token + 两个平台部署 + 本地预览
// 用法: node scripts/health.mjs [--verbose]
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const C = {
  ok: (s) => '\x1b[32m' + s + '\x1b[0m',
  bad: (s) => '\x1b[31m' + s + '\x1b[0m',
  dim: (s) => '\x1b[90m' + s + '\x1b[0m',
  bold: (s) => '\x1b[1m' + s + '\x1b[0m'
};

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log('  ' + (ok ? C.ok('✓') : C.bad('✗')) + ' ' + name.padEnd(28) + C.dim(detail || ''));
}
const section = (t) => console.log('\n' + C.bold('◆ ' + t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 基础 ----------

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
  } catch {
    return fallback;
  }
}

function git(args) {
  // 用文件描述符捕获输出，避开沙箱对 stdio 管道的限制
  const local = path.join(ROOT, '.tools', 'git', 'cmd', 'git.exe');
  const bin = fs.existsSync(local) ? local : 'git';
  const cacheDir = path.join(ROOT, '.tools', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const log = path.join(cacheDir, 'health-git-' + Math.random().toString(36).slice(2, 8) + '.log');
  const fd = fs.openSync(log, 'w');
  let r;
  try {
    r = spawnSync(bin, args, { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 60000 });
  } finally {
    fs.closeSync(fd);
  }
  let out = '';
  try {
    out = fs.readFileSync(log, 'utf8').trim();
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(log);
  } catch {
    /* ignore */
  }
  return { status: r.status, out, error: r.error ? r.error.message : null };
}

async function httpJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': 'dsh-health', ...headers } });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: r.status, ok: r.ok, json, text, headers: r.headers };
}

// ---------- 各项检查 ----------

function checkGit() {
  section('本机环境');
  const v = git(['--version']);
  record('git 可用', v.status === 0 && /git version/.test(v.out), v.out || v.error || '');

  const repo = git(['rev-parse', '--is-inside-work-tree']);
  record('当前目录是 git 仓库', repo.status === 0 && repo.out === 'true');

  const head = git(['rev-parse', '--short', 'HEAD']);
  record('本地有提交', head.status === 0, head.out);
  return head.out;
}

function checkRepo(head) {
  const status = git(['status', '--porcelain']);
  const dirty = status.out.split('\n').filter((l) => l.trim() && !l.startsWith('??'));
  record('工作区干净（无未提交改动）', dirty.length === 0, dirty.length ? dirty.slice(0, 3).join(' | ') : '');

  const ahead = git(['rev-list', '--count', 'origin/main..HEAD']);
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']);
  record('与 origin/main 同步', ahead.status === 0 && ahead.out === '0' && behind.out === '0',
    'ahead=' + (ahead.out || '?') + ' behind=' + (behind.out || '?'));

  const cfg = git(['config', '--get', 'http.https://github.com/.extraheader']);
  record('push 凭据已配置', cfg.status === 0 && cfg.out.length > 0, cfg.status === 0 ? 'http.extraheader ✓' : '缺失');

  const remote = git(['remote', 'get-url', 'origin']);
  record('origin 指向正确仓库', /github-vercel-link\.git$/.test(remote.out), remote.out);
  return head;
}

async function checkTokens(tokens) {
  section('凭据');
  if (!tokens?.githubToken) record('GitHub token', false, '未配置');
  else {
    const r = await httpJson('https://api.github.com/user', {
      Authorization: 'Bearer ' + tokens.githubToken,
      Accept: 'application/vnd.github+json'
    });
    record('GitHub token', r.status === 200,
      r.status === 200 ? r.json.login + ' · scopes=' + (r.headers.get('x-oauth-scopes') || '-') : 'HTTP ' + r.status);
  }

  if (!tokens?.vercelToken) record('Vercel token', false, '未配置');
  else {
    const r = await httpJson('https://api.vercel.com/v2/user', { Authorization: 'Bearer ' + tokens.vercelToken });
    record('Vercel token', r.status === 200, r.status === 200 ? (r.json.user?.username || '') : 'HTTP ' + r.status);
  }

  if (!tokens?.cloudflareToken) record('Cloudflare token', false, '未配置');
  else {
    const r = await httpJson('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      Authorization: 'Bearer ' + tokens.cloudflareToken
    });
    const st = r.json?.result?.status;
    record('Cloudflare token', r.status === 200 && st === 'active',
      'status=' + (st || 'HTTP ' + r.status) + (r.json?.result?.expires_on ? ' · 到期 ' + r.json.result.expires_on : ''));
  }
}

async function checkVercel(tokens, head, result) {
  section('Vercel');
  if (!result?.projectId) {
    record('Vercel 项目信息', false, '缺少 .provision-result.json');
    return;
  }
  const h = { Authorization: 'Bearer ' + tokens.vercelToken };
  const d = await httpJson('https://api.vercel.com/v6/deployments?projectId=' + result.projectId + '&limit=10', h);
  const dep = (d.json?.deployments || []).find((x) => (x.meta?.githubCommitSha || '').startsWith(head));
  record('HEAD 已部署', !!dep, dep ? dep.readyState + ' · ' + dep.uid : '未找到 ' + head + ' 的部署');
  if (dep) record('部署状态 READY', dep.readyState === 'READY', dep.readyState);

  const url = result.productionUrl || 'https://github-vercel-link.vercel.app';
  const live = await httpJson(url + '/api/hello', { 'Cache-Control': 'no-cache' });
  record('线上 /api/hello', live.ok && live.json?.ok, live.json ? 'host=' + live.json.host + ' sha=' + live.json.gitSha : 'HTTP ' + live.status);
  record('线上 sha = 本地 HEAD', live.json?.gitSha === head, (live.json?.gitSha || '-') + ' vs ' + head);

  const page = await fetch(url + '/', { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.text()).catch(() => '');
  record('生产首页可访问', page.includes('id="hostTitle"'), url);
}

async function checkCloudflare(tokens, head, result) {
  section('Cloudflare Pages');
  if (!result?.pagesUrl) {
    record('Cloudflare 项目信息', false, '缺少 .cloudflare-result.json');
    return;
  }
  const acc = result.account?.id;
  const proj = result.project;
  const h = { Authorization: 'Bearer ' + tokens.cloudflareToken };
  const d = await httpJson(
    'https://api.cloudflare.com/client/v4/accounts/' + acc + '/pages/projects/' + proj + '/deployments?per_page=10',
    h
  );
  const dep = (d.json?.result || []).find((x) => (x.deployment_trigger?.metadata?.commit_hash || '').startsWith(head));
  record('HEAD 已部署', !!dep, dep ? dep.latest_stage?.status + ' · ' + dep.id.slice(0, 8) : '未找到 ' + head + ' 的部署');
  if (dep) record('部署状态 success', dep.latest_stage?.status === 'success', dep.latest_stage?.status || '?');

  const url = result.pagesUrl;
  const live = await httpJson(url + '/api/hello', { 'Cache-Control': 'no-cache' });
  record('线上 /api/hello', live.ok && live.json?.ok, live.json ? 'host=' + live.json.host + ' sha=' + live.json.gitSha : 'HTTP ' + live.status);
  record('线上 sha = 本地 HEAD', live.json?.gitSha === head, (live.json?.gitSha || '-') + ' vs ' + head);

  const page = await fetch(url + '/', { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.text()).catch(() => '');
  record('生产首页可访问', page.includes('id="hostTitle"'), url);
}

async function checkLocalPreview() {
  section('本地预览');
  const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-server.mjs'), '--port', '4399'], {
    cwd: ROOT,
    stdio: 'ignore'
  });
  try {
    let ok = false;
    let info = '';
    for (let i = 0; i < 15; i++) {
      await sleep(300);
      try {
        const r = await fetch('http://127.0.0.1:4399/api/hello');
        const j = await r.json();
        ok = r.ok && j.ok;
        info = 'host=' + (j.host || '-') + ' env=' + j.env;
        break;
      } catch {
        /* 还没起来 */
      }
    }
    record('dev-server 可启动', ok, info);
  } finally {
    server.kill();
  }
}

// ---------- main ----------

async function main() {
  console.log(C.bold('GitHub → Vercel / Cloudflare Pages 环境体检'));
  console.log(C.dim('工作区: ' + ROOT));

  const tokens = readJson('.secrets/tokens.json', {});
  const vercelResult = readJson('.provision-result.json', {});
  const cfResult = readJson('.cloudflare-result.json', {});

  const head = checkGit();
  checkRepo(head);
  await checkTokens(tokens);
  await checkVercel(tokens, head, vercelResult);
  await checkCloudflare(tokens, head, cfResult);
  await checkLocalPreview();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + C.bold('◆ 结论'));
  if (failed.length === 0) {
    console.log('  ' + C.ok('全部正常 ✓') + '  共 ' + results.length + ' 项检查通过');
    console.log('  ' + C.dim('日常使用: git add -A && git commit -m "..." && git push  → 两个平台自动上线'));
  } else {
    console.log('  ' + C.bad(failed.length + ' 项异常') + ' / 共 ' + results.length + ' 项');
    for (const f of failed) console.log('   - ' + f.name + ': ' + (f.detail || ''));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('体检脚本异常: ' + (e.stack || e.message));
  process.exit(1);
});
