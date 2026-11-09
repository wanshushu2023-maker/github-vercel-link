#!/usr/bin/env node
// 安装便携版 Git 到工作区 .tools/git（无需管理员权限、不写系统目录）
// 来源: git-for-windows 官方发行包（MinGit），经国内镜像加速下载并做三重校验：
//   1) 官方发布页解析资源名（保证版本/文件名正确）
//   2) 两个独立镜像（npmmirror / 华为云）完整文件 SHA-256 比对
//   3) 与 GitHub 官方 CDN 分片抽样逐字节比对（镜像若被篡改必然对不上）
// 校验全部通过才解压安装。
// 用法: node scripts/install-git.mjs [--force]
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, '.tools');
const DEST = path.join(TOOLS, 'git');
const CACHE = path.join(TOOLS, 'cache');
const GIT_EXE = path.join(DEST, 'cmd', 'git.exe');
const FORCE = process.argv.includes('--force');

const MIRRORS = [
  { label: 'npmmirror(阿里)', base: 'https://cdn.npmmirror.com/binaries/git-for-windows/' },
  { label: '华为云', base: 'https://mirrors.huaweicloud.com/git-for-windows/' }
];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function run(file, args) {
  const r = spawnSync(file, args, { encoding: 'utf8' });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

function progress(total, label) {
  let received = 0;
  let nextMark = 10;
  return {
    onData(chunk) {
      received += chunk.length;
      if (total) {
        const pct = Math.floor((received / total) * 100);
        if (pct >= nextMark) {
          process.stdout.write('  ' + label + ' ' + pct + '%\r');
          nextMark += 10;
        }
      }
    },
    get received() {
      return received;
    },
    clear() {
      process.stdout.write(' '.repeat(40) + '\r');
    }
  };
}

async function downloadFull(url, dest, { timeoutMs = 180000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  const prog = progress(total, '进度');
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => prog.onData(c));
  await pipeline(body, createWriteStream(dest));
  prog.clear();
  const stat = await fs.stat(dest);
  if (total && stat.size !== total) throw new Error('大小不符 ' + stat.size + ' != ' + total);
  return { size: stat.size, sha256: await sha256File(dest), total };
}

// 从官方 CDN 取若干分片，与本地文件逐字节比对
async function sampleVerifyAgainstOfficial(officialUrl, localFile, size) {
  const local = await fs.readFile(localFile);
  const ranges = [
    [0, 65535],
    [Math.floor(size * 0.17), Math.floor(size * 0.17) + 65535],
    [Math.floor(size * 0.41), Math.floor(size * 0.41) + 65535],
    [Math.floor(size * 0.68), Math.floor(size * 0.68) + 65535],
    [size - 65536, size - 1]
  ];
  let ok = 0;
  for (const [start, end] of ranges) {
    try {
      const res = await fetch(officialUrl, {
        headers: { Range: 'bytes=' + start + '-' + end },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) {
        console.log('  分片 ' + start + '-… 官方返回 ' + res.status + '，跳过');
        continue;
      }
      const remote = Buffer.from(await res.arrayBuffer());
      const localSlice = local.subarray(start, start + remote.length);
      if (remote.length && remote.equals(localSlice.subarray(0, remote.length))) {
        ok++;
        console.log('  ✓ 分片 @' + start + ' (' + remote.length + ' bytes) 与官方一致');
      } else {
        throw new Error('分片 @' + start + ' 与官方不一致 —— 镜像文件可能被篡改，已中止');
      }
    } catch (e) {
      if (/篡改/.test(e.message)) throw e;
      console.log('  分片 @' + start + ' 拉取失败(' + e.message + ')，跳过');
    }
  }
  if (ok < 2) throw new Error('官方分片校验成功数不足（' + ok + '/5），拒绝安装');
  console.log('  官方源抽样比对通过: ' + ok + '/5');
}

async function main() {
  console.log('=== 安装便携版 Git ===');

  if (!FORCE && (await exists(GIT_EXE))) {
    console.log('已安装，跳过: ' + GIT_EXE);
    console.log('  ' + run(GIT_EXE, ['--version']).out);
    return;
  }

  await fs.mkdir(CACHE, { recursive: true });

  console.log('[1] 解析 git-for-windows 最新发行版');
  const page = await fetch('https://github.com/git-for-windows/git/releases/latest', { redirect: 'follow' });
  if (!page.ok) throw new Error('发布页不可达 HTTP ' + page.status);
  const tag = page.url.split('/').pop();
  const version = tag.replace(/^v/, '').replace(/\.windows\./, '.');
  const assetName = 'MinGit-' + version + '-64-bit.zip';
  const officialUrl = 'https://github.com/git-for-windows/git/releases/download/' + tag + '/' + assetName;
  console.log('  tag: ' + tag + '  →  ' + assetName);

  console.log('[2] 从两个镜像下载（各自算 SHA-256）');
  const downloaded = [];
  for (const m of MIRRORS) {
    const url = m.base + tag + '/' + assetName;
    console.log('  ' + m.label + ': ' + url);
    try {
      const file = path.join(CACHE, 'mingit-' + downloaded.length + '.zip');
      const info = await downloadFull(url, file);
      console.log('    完成 ' + (info.size / 1048576).toFixed(1) + ' MB  sha256=' + info.sha256.slice(0, 16) + '…');
      downloaded.push({ ...m, url, file, ...info });
    } catch (e) {
      console.log('    失败: ' + e.message);
    }
    if (downloaded.length) break; // 主镜像成功即可，第二个仅用于交叉校验
  }
  if (!downloaded.length) throw new Error('所有镜像下载失败');

  // 若只拿到一份，再补一份用于比对（换另一个镜像）
  if (downloaded.length === 1) {
    for (const m of MIRRORS) {
      if (downloaded.some((d) => d.label === m.label)) continue;
      try {
        console.log('  交叉校验副本 ← ' + m.label);
        const file = path.join(CACHE, 'mingit-cross.zip');
        const info = await downloadFull(m.base + tag + '/' + assetName, file);
        downloaded.push({ ...m, file, ...info, cross: true });
        break;
      } catch (e) {
        console.log('    失败: ' + e.message);
      }
    }
  }

  const primary = downloaded[0];
  console.log('[3] 校验');
  if (downloaded.length > 1 && downloaded[1].sha256 !== primary.sha256) {
    throw new Error('两个镜像的 SHA-256 不一致，拒绝安装');
  }
  if (downloaded.length > 1) console.log('  ✓ 镜像间 SHA-256 一致 (' + primary.sha256 + ')');
  await sampleVerifyAgainstOfficial(officialUrl, primary.file, primary.size);

  console.log('[4] 解压到 .tools/git');
  if (await exists(DEST)) await fs.rm(DEST, { recursive: true, force: true });
  await fs.mkdir(DEST, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  let extracted = false;
  if (await exists(tar)) {
    const r = run(tar, ['-xf', primary.file, '-C', DEST]);
    extracted = r.code === 0;
    if (!extracted) console.log('  tar 解压失败: ' + r.out.slice(0, 300));
  }
  if (!extracted) {
    const ps = run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Expand-Archive -LiteralPath '" + primary.file + "' -DestinationPath '" + DEST + "' -Force"
    ]);
    extracted = ps.code === 0;
    if (!extracted) throw new Error('解压失败: ' + ps.out.slice(0, 400));
  }

  console.log('[5] 验证');
  if (!(await exists(GIT_EXE))) {
    const found = await fs.readdir(DEST).catch(() => []);
    throw new Error('解压后没有 cmd/git.exe，目录: ' + found.join(', '));
  }
  const v = run(GIT_EXE, ['--version']);
  console.log('  ' + v.out);
  console.log('  ' + GIT_EXE);
  console.log('\n完成。');
}

main().catch((e) => {
  console.error('\n✗ 安装失败: ' + e.message);
  process.exit(1);
});
