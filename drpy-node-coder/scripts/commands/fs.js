/**
 * fs 组命令：ls / read / write / rm / edit / find
 * 移植自 drpy-node-mcp/tools/fsTools.js，去掉 MCP 的 content[] 包装，返回纯 data。
 *
 * 双后端：ctx.target.kind === 'remote' 时走远端 /api/admin/files/*（远程网关），
 * 否则直读本地 drpy-node 目录。变换/校验/搜索核心逻辑两端共用。
 *
 * 安全护栏（两端一致）：
 *   - 路径护栏：本地 isSafePath（限定项目内）；远程 assertRemotePath（必须相对远端项目根，
 *     远端自身还有 isSafePath 双保险）
 *   - BLOCKED_EXTENSIONS 禁止写 .md/.txt 等文档类（避免误改文档）
 *   - write/edit 写盘后回读验证，不一致则报错（防假成功）
 *   - edit 的 JS 文件写盘前做 vm.Script 语法校验，失败则不写盘
 *   - edit replace_text 要求唯一匹配；行操作限 200 行
 */
import fs from '../lib/fsUtil.js';
import path from 'path';
import vm from 'vm';

import { resolvePath, isSafePath } from '../lib/pathResolver.js';
import { decodeDsSource } from '../lib/dsHelper.js';
import { decoder } from '../lib/runtime.js';
import { adminFetch, fetchRemoteSource, assertRemotePath } from '../lib/remote.js';

const MAX_AFFECTED_LINES = 200;

const BLOCKED_EXTENSIONS = ['.md', '.txt', '.rst', '.adoc', '.doc', '.docx', '.pdf'];
const BLOCKED_MESSAGE = (ext) =>
  `禁止操作 ${ext} 文件！CLI 文件工具仅用于项目代码文件（.js/.json/.css/.html 等）。文档/README 请用 IDE 的 Write/Edit。`;

