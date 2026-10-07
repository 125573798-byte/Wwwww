// Cloudflare Pages Function —— 进销存云备份后端
// 访问：https://<项目>.pages.dev/api/backup/...
// 必需环境变量：BACKUP_TOKEN（访问令牌）、R2_BUCKET（R2 绑定）
// R2 绑定：仪表盘 → Pages → 设置 → 函数 → R2 绑定，变量名 R2_BUCKET
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Backup-Token',
  'Content-Type': 'application/json; charset=utf-8',
};
function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: CORS }); }
function auth(req, env) {
  const tok = env.BACKUP_TOKEN;
  if (!tok) return 'BACKUP_TOKEN 未配置';
  const h = req.headers.get('Authorization') || req.headers.get('X-Backup-Token') || '';
  const given = h.replace(/^Bearer\s+/i, '').trim();
  if (given !== String(tok).trim()) return '令牌不正确';
  return null;
}
const PREFIX = 'inventory-snapshots/';
async function listObjects(bucket) {
  const out = []; let cursor;
  do {
    const opts = { prefix: PREFIX, limit: 1000, order: 'desc' };
    if (cursor) opts.cursor = cursor;
    const r = await bucket.list(opts);
    for (const o of r.objects) out.push({ key: o.key.replace(PREFIX, ''), size: o.size, updated: o.uploaded instanceof Date ? o.uploaded.toISOString() : o.uploaded, etag: o.etag });
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}
export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const bucket = env.R2_BUCKET;
  if (!bucket) return json({ ok: false, error: 'R2_BUCKET 未绑定' }, 500);
  const seg = (params && params.path) ? (Array.isArray(params.path) ? params.path.join('/') : params.path) : '';
  try {
    if (request.method === 'PUT' && seg === 'backup/upload') {
      const err = auth(request, env); if (err) return json({ ok: false, error: err }, 401);
      const key = url.searchParams.get('key');
      if (!key || !/^[A-Za-z0-9_\-\.]+$/.test(key)) return json({ ok: false, error: 'key 非法' }, 400);
      const body = await request.text();
      if (!body) return json({ ok: false, error: 'body 为空' }, 400);
      await bucket.put(PREFIX + key, body, { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: { uploadedAt: new Date().toISOString(), source: 'inventory-app' } });
      const all = await listObjects(bucket);
      await Promise.all(all.slice(30).map(o => bucket.delete(PREFIX + o.key).catch(() => {})));
      return json({ ok: true, key, size: body.length, kept: Math.min(all.length, 30) });
    }
    if (request.method === 'GET' && seg === 'backup/latest') {
      const err = auth(request, env); if (err) return json({ ok: false, error: err }, 401);
      const all = await listObjects(bucket);
      if (!all.length) return json({ ok: true, exists: false, index: [] });
      const head = await bucket.get(PREFIX + all[0].key);
      const text = await head.text();
      let snapshot; try { snapshot = JSON.parse(text); } catch (e) { snapshot = text; }
      return json({ ok: true, exists: true, meta: { key: all[0].key, size: all[0].size, savedAtISO: all[0].updated, source: head.customMetadata && head.customMetadata.source }, snapshot });
    }
    if (request.method === 'GET' && seg === 'backup/list') {
      const err = auth(request, env); if (err) return json({ ok: false, error: err }, 401);
      return json({ ok: true, exists: true, index: await listObjects(bucket) });
    }
    if (request.method === 'GET' && seg === 'backup/download') {
      const err = auth(request, env); if (err) return json({ ok: false, error: err }, 401);
      const key = url.searchParams.get('key');
      const obj = await bucket.get(PREFIX + key);
      if (!obj) return json({ ok: false, error: '快照不存在' }, 404);
      const text = await obj.text();
      let snapshot; try { snapshot = JSON.parse(text); } catch (e) { snapshot = text; }
      return json({ ok: true, exists: true, meta: { key, size: obj.size, savedAtISO: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : obj.uploaded }, snapshot });
    }
    if (request.method === 'DELETE' && seg === 'backup/delete') {
      const err = auth(request, env); if (err) return json({ ok: false, error: err }, 401);
      await bucket.delete(PREFIX + url.searchParams.get('key')).catch(() => {});
      return json({ ok: true, deleted: url.searchParams.get('key') });
    }
    return json({ ok: false, error: '路径不存在：/' + seg }, 404);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}
