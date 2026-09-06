/**
 * 远程网关后端：通过 drpy-node 服务端 /api/admin/* 与 /api/:module 操作远程部署。
 *
 * 能力映射（本地命令 → 远端端点）：
 *   fs ls/read/write/rm      → /api/admin/files/*
 *   syntax/validate          → /api/admin/sources/syntax | validate（服务端执行，以远端为准）
 *   src list/routes/template → /api/admin/sources | routes | sources/template
 *   logs/sql/config/restart  → /api/admin/logs | db/query | config | restart
 *   test/evaluate            → /api/:module（远端运行时真实行为，Q3 口径）
 *
 * 错误语义（Q5/Q7）：
 *   401 → 凭据被拒，提示核对远端 .env 的 API_AUTH_NAME/API_AUTH_CODE
 *   403 只读 → 提示远端 .env READ_ONLY_MODE=0 后重启
 *   404 → 远端缺该 API，提示升级远端 drpy-node
 */
import { isSafePath } from './pathResolver.js';
import { decodeDsSource } from './dsHelper.js';
import { decoder } from './runtime.js';

const TIMEOUT_MS = 60000;

function buildHeaders(target, json) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (target.user || target.password) {
    const cred = Buffer.from(`${target.user}:${target.password}`).toString('base64');
    h['Authorization'] = `Basic ${cred}`;
  }
  return h;
}

function describeHttpError(status, bodyText, apiPath, query) {
  let body = {};
  try { body = JSON.parse(bodyText); } catch { /* 非 JSON 响应体 */ }
  const serverMsg = body.error || body.message || bodyText.slice(0, 200);
  if (status === 401) {
    return new Error(`网关鉴权失败(401): ${serverMsg}。请核对网关 user/password（对应远端 .env 的 API_AUTH_NAME/API_AUTH_CODE；远端未配置这两项时无需凭据）`);
  }
  if (status === 403) {
    const msg = String(serverMsg || '');
    if (/只读|READ_ONLY/i.test(msg)) {
      return new Error(`远端处于只读模式(403): ${msg}。将远端 .env 中 READ_ONLY_MODE 设为 0 并重启服务后重试`);
    }
    return new Error(`远端拒绝(403): ${serverMsg}`);
  }
  if (status === 404) {
    // 区分两种 404：fastify 路由不存在（error 恰为 "Not Found" 或 message 含 "does not exist"）= 端点缺失；
    // 业务 404（如 files/read 的 {error:'文件不存在'}、运行时 {error:'Module x not found'}）= 原样透传。
    const m = String(body.message || '');
    if (/does not exist/i.test(m) || String(body.error || '') === 'Not Found') {
      return new Error(`远端无此 API(404): ${apiPath}。远端 drpy-node 版本可能过旧缺少该端点，请升级远端代码后重试`);
    }
    const biz = String(body.error || body.message || 'Not Found');
    // 文件类业务 404 的高频根因：AI 用了不带目录前缀的源文件名
    if (/文件不存在/.test(biz) && query && query.path && !String(query.path).includes('/')) {
      return new Error(`${biz}。提示：源文件需带目录前缀（spider/js/xxx.js、spider/php/xxx.php 等）；不确定文件名时先 src list --filter 关键词`);
    }
    return new Error(biz);
  }
  return new Error(`远端 HTTP ${status}: ${serverMsg}`);
}

async function parseJsonResponse(resp, apiPath, query) {
  const text = await resp.text();
  if (!resp.ok) throw describeHttpError(resp.status, text, apiPath, query);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`远端返回非 JSON 响应（${apiPath}）: ${text.slice(0, 200)}`);
  }
}

/**
 * 调用远端 admin API。query 为对象（值自动 String()）。
 * opts.rawText=true 时返回 {status, text}，由调用方自行解析
 * （远端部分端点如 config get?key= 返回裸值而非 JSON）。
 */