function checkBlockedExtension(filePath) {
  const lower = filePath.toLowerCase();
  for (const ext of BLOCKED_EXTENSIONS) {
    if (lower.endsWith(ext)) throw new Error(BLOCKED_MESSAGE(ext));
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** 优先 --content，其次 --content-file，最后 stdin（当 stdin 非 TTY） */
async function readContent(flags) {
  if (flags.content !== undefined) return flags.content;
  if (flags['content-file']) {
    return await fs.readFile(flags['content-file'], 'utf-8');
  }
  if (!process.stdin.isTTY) return await readStdin();
  return undefined;
}

async function decodeJs(content) {
  if (!content.endsWith) return content;
  // 非入口：仅在调用方判断 .js 后使用
  const fn = await decoder();
  return await decodeDsSource(content, fn);
}

// ============ 变换/搜索核心（本地与远程共用） ============

function validateJsSyntax(code) {
  try {
    new vm.Script(code);
    return null;
  } catch (e) {
    return e.message;
  }
}

/**
 * 对内容执行 edit 操作（纯函数，不落盘）。
 * @returns {{content:string, summary:string, changedLines:number, diff:Array}}
 */
function applyEditOperation(originalContent, operation, flags) {
  let content = originalContent;
  let summary = '';

  if (operation === 'replace_text') {
    const { search, replacement } = flags;
    if (!search) throw new Error("replace_text 需要 --search");
    const idx = content.indexOf(search);
    if (idx === -1) {
      throw new Error(`Text not found: "${search.substring(0, 100)}${search.length > 100 ? '...' : ''}"`);
    }
    const secondIdx = content.indexOf(search, idx + 1);
    if (secondIdx !== -1) {
      const ln1 = content.substring(0, idx).split('\n').length;
      const ln2 = content.substring(0, secondIdx).split('\n').length;
      throw new Error(
        `搜索文本有 2+ 处匹配（行 ${ln1} 和 ${ln2}），拒绝替换。请用更长的唯一文本，或先用 fs find 定位。`
      );
    }
    content = content.substring(0, idx) + (replacement || '') + content.substring(idx + search.length);
    summary = `Replaced text at pos ${idx} (${search.length} → ${(replacement || '').length} chars)`;
  } else if (operation === 'replace_lines' || operation === 'delete_lines' || operation === 'insert_lines') {
    const startLine = Number(flags['start-line']);
    const endLine = flags['end-line'] !== undefined ? Number(flags['end-line']) : startLine;
    const lines = content.split('\n');

    if (operation === 'insert_lines') {
      if (!(startLine >= 0)) throw new Error('insert_lines 需要 --start-line >= 0');
      if (startLine > lines.length) throw new Error(`start_line ${startLine} 超范围 (0-${lines.length})`);
      const newContent = flags.__stdinContent || '';
      const newLines = newContent.split('\n');
      if (newLines.length > MAX_AFFECTED_LINES) {
        throw new Error(`insert_lines 将插入 ${newLines.length} 行（上限 ${MAX_AFFECTED_LINES}）`);
      }
      lines.splice(startLine, 0, ...newLines);
      content = lines.join('\n');
      summary = `Inserted ${newLines.length} line(s) ${startLine === 0 ? 'at beginning' : `after line ${startLine}`}`;
    } else {
      if (!(startLine >= 1)) throw new Error(`${operation} 需要 --start-line >= 1`);
      if (startLine > lines.length) throw new Error(`start_line ${startLine} 超范围 (1-${lines.length})`);
      const end = Math.min(endLine || startLine, lines.length);
      if (end < startLine) throw new Error(`end_line ${end} < start_line ${startLine}`);
      const count = end - startLine + 1;
      if (count > MAX_AFFECTED_LINES) {
        throw new Error(`${operation} 将影响 ${count} 行（上限 ${MAX_AFFECTED_LINES}）`);
      }
      if (operation === 'replace_lines') {
        const newContent = flags.__stdinContent || '';
        const newLines = newContent.split('\n');
        lines.splice(startLine - 1, count, ...newLines);
        content = lines.join('\n');
        summary = `Replaced lines ${startLine}-${end} with ${newLines.length} line(s)`;
      } else {
        lines.splice(startLine - 1, count);
        content = lines.join('\n');
        summary = `Deleted lines ${startLine}-${end} (${count} line(s))`;
      }
    }
  } else {
    throw new Error(`Unknown operation: ${operation}`);
  }

  // diff
  const diffLines = [];
  const origLines = originalContent.split('\n');
  const newLines = content.split('\n');
  const maxLen = Math.max(origLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i];
    const n = newLines[i];
    if (o !== n) {
      if (o === undefined) diffLines.push({ line: i + 1, type: 'added', content: n });
      else if (n === undefined) diffLines.push({ line: i + 1, type: 'removed', content: o });
      else diffLines.push({ line: i + 1, type: 'changed', old: o, new: n });
    }
  }

  return { content, summary, changedLines: diffLines.length, diffLines };
}

/** 行/正则搜索（纯函数，本地与远程共用） */
function searchInContent(content, filePath, keyword, useRegex, contextLines, maxMatches) {
  const lines = content.split('\n');
  let pattern;
  if (useRegex) {
    try {
      pattern = new RegExp(keyword);
    } catch (e) {
      throw new Error(`Invalid regex: ${e.message}`);
    }
  }

  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const isMatch = useRegex ? pattern.test(lines[i]) : lines[i].includes(keyword);
    if (isMatch) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      const contextArr = [];
      for (let j = start; j <= end; j++) {
        contextArr.push({ line: j + 1, content: lines[j], isMatch: j === i });
      }
      matches.push({ line: i + 1, text: lines[i], context: contextArr });
      if (matches.length >= maxMatches) break;
    }
  }

  return {
    file: filePath,
    keyword,
    regex: useRegex,
    total_lines: lines.length,
    matches: matches.length,
    results: matches,
  };
}

// ============ 远程实现（/api/admin/files/* + 源目录走 sources/*） ============

/**
 * 远端保护规则：源目录（spider/js 等）不允许通过通用 files API 写/删，
 * 必须走 /api/admin/sources/upload（自带语法校验）与 /api/admin/sources/delete。
 * CLI 遵守同样的分流，保证远程写源与远端管理入口行为一致。
 */
const REMOTE_SOURCE_DIRS = [
  ['spider/js_dr2', 'dr2'],
  ['spider/catvod', 'catvod'],
  ['spider/js', 'js'],
  ['spider/php', 'php'],
  ['spider/py', 'py'],
];

