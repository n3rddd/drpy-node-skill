/**
 * system 组命令：logs / sql / config get / config set / restart
 * 移植自 drpy-node-mcp/tools/systemTools.js + dbTools.js。
 * - logs: 读 logs/ 下最新 .log.txt 尾部
 * - sql: node-sqlite3-wasm 只读 SELECT 查 database.db
 * - config: 读写 config/env.json（点语法嵌套，带 lock）
 * - restart: PM2 重启 drpys
 */
import fs from '../lib/fsUtil.js';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';

import { resolvePath } from '../lib/pathResolver.js';
import { adminFetch } from '../lib/remote.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execPromise = promisify(exec);

let _Database = null;
async function loadDatabase() {
  if (_Database) return _Database;
  const vendorJs = path.resolve(__dirname, '..', 'vendor', 'sqlite', 'node-sqlite3-wasm.js');
  const mod = fs.existsSync(vendorJs)
    ? await import(pathToFileURL(vendorJs).href)
    : await import('node-sqlite3-wasm'); // fallback：用户自行 npm install
  const pkg = mod.default || mod;
  _Database = pkg.Database || pkg;
  if (typeof _Database !== 'function') throw new Error('node-sqlite3-wasm 未导出 Database');
  return _Database;
}

function getNestedValue(obj, keyPath) {
  return keyPath.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
}

function setNestedValue(obj, keyPath, value) {
  const parts = keyPath.split('.');
  const last = parts.pop();
  const target = parts.reduce((acc, part) => {
    if (!acc[part]) acc[part] = {};
    return acc[part];
  }, obj);
  target[last] = value;
}

/** logs [--lines N] */
async function logs(ctx) {
  const linesToRead = Number(ctx.flags.lines) || 50;
  if (ctx.target.kind === 'remote') {
    const body = await adminFetch(ctx.target, 'GET', '/api/admin/logs', { query: { lines: linesToRead } });
    return { file: body.file || undefined, lines: String(body.content || '').split('\n').slice(-linesToRead).join('\n') };
  }
  const logDir = resolvePath('logs');
  if (!(await fs.pathExists(logDir))) return { note: 'No logs directory found.' };
  const files = await fs.readdir(logDir);
  const logFiles = files.filter((f) => f.endsWith('.log.txt')).sort().reverse();
  if (logFiles.length === 0) return { note: 'No log files found.' };
  const content = await fs.readFile(path.join(logDir, logFiles[0]), 'utf-8');
  const lines = content.trim().split('\n');
  return { file: logFiles[0], lines: lines.slice(-linesToRead).join('\n') };
}

/** sql <query>（只读 SELECT） */
async function sql(ctx) {
  const query = ctx.positional.join(' ');
  if (!query || !query.trim().toLowerCase().startsWith('select')) {
    throw new Error('Only SELECT queries are allowed.');
  }
  if (ctx.target.kind === 'remote') {
    return await adminFetch(ctx.target, 'POST', '/api/admin/db/query', { body: { sql: query } });
  }
  const dbPath = resolvePath('database.db');
  const Database = await loadDatabase();
  let db;
  try {
    db = new Database(dbPath);
    const rows = db.all(query);
    return { rows };
  } catch (e) {
    throw new Error(`SQL Error: ${e.message}`);
  } finally {
    if (db) db.close();
  }
}

/** config get [key] */
async function configGet(ctx) {
  const key = ctx.positional[0];
  if (ctx.target.kind === 'remote') {
    if (key) {
      // 远端带 key 时返回裸值（字符串/数字，非 JSON），用 rawText 容错解析
      const { text } = await adminFetch(ctx.target, 'GET', '/api/admin/config', { query: { key }, rawText: true });
      let value = text;
      try { value = JSON.parse(text); } catch { /* 保留原文 */ }
      return { key, value };
    }
    return await adminFetch(ctx.target, 'GET', '/api/admin/config');
  }
  const configPath = resolvePath('config/env.json');
  if (!(await fs.pathExists(configPath))) throw new Error('config/env.json not found');
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  if (key) return { key, value: getNestedValue(config, key) };
  return config;
}

/** config set <key> <value> */
async function configSet(ctx) {
  const key = ctx.positional[0];
  const value = ctx.positional[1];
  if (!key || value === undefined) throw new Error('用法: config set <key> <value>');
  if (ctx.target.kind === 'remote') {
    let parsedValue = value;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      /* keep as string */
    }
    return await adminFetch(ctx.target, 'POST', '/api/admin/config', { body: { key, value: parsedValue } });
  }
  const configPath = resolvePath('config/env.json');
  const lockPath = resolvePath('config/env.json.lock');
  if (!(await fs.pathExists(configPath))) throw new Error('config/env.json not found');
  if (await fs.pathExists(lockPath)) throw new Error('Config is locked by another process');

  await fs.outputFile(lockPath, String(process.pid));
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    let parsedValue = value;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      /* keep as string */
    }
    setNestedValue(config, key, parsedValue);
    await fs.outputFile(configPath, JSON.stringify(config, null, 2));
    return { key, value: parsedValue };
  } finally {
    await fs.remove(lockPath);
  }
}

/** restart（PM2 drpys / 远程走 admin restart） */
async function restart(ctx) {
  if (ctx.target.kind === 'remote') {
    const body = await adminFetch(ctx.target, 'POST', '/api/admin/restart');
    return { success: true, gateway: ctx.target.name, remote_response: body };
  }
  try {
    await execPromise('pm2 restart drpys');
    return { success: true, message: '服务已通过 PM2 重启' };
  } catch (pm2Error) {
    return {
      success: false,
      message: '当前未使用 PM2 运行。请手动重启：Ctrl+C 停止后运行 npm run dev',
      error: pm2Error.message,
    };
  }
}

export const commands = {
  logs,
  sql,
  'config get': configGet,
  'config set': configSet,
  restart,
};
