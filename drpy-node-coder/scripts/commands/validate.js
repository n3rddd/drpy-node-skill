/**
 * validate 组命令：syntax / validate / resolved
 * 移植自 drpy-node-mcp/tools/spiderTools.js 的 check_syntax、validate_spider、get_resolved_rule。
 *
 * - syntax <path>  ：读文件(.js 自动 DS 解密) → vm.Script 语法检查
 * - validate <path>：vm sandbox 跑源码 → 校验 rule 对象及必填字段(title/host/url)
 * - resolved <path>：drpyS.getRuleObject 加载源 → 按关键 key 输出模板继承后的最终摘要
 *
 * sandbox 含全量 noop 全局（源码顶层可能引用任意符号，缺失会误报）。
 */
import fs from '../lib/fsUtil.js';
import path from 'path';
import vm from 'vm';

import { resolvePath, isSafePath } from '../lib/pathResolver.js';
import { decodeDsSource } from '../lib/dsHelper.js';
import * as runtime from '../lib/runtime.js';
import { adminFetch, fetchRemoteSource, assertRemotePath } from '../lib/remote.js';

const RULE_SUMMARY_KEYS = [
  'title', 'author', '类型', 'host', 'url', 'homeUrl', 'searchUrl',
  'searchable', 'quickSearch', 'filterable', 'headers', 'timeout',
  'class_name', 'class_url', 'class_parse', 'filter', 'filter_url',
  'play_parse', 'lazy', 'limit', 'double', '推荐', '一级', '二级', '搜索',
  'hostJs', '预处理', '模板', '模板修改',
];