function matchRemoteSourceDir(filePath) {
  const norm = `${String(filePath).replace(/\\/g, '/')}/`;
  for (const [dir, engine] of REMOTE_SOURCE_DIRS) {
    if (norm.startsWith(`${dir}/`)) return { engine, filename: path.basename(filePath) };
  }
  return null;
}

/** 远程写原文（源目录走 upload 覆盖式上传，其余走 files/write），写后回读验证 */
async function remoteWriteRaw(ctx, filePath, content) {
  const src = matchRemoteSourceDir(filePath);
  if (src) {
    await adminFetch(ctx.target, 'POST', '/api/admin/sources/upload', {
      body: { engine: src.engine, filename: src.filename, content, overwrite: true },
    });
  } else {
    await adminFetch(ctx.target, 'POST', '/api/admin/files/write', { body: { path: filePath, content } });
  }
  // 回读验证（读原文，不解密）
  const back = await adminFetch(ctx.target, 'GET', '/api/admin/files/read', { query: { path: filePath } });
  const written = back.content ?? '';
  if (written !== content) {
    throw new Error(
      `WRITE_VERIFICATION_FAILED: 远端写入后回读内容与预期不一致 (expected ${content.length} chars, got ${written.length})`
    );
  }
  return written;
}

async function remoteLs(ctx) {
  const dirPath = assertRemotePath(ctx.positional[0] || '.');
  const body = await adminFetch(ctx.target, 'GET', '/api/admin/files/list', { query: { path: dirPath } });
  return {
    path: dirPath,
    entries: (body.files || []).map((f) => ({ name: f.name, isDirectory: !!f.isDirectory })),
  };
}

async function remoteRead(ctx) {
  const filePath = assertRemotePath(ctx.positional[0]);
  const result = await fetchRemoteSource(ctx.target, filePath);
  if (result.type === 'image') return { type: 'image', dataUrl: result.dataUrl };
  return { type: 'text', content: result.content, decoded: result.decoded };
}

async function remoteWrite(ctx) {
  const filePath = assertRemotePath(ctx.positional[0]);
  const content = await readContent(ctx.flags);
  if (content === undefined) throw new Error('缺少内容：使用 --content / --content-file 或通过 stdin 提供');
  checkBlockedExtension(filePath);

  const written = await remoteWriteRaw(ctx, filePath, content);
  return {
    file: filePath,
    operation: matchRemoteSourceDir(filePath) ? 'remote_source_upload' : 'remote_write',
    writeVerification: { passed: true, expectedLength: content.length, actualLength: written.length },
  };
}

async function remoteRm(ctx) {
  const filePath = assertRemotePath(ctx.positional[0]);
  const src = matchRemoteSourceDir(filePath);
  if (src) {
    await adminFetch(ctx.target, 'POST', '/api/admin/sources/delete', { body: { path: filePath } });
  } else {
    await adminFetch(ctx.target, 'DELETE', '/api/admin/files/delete', { query: { path: filePath } });
  }
  return { file: filePath, deleted: true };
}

async function remoteEdit(ctx) {
  const filePath = assertRemotePath(ctx.positional[0]);
  const operation = ctx.positional[1] || ctx.flags.operation;
  if (!operation) throw new Error('operation 必填：replace_text/replace_lines/delete_lines/insert_lines');
  checkBlockedExtension(filePath);

  // 行操作的新内容来自 --content/--content-file/stdin，先读出再进纯函数
  const flags = { ...ctx.flags };
  if (['replace_lines', 'insert_lines'].includes(operation)) {
    flags.__stdinContent = (await readContent(ctx.flags)) || '';
  }

  // 读远端原文（不解密，与本地 edit 行为一致）
  const back = await adminFetch(ctx.target, 'GET', '/api/admin/files/read', { query: { path: filePath } });
  if (!back || back.type !== 'text') throw new Error(`File not found or unreadable: ${filePath}`);
  const originalContent = back.content ?? '';

  const isJsFile = filePath.endsWith('.js');
  const applied = applyEditOperation(originalContent, operation, flags);
  if (isJsFile) {
    const syntaxError = validateJsSyntax(applied.content);
    if (syntaxError) {
      throw new Error(`JS_SYNTAX_CHECK_FAILED: 编辑会破坏 JS 语法，文件未修改。${syntaxError}`);
    }
  }

  const written = await remoteWriteRaw(ctx, filePath, applied.content);

  const diff = applied.diffLines.length > 50
    ? applied.diffLines.slice(0, 50).concat([{ type: 'truncated', info: `还有 ${applied.diffLines.length - 50} 处变更` }])
    : applied.diffLines;

  return {
    file: filePath,
    operation: applied.summary,
    changes: applied.changedLines,
    diff,
    syntaxCheck: isJsFile ? 'PASSED' : undefined,
    writeVerification: { passed: true, expectedLength: applied.content.length, actualLength: written.length },
  };
}

