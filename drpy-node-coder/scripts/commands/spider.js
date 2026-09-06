/**
 * spider 组命令（P3 静态 + P4 运行时）。
 * 移植自 drpy-node-mcp/tools/spiderTools.js，去掉 MCP content[] 包装。
 *
 * 静态命令(P3)：src list / src routes / template / libs / api-list / claw-ds
 * 运行时命令(P4)：fetch / analyze / guess / iframe / debug / filter
 *   运行时命令经 runtime 懒加载 drpy-node 的 req / htmlParser(jsoup) / cheerio。
 *   filter 改用 drpy req（原版用 axios），统一请求栈、去掉 axios 依赖。
 */
import fs from '../lib/fsUtil.js';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

import { resolvePath } from '../lib/pathResolver.js';
import * as runtime from '../lib/runtime.js';
import { flagBool } from '../lib/argv.js';
import { adminFetch } from '../lib/remote.js';
import { makeSpiderTemplate, DRPY_LIBS_INFO, DRPY_API_LIST } from '../data/spider-static.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

/** CLI flags/headers → req options */
function buildOptions(ctx, defaultUA) {
  const opt = {};
  if (ctx.flags.method) opt.method = ctx.flags.method;
  if (ctx.headers && Object.keys(ctx.headers).length) opt.headers = { ...ctx.headers };
  else if (defaultUA) opt.headers = { 'User-Agent': defaultUA };
  if (ctx.flags.data !== undefined) opt.data = ctx.flags.data;
  if (!opt.method) opt.method = 'GET';
  return opt;
}

function extractBody(res) {
  if (res && typeof res === 'object') {
    if (res.content !== undefined) return res.content;
    if (res.data !== undefined) return res.data;
  }
  return res;
}

// ============ P3 静态命令 ============

async function listSources(ctx) {
  const filterKw = ctx.flags.filter;
  const applyFilter = (arr) => (filterKw ? arr.filter((f) => f.includes(filterKw)) : arr);
  // 远程：/api/admin/sources 按引擎分组返回（js/dr2/catvod/php/py + disabled）
  if (ctx.target.kind === 'remote') {
    const body = await adminFetch(ctx.target, 'GET', '/api/admin/sources');
    const result = {
      'spider/js': applyFilter(body.js || []),
      'spider/js_dr2': applyFilter(body.dr2 || []),
      'spider/catvod': applyFilter(body.catvod || []),
      'spider/php': applyFilter(body.php || []),
      'spider/py': applyFilter(body.py || []),
    };
    if (Array.isArray(body.disabled) && body.disabled.length > 0) result.disabled = body.disabled;
    if (filterKw) result.filtered_by = filterKw;
    return result;
  }
  const result = { 'spider/js': [], 'spider/catvod': [] };
  const jsDir = resolvePath('spider/js');
  const catvodDir = resolvePath('spider/catvod');
  if (await fs.pathExists(jsDir)) {
    result['spider/js'] = applyFilter((await fs.readdir(jsDir)).filter((f) => f.endsWith('.js')));
  }
  if (await fs.pathExists(catvodDir)) {
    result['spider/catvod'] = applyFilter((await fs.readdir(catvodDir)).filter((f) => f.endsWith('.js')));
  }
  if (filterKw) result.filtered_by = filterKw;
  return result;
}

async function routes(ctx) {
  if (ctx.target.kind === 'remote') {
    const body = await adminFetch(ctx.target, 'GET', '/api/admin/routes');
    return { gateway: ctx.target.name, routes: body };
  }
  const p = resolvePath('controllers/index.js');
  if (!(await fs.pathExists(p))) {
    return { registered_controllers: [], note: 'controllers/index.js not found' };
  }
  const content = await fs.readFile(p, 'utf-8');
  const registered = content
    .split('\n')
    .filter((l) => l.trim().startsWith('fastify.register('))
    .map((l) => l.trim());
  return { file: 'controllers/index.js', registered_controllers: registered };
}

async function template(ctx) {
  if (ctx.target.kind === 'remote') {
    const body = await adminFetch(ctx.target, 'GET', '/api/admin/sources/template');
    return { template: body.template || body };
  }
  return { template: makeSpiderTemplate() };
}

async function libs() {
  return DRPY_LIBS_INFO;
}

async function apiList() {
  return DRPY_API_LIST;
}

async function clawDs(ctx) {
  const lang = ctx.flags.lang === 'zh' ? 'zh' : 'en';
  const fileName = lang === 'zh' ? 'skills-zh.md' : 'skills.md';
  const p = path.join(__dirname, '..', 'data', fileName);
  if (!(await fs.pathExists(p))) throw new Error(`${fileName} 数据文件缺失`);
  const content = await fs.readFile(p, 'utf-8');
  return { lang, content };
}

// ============ P4 运行时命令 ============

