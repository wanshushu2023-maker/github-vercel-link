#!/usr/bin/env node
// 强制同步部署：不管 GitHub webhook 有没有投递成功，直接把两个平台部署到当前 HEAD
// 用法: node scripts/sync-deploy.mjs [--sha <commit>] [--only vercel|cloudflare]
//
// 为什么需要它：GitHub 偶发降级（githubstatus.com 显示 Partially Degraded Service）时，
// push 的 webhook 可能丢失，两个平台都不会自动构建。这个脚本用官方 API 主动触发。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argOf = (n) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : null;
};
const only = argOf('--only');
const log = {
  step: (n, m) => console.log('\n[' + n + '] ' + m),
  ok: (m) => console.log('    ✓ ' + m),
  info: (m) => console.log('    · ' + m),
  warn: (m) => console.log('    ! ' + m)
};
const fail = (m) => {
  console.error('\n✗ ' + m);
  process.exit(1);
};

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const tokens = readJson('.secrets/tokens.json');
const vercelResult = (() => {
  try {
    return readJson('.provision-result.json');
  } catch {
    return {};
  }
})();
const cfResult = (() => {
  try {
    return readJson('.cloudflare-result.json');
  } catch {
    return {};
  }
})();

function localHead() {
  const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
  if (head.startsWith('ref: ')) return fs.readFileSync(path.join(ROOT, '.git', head.slice(5).trim()), 'utf8').trim();
  return head;
}

