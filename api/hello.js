// Vercel Serverless Function: GET /api/hello
// 返回 Vercel 在构建时注入的 GitHub 提交信息，用来证明"这次部署来自 GitHub 推送"。
'use strict';

module.exports = function handler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const env = process.env;
  const sha = env.VERCEL_GIT_COMMIT_SHA || '';

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    ok: true,
    message: 'GitHub 提交已由 Vercel 自动部署',
    where: 'Vercel Serverless Function',
    now: new Date().toISOString(),
    gitOwner: env.VERCEL_GIT_REPO_OWNER || null,
    gitRepo: env.VERCEL_GIT_REPO_SLUG || null,
    gitRef: env.VERCEL_GIT_COMMIT_REF || null,
    gitSha: sha ? sha.slice(0, 7) : null,
    deploymentId: env.VERCEL_DEPLOYMENT_ID || null,
    env: env.VERCEL_ENV || 'development',
    region: env.VERCEL_REGION || 'local',
    runtime: process.version
  });
};
