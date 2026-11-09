#!/usr/bin/env node
// 用 Cloudflare API 把 GitHub 仓库接成 Pages 项目（push 自动部署），并等待/验证首次部署。
// 用法:
//   node scripts/cloudflare-pages.mjs [--tokens-file .secrets/tokens.json] \
//     [--project github-vercel-link] [--repo wanshushu2023-maker/github-vercel-link] \
//     [--branch main] [--account <账号 id 或名称>]
//
// token 文件: { "cloudflareToken": "..." }（也支持环境变量 CLOUDFLARE_API_TOKEN）
// token 需要权限: Account → Cloudflare Pages → Edit（建议再加 Account Settings → Read）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CF = 'https://api.cloudflare.com/client/v4';

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CfError extends Error {
  constructor(status, errors) {
    const first = (errors && errors[0]) || {};
    super('Cloudflare API 失败 (HTTP ' + status + '): ' + (first.message || JSON.stringify(errors)));
    this.status = status;
    this.code = first.code;
    this.messageText = first.message || '';
  }
}

async function cf(token, endpoint, options = {}) {
  const res = await fetch(CF + endpoint, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-cloudflare-pages'
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  if (!res.ok || !json || json.success === false) {
    throw new CfError(res.status, json?.errors || [{ message: text.slice(0, 300) }]);
  }
  return json.result;
}

async function loadToken() {
  const fileArg = argOf('--tokens-file');
  const file = path.resolve(ROOT, fileArg || '.secrets/tokens.json');
  let token = process.env.CLOUDFLARE_API_TOKEN;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    token ||= parsed.cloudflareToken || parsed.cloudflare || parsed.cfToken;
  } catch {
    /* 文件不存在时只靠环境变量 */
  }
  if (!token) fail('缺少 Cloudflare API token（--tokens-file 里的 cloudflareToken 或 CLOUDFLARE_API_TOKEN）');
  return token.trim();
}

async function localHead() {
  try {
    const head = (await fs.readFile(path.join(ROOT, '.git', 'HEAD'), 'utf8')).trim();
    if (head.startsWith('ref: ')) {
      return (await fs.readFile(path.join(ROOT, '.git', head.slice(5).trim()), 'utf8')).trim();
    }
    return head;
  } catch {
    return null;
  }
}

function stageOf(dep) {
  return dep?.latest_stage?.status || dep?.latest_stage?.name || dep?.status || 'unknown';
}

function summarize(dep) {
  const m = dep?.deployment_trigger?.metadata || {};
  return [
    'id=' + (dep?.id || '?'),
    'state=' + stageOf(dep),
    'branch=' + (m.branch || '-'),
    'sha=' + (m.commit_hash || '').slice(0, 7)
  ].join('  ');
}

async function waitDeployment(token, accountId, project, branch, expectedSha) {
  const deadline = Date.now() + 300000;
  let last = '';
  let seen = null;
  while (Date.now() < deadline) {
    let deps = [];
    try {
      deps = await cf(
        token,
        '/accounts/' + accountId + '/pages/projects/' + project + '/deployments?per_page=10'
      );
    } catch (e) {
      log.warn('查部署列表失败: ' + e.message);
    }
    const mine =
      deps.find((d) => {
        const m = d.deployment_trigger?.metadata || {};
        return m.branch === branch && (!m.commit_hash || !expectedSha || m.commit_hash.startsWith(expectedSha.slice(0, 7)));
      }) || deps.find((d) => (d.deployment_trigger?.metadata || {}).branch === branch) || deps[0] || null;

    if (mine) {
      seen = mine;
      const st = stageOf(mine);
      if (st !== last) {
        last = st;
        log.info('部署状态: ' + summarize(mine) + (mine.url ? '  ' + mine.url : ''));
      }
      if (st === 'success') return mine;
      if (st === 'failure' || st === 'canceled') {
        fail('Cloudflare Pages 部署失败 (' + st + ')，到后台看构建日志: https://dash.cloudflare.com/' + accountId + '/pages/view/' + project);
      }
    } else {
      log.info('等待首次部署出现…');
    }
    await sleep(5000);
  }
  fail('等待部署超时（5 分钟）。可到后台查看: https://dash.cloudflare.com/' + accountId + '/pages/view/' + project);
}