function buildValidateSandbox() {
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    require: () => ({}),
    module: { exports: {} },
    exports: {},
    Buffer,
    WebAssembly: {},
    setTimeout, setInterval, clearTimeout, clearInterval,
    TextEncoder, TextDecoder,
    performance: { now: () => 0 },
    WebSocket: function () {},
    WebSocketServer: function () {},
    URL, URLSearchParams,
    process: { env: {}, cwd: () => '' },
    JSON, Math, Date, Array, String, RegExp, Object, Number, Boolean, Error, TypeError, RangeError, SyntaxError, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, Intl, BigInt,
    parseInt, parseFloat, isNaN, isFinite, NaN, Infinity, undefined, eval, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, escape, unescape, btoa, atob,
  };
  const noop = () => {};
  const noopAsync = async () => '';
  const noopReturn = (v) => v;
  Object.assign(sandbox, {
    MOBILE_UA: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
    PC_UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.54 Safari/537.36',
    UA: 'Mozilla/5.0',
    UC_UA: 'Mozilla/5.0 (Linux; U; Android 9; zh-CN; MI 9 Build/PKQ1.181121.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.108 UCBrowser/12.5.5.1035 Mobile Safari/537.36',
    IOS_UA: 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
    DICT: 'abcdefghijklmnopqrstuvwxyz0123456789',
    RULE_CK: 'cookie',
    CATE_EXCLUDE: '首页|留言|APP|下载|资讯|新闻|动态',
    TAB_EXCLUDE: '猜你|喜欢|下载|剧情|榜|评论',
    OCR_RETRY: 3,
    OCR_API: 'https://api.nn.ci/ocr/b64/text',
    nodata: {},
    SPECIAL_URL: /^(ftp|magnet|thunder|ws):/,
    NOVEL_DIR: '',
    rule: {},
    RKEY: 'validate',
    input: '',
    HOST: '',
    MY_URL: '',
    request: noopAsync,
    post: noopAsync,
    fetch: noopAsync,
    req: noopAsync,
    reqs: noopAsync,
    getHtml: noopAsync,
    getCode: noopAsync,
    checkHtml: async (h) => h,
    reqCookie: async () => ({ cookie: '', html: '' }),
    verifyCode: noopAsync,
    cachedRequest: noopAsync,
    batchFetch: async () => [],
    batchExecute: async () => [],
    XMLHttpRequest: function () { return { open: noop, send: noop, setRequestHeader: noop }; },
    responseBase64: '',
    pdfh: () => '',
    pd: noopReturn,
    pdfa: () => [],
    jsp: () => ({ pdfh: () => '', pd: noopReturn, pdfa: () => [], pdfl: () => [], pq: noopReturn }),
    jsoup: function () { return { pdfh: () => '', pd: noopReturn, pdfa: () => [] }; },
    pdfl: () => [],
    pq: noopReturn,
    pjfh: noopReturn,
    pj: noopReturn,
    pjfa: () => [],
    jsonpath: { query: () => [] },
    executeParse: noopReturn,
    cheerio: { load: () => ({ text: noop, html: noopReturn, find: noopReturn, attr: noopReturn, each: noop }) },
    base64Encode: noopReturn,
    base64Decode: noopReturn,
    md5: noopReturn,
    md5X: noopReturn,
    aes: noopReturn,
    aesX: noopReturn,
    des: noopReturn,
    desX: noopReturn,
    rsa: noopReturn,
    rsaX: noopReturn,
    rc4Encrypt: noopReturn,
    rc4Decrypt: noopReturn,
    rc4: { encrypt: noopReturn, decrypt: noopReturn },
    rc4_decode: noopReturn,
    CryptoJS: {},
    getCryptoJS: () => ({}),
    JSEncrypt: function () {},
    NODERSA: function () {},
    forge: {},
    gzip: noopReturn,
    ungzip: noopReturn,
    pako: {},
    zlib: {},
    encodeStr: noopReturn,
    decodeStr: noopReturn,
    gbkTool: {},
    uint8ArrayToBase64: noopReturn,
    Utf8ArrayToStr: noopReturn,
    urlencode: noopReturn,
    encodeUrl: noopReturn,
    iconv: {},
    setItem: noop,
    getItem: noopReturn,
    clearItem: noop,
    local: { set: noop, get: noopReturn, delete: noop },
    COOKIE: { get: noopReturn, set: noop },
    urljoin: noopReturn,
    urljoin2: noopReturn,
    joinUrl: noopReturn,
    getHome: noopReturn,
    buildUrl: noopReturn,
    getQuery: noopReturn,
    parseQueryString: noopReturn,
    buildQueryString: noopReturn,
    objectToQueryString: noopReturn,
    encodeIfContainsSpecialChars: noopReturn,
    urlDeal: noopReturn,
    tellIsJx: noopReturn,
    pathLib: path,
    qs: { parse: noopReturn, stringify: noopReturn },
    randomUa: { generateUa: () => 'Mozilla/5.0' },
    matchesAll: () => [],
    cut: noopReturn,
    strExtract: noopReturn,
    stringify: (o) => JSON.stringify(o),
    dealJson: noopReturn,
    lrcToSrt: noopReturn,
    naturalSort: noopReturn,
    JSON5: { parse: noopReturn, stringify: noopReturn },
    JSONbig: { parse: noopReturn, stringify: noopReturn },
    JsonBig: { parse: noopReturn, stringify: noopReturn },
    setResult: noopReturn,
    setHomeResult: noopReturn,
    setResult2: noopReturn,
    fixAdM3u8Ai: noopAsync,
    forceOrder: noopReturn,
    keysToLowerCase: noopReturn,
    getOriginalJs: noopReturn,
    vodDeal: {},
    processImage: noop,
    jsEncoder: {},
    jsDecoder: {},
    jinja: { render: noopReturn },
    template: { render: noopReturn },
    log: noop,
    print: noop,
    randStr: noopReturn,
    toBeijingTime: noopReturn,
    computeHash: noopReturn,
    deepCopy: noopReturn,
    sleep: noopAsync,
    sleepSync: noop,
    createBasicAuthHeaders: noopReturn,
    get_size: noopAsync,
    getContentType: noopReturn,
    getMimeType: noopReturn,
    getParsesDict: noopReturn,
    getFirstLetter: noopReturn,
    utils: {},
    misc: {},
    $: noopReturn,
    $js: noopReturn,
    runMain: noopReturn,
    AIS: {},
    OcrApi: { classification: noopAsync },
    simplecc: { t2s: noopReturn, s2t: noopReturn },
    DataBase: function () {},
    database: {},
    CryptoJSW: {},
    hlsParser: {},
    RSA: {},
    jsonToCookie: noopReturn,
    cookieToJson: noopReturn,
    ENV: {},
    _ENV: {},
    axios: { get: noopAsync, post: noopAsync },
    axiosX: noopAsync,
    Quark: {},
    Baidu: {}, Baidu2: {},
    UC: {},
    Ali: {},
    Cloud: {},
    Yun: {},
    Pan: {},
    Xun: {},
    createWebDAVClient: noopReturn,
    createFTPClient: noopReturn,
    js2Proxy: noopReturn,
    JSProxyStream: function () {},
    JSFile: function () {},
    getProxyUrl: noopReturn,
    hexToString: noopReturn,
    stringToHex: noopReturn,
    enBytes2Str: noopReturn,
    str2EnBytes: noopReturn,
    gdb64Decode: noopReturn,
    gdb64Encode: noopReturn,
    compressJs: noopReturn,
    decompressJs: noopReturn,
    decodeBase64Gzip: noopReturn,
    sha1: noopReturn,
    sha256: noopReturn,
    sha512: noopReturn,
    minizlib: {},
  });
  return sandbox;
}

async function readCode(filePath) {
  let code = await fs.readFile(resolvePath(filePath), 'utf-8');
  if (filePath.endsWith('.js')) {
    const fn = await runtime.decoder();
    code = await decodeDsSource(code, fn);
  }
  return code;
}

// ============ 远程实现（服务端执行，以远端为准） ============

/** 远程 syntax：远端服务端检查（支持 js DS 解密 / php -l / py_compile） */
async function remoteSyntax(ctx) {
  const filePath = assertRemotePath(ctx.positional[0]);
  const body = await adminFetch(ctx.target, 'POST', '/api/admin/sources/syntax', { body: { path: filePath } });
  if (!body.isValid) {
    throw new Error(`Syntax Error: ${body.error || body.message || '远端语法检查未通过'}`);
  }
  return { ok: true, file: filePath, message: body.message };
}

