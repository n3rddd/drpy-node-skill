#!/usr/bin/env node
/**
 * drpy-node-coder CLI 统一入口。
 *
 * 用法: node cli.js [--root <drpy-node-路径>] [--target <网关名>] <命令> [位置参数] [--flags]
 *
 * 命令格式两种：
 *   两段式: node cli.js fs read spider/js/xxx.js
 *   顶层动词: node cli.js fetch https://example.com
 *
 * 元命令: setup / where / doctor / help
 * 业务命令来自 commands/*.js（动态注册，文件存在则加载）。
 * --target 选择执行网关：local（默认，本地 drpy-node）或 gateway add 注册的远程网关名；
 * 不传时用 gateway use 设置的当前网关。文件/验证/测试类命令按 target 分流本地或远程执行。
 *
 * 所有命令统一输出 JSON：成功 {ok:true,data}，失败 {ok:false,error,message}（退出码非 0）。
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { parseArgs } from './lib/argv.js';
import { ok, fail, attachGlobalErrorHandlers } from './lib/output.js';
import { getProjectRoot, setProjectRoot, DOTFILE } from './lib/pathResolver.js';
import { resolveTarget, describeTargets } from './lib/gateway.js';

attachGlobalErrorHandlers();

// 保证 stdout 纯净（仅 output.ok 写 JSON 到 stdout）。第三方库（req.js 的 DOH 日志等）
// 的 console.log 一律改走 stderr，避免破坏 AI 对 stdout JSON 的解析。
console.log = (...args) => {
  process.stderr.write(args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ') + '\n');
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 动态注册业务命令 ----
const COMMAND_FILES = [
  './commands/fs.js',
  './commands/spider.js',
  './commands/validate.js',
  './commands/test.js',
  './commands/house.js',
  './commands/system.js',
  './commands/gateway.js',
];
const ROUTES = {};
for (const f of COMMAND_FILES) {
  try {
    const mod = await import(f);
    if (mod && mod.commands) Object.assign(ROUTES, mod.commands);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // commands 文件尚未创建（分阶段实现）→ 静默跳过；其它错误告警
    if (!/Cannot find|ERR_MODULE_NOT_FOUND|Failed to resolve/.test(msg)) {
      process.stderr.write(`[warn] 加载 ${f} 失败: ${msg}\n`);
    }
  }
}

// ---- 元命令 ----
async function setup(ctx) {
  const target = ctx.positional[0];
  if (!target) throw new Error('用法: node cli.js setup <drpy-node-绝对路径>');
  const abs = path.resolve(target);
  const markers = ['spider/js', 'libs_drpy/htmlParser.js'];
  for (const m of markers) {
    if (!fs.existsSync(path.join(abs, m))) {
      throw new Error(`路径 ${abs} 不像 drpy-node 项目根（缺少 ${m}）`);
    }
  }
  fs.mkdirSync(path.dirname(DOTFILE), { recursive: true });
  fs.writeFileSync(DOTFILE, abs + '\n', 'utf-8');
  setProjectRoot(abs);
  // 迁移：删除 skill 目录里的旧定位文件（skill 目录保持无状态，zip 可整包分发）
  const legacy = path.join(__dirname, '.drpy-root');
  if (fs.existsSync(legacy)) fs.rmSync(legacy);
  return { root: abs, dotfile: DOTFILE, migrated_from: fs.existsSync(legacy) ? legacy : undefined };
}

async function where() {
  const root = getProjectRoot();
  if (!root) {
    throw new Error('未定位到 drpy-node 项目根。请运行: node cli.js setup <drpy-node-绝对路径>');
  }
  return { root };
}

async function doctor() {
  const result = { node: process.versions.node, root: null, modules: {}, house: null, ok: false };
  const root = getProjectRoot();
  result.root = root;
  if (!root) {
    result.advice = '运行: node cli.js setup <drpy-node-绝对路径>';
    return result;
  }
  const checks = [
    'utils/req.js',
    'libs_drpy/htmlParser.js',
    'libs_drpy/drpyInject.js',
    'libs_drpy/drpyCustom.js',
    'libs/drpyS.js',
    'drpy-node-bundle/libs/localDsCore.bundled.js',
    'config/env.json',
  ];
  for (const rel of checks) {
    result.modules[rel] = fs.existsSync(path.join(root, rel));
  }
  try {
    const envPath = path.join(root, 'config/env.json');
    if (fs.existsSync(envPath)) {
      const cfg = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
      result.house = {
        url: cfg.HOUSER_URL || '(默认 http://183.87.133.60:5678)',
        token_configured: !!cfg.HOUSE_TOKEN,
      };
    }
  } catch (e) {
    result.house = { error: e.message };
  }
  // skill 便携化：vendor/ 自带运行时（localDsCore bundle + sqlite）。
  // simplecc 为可选——上游 bundle 在任意位置均加载失败（__wbindgen_placeholder__），仅影响 GBK 站点。
  const vendorDir = path.join(__dirname, 'vendor');
  result.vendor = {
    localDsCore: fs.existsSync(path.join(vendorDir, 'localDsCore.bundled.js')),
    sqlite_js: fs.existsSync(path.join(vendorDir, 'sqlite', 'node-sqlite3-wasm.js')),
    sqlite_wasm: fs.existsSync(path.join(vendorDir, 'sqlite', 'node-sqlite3-wasm.wasm')),
    bundle_sqlite_wasm: fs.existsSync(path.join(vendorDir, 'node-sqlite3-wasm.wasm')),
    simplecc_wasm_optional: fs.existsSync(path.join(vendorDir, 'simplecc_wasm_bg.wasm')),
  };
  const vendorCoreOk = result.vendor.localDsCore && result.vendor.sqlite_js && result.vendor.sqlite_wasm;
  result.ok = !!root && Object.values(result.modules).every(Boolean) && vendorCoreOk;
  // 网关概览（不做网络探测，探活用 gateway test）
  try {
    result.gateways = describeTargets();
  } catch (e) {
    result.gateways = { error: e.message };
  }
  return result;
}

function help() {
  const meta = ['setup', 'where', 'doctor', 'help'];
  const business = Object.keys(ROUTES).sort();
  return {
    meta,
    business,
    total: meta.length + business.length,
    tip: '每个命令输出 JSON：成功 {ok:true,data}，失败 {ok:false,error}。--target <网关> 或 gateway use 切换执行目标。详见 README.md',
  };
}

const META = {
  setup,
  where,
  doctor,
  help: () => help(),
};

// ---- 主流程 ----
const raw = process.argv.slice(2);

// 提前提取全局 --root / --root=value 与 --target / --target=value（网关选择）
let targetName;
for (let i = 0; i < raw.length; i++) {
  const t = raw[i];
  if (t === '--root' && raw[i + 1]) {
    setProjectRoot(raw[i + 1]);
    raw.splice(i, 2);
    i--;
  } else if (t && t.startsWith('--root=')) {
    setProjectRoot(t.slice('--root='.length));
    raw.splice(i, 1);
    i--;
  } else if (t === '--target' && raw[i + 1]) {
    targetName = raw[i + 1];
    raw.splice(i, 2);
    i--;
  } else if (t && t.startsWith('--target=')) {
    targetName = t.slice('--target='.length);
    raw.splice(i, 1);
    i--;
  }
}

const parsed = parseArgs(raw);

// 定位到 drpy-node 项目根并切换 cwd。这样 localDsCore/drpyS 的运行时缓存
// （local/js_drpyS_*）、日志等写入 drpy-node 项目内，与 drpy-node 自身运行一致，不污染 skill 目录。
// 文件命令均用 resolvePath（基于 PROJECT_ROOT，不依赖 cwd），不受 chdir 影响。
const _root = getProjectRoot();
if (_root) {
  try {
    process.chdir(_root);
  } catch {
    /* ignore chdir failure */
  }
}

async function main() {
  const pos = parsed.positional;
  if (pos.length === 0) {
    ok(help());
    return;
  }
  const ctx = { positional: pos, flags: parsed.flags, headers: parsed.headers, target: resolveTarget(targetName) };
  let handler = null;

  const two = pos.length >= 2 ? `${pos[0]} ${pos[1]}` : null;
  if (two && (ROUTES[two] || META[two])) {
    handler = ROUTES[two] || META[two];
    ctx.positional = pos.slice(2);
  } else if (ROUTES[pos[0]] || META[pos[0]]) {
    handler = ROUTES[pos[0]] || META[pos[0]];
    ctx.positional = pos.slice(1);
  } else {
    fail('未知命令', `未识别: ${pos.join(' ')}。可用命令见: node cli.js help`);
    return;
  }

  try {
    const data = await handler(ctx);
    ok(data);
  } catch (e) {
    fail(e && e.message ? e.message : String(e), e && e.stack ? e.stack : undefined);
  }
}

main();