async function fetch(ctx) {
  const url = ctx.positional[0];
  if (!url) throw new Error('url 必填');
  const reqFn = await runtime.req();
  const opt = buildOptions(ctx);
  const res = await reqFn(url, opt);
  return {
    status: (res && (res.code || res.status)) || null,
    statusText: (res && res.statusText) || '',
    headers: (res && res.headers) || {},
    data: extractBody(res),
  };
}

async function analyze(ctx) {
  const url = ctx.positional[0];
  if (!url) throw new Error('url 必填');
  const reqFn = await runtime.req();
  const cheerio = await runtime.cheerio();
  const opt = buildOptions(ctx, PC_UA);
  const res = await reqFn(url, opt);
  const html = extractBody(res);
  const $ = cheerio.load(html);
  $('script, style, link, meta, noscript, iframe, svg, path, nav, footer').remove();
  let simplified = $('body').html() || '';
  simplified = simplified.replace(/\n\s*\n/g, '\n').substring(0, 15000);
  return { url, title: $('title').text().trim(), simplifiedHtml: simplified };
}

async function guess(ctx) {
  const url = ctx.positional[0];
  if (!url) throw new Error('url 必填');
  const reqFn = await runtime.req();
  const cheerio = await runtime.cheerio();
  const opt = buildOptions(ctx);
  const res = await reqFn(url, opt);
  const html = extractBody(res);
  const $ = cheerio.load(html);

  let matched = '未匹配到任何内置模板';
  if ($('.stui-header__menu').length > 0 || $('.stui-vodlist').length > 0) matched = '首图2 (stui-vodlist特征)';
  else if ($('.myui-header__menu').length > 0 || $('.myui-vodlist').length > 0) matched = '首图 (myui-vodlist特征)';
  else if ($('.module-poster-item').length > 0 || $('.module-item').length > 0) matched = 'mxpro (module-item特征)';
  else if ($('.module-list').length > 0 && $('.module-items').length > 0) matched = 'mxone5 (module-items特征)';
  else if ($('.top_nav').length > 0 || $('.cbox_list').length > 0) matched = 'mx (top_nav特征)';
  else if ($('rss').length > 0 || $('video').length > 0 || html.includes('<?xml')) matched = '采集1 (XML/RSS特征)';

  return {
    url,
    title: $('title').text().trim(),
    matchedTemplate: matched,
    tip: matched.startsWith('未匹配') ? undefined : `匹配到内置模板，可在 rule 中设置 "模板: '${matched.split(' ')[0]}'" 并只覆盖特殊字段`,
  };
}

