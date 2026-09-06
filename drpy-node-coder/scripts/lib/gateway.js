/**
 * 网关配置管理（多目标：local / 远程 drpy-node）。
 *
 * 配置文件：~/.drpy-node-coder/gateways.json（用户目录，不随任何 git 仓库发布）。
 * 结构：
 *   {
 *     "current": "local",                    // nvm-use 式当前网关指针
 *     "gateways": {
 *       "prod": {
 *         "url": "http://1.2.3.4:5757",      // 远端 drpy-node 服务地址
 *         "user": "admin",                   // Basic Auth 用户名（远端 .env 的 API_AUTH_NAME）
 *         "password_env": "DRPY_GW_PROD_PWD",// 凭据走环境变量（推荐，密文不入盘）
 *         "password": "",                    // 明文兜底（不推荐，仅个人机可用）
 *         "api_pwd_env": "DRPY_GW_PROD_APIPWD", // 运行时 /api 密码环境变量（远端 .env 的 API_PWD）
 *         "api_pwd": "",
 *         "note": ""
 *       }
 *     }
 *   }
 *
 * `local` 是内建目标（复用 setup 定位的本地 drpy-node），无需配置即可用。
 * 全同步实现：配置读取简单、命令内直接用。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

export const LOCAL_TARGET = 'local';

function configDir() {
  return path.join(os.homedir(), '.drpy-node-coder');
}

function configPath() {
  return path.join(configDir(), 'gateways.json');
}

// persist 后同一 shell 内的命令拿不到新环境变量（shell 未重读 profile），
// Windows 下直接回读注册表 HKCU\Environment 兜底（进程内缓存）。
const _regEnvCache = new Map();
function readWindowsUserEnv(name) {
  if (process.platform !== 'win32') return '';
  if (_regEnvCache.has(name)) return _regEnvCache.get(name);
  let v = '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /REG_SZ\s+([\s\S]*)$/.exec(out);
    if (m) v = m[1].trim();
  } catch { /* 变量不存在 */ }
  _regEnvCache.set(name, v);
  return v;
}

export function loadConfig() {
  const empty = { current: LOCAL_TARGET, gateways: {} };
  try {
    if (!fs.existsSync(configPath())) return empty;
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    return {
      current: raw.current || LOCAL_TARGET,
      gateways: raw.gateways && typeof raw.gateways === 'object' ? raw.gateways : {},
    };
  } catch (e) {
    throw new Error(`网关配置文件损坏（${configPath()}）: ${e.message}`);
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

/** env 引用优先；其次 Windows 注册表兜底（persist 后同会话场景）；明文兜底；都不存在返回 '' */
function resolveSecret(envKey, inline) {
  if (envKey) {
    if (process.env[envKey]) return process.env[envKey];
    const fromReg = readWindowsUserEnv(envKey);
    if (fromReg) return fromReg;
  }
  return inline || '';
}

/**
 * 解析目标名 → target 对象（cli.js 注入 ctx.target）。
 * @param {string|undefined} name --target 显式名；缺省用配置的 current
 * @returns {{kind:'local',name:'local'} | {kind:'remote',name,url,user,password,apiPwd,note}}
 */
export function resolveTarget(name) {
  const cfg = loadConfig();
  const picked = name || cfg.current || LOCAL_TARGET;
  if (picked === LOCAL_TARGET) return { kind: 'local', name: LOCAL_TARGET };
  const gw = cfg.gateways[picked];
  if (!gw) {
    const known = [LOCAL_TARGET, ...Object.keys(cfg.gateways)].join(', ');
    throw new Error(`未知网关: ${picked}。可用: ${known}（gateway add 添加 / gateway use 切换）`);
  }
  if (!gw.url) throw new Error(`网关 ${picked} 缺少 url。用 gateway add 重新配置。`);
  return {
    kind: 'remote',
    name: picked,
    url: String(gw.url).replace(/\/+$/, ''),
    user: gw.user || '',
    password: resolveSecret(gw.password_env, gw.password),
    apiPwd: resolveSecret(gw.api_pwd_env, gw.api_pwd),
    note: gw.note || '',
  };
}

/** 脱敏视图（gateway list / doctor 输出用，绝不回显明文凭据） */
export function describeTargets() {
  const cfg = loadConfig();
  return {
    current: cfg.current,
    gateways: [
      { name: LOCAL_TARGET, kind: 'local', current: cfg.current === LOCAL_TARGET },
      ...Object.entries(cfg.gateways).map(([name, gw]) => ({
        name,
        kind: 'remote',
        url: gw.url,
        user: gw.user || '',
        password_from_env: !!gw.password_env,
        password_set_inline: !!gw.password,
        api_pwd_from_env: !!gw.api_pwd_env,
        note: gw.note || '',
        current: cfg.current === name,
      })),
    ],
  };
}

/** gateway add：已存在时除非 overwrite 否则拒绝 */
export function addGateway(name, url, flags = {}, overwrite = false) {
  if (!name || !url) throw new Error('用法: gateway add <name> <url> [--user u --password-env VAR --password p --api-pwd-env VAR --note txt]');
  if (!/^https?:\/\//.test(url)) throw new Error(`url 必须以 http(s):// 开头，收到: ${url}`);
  const cfg = loadConfig();
  if (cfg.gateways[name] && !overwrite) {
    throw new Error(`网关 ${name} 已存在。加 --overwrite 覆盖，或换名。`);
  }
  if (name === LOCAL_TARGET) throw new Error('local 是保留名（本地 drpy-node），不可占用');
  cfg.gateways[name] = {
    url: String(url).replace(/\/+$/, ''),
    user: flags.user || '',
    password_env: flags['password-env'] || '',
    password: flags.password || '',
    api_pwd_env: flags['api-pwd-env'] || '',
    api_pwd: flags['api-pwd'] || '',
    note: flags.note || '',
  };
  // 首个远程网关自动设为 current？不——保持 current 语义单一（显式 use），避免隐式切换。
  saveConfig(cfg);
  return { name, url: cfg.gateways[name].url, config_file: configPath() };
}

export function removeGateway(name) {
  if (name === LOCAL_TARGET) throw new Error('local 是内建目标，不可删除');
  const cfg = loadConfig();
  if (!cfg.gateways[name]) throw new Error(`网关 ${name} 不存在`);
  delete cfg.gateways[name];
  if (cfg.current === name) cfg.current = LOCAL_TARGET;
  saveConfig(cfg);
  return { removed: name, current: cfg.current };
}

/** nvm use 式切换；local 亦可 */
export function useGateway(name) {
  const cfg = loadConfig();
  if (name !== LOCAL_TARGET && !cfg.gateways[name]) {
    const known = [LOCAL_TARGET, ...Object.keys(cfg.gateways)].join(', ');
    throw new Error(`未知网关: ${name}。可用: ${known}`);
  }
  cfg.current = name;
  saveConfig(cfg);
  return { current: name };
}
