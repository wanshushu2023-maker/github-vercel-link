#!/usr/bin/env node
// 域名 & DNS 诊断：列出 Cloudflare 全部域名、DNS 记录，交叉比对 Vercel/Pages 项目，
// 找出"绑了自定义域名但解析缺失/错误"的问题，并可选修复。
// 用法:
//   node scripts/domains.mjs            # 只诊断
//   node scripts/domains.mjs --fix      # 自动补缺失的 CNAME（仅限明确缺记录的 Vercel 子域名）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, '.secrets/tokens.json'), 'utf8'));
const FIX = process.argv.includes('--fix');
const C = {
  ok: (s) => '\x1b[32m' + s + '\x1b[0m',
  bad: (s) => '\x1b[31m' + s + '\x1b[0m',
  warn: (s) => '\x1b[33m' + s + '\x1b[0m',
  dim: (s) => '\x1b[90m' + s + '\x1b[0m',
  bold: (s) => '\x1b[1m' + s + '\x1b[0m'
};
const section = (t) => console.log('\n' + C.bold('◆ ' + t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CF = 'https://api.cloudflare.com/client/v4';
const CFH = { Authorization: 'Bearer ' + tokens.cloudflareToken, 'User-Agent': 'dsh-domains' };
const VRH = { Authorization: 'Bearer ' + tokens.vercelToken, 'User-Agent': 'dsh-domains' };

async function cfGet(p) {
  const r = await fetch(CF + p, { headers: CFH, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) throw new Error('CF ' + p + ' HTTP ' + r.status + ' ' + JSON.stringify(j?.errors || '').slice(0, 120));
  return j.result;
}

async function cfWrite(method, p, body) {
  const r = await fetch(CF + p, {
    method,
    headers: { ...CFH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) throw new Error('CF ' + method + ' ' + p + ' HTTP ' + r.status + ' ' + JSON.stringify(j?.errors || '').slice(0, 200));
  return j.result;
}

async function httpStatus(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return r.status;
  } catch (e) {
    return 'FAIL(' + (e.cause?.code || e.name) + ')';
  }
}

// ---------- 收集 ----------

const zones = await cfGet('/zones?per_page=50');
section('Cloudflare 域名（Zone）: ' + zones.length);
const zoneRecords = {};
for (const z of zones) {
  const recs = await cfGet('/zones/' + z.id + '/dns_records?per_page=100');
  zoneRecords[z.name] = recs;
  console.log('  · ' + C.bold(z.name).padEnd(22) + C.dim(z.status + ' · ' + (z.plan?.name || '')) + '  DNS 记录 ' + recs.length + ' 条');
}

// Vercel 项目 → 自定义域名（同时记录每个项目的全部域名，含默认 *.vercel.app）
const vp = await (await fetch('https://api.vercel.com/v9/projects?limit=100', { headers: VRH })).json();
const vercelDomains = [];
const projDefaultDomains = [];
for (const proj of vp.projects || []) {
  const d = await (await fetch('https://api.vercel.com/v9/projects/' + proj.id + '/domains', { headers: VRH })).json();
  for (const dom of d.domains || []) {
    const name = dom.name;
    if (name.endsWith('.vercel.app')) {
      projDefaultDomains.push({ name, url: 'https://' + name });
      continue;
    }
    vercelDomains.push({ domain: name, project: proj.name, platform: 'Vercel', verified: dom.verified });
  }
}

// Cloudflare Pages 项目 → 自定义域名
const acc = (await cfGet('/accounts?per_page=50'))[0];
const pages = await cfGet('/accounts/' + acc.id + '/pages/projects');
const pagesDomains = [];
for (const p of pages) {
  for (const name of p.domains || []) {
    if (name.endsWith('.pages.dev')) continue;
    pagesDomains.push({ domain: name, project: p.name, platform: 'Cloudflare Pages' });
  }
}

// ---------- 交叉比对 ----------

function findZone(domain) {
  return zones.find((z) => domain === z.name || domain.endsWith('.' + z.name));
}

function recordsFor(domain) {
  const zone = findZone(domain);
  if (!zone) return { zone: null, records: [] };
  const recs = zoneRecords[zone.name] || [];
  const label = domain === zone.name ? '@' : domain.slice(0, -(zone.name.length + 1));
  return {
    zone,
    label,
    records: recs.filter((r) => {
      const n = r.name === zone.name ? '@' : r.name.slice(0, -(zone.name.length + 1));
      return n === label || (r.name === domain);
    })
  };
}

section('自定义域名解析检查');
const issues = [];
const all = [...vercelDomains, ...pagesDomains];
const rows = [];
for (const item of all) {
  const { zone, label, records } = recordsFor(item.domain);
  const dns = records.map((r) => r.type + ' ' + r.content + (r.proxied ? ' (代理)' : '')).join(' / ');
  let state;
  let ok = false;
  if (!zone) {
    state = '不在 Cloudflare（外部 DNS）';
    issues.push({ domain: item.domain, project: item.project, platform: item.platform, problem: 'DNS 不在 Cloudflare，需去对应域名服务商配记录', need: 'external' });
  } else if (!records.length) {
    state = '❌ 无 DNS 记录';
    issues.push({ domain: item.domain, project: item.project, platform: item.platform, problem: 'Zone ' + zone.name + ' 里没有 ' + label + ' 的记录', need: 'cname', zoneId: zone.id, zone: zone.name, label, target: item.platform === 'Vercel' ? 'cname.vercel-dns.com' : item.project + '.pages.dev' });
  } else {
    state = '✓ ' + dns;
    ok = true;
  }
  rows.push({ ...item, zone: zone?.name || null, label: label || null, dns, state, ok });
  console.log('  ' + (ok ? C.ok('✓') : C.bad('✗')) + ' ' + item.domain.padEnd(30) + C.dim(item.platform.padEnd(18) + item.project.padEnd(24) + state));
}

// ---------- 修复 ----------

const fixable = issues.filter((i) => i.need === 'cname' && i.zoneId);
if (fixable.length) {
  section(FIX ? '自动补 DNS 记录' : '缺失记录（可用 --fix 自动补）');
  for (const f of fixable) {
    const desc = 'CNAME ' + f.label + ' → ' + f.target + '  (zone ' + f.zone + ')';
    if (!FIX) {
      console.log('  ' + C.warn('待补: ') + desc + C.dim('  [' + f.domain + ']'));
      continue;
    }
    try {
      const created = await cfWrite('POST', '/zones/' + f.zoneId + '/dns_records', {
        type: 'CNAME',
        name: f.label === '@' ? f.zone : f.label,
        content: f.target,
        ttl: 1,
        proxied: false
      });
      console.log('  ' + C.ok('已添加: ') + desc + C.dim('  record=' + created.name + ' proxied=' + created.proxied));
    } catch (e) {
      console.log('  ' + C.bad('添加失败: ') + desc + ' — ' + e.message);
    }
  }
}

// ---------- 站点可达性 ----------

section('站点可达性');
// 从 API 取真实域名，避免手写默认域名（*.vercel.app 带随机后缀，容易张冠李戴）
const sites = [];
const seen = new Set();
for (const r of rows) {
  if (!seen.has(r.domain)) {
    seen.add(r.domain);
    sites.push([r.domain + ' [' + r.platform + ']', 'https://' + r.domain]);
  }
}
for (const d of projDefaultDomains) {
  if (!seen.has(d.name)) {
    seen.add(d.name);
    sites.push([d.name, d.url]);
  }
}
for (const p of pages) {
  const host = p.subdomain;
  if (host && !seen.has(host)) {
    seen.add(host);
    sites.push([host + ' [Pages]', 'https://' + host]);
  }
}
const statuses = {};
for (const [name, url] of sites) {
  const st = await httpStatus(url);
  statuses[name] = st;
  const good = typeof st === 'number' && st < 400;
  console.log('  ' + (good ? C.ok(String(st)) : C.bad(String(st))) + '  ' + name.padEnd(40) + C.dim(url));
  await sleep(200);
}

// ---------- 输出 JSON ----------

const out = {
  generatedAt: new Date().toISOString(),
  zones: zones.map((z) => ({ name: z.name, id: z.id, status: z.status, plan: z.plan?.name, recordCount: (zoneRecords[z.name] || []).length, records: zoneRecords[z.name] || [] })),
  customDomains: rows,
  issues,
  statuses,
  fixed: FIX ? fixable.map((f) => f.domain) : []
};
fs.writeFileSync(path.join(ROOT, '.domains.json'), JSON.stringify(out, null, 2) + '\n');

section('汇总');
console.log('  Cloudflare 域名: ' + zones.length + '  自定义域名: ' + all.length + '  问题: ' + issues.length);
if (issues.length) {
  for (const i of issues) console.log('   - ' + i.domain + ' [' + i.platform + '] ' + i.problem);
}
console.log('\n' + C.dim('明细已写入 .domains.json'));
process.exit(issues.length && !FIX ? 1 : 0);