async function iframe(ctx) {
  const url = ctx.positional[0];
  if (!url) throw new Error('url 必填');
  const reqFn = await runtime.req();
  const cheerio = await runtime.cheerio();
  const opt = buildOptions(ctx, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  const res = await reqFn(url, opt);
  const html = extractBody(res);
  const $ = cheerio.load(html);
  const iframes = $('iframe');
  if (iframes.length === 0) {
    return { url, found: false, note: '页面无 iframe，可检查 script 数据（如 player_aaaa）' };
  }
  const srcs = [];
  iframes.each((i, el) => srcs.push($(el).attr('src')));
  return {
    url,
    found: true,
    iframes: srcs,
    lazyHint: 'lazy 函数示例: var src = pdfh(await request(input), "iframe&&src");',
  };
}

async function debug(ctx) {
  const rule = ctx.flags.rule;
  const mode = ctx.flags.mode;
  if (!rule) throw new Error('--rule 必填');
  if (!['pdfa', 'pdfh', 'pd'].includes(mode)) throw new Error('--mode 必填: pdfa | pdfh | pd');

  const { jsoup } = await runtime.parser();
  if (!jsoup) throw new Error('jsoup 加载失败（htmlParser.js 未导出 jsoup）');

  let content = ctx.flags.html;
  const url = ctx.flags.url;
  let finalUrl = ctx.flags['base-url'] || url;

  if (url && !content) {
    const reqFn = await runtime.req();
    const opt = buildOptions(ctx);
    const res = await reqFn(url, opt);
    content = extractBody(res);
    if (!finalUrl) finalUrl = url;
  }
  if (!content) throw new Error('提供 --html 或 --url');

  const j = new jsoup(finalUrl || '');
  let result;
  if (mode === 'pdfa') result = j.pdfa(content, rule);
  else if (mode === 'pdfh') result = j.pdfh(content, rule);
  else result = j.pd(content, rule);
  return {
    mode,
    rule,
    count: Array.isArray(result) ? result.length : result ? 1 : 0,
    result,
  };
}

// extractFilter 逻辑（原 extractFilter.js，axios → drpy req）
function extractCmsFilter($, drpyFilter) {
  const blocks = $(
    '.stui-screen__list, .myui-screen__list, .module-screen, .screen-list, ' +
      'dl.type, .filter-list, .screen-box, .stui-screen, .myui-screen'
  );
  if (blocks.length === 0) return false;
  const typeName = '*';
  blocks.each((idx, el) => {
    const filterName = $(el).find('span.text-muted, dt, .text-muted, .filter-title').first().text().trim();
    let keyName = '';
    if (filterName.includes('地区') || filterName.includes('area')) keyName = 'area';
    else if (filterName.includes('年份') || filterName.includes('year')) keyName = 'year';
    else if (filterName.includes('类型') || filterName.includes('class') || filterName.includes('genre')) keyName = 'class';
    else if (filterName.includes('排序') || filterName.includes('sort') || filterName.includes('order')) keyName = 'order';
    else if (filterName) keyName = filterName;
    if (!keyName) return;
    $(el)
      .find('a')
      .each((i, a) => {
        const text = $(a).text().trim();
        const href = $(a).attr('href') || '';
        let val = '';
        const m = href.match(/[?&](\w+)=(\w+)/);
        if (m) val = m[2];
        if (text === '全部' || text === '全部类型' || text === '全部地区' || text === '全部年份') val = '';
        if (!text) return;
        if (!drpyFilter[typeName]) drpyFilter[typeName] = {};
        if (!drpyFilter[typeName][keyName]) drpyFilter[typeName][keyName] = [];
        if (!drpyFilter[typeName][keyName].find((x) => x.n === text)) {
          drpyFilter[typeName][keyName].push({ n: text, v: val });
        }
      });
  });
  return true;
}

const KEY_NAME_MAP = { class: '类型', area: '地区', year: '年份', sort: '排序', sort_field: '排序', by: '排序', order: '排序' };

async function filter(ctx) {
  const urls = ctx.positional;
  if (!urls.length) throw new Error('至少提供一个 url');
  const isGzip = flagBool(ctx.flags, 'gzip');
  const reqFn = await runtime.req();
  const cheerio = await runtime.cheerio();
  const headers = { 'User-Agent': 'MOBILE_UA', ...(ctx.headers || {}) };

  const drpyFilter = {};
  for (const baseUrl of urls) {
    const res = await reqFn(baseUrl, { method: 'GET', headers });
    const html = extractBody(res);
    const $ = cheerio.load(html);
    extractCmsFilter($, drpyFilter);
    const links = $('a').toArray();
    links.forEach((a) => {
      const href = $(a).attr('href');
      if (href && (href.includes('.html?') || href.startsWith('?'))) {
        const text = $(a).text().trim();
        let typeName = '*';
        let keyName = '';
        let val = '';
        if (href.startsWith('?')) {
          const mu = baseUrl.match(/\/([^/.]+)\.html/);
          if (mu) typeName = mu[1];
          const mh = href.match(/\?(.*?)=([^&]+)/);
          if (mh) { keyName = mh[1]; val = mh[2]; }
        } else {
          const m = href.match(/\/([^/.]+)\.html\?(.*?)=([^&]+)/);
          if (m) { typeName = m[1]; keyName = m[2]; val = m[3]; }
        }
        if (keyName && val !== undefined) {
          if (['page', 'p', 'pg'].includes(keyName.toLowerCase())) return;
          if (['全部', '全部类型', '全部地区', '全部年份'].includes(text)) val = '';
          if (!drpyFilter[typeName]) drpyFilter[typeName] = {};
          if (!drpyFilter[typeName][keyName]) drpyFilter[typeName][keyName] = [];
          if (!drpyFilter[typeName][keyName].find((x) => x.n === text)) {
            drpyFilter[typeName][keyName].push({ n: text, v: val });
          }
        }
      }
    });
  }

  const finalFilter = {};
  for (const type of Object.keys(drpyFilter)) {
    finalFilter[type] = [];
    for (const key of Object.keys(drpyFilter[type])) {
      const vals = drpyFilter[type][key];
      const allIdx = vals.findIndex((x) => x.n.includes('全部') || x.v === '');
      if (allIdx > 0) {
        const all = vals.splice(allIdx, 1)[0];
        all.n = '全部'; all.v = '';
        vals.unshift(all);
      } else if (allIdx === -1) {
        vals.unshift({ n: '全部', v: '' });
      }
      finalFilter[type].push({ key, name: KEY_NAME_MAP[key] || key, value: vals });
    }
  }

  if (isGzip) {
    const zipped = zlib.gzipSync(Buffer.from(JSON.stringify(finalFilter)));
    return { gzip: zipped.toString('base64') };
  }
  return { filter: finalFilter };
}

export const commands = {
  'src list': listSources,
  'src routes': routes,
  template,
  libs,
  'api-list': apiList,
  'claw-ds': clawDs,
  fetch,
  analyze,
  guess,
  iframe,
  debug,
  filter,
};
