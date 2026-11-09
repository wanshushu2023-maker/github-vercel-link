#!/usr/bin/env node
// 验证 GitHub → Vercel 链路：等最新部署 READY，然后检查生产页面与 /api/hello 是否是新提交
// 用法: node scripts/verify.mjs [--sha <commit>] [--marker v1.0.1]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};

const result = JSON.parse(await fs.readFile(path.join(ROOT, '.provision-result.json'), 'utf8'));
const tokens = JSON.parse(await fs.readFile(path.join(ROOT, '.secrets', 'tokens.json'), 'utf8'));
const expectSha = argOf('--sha') || result.commit;
const marker = argOf('--marker') || null;
const H = { Authorization: 'Bearer ' + tokens.vercelToken, 'User-Agent': 'dsh-verify' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

log('项目: ' + result.project + '  期望提交: ' + expectSha.slice(0, 7));

let dep = null;
const started = Date.now();
while (Date.now() - started < 180000) {
  const r = await fetch('https://api.vercel.com/v6/deployments?projectId=' + result.projectId + '&limit=5', { headers: H });
  const j = await r.json();
  const deps = j.deployments || [];
  dep = deps.find((d) => d.meta?.githubCommitSha === expectSha) || null;
  if (dep) {
    log('找到部署 ' + dep.uid + '  state=' + dep.readyState + '  sha=' + (dep.meta?.githubCommitSha || '').slice(0, 7));
    if (dep.readyState === 'READY') break;
    if (dep.readyState === 'ERROR' || dep.readyState === 'CANCELED') {
      log('部署失败: ' + dep.readyState);
      process.exit(1);
    }
  } else {
    const latest = deps[0];
    log('等待新部署…（当前最新: ' + (latest ? latest.uid + ' ' + latest.readyState + ' sha=' + (latest.meta?.githubCommitSha || '-').slice(0, 7) : '无') + '）');
  }
  await sleep(4000);
}

if (!dep || dep.readyState !== 'READY') {
  log('超时：没等到 ' + expectSha.slice(0, 7) + ' 的 READY 部署');
  process.exit(1);
}

const base = 'https://' + (result.productionUrl || '').replace(/^https?:\/\//, '');
log('\n部署 READY，检查线上内容:');
log('  deployment url : https://' + dep.url);

const helloRes = await fetch(base + '/api/hello', { headers: { 'Cache-Control': 'no-cache' } });
const hello = await helloRes.json();
log('  /api/hello     : HTTP ' + helloRes.status + '  gitSha=' + hello.gitSha + '  ref=' + hello.gitRef + '  env=' + hello.env);
const shaOk = hello.gitSha === expectSha.slice(0, 7);
log('  sha 一致       : ' + (shaOk ? '✓' : '✗ (' + hello.gitSha + ' vs ' + expectSha.slice(0, 7) + ')'));

const pageRes = await fetch(base + '/', { headers: { 'Cache-Control': 'no-cache' } });
const html = await pageRes.text();
const titleOk = html.includes('GitHub → Vercel');
const markerOk = marker ? html.includes(marker) : true;
log('  生产首页       : HTTP ' + pageRes.status + '  标题标记=' + (titleOk ? '✓' : '✗') + (marker ? '  内容标记(' + marker + ')=' + (markerOk ? '✓' : '✗') : ''));

const ok = shaOk && titleOk && markerOk;
log('\n结论: ' + (ok ? '链路已验证 ✓ push → 自动部署 → 线上内容更新' : '有检查未通过 ✗'));
process.exit(ok ? 0 : 1);