async function vercelApi(endpoint, options = {}) {
  const res = await fetch('https://api.vercel.com' + endpoint, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + tokens.vercelToken,
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-sync-deploy'
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error('Vercel ' + endpoint + ' HTTP ' + res.status + ': ' + (json?.error?.message || text.slice(0, 200)));
  return json;
}

async function cfApi(endpoint, options = {}) {
  const res = await fetch('https://api.cloudflare.com/client/v4' + endpoint, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + tokens.cloudflareToken,
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-sync-deploy'
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new Error('Cloudflare ' + endpoint + ' HTTP ' + res.status + ': ' + ((json?.errors || [])[0]?.message || ''));
  }
  return json.result;
}

async function syncVercel(head) {
  const projectId = vercelResult.projectId;
  if (!projectId) fail('缺少 .provision-result.json 里的 projectId');
  log.step('Vercel', '检查当前 HEAD 是否已部署');
  const list = await vercelApi('/v6/deployments?projectId=' + projectId + '&limit=10');
  let dep = (list.deployments || []).find((d) => (d.meta?.githubCommitSha || '').startsWith(head));
  if (dep && dep.readyState === 'READY') {
    log.ok('已有 READY 部署 ' + dep.uid);
    return dep;
  }
  if (dep) {
    log.info('已有部署 ' + dep.uid + '，状态 ' + dep.readyState + '，等待完成');
  } else {
    const project = await vercelApi('/v9/projects/' + projectId);
    const repoId = project.link?.repoId;
    if (!repoId) fail('项目没有绑定 GitHub 仓库（link.repoId 缺失）');
    log.info('没有 ' + head + ' 的部署 → 用 gitSource 主动触发（repoId=' + repoId + '）');
    dep = await vercelApi('/v13/deployments?skipAutoDetectionConfirmation=1', {
      method: 'POST',
      body: {
        name: project.name,
        project: projectId,
        target: 'production',
        gitSource: { type: 'github', ref: 'main', sha: head, repoId: String(repoId) }
      }
    });
    log.ok('已触发部署 ' + (dep.uid || dep.id));
  }

  const deadline = Date.now() + 300000;
  let last = '';
  while (Date.now() < deadline) {
    const l = await vercelApi('/v6/deployments?projectId=' + projectId + '&limit=10');
    const d = (l.deployments || []).find((x) => (x.meta?.githubCommitSha || '').startsWith(head));
    if (d) {
      if (d.readyState !== last) {
        last = d.readyState;
        log.info('状态: ' + d.readyState + (d.url ? '  https://' + d.url : ''));
      }
      if (d.readyState === 'READY') return d;
      if (d.readyState === 'ERROR' || d.readyState === 'CANCELED') fail('Vercel 部署失败: ' + d.readyState);
    }
    await sleep(5000);
  }
  fail('等 Vercel 部署超时');
}

async function syncCloudflare(head) {
  if (!cfResult.account?.id || !cfResult.project) fail('缺少 .cloudflare-result.json');
  const acc = cfResult.account.id;
  const proj = cfResult.project;
  log.step('Cloudflare Pages', '检查当前 HEAD 是否已部署');
  const list = await cfApi('/accounts/' + acc + '/pages/projects/' + proj + '/deployments?per_page=10');
  let dep = (list || []).find((d) => (d.deployment_trigger?.metadata?.commit_hash || '').startsWith(head));
  if (dep && dep.latest_stage?.status === 'success') {
    log.ok('已有成功部署 ' + dep.id.slice(0, 8));
    return dep;
  }
  if (dep) {
    log.info('已有部署 ' + dep.id.slice(0, 8) + '，状态 ' + dep.latest_stage?.status + '，等待完成');
  } else {
    let hooks = [];
    try {
      hooks = await cfApi('/accounts/' + acc + '/pages/projects/' + proj + '/deploy_hooks');
    } catch {
      hooks = [];
    }
    let hook = (hooks || []).find((h) => (h.branch || h.name) === 'main');
    if (!hook) {
      hook = await cfApi('/accounts/' + acc + '/pages/projects/' + proj + '/deploy_hooks', {
        method: 'POST',
        body: { branch: 'main' }
      });
      log.info('已创建 deploy hook');
    }
    const hookUrl = 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/' + hook.hook_id;
    const res = await fetch(hookUrl, { method: 'POST', headers: { 'User-Agent': 'dsh-sync-deploy' } });
    if (!res.ok) fail('deploy hook 触发失败 HTTP ' + res.status);
    log.ok('已通过 deploy hook 触发构建');
  }

  const deadline = Date.now() + 300000;
  let last = '';
  while (Date.now() < deadline) {
    const l = await cfApi('/accounts/' + acc + '/pages/projects/' + proj + '/deployments?per_page=10');
    const d = (l || []).find((x) => (x.deployment_trigger?.metadata?.commit_hash || '').startsWith(head));
    if (d) {
      const st = d.latest_stage?.status;
      if (st !== last) {
        last = st;
        log.info('状态: ' + st + (d.url ? '  ' + d.url : ''));
      }
      if (st === 'success') return d;
      if (st === 'failure' || st === 'canceled') fail('Cloudflare 部署失败: ' + st);
    }
    await sleep(5000);
  }
  fail('等 Cloudflare 部署超时');
}

async function verifyLive(label, url, head) {
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(url + '/api/hello', { headers: { 'Cache-Control': 'no-cache' } });
      const j = await r.json();
      if (r.ok && j.ok) {
        const ok = j.gitSha === head;
        console.log('    ' + (ok ? '✓' : '·') + ' ' + label + ' /api/hello host=' + j.host + ' sha=' + j.gitSha + (ok ? ' 与 HEAD 一致' : ' (期望 ' + head + ')'));
        return ok;
      }
    } catch {
      /* 等待生效 */
    }
    await sleep(4000);
  }
  console.log('    ! ' + label + ' 线上未响应');
  return false;
}

async function main() {
  const head = (argOf('--sha') || localHead()).slice(0, 7);
  console.log('=== 强制同步部署 ===');
  console.log('目标提交: ' + head + (only ? '  （只同步 ' + only + '）' : ''));

  const results = [];
  if (only !== 'cloudflare' && tokens.vercelToken) {
    const dep = await syncVercel(head);
    results.push(await verifyLive('Vercel', 'https://github-vercel-link.vercel.app', head));
    console.log('    Vercel 部署: ' + (dep.url ? 'https://' + dep.url : dep.uid));
  }
  if (only !== 'vercel' && tokens.cloudflareToken) {
    const dep = await syncCloudflare(head);
    results.push(await verifyLive('Cloudflare', cfResult.pagesUrl || 'https://github-vercel-link.pages.dev', head));
    console.log('    Cloudflare 部署: ' + dep.id);
  }

  console.log('\n=== 完成 ===');
  if (results.every(Boolean)) {
    console.log('两个平台都已对齐到 ' + head + ' ✓');
  } else {
    console.log('部分平台未对齐，请查看上面输出');
    process.exit(1);
  }
}

main().catch((e) => fail(e.stack || e.message));
