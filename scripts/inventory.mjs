#!/usr/bin/env node
// 资产清单：列出你账号下的域名、站点（Vercel 项目 / Cloudflare Pages 项目 / GitHub 仓库）
// 用法: node scripts/inventory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, '.secrets/tokens.json'), 'utf8'));

const C = {
  ok: (s) => '\x1b[32m' + s + '\x1b[0m',
  bad: (s) => '\x1b[31m' + s + '\x1b[0m',
  dim: (s) => '\x1b[90m' + s + '\x1b[0m',
  bold: (s) => '\x1b[1m' + s + '\x1b[0m'
};
const section = (t) => console.log('\n' + C.bold('◆ ' + t));

async function api(url, headers) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'dsh-inventory', ...headers },
    signal: AbortSignal.timeout(30000)
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: r.status, ok: r.ok, json, text };
}

const out = { vercel: { projects: [], domains: [] }, cloudflare: { pages: [], zones: null, zonesError: null }, github: { repos: [] } };

// ---------- Vercel ----------
async function vercel() {
  const h = { Authorization: 'Bearer ' + tokens.vercelToken };
  section('Vercel');

  const p = await api('https://api.vercel.com/v9/projects?limit=100', h);
  const projects = p.json?.projects || [];
  if (!p.ok) {
    console.log('  ' + C.bad('项目列表失败 HTTP ' + p.status));
  } else {
    console.log('  项目数: ' + projects.length);
    for (const proj of projects) {
      const dep = proj.latestDeployments?.[0];
      let domains = [];
      try {
        const d = await api('https://api.vercel.com/v9/projects/' + proj.id + '/domains', h);
        domains = (d.json?.domains || []).map((x) => x.name);
      } catch {
        /* ignore */
      }
      const rec = {
        name: proj.name,
        id: proj.id,
        framework: proj.framework || 'static/other',
        repo: proj.link ? proj.link.org + '/' + proj.link.repo : null,
        productionUrl: proj.alias?.[0] || domains[0] || proj.name + '.vercel.app',
        domains,
        latestDeployment: dep ? { url: 'https://' + dep.url, state: dep.readyState, sha: (dep.meta?.githubCommitSha || '').slice(0, 7) } : null,
        createdAt: proj.createdAt
      };
      out.vercel.projects.push(rec);
      console.log('  · ' + C.bold(proj.name).padEnd(30) + C.dim((proj.framework || 'static').padEnd(12)) +
        (dep ? dep.readyState : 'no-deploy') + '  https://' + (proj.alias?.[0] || proj.name + '.vercel.app'));
      if (rec.repo) console.log('      git: ' + rec.repo);
      if (domains.length) console.log('      自定义域名: ' + domains.join(', '));
    }
  }

  // 账号下的域名（Vercel 注册/转移的域名）
  const d = await api('https://api.vercel.com/v5/domains?limit=100', h);
  if (d.ok) {
    const domains = d.json?.domains || [];
    out.vercel.domains = domains;
    console.log('\n  账号域名数: ' + domains.length);
    for (const dom of domains) {
      console.log('  · ' + dom.name + C.dim('  verified=' + dom.verified + '  projectId=' + (dom.projectId || '-')));
    }
  } else {
    console.log('  ' + C.bad('域名列表失败 HTTP ' + d.status + ' ' + (d.json?.error?.message || '')));
  }
}

// ---------- Cloudflare ----------
async function cloudflare() {
  const h = { Authorization: 'Bearer ' + tokens.cloudflareToken };
  section('Cloudflare');

  const acc = await api('https://api.cloudflare.com/client/v4/accounts?per_page=50', h);
  const account = (acc.json?.result || [])[0];
  if (!account) {
    console.log('  ' + C.bad('拿不到账号'));
    return;
  }
  console.log('  账号: ' + account.name + C.dim('  ' + account.id));

  // 域名（需要 Zone:Read 权限）
  const z = await api('https://api.cloudflare.com/client/v4/zones?per_page=50', h);
  if (z.ok) {
    const zones = z.json?.result || [];
    out.cloudflare.zones = zones.map((x) => ({ name: x.name, status: x.status, plan: x.plan?.name, accountName: x.account?.name }));
    console.log('\n  域名（Zone）数: ' + zones.length);
    for (const zone of zones) {
      console.log('  · ' + C.bold(zone.name).padEnd(32) + C.dim(zone.status + ' · ' + (zone.plan?.name || '')));
    }
  } else {
    out.cloudflare.zonesError = { status: z.status, message: z.json?.errors?.[0]?.message };
    console.log('\n  ' + C.bad('域名列表失败 HTTP ' + z.status + ' — ' + (z.json?.errors?.[0]?.message || '')));
    console.log('  ' + C.dim('原因：当前 token 只有 Pages:Edit + Account Settings:Read，缺 Zone:Read'));
  }

  // Pages 项目
  const p = await api('https://api.cloudflare.com/client/v4/accounts/' + account.id + '/pages/projects', h);
  const pages = p.json?.result || [];
  if (p.ok) {
    console.log('\n  Pages 项目数: ' + pages.length);
    for (const proj of pages) {
      const dep = proj.latest_deployment;
      out.cloudflare.pages.push({
        name: proj.name,
        subdomain: proj.subdomain,
        domains: proj.domains,
        source: proj.source ? proj.source.type + (proj.source.config ? ':' + proj.source.config.owner + '/' + proj.source.config.repo_name : '') : null,
        latestDeployment: dep ? { id: dep.id, state: dep.latest_stage?.status, url: dep.url, sha: (dep.deployment_trigger?.metadata?.commit_hash || '').slice(0, 7) } : null,
        createdAt: proj.created_on
      });
      console.log('  · ' + C.bold(proj.name).padEnd(28) + C.dim((proj.subdomain || '').padEnd(38)) + (dep?.latest_stage?.status || 'no-deploy'));
      if (proj.domains?.length > 1) console.log('      域名: ' + proj.domains.join(', '));
    }
  } else {
    console.log('  ' + C.bad('Pages 项目列表失败 HTTP ' + p.status));
  }
}

// ---------- GitHub ----------
async function github() {
  const h = { Authorization: 'Bearer ' + tokens.githubToken, Accept: 'application/vnd.github+json' };
  section('GitHub（最近更新的仓库）');
  const r = await api('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner', h);
  if (!r.ok) {
    console.log('  ' + C.bad('仓库列表失败 HTTP ' + r.status));
    return;
  }
  const repos = r.json || [];
  out.github.repos = repos.map((x) => ({ name: x.full_name, private: x.private, pushedAt: x.pushed_at, homepage: x.homepage || null, defaultBranch: x.default_branch }));
  console.log('  仓库数: ' + repos.length);
  for (const repo of repos.slice(0, 20)) {
    console.log('  · ' + repo.full_name.padEnd(48) + C.dim((repo.private ? 'private' : 'public').padEnd(9) + ' pushed=' + (repo.pushed_at || '').slice(0, 10)));
  }
  if (repos.length > 20) console.log('  ' + C.dim('… 还有 ' + (repos.length - 20) + ' 个'));
}

async function main() {
  console.log(C.bold('账号资产清单'));
  await vercel();
  await cloudflare();
  await github();
  fs.writeFileSync(path.join(ROOT, '.inventory.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ...out }, null, 2) + '\n');
  console.log('\n' + C.dim('完整数据已写入 .inventory.json'));
}

main().catch((e) => {
  console.error('清单脚本异常: ' + (e.stack || e.message));
  process.exit(1);
});
