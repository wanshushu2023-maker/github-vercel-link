#!/usr/bin/env node
// 校验 .secrets/tokens.json 里已填的 token（不打印 token 本身）
// 用法: node scripts/check-tokens.mjs [--tokens-file .secrets/tokens.json]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fileArg = process.argv.indexOf('--tokens-file');
const tokensFile = path.resolve(ROOT, fileArg > -1 ? process.argv[fileArg + 1] : '.secrets/tokens.json');

const info = (label, msg) => console.log('  ' + label.padEnd(12) + msg);
const mask = (t) => (t ? t.slice(0, 6) + '…' + t.slice(-4) + ' (' + t.length + ') ' : '(空)');

async function main() {
  let tokens;
  try {
    tokens = JSON.parse(await fs.readFile(tokensFile, 'utf8'));
  } catch (e) {
    console.error('读不到/解析失败: ' + tokensFile + ' → ' + e.message);
    process.exit(1);
  }

  console.log('token 文件: ' + tokensFile);
  console.log('  githubToken = ' + mask(tokens.githubToken));
  console.log('  vercelToken = ' + mask(tokens.vercelToken));

  let allOk = true;

  console.log('\n[GitHub]');
  if (!tokens.githubToken) {
    info('状态', '未填写 → 跳过');
    allOk = false;
  } else {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: 'Bearer ' + tokens.githubToken,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-token-check'
      }
    });
    if (!res.ok) {
      const body = await res.text();
      info('状态', 'HTTP ' + res.status + ' ' + body.slice(0, 160));
      allOk = false;
    } else {
      const u = await res.json();
      info('账号', u.login + (u.name ? ' (' + u.name + ')' : ''));
      info('用户 id', String(u.id));
      info('公开邮箱', u.email || '(未公开，会用 noreply 邮箱)');
      const scopes = res.headers.get('x-oauth-scopes');
      info('token 类型', res.headers.get('x-accepted-oauth-scopes') === null ? '?' : 'classic');
      info('scopes', scopes === null ? '(fine-grained token 或未返回)' : scopes || '(none)');
      const hasRepo = scopes === null || /(^|,)\s*repo\s*(,|$)/.test(scopes);
      info('可建仓库/推送', hasRepo ? '✓ 看起来可以' : '✗ 缺 repo scope');
      if (!hasRepo) allOk = false;
      // 验证能否创建仓库所需的最小权限：读取自己的仓库列表
      const rr = await fetch('https://api.github.com/user/repos?per_page=1', {
        headers: {
          Authorization: 'Bearer ' + tokens.githubToken,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'dsh-token-check'
        }
      });
      info('读取仓库权限', rr.ok ? '✓ HTTP ' + rr.status : '✗ HTTP ' + rr.status);
      if (!rr.ok) allOk = false;
    }
  }

  console.log('\n[Vercel]');
  if (!tokens.vercelToken) {
    info('状态', '未填写 → 跳过');
    allOk = false;
  } else {
    const res = await fetch('https://api.vercel.com/v2/user', {
      headers: { Authorization: 'Bearer ' + tokens.vercelToken, 'User-Agent': 'dsh-token-check' }
    });
    if (!res.ok) {
      const body = await res.text();
      info('状态', 'HTTP ' + res.status + ' ' + body.slice(0, 200));
      allOk = false;
    } else {
      const j = await res.json();
      const u = j.user || {};
      info('账号', (u.username || u.email || '?') + '  id=' + (u.id || u.uid || '?'));
      info('邮箱', u.email || '(无)');
      info('默认头像/角色', (u.name || '-') + ' / ' + (u.version || '-'));
      const teamsRes = await fetch('https://api.vercel.com/v2/teams', {
        headers: { Authorization: 'Bearer ' + tokens.vercelToken, 'User-Agent': 'dsh-token-check' }
      });
      if (teamsRes.ok) {
        const tj = await teamsRes.json();
        const teams = tj.teams || [];
        info('团队数', String(teams.length) + (teams.length ? ' → ' + teams.map((t) => t.slug + '(' + t.id + ')').join(', ') : ''));
      }
      const projRes = await fetch('https://api.vercel.com/v9/projects?limit=1', {
        headers: { Authorization: 'Bearer ' + tokens.vercelToken, 'User-Agent': 'dsh-token-check' }
      });
      info('列项目权限', projRes.ok ? '✓ HTTP ' + projRes.status : '✗ HTTP ' + projRes.status);
      if (!projRes.ok) allOk = false;
    }
  }

  console.log('\n结论: ' + (allOk ? '两个 token 都可用 ✓' : '还没齐或有问题 ✗'));
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('校验异常: ' + e.message);
  process.exit(1);
});
