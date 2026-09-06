/**
 * gateway 组命令：多网关管理（nvm-use 式切换 + 显式 --target 覆盖）。
 *
 * - gateway add <name> <url> [--user --password-env --password --api-pwd-env --api-pwd --note] [--overwrite]
 * - gateway list | current
 * - gateway use <name>        # local 亦可；之后所有命令默认打该网关
 * - gateway remove <name>
 * - gateway test [name]       # 探活 + 版本 + 关键端点可用性
 * - gateway persist <name>    # 凭据固化：写 Windows 用户级环境变量 + Git Bash profile，
 *                             # 配置改为 env 引用——此后任何新终端/新会话零配置可用
 *
 * 凭据约定（Q4）：密码走环境变量（--password-env VAR），配置文件只存变量名；
 * 明文 --password 兜底（文件在 ~/.drpy-node-coder/，不进 git，但不推荐）。
 * persist 是"从明文/临时 env 提升为系统级环境变量"的一次性动作，幂等可重跑。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { flagBool } from '../lib/argv.js';
import {
  addGateway, removeGateway, useGateway, describeTargets, resolveTarget, loadConfig, saveConfig,
} from '../lib/gateway.js';
import { probe } from '../lib/remote.js';

const execPromise = promisify(exec);

async function gwAdd(ctx) {
  const [name, url] = ctx.positional;
  const result = addGateway(name, url, ctx.flags, flagBool(ctx.flags, 'overwrite'));
  return { ...result, next: `gateway use ${name} 切换 / gateway test ${name} 探活` };
}

async function gwList() {
  return describeTargets();
}

async function gwCurrent() {
  const cfg = loadConfig();
  const t = resolveTarget();
  return {
    current: cfg.current,
    kind: t.kind,
    url: t.url || '(本地 drpy-node，见 where)',
    user: t.user || '',
    has_credentials: !!(t.user || t.password),
    has_api_pwd: !!t.apiPwd,
  };
}

async function gwUse(ctx) {
  const name = ctx.positional[0];
  return useGateway(name);
}

async function gwRemove(ctx) {
  const name = ctx.positional[0];
  return removeGateway(name);
}

async function gwTest(ctx) {
  const name = ctx.positional[0];
  const target = resolveTarget(name);
  if (target.kind === 'local') throw new Error('gateway test 用于远程网关；本地 drpy-node 请用 doctor 检查');
  const result = await probe(target);
  return {
    gateway: target.name,
    ...result,
    hint: result.ok
      ? '网关可用。gateway use <name> 后即可远程执行 fs/test/evaluate 等命令'
      : '存在不可用端点：ok 项对应能力可用，其余按错误提示处理（404 升级远端 / 401 核对凭据 / 403 只读模式）',
  };
}

// ============ persist：凭据固化到系统级环境变量 ============

/** bash 单引号字面量（值内 ' → '\'' ） */
function bashQuote(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/** 幂等维护 ~/.bashrc / ~/.bash_profile 里的 export 行（存在则替换，缺失则追加） */
function upsertBashExport(name, value) {
  const line = `export ${name}=${bashQuote(value)}`;
  const re = new RegExp(`^export ${name}=.*$`, 'm');
  // .bashrc 总是写（不存在则创建，bash interactive 通吃）；
  // .bash_profile / .zshrc 仅在已存在时维护——在 Linux 新机器上创建 .bash_profile 会让
  // login shell 不再读 ~/.profile（丢失发行版默认 PATH 初始化）；.zshrc 存在说明是 zsh 用户
  const always = [path.join(os.homedir(), '.bashrc')];
  const ifExists = [path.join(os.homedir(), '.bash_profile'), path.join(os.homedir(), '.zshrc')];
  const targets = [...always, ...ifExists.filter((f) => fs.existsSync(f))];
  const touched = [];
  for (const f of targets) {
    const content = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '';
    const next = re.test(content) ? content.replace(re, line) : content.replace(/\n*$/, '\n') + line + '\n';
    fs.writeFileSync(f, next, 'utf-8');
    touched.push(f);
  }
  return touched;
}

/** 写 Windows 用户级环境变量（注册表 HKCU\Environment；PowerShell 单引号字面量无注入面） */
async function setWindowsUserEnv(name, value) {
  const v = String(value).replace(/'/g, "''");
  if (/["\r\n]/.test(value)) throw new Error(`凭据含双引号/换行，无法自动写入环境变量，请手动配置`);
  await execPromise(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('${name}','${v}','User')"`);
}

async function gwPersist(ctx) {
  const name = ctx.positional[0];
  if (!name) throw new Error('用法: gateway persist <name>');
  if (name === 'local') throw new Error('local 是本地 drpy-node，无凭据可固化');
  const cfg = loadConfig();
  const gw = cfg.gateways[name];
  if (!gw) throw new Error(`网关 ${name} 不存在。先 gateway add`);

  // 变量名：沿用已配置的，或按网关名生成
  const norm = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const pwdVar = gw.password_env || `DRPY_GW_${norm}_PWD`;
  const apiVar = gw.api_pwd_env || `DRPY_GW_${norm}_APIPWD`;

  // 值来源：当前会话环境变量 > 配置里的明文。都没有则无从固化。
  const pwd = (pwdVar && process.env[pwdVar]) || gw.password || '';
  const apiPwd = (apiVar && process.env[apiVar]) || gw.api_pwd || '';
  if (!pwd && !apiPwd) {
    throw new Error(`网关 ${name} 没有可固化的凭据。先 gateway add <name> <url> --overwrite --password .. --api-pwd ..（或当前会话 export ${pwdVar}）`);
  }

  const isWin = process.platform === 'win32';
  const envVars = [];
  if (isWin) {
    // Windows：注册表用户级环境变量（cmd/PowerShell/新进程读取）+ bash profile（Git Bash）
    if (pwd) { await setWindowsUserEnv(pwdVar, pwd); envVars.push(pwdVar); }
    if (apiPwd) { await setWindowsUserEnv(apiVar, apiPwd); envVars.push(apiVar); }
  } else {
    // Linux/macOS：无注册表等价物，凭据经 bash profile 固化
    envVars.push(pwd ? pwdVar : apiVar);
  }
  const bashFiles = [];
  if (pwd) bashFiles.push(...upsertBashExport(pwdVar, pwd));
  if (apiPwd) bashFiles.push(...upsertBashExport(apiVar, apiPwd));

  // 配置改为 env 引用，清掉明文（密文不入盘）
  if (pwd) { gw.password_env = pwdVar; gw.password = ''; }
  if (apiPwd) { gw.api_pwd_env = apiVar; gw.api_pwd = ''; }
  saveConfig(cfg);

  return {
    gateway: name,
    env_vars: envVars,
    persisted_to: isWin ? 'Windows 用户级环境变量(HKCU\\Environment) + bash profile' : 'bash profile（Linux/macOS 无系统级环境变量，走 ~/.bashrc）',
    bash_profiles: [...new Set(bashFiles)],
    note: '新开终端/会话生效；已开着的终端需重开或 source ~/.bashrc。SSH 登录若未生效，确认 ~/.profile 会 source ~/.bashrc。',
  };
}

export const commands = {
  'gateway add': gwAdd,
  'gateway list': gwList,
  'gateway current': gwCurrent,
  'gateway use': gwUse,
  'gateway remove': gwRemove,
  'gateway test': gwTest,
  'gateway persist': gwPersist,
};