async function remoteFind(ctx) {
  const filePath = assertRemotePath(ctx.positional[0]);
  const keyword = ctx.positional[1];
  if (!keyword) throw new Error('keyword 必填');
  const useRegex = ctx.flags.regex === 'true' || ctx.flags.regex === true;
  const contextLines = ctx.flags['surrounding-lines'] !== undefined ? Number(ctx.flags['surrounding-lines']) : 2;
  const maxMatches = ctx.flags['max-matches'] !== undefined ? Number(ctx.flags['max-matches']) : 20;

  const result = await fetchRemoteSource(ctx.target, filePath);
  if (result.type !== 'text') throw new Error(`不支持对二进制/图片文件执行 find: ${filePath}`);
  return searchInContent(result.content, filePath, keyword, useRegex, contextLines, maxMatches);
}

// ============ 本地实现 ============

/** ls [path] */
async function ls(ctx) {
  if (ctx.target.kind === 'remote') return remoteLs(ctx);
  const dirPath = ctx.positional[0] || '.';
  if (!isSafePath(dirPath)) throw new Error('Access denied: 路径超出 drpy-node 项目范围');
  const fullPath = resolvePath(dirPath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  return {
    path: dirPath,
    entries: entries.map((f) => ({ name: f.name, isDirectory: f.isDirectory() })),
  };
}

/** read <path> */
async function read(ctx) {
  if (ctx.target.kind === 'remote') return remoteRead(ctx);
  const filePath = ctx.positional[0];
  if (!filePath || !isSafePath(filePath)) throw new Error('Invalid path');

  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff', '.tif'];
  if (imageExts.some((ext) => filePath.toLowerCase().endsWith(ext))) {
    const buffer = await fs.readFile(resolvePath(filePath));
    const ext = filePath.split('.').pop().toLowerCase();
    const mimeTypes = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
      tiff: 'image/tiff', tif: 'image/tiff',
    };
    const mimeType = mimeTypes[ext] || 'image/png';
    return { type: 'image', mimeType, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` };
  }

  let content = await fs.readFile(resolvePath(filePath), 'utf-8');
  let decoded = false;
  if (filePath.endsWith('.js')) {
    content = await decodeJs(content);
    decoded = true;
  }
  return { type: 'text', content, decoded };
}

/** write <path> [--content|--content-file|stdin] */
async function write(ctx) {
  if (ctx.target.kind === 'remote') return remoteWrite(ctx);
  const filePath = ctx.positional[0];
  const content = await readContent(ctx.flags);
  if (filePath === undefined || !isSafePath(filePath)) throw new Error('Invalid path');
  if (content === undefined) throw new Error('缺少内容：使用 --content / --content-file 或通过 stdin 提供');
  checkBlockedExtension(filePath);

  const fullPath = resolvePath(filePath);
  const existed = await fs.pathExists(fullPath);
  const beforeStat = existed ? await fs.stat(fullPath) : null;
  await fs.outputFile(fullPath, content);
  const written = await fs.readFile(fullPath, 'utf-8');
  const afterStat = await fs.stat(fullPath);

  if (written !== content) {
    throw new Error(
      `WRITE_VERIFICATION_FAILED: 写入后回读内容与预期不一致 (expected ${content.length} chars, got ${written.length})`
    );
  }

  return {
    file: filePath,
    operation: existed ? 'overwrite' : 'create',
    writeVerification: {
      passed: true,
      expectedLength: content.length,
      actualLength: written.length,
      sizeBefore: beforeStat ? beforeStat.size : 0,
      sizeAfter: afterStat.size,
    },
  };
}

/** rm <path> */
async function rm(ctx) {
  if (ctx.target.kind === 'remote') return remoteRm(ctx);
  const filePath = ctx.positional[0];
  if (!filePath || !isSafePath(filePath)) throw new Error('Invalid path');
  await fs.remove(resolvePath(filePath));
  return { file: filePath, deleted: true };
}

/** edit <path> <op> [--search --replacement | --start-line --end-line --content] */
async function edit(ctx) {
  if (ctx.target.kind === 'remote') return remoteEdit(ctx);
  const filePath = ctx.positional[0];
  const operation = ctx.positional[1] || ctx.flags.operation;
  if (!filePath || !isSafePath(filePath)) throw new Error('Invalid path');
  if (!operation) throw new Error('operation 必填：replace_text/replace_lines/delete_lines/insert_lines');
  checkBlockedExtension(filePath);

  const fullPath = resolvePath(filePath);
  if (!(await fs.pathExists(fullPath))) throw new Error(`File not found: ${filePath}`);

  const flags = { ...ctx.flags };
  if (['replace_lines', 'insert_lines'].includes(operation)) {
    flags.__stdinContent = (await readContent(ctx.flags)) || '';
  }

  let content = await fs.readFile(fullPath, 'utf-8');
  const originalContent = content;
  const originalStat = await fs.stat(fullPath);

  const applied = applyEditOperation(content, operation, flags);
  content = applied.content;

  const isJsFile = filePath.endsWith('.js');
  if (isJsFile) {
    const syntaxError = validateJsSyntax(content);
    if (syntaxError) {
      const err = new Error(`JS_SYNTAX_CHECK_FAILED: 编辑会破坏 JS 语法，文件未修改。${syntaxError}`);
      err.notWritten = true;
      err.syntaxError = syntaxError;
      throw err;
    }
  }

  await fs.writeFile(fullPath, content, 'utf-8');
  const written = await fs.readFile(fullPath, 'utf-8');
  const writtenStat = await fs.stat(fullPath);
  if (written !== content) {
    throw new Error(`WRITE_VERIFICATION_FAILED: 编辑写盘后回读不一致 (expected ${content.length}, got ${written.length})`);
  }

  const diff = applied.diffLines.length > 50
    ? applied.diffLines.slice(0, 50).concat([{ type: 'truncated', info: `还有 ${applied.diffLines.length - 50} 处变更` }])
    : applied.diffLines;

  return {
    file: filePath,
    operation: applied.summary,
    changes: applied.changedLines,
    diff,
    syntaxCheck: isJsFile ? 'PASSED' : undefined,
    writeVerification: {
      passed: true,
      expectedLength: content.length,
      actualLength: written.length,
      sizeBefore: originalStat.size,
      sizeAfter: writtenStat.size,
    },
  };
}

/** find <path> <keyword> [--regex --surrounding-lines N --max-matches N] */
async function find(ctx) {
  if (ctx.target.kind === 'remote') return remoteFind(ctx);
  const filePath = ctx.positional[0];
  const keyword = ctx.positional[1];
  const useRegex = ctx.flags.regex === 'true' || ctx.flags.regex === true;
  const contextLines = ctx.flags['surrounding-lines'] !== undefined ? Number(ctx.flags['surrounding-lines']) : 2;
  const maxMatches = ctx.flags['max-matches'] !== undefined ? Number(ctx.flags['max-matches']) : 20;

  if (!filePath || !isSafePath(filePath)) throw new Error('Invalid path');
  if (!keyword) throw new Error('keyword 必填');

  const fullPath = resolvePath(filePath);
  if (!(await fs.pathExists(fullPath))) throw new Error(`File not found: ${filePath}`);

  let content = await fs.readFile(fullPath, 'utf-8');
  if (filePath.endsWith('.js')) content = await decodeJs(content);

  return searchInContent(content, filePath, keyword, useRegex, contextLines, maxMatches);
}

export const commands = {
  'fs ls': ls,
  'fs read': read,
  'fs write': write,
  'fs rm': rm,
  'fs edit': edit,
  'fs find': find,
};
