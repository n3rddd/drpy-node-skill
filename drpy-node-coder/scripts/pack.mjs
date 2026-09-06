#!/usr/bin/env node
/**
 * 打包 skill 为分发 zip（防泄漏）。
 *
 * 原则：网关配置/凭据/~/.drpy-node-coder 全在用户目录与系统环境变量，skill 目录本应无状态；
 * 但运行期可能产生本机残留（.drpy-root、logs、local、config），本脚本把它们全部排除，
 * 消除"打包时忘记排除"的根因。任何情况下都不要手工 zip 整个目录代替本脚本。
 *
 * 用法: node scripts/pack.mjs   → 输出 ../drpy-node-coder-YYYYMMDD.zip
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // .../drpy-node-coder/scripts
const skillDir = path.resolve(__dirname, '..'); // .../drpy-node-coder
const outDir = path.resolve(skillDir, '..');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const out = path.join(outDir, `drpy-node-coder-${stamp}.zip`);

// 排除：运行态/本机文件（含历史遗留位置），以及任何可能的 zip 套娃
const excludes = [
  'drpy-node-coder/scripts/.drpy-root',
  'drpy-node-coder/scripts/logs',
  'drpy-node-coder/scripts/local',
  'drpy-node-coder/scripts/config',
  'drpy-node-coder/scripts/node_modules',
  '*.zip',
];

// Windows 用系统自带 bsdtar（支持 -a 出 zip 与 --exclude）；Git Bash 的 GNU tar 不支持 zip，须走绝对路径
const tarExe = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

// 非 Windows：GNU tar 不支持 zip 输出。分发打包约定在 Windows 侧执行；Linux/macOS 明确报错而非产出坏包
if (process.platform !== 'win32') {
  let isBsd = false;
  try { isBsd = execFileSync('tar', ['--version'], { encoding: 'utf-8' }).includes('bsdtar'); } catch { /* tar 缺失 */ }
  if (!isBsd) {
    console.error('打包约定在 Windows 执行（GNU tar 不支持 zip）。Linux/macOS 需安装 bsdtar(libarchive) 后重试，或改用：');
    console.error('  zip -r drpy-node-coder.zip drpy-node-coder -x "drpy-node-coder/scripts/.drpy-root" "drpy-node-coder/scripts/logs/*" "drpy-node-coder/scripts/local/*" "drpy-node-coder/scripts/config/*" "drpy-node-coder/scripts/node_modules/*" "*.zip"');
    process.exit(1);
  }
}

const args = ['-a', '-c', '-f', out, ...excludes.flatMap((e) => ['--exclude', e]), '-C', outDir, 'drpy-node-coder'];
execFileSync(tarExe, args, { stdio: 'inherit' });

const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`打包完成: ${out} (${mb} MB)`);
console.log('已排除: scripts/{.drpy-root,logs,local,config,node_modules}；网关凭据在 ~/.drpy-node-coder 与系统环境变量，不在包内。');