async function main() {
  const project = argOf('--project') || 'github-vercel-link';
  const repoArg = argOf('--repo') || 'wanshushu2023-maker/github-vercel-link';
  const [owner, repo] = repoArg.split('/');
  const branch = argOf('--branch') || 'main';
  if (!owner || !repo) fail('--repo 需要 owner/repo 格式');
  const accountWanted = argOf('--account') || process.env.CLOUDFLARE_ACCOUNT_ID || null;

  console.log('=== GitHub → Cloudflare Pages ===');
  console.log('仓库: ' + owner + '/' + repo + '  |  项目: ' + project + '  |  分支: ' + branch);

  log.step(1, '校验 Cloudflare token');
  const token = await loadToken();
  let verify;
  try {
    verify = await cf(token, '/user/tokens/verify');
  } catch (e) {
    fail('token 无效: ' + e.message);
  }
  log.ok('token 状态: ' + (verify?.status || 'active'));

  log.step(2, '选择 Cloudflare 账号');
  const accounts = await cf(token, '/accounts?per_page=50');
  if (!accounts.length) fail('这个 token 看不到任何账号（权限不足？需要 Account Settings: Read 或 Pages: Edit）');
  let account;
  if (accountWanted) {
    account = accounts.find((a) => a.id === accountWanted || a.name === accountWanted);
    if (!account) fail('找不到账号 ' + accountWanted + '；可见账号: ' + accounts.map((a) => a.name + '(' + a.id + ')').join(', '));
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    fail('有多个账号，请用 --account 指定: ' + accounts.map((a) => a.name + '(' + a.id + ')').join(', '));
  }
  log.ok('账号: ' + account.name + '  ' + account.id);

  log.step(3, '创建 Pages 项目并绑定 GitHub 仓库');
  let proj = null;
  try {
    proj = await cf(token, '/accounts/' + account.id + '/pages/projects/' + project);
    log.ok('项目已存在: ' + proj.name + '  (' + (proj.subdomain ? proj.subdomain : project + '.pages.dev') + ')');
    const src = proj.source || {};
    if (src.type !== 'github') {
      log.warn('现有项目 source=' + (src.type || 'none') + '，不是 GitHub 自动部署；如需重建请到后台删除项目。');
    } else {
      log.info('当前绑定: ' + src.config?.owner + '/' + src.config?.repo_name + ' @ ' + src.config?.production_branch);
    }
  } catch (e) {
    if (e.status !== 404) throw e;
    try {
      proj = await cf(token, '/accounts/' + account.id + '/pages/projects', {
        method: 'POST',
        body: {
          name: project,
          production_branch: branch,
          source: {
            type: 'github',
            config: {
              owner,
              repo_name: repo,
              production_branch: branch,
              deployments_enabled: true,
              production_deployments_enabled: true,
              pr_comments_enabled: false,
              preview_deployment_setting: 'all',
              preview_branch_includes: ['*'],
              preview_branch_excludes: []
            }
          },
          build_config: { build_command: '', destination_root: '', destination_dir: '', root_dir: '' }
        }
      });
      log.ok('已创建 Pages 项目: ' + proj.name);
    } catch (createErr) {
      if (/git|github|install|authoriz/i.test(createErr.messageText || createErr.message)) {
        console.error('');
        console.error('✗ Cloudflare 访问不到这个 GitHub 仓库：需要在 GitHub 上安装 / 授权 Cloudflare Pages 的 GitHub App。');
        console.error('  一次性授权（约 1 分钟）：');
        console.error('    1) 打开 https://github.com/apps/cloudflare-pages/installations/new');
        console.error('    2) 选择账号 wanshushu2023-maker → 仓库范围勾选 ' + owner + '/' + repo + '（或 All repositories）→ Install');
        console.error('    3) 回到 Cloudflare 后台 https://dash.cloudflare.com/?to=/:account/pages 确认可见该仓库');
        console.error('    4) 重新运行本脚本');
        console.error('');
        console.error('  原始错误: ' + createErr.message);
        process.exit(2);
      }
      throw createErr;
    }
  }

  log.step(4, '等待首次部署（由 GitHub 仓库触发）');
  const dep = await waitDeployment(token, account.id, project, branch, await localHead());

  const pagesHost = proj?.subdomain || project + '.pages.dev';
  const pagesUrl = 'https://' + pagesHost;
  log.info('生产域名: ' + pagesUrl);

  log.step(5, '验证线上函数');
  let hello = null;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(pagesUrl + '/api/hello', { headers: { 'Cache-Control': 'no-cache' } });
      const j = await r.json();
      if (r.ok && j.ok) {
        hello = j;
        break;
      }
      log.info('等待 Functions 生效… HTTP ' + r.status);
    } catch (e) {
      log.info('等待域名生效… ' + e.message);
    }
    await sleep(4000);
  }
  if (hello) {
    log.ok('/api/hello: host=' + hello.host + ' sha=' + hello.gitSha + ' ref=' + hello.gitRef);
  } else {
    log.warn('/api/hello 还没 200；静态页可能已可访问，Functions 绑定稍后再试。');
  }

  const result = {
    account: { id: account.id, name: account.name },
    project: project,
    pagesHost,
    pagesUrl,
    deploymentId: dep?.id || null,
    deploymentState: stageOf(dep),
    deploymentAlias: dep?.url || null,
    branch,
    repo: owner + '/' + repo,
    hello,
    checkedAt: new Date().toISOString()
  };
  const outFile = path.join(ROOT, '.cloudflare-result.json');
  await fs.writeFile(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log('\n=== 完成 ===');
  console.log('Pages 项目 : ' + project + '（账号 ' + account.name + '）');
  console.log('线上地址   : ' + pagesUrl);
  console.log('部署       : ' + summarize(dep));
  console.log('结果文件   : ' + outFile);
  console.log('\n之后每次 push 到 ' + branch + '，Cloudflare Pages 都会自动重建。');
}

main().catch((e) => {
  if (e instanceof CfError) fail(e.message);
  fail(e.stack || e.message);
});