export async function adminFetch(target, method, apiPath, { query, body, rawText } = {}) {
  const qs = query
    ? '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
    : '';
  const url = `${target.url}${apiPath}${qs}`;
  const resp = await fetch(url, {
    method,
    headers: buildHeaders(target, body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (rawText) {
    const text = await resp.text();
    if (!resp.ok) throw describeHttpError(resp.status, text, apiPath, query);
    return { status: resp.status, text };
  }
  return parseJsonResponse(resp, apiPath, query);
}

/**
 * 调用远端运行时 /api/:module（与本地 localDsCore engine 同构的查询协议）。
 * query 形如 {} | {ac:'list',t} | {ac:'detail',ids:[...]} | {wd} | {play,flag}。
 */
export async function runtimeCall(target, moduleName, query = {}) {
  const params = {};
  if (target.apiPwd) params.pwd = target.apiPwd;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  const qs = new URLSearchParams(params).toString();
  const url = `${target.url}/api/${encodeURIComponent(moduleName)}${qs ? '?' + qs : ''}`;
  let resp;
  try {
    resp = await fetch(url, { headers: buildHeaders(target, false), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`远端运行时不可达（${url}）: ${e.message}`);
  }
  const text = await resp.text();
  if (!resp.ok) throw describeHttpError(resp.status, text, `/api/${moduleName}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`远端运行时返回非 JSON（/api/${moduleName}）: ${text.slice(0, 200)}`);
  }
}

/** 远程相对路径护栏（远端自己还有 isSafePath 双保险） */
export function assertRemotePath(p) {
  if (!p || !isSafePath(p)) throw new Error('Invalid path');
  const norm = String(p).replace(/\\/g, '/');
  if (path_abs(norm)) throw new Error('远程路径必须相对远端项目根');
  return p;
}
function path_abs(norm) {
  return /^[a-zA-Z]:/.test(norm) || norm.startsWith('/');
}

/** 探测网关：health/version + 关键端点可用性（gateway test 用，Q5 版本漂移显式暴露） */
export async function probe(target) {
  const result = { url: target.url, health: null, version: null, endpoints: {}, ok: false };
  const check = async (label, fn) => {
    try {
      await fn();
      result.endpoints[label] = 'ok';
    } catch (e) {
      result.endpoints[label] = e.message;
    }
  };
  try {
    result.health = await adminFetch(target, 'GET', '/api/admin/health');
  } catch (e) {
    result.health = { error: e.message };
    result.endpoints.health = e.message;
    return result; // 服务不可达时无需再探
  }
  try {
    const v = await adminFetch(target, 'GET', '/api/admin/version');
    result.version = typeof v === 'object' ? (v.version || v.data || v) : v;
  } catch (e) {
    result.version = e.message;
  }
  await check('files', () => adminFetch(target, 'GET', '/api/admin/files/list', { query: { path: 'spider/js' } }));
  await check('sources', () => adminFetch(target, 'GET', '/api/admin/sources'));
  await check('syntax', async () => {
    // 探不存在的文件：远端 400「文件不存在」= 端点在；404 路由不存在 = 端点缺
    try {
      await adminFetch(target, 'POST', '/api/admin/sources/syntax', { body: { path: 'spider/js/__probe_noexist__.js' } });
    } catch (e) {
      if (/无此 API/.test(e.message)) throw e;
    }
  });
  await check('runtime', async () => {
    // 探不存在的源：任何业务错误都证明 /api 路由在；只有 404 路由不存在才算缺
    try {
      await runtimeCall(target, 'drpy-node-mcp-probe-nonexistent', {});
    } catch (e) {
      if (/无此 API/.test(e.message)) throw e;
    }
  });
  result.ok = Object.values(result.endpoints).every((v) => v === 'ok');
  return result;
}

/** 拉取远端 .js 源文件并本地 DS 解密（远程 fs read / resolved 共用） */
export async function fetchRemoteSource(target, filePath) {
  const body = await adminFetch(target, 'GET', '/api/admin/files/read', { query: { path: filePath } });
  if (body.type === 'image') return { type: 'image', dataUrl: body.dataUrl };
  let content = body.content ?? '';
  let decoded = false;
  if (String(filePath).endsWith('.js')) {
    const fn = await decoder();
    content = await decodeDsSource(content, fn);
    decoded = true;
  }
  return { type: 'text', content, decoded };
}
