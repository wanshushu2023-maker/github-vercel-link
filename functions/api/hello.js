// Cloudflare Pages Function: GET /api/hello
// 约定：functions/api/hello.js -> /api/hello（与 Vercel 的 api/hello.js 并存，互不干扰）
// HTTP 方法只允许 GET；其它方法 CF Pages 会自动返回 405。
const GIT_OWNER = 'wanshushu2023-maker';
const GIT_REPO = 'github-vercel-link';

export async function onRequestGet({ env }) {
  const sha = env.CF_PAGES_COMMIT_SHA || '';
  const branch = env.CF_PAGES_BRANCH || '';
  const body = {
    ok: true,
    host: 'Cloudflare Pages',
    message: 'GitHub 提交已由 Cloudflare Pages 自动部署',
    where: 'Cloudflare Pages Function',
    now: new Date().toISOString(),
    gitOwner: GIT_OWNER,
    gitRepo: GIT_REPO,
    gitRef: branch || null,
    gitSha: sha ? sha.slice(0, 7) : null,
    deploymentId: env.CF_PAGES_DEPLOYMENT_ID || null,
    env: branch === 'main' ? 'production' : branch ? 'preview' : 'development',
    region: null,
    runtime: 'workerd (Cloudflare Pages Functions)',
    pageUrl: env.CF_PAGES_URL || null
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0'
    }
  });
}