/** 远程 validate：远端沙箱执行并校验 rule 必填字段 */
async function remoteValidate(ctx) {
  const filePath = assertRemotePath(ctx.positional[0]);
  const body = await adminFetch(ctx.target, 'POST', '/api/admin/sources/validate', { body: { path: filePath } });
  if (!body.isValid) {
    return { valid: false, file: filePath, error: body.error || body.message || '远端校验未通过' };
  }
  return {
    valid: true,
    file: filePath,
    title: body.title,
    host: body.host,
    message: body.message,
    checked_on: `remote:${ctx.target.name}`,
  };
}

/**
 * 远程 resolved：拉取远端源文件（本地 DS 解密）→ 写系统临时文件 → 本地 getRuleObject 解析。
 * 模板继承用的是 drpy-node 内置模板字典（template.getMubans()），与源文件位置无关，
 * 因此本地引擎即可完整解析远端源的最终规则。
 */
async function remoteResolved(ctx) {
  const filePath = assertRemotePath(ctx.positional[0]);
  const pulled = await fetchRemoteSource(ctx.target, filePath);
  if (pulled.type !== 'text') throw new Error(`不支持对二进制文件执行 resolved: ${filePath}`);

  const os = await import('os');
  const tmpFile = path.join(os.tmpdir(), `drpy-coder-resolved-${Date.now()}-${path.basename(filePath)}`);
  try {
    await fs.writeFile(tmpFile, pulled.content, 'utf-8');
    return await resolveWithEngine(tmpFile);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// ============ 本地实现 ============

/** 用本地 drpyS.getRuleObject 输出规则摘要（本地 resolved 与远程 resolved 共用） */
async function resolveWithEngine(absoluteFilePath) {
  const mod = await runtime.drpyS();
  const getRuleObject = mod.getRuleObject || (mod.default && mod.default.getRuleObject);
  if (typeof getRuleObject !== 'function') {
    throw new Error('libs/drpyS.js 未导出 getRuleObject');
  }
  const rule = await getRuleObject(absoluteFilePath, {}, true);
  if (!rule || !rule.title) {
    throw new Error('No valid rule object found (getRuleObject 返回空)');
  }
  const summary = {};
  for (const key of RULE_SUMMARY_KEYS) {
    if (rule[key] !== undefined) summary[key] = rule[key];
  }
  const extraKeys = Object.keys(rule).filter((k) => !RULE_SUMMARY_KEYS.includes(k) && typeof rule[k] !== 'function');
  if (extraKeys.length > 0) summary._extra_keys = extraKeys;
  return summary;
}

/** syntax <path> */
async function syntax(ctx) {
  if (ctx.target.kind === 'remote') return remoteSyntax(ctx);
  const filePath = ctx.positional[0];
  if (!filePath || !isSafePath(filePath)) throw new Error('Invalid path');
  const code = await readCode(filePath);
  try {
    new vm.Script(code);
    return { ok: true, file: filePath };
  } catch (e) {
    const err = new Error(`Syntax Error: ${e.message}`);
    err.stack = e.stack;
    throw err;
  }
}

/** validate <path> */
async function validate(ctx) {
  if (ctx.target.kind === 'remote') return remoteValidate(ctx);
  const filePath = ctx.positional[0];
  if (!filePath || !isSafePath(filePath)) throw new Error('Invalid path');

  const code = await readCode(filePath);
  const sandbox = buildValidateSandbox();
  vm.createContext(sandbox);
  try {
    new vm.Script(code).runInContext(sandbox);
  } catch (e) {
    return { valid: false, file: filePath, error: `执行/语法错误: ${e.message}` };
  }

  if (!sandbox.rule || typeof sandbox.rule !== 'object') {
    return { valid: false, file: filePath, error: "Missing 'rule' object in spider file." };
  }
  const required = ['title', 'host', 'url'];
  const missing = required.filter((k) => !sandbox.rule[k]);
  if (missing.length > 0) {
    return { valid: false, file: filePath, error: `Missing required rule fields: ${missing.join(', ')}` };
  }
  return {
    valid: true,
    file: filePath,
    title: sandbox.rule.title,
    host: sandbox.rule.host,
    has_class_parse: !!sandbox.rule.class_parse,
    has_lazy: !!(sandbox.rule.lazy || sandbox.rule.play_parse),
    searchable: sandbox.rule.searchable,
  };
}

/** resolved <path> */
async function resolved(ctx) {
  if (ctx.target.kind === 'remote') return remoteResolved(ctx);
  const filePath = ctx.positional[0];
  if (!filePath || !isSafePath(filePath)) throw new Error('Invalid path');

  return await resolveWithEngine(resolvePath(filePath));
}

export const commands = {
  syntax,
  validate,
  resolved,
};
