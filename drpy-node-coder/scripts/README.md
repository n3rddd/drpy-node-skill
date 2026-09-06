# drpy-node-coder CLI

自包含命令行工具，替代 `drpy-node-mcp` MCP 服务。配合 `drpy-node-coder` skill 使用，AI 在 skill 内直接 `node scripts/cli.js <命令>` 完成爬虫源的开发、测试、修复与仓库发布。

## 便携性

- ✅ 免去 MCP server 常驻进程与 stdio/sse 客户端配置
- ✅ **零 npm 依赖**：无需 `npm install`。`localDsCore` bundle（14M，含 cheerio/axios/drpyS/htmlParser 全内联）+ sqlite + 编码 wasm 自带于 `vendor/`
- ⚠️ 仍需 `drpy-node` 项目在本地：CLI 复用其 `req`/`pdfa`/`drpyS`/DS解密 **源码模块**（这些互相 import，非 bundle，搬不动）；但最重的 `localDsCore` 测试引擎已内联进 `vendor/`，`test`/`evaluate` 不再依赖 `drpy-node-bundle` 目录
- ⚠️ `simplecc`（GBK 编码转换）为可选：上游 bundle 在任意位置均加载失败（`__wbindgen_placeholder__`），仅影响 GBK 站点，JSON API / UTF-8 源不受影响

## 无状态与分发安全

**skill 目录完全无状态**：网关配置/凭据在 `~/.drpy-node-coder/gateways.json`（凭据值固化为 Windows 用户级环境变量 + bash profile，见 gateway persist），drpy-node 根定位在 `~/.drpy-node-coder/drpy-root`——都不在 skill 目录、不进 git。

**分发打包必须用 `node scripts/pack.mjs`**（勿手工 zip）：自动排除运行期可能产生的本机残留（`scripts/{.drpy-root,logs,local,config,node_modules}`），输出 `../drpy-node-coder-YYYYMMDD.zip`（约 5MB）。

## 首次使用

```bash
cd drpy-node-coder/scripts
node cli.js setup E:/gitwork/drpy-node        # 定位 drpy-node 项目根（写入 .drpy-root）
node cli.js doctor                            # 自检（含 vendor/ 运行时检查）
```

定位优先级：`--root` 参数 > 环境变量 `DRPY_NODE_ROOT` > `.drpy-root` 文件 > 向上查找 > `../drpy-node` fallback。

## 网关与远程执行

CLI 支持多网关：除本地 drpy-node（`local`，默认）外，可注册任意多个远程部署的 drpy-node 作为网关，`--target <网关名>` 显式指定或 `gateway use` 切换默认目标。

```bash
node cli.js gateway add prod http://1.2.3.4:5757 --user admin --password .. --api-pwd ..
node cli.js gateway persist prod    # 凭据固化：写入 Windows 用户级环境变量 + Git Bash profile
node cli.js gateway test prod       # 探活 + 版本 + 关键端点可用性
node cli.js gateway use prod        # 之后所有命令默认打 prod（nvm use 式）
node cli.js src list --target prod  # 单次显式覆盖
node cli.js gateway use local       # 切回本地
```

- **凭据固化（persist）**：把凭据写入 Windows 用户级环境变量（`HKCU\Environment`，新开终端生效）与 `~/.bashrc`/`~/.bash_profile`（幂等 upsert），配置文件改存变量名、清掉明文。persist 后任何新会话零配置可用；仅已开着的旧终端需重开。
- 配置存于 `~/.drpy-node-coder/gateways.json`（用户目录，不随任何 git 仓库发布）
- `user`/`password` 对应远端 `.env` 的 `API_AUTH_NAME`/`API_AUTH_CODE`（远端未配置则无需凭据）；`api_pwd` 对应远端 `API_PWD`
- 远程验证口径：`test`/`evaluate`/`syntax`/`validate` 在远程网关时执行于远端（远端运行时真实行为，含其环境变量/插件/缓存）；`fetch`/`analyze`/`guess`/`debug` 等外部站点分析永远本地执行；`house *` 与网关无关
- 远程写源遵守远端保护规则：源目录走 `sources/upload`（自带语法校验）/`sources/delete`，其余走 files API
- 远程 `resolved`：拉取远端源到系统临时文件，用本地引擎解析（模板字典是 drpy-node 内置的，与文件位置无关），完成后即删临时文件
- 错误自解释：401=核对凭据；403 只读模式=远端 `.env` 设 `READ_ONLY_MODE=0` 重启；404 无此 API=升级远端 drpy-node
- hipy/py 源在远端改动后需远端自行重启服务（daemon 缓存），CLI 不自动 restart

## 输出约定

所有命令输出 JSON：

- 成功：`{"ok":true,"data":...}`，退出码 0
- 失败：`{"ok":false,"error":"...","message":"..."}`，退出码 1

## 命令清单

### 元命令
| 命令 | 说明 |
|---|---|
| `setup <drpy-node-路径>` | 写入 `.drpy-root` |
| `where` | 显示当前定位的 drpy-node 根 |
| `doctor` | 自检：node 版本、根定位、关键运行时模块、house 配置、网关概览 |
| `help` | 列出所有可用命令 |

### 网关（gateway 组）
| 命令 | 说明 |
|---|---|
| `gateway add <name> <url> [--user --password-env --password --api-pwd-env --api-pwd --note] [--overwrite]` | 注册远程网关 |
| `gateway persist <name>` | 凭据固化到 Windows 用户级环境变量 + Git Bash profile（配置改存变量名，清明文；幂等） |
| `gateway list` / `gateway current` | 列网关（凭据脱敏）/ 当前网关 |
| `gateway use <name>` | 切换默认网关（`local` 亦可） |
| `gateway remove <name>` | 删除网关 |
| `gateway test [name]` | 探活 + 版本 + 端点可用性 |

所有业务命令支持全局 `--target <网关名>` 单次覆盖；缺省用 `gateway use` 设置的当前网关（初始 `local`）。

### 文件系统（fs 组）
| 命令 | 说明 |
|---|---|
| `fs ls [path]` | 列目录 |
| `fs read <path>` | 读文件（DS 源自动解密） |
| `fs write <path> --content ...` | 写文件（支持 `--content-file`/stdin） |
| `fs rm <path>` | 删除 |
| `fs edit <path> <op> ...` | replace_text/replace_lines/delete_lines/insert_lines（JS 语法校验） |
| `fs find <path> <keyword>` | 搜索（`--regex --surrounding-lines --max-matches`） |

### 爬虫开发
| 命令 | 说明 |
|---|---|
| `src list` / `src routes` | 列源 / 路由信息 |
| `fetch <url>` | 用 drpy `req` 抓取（`--method --header k=v --data`） |
| `analyze <url>` | 抓取并清洗 HTML 输出精简 DOM |
| `guess <url>` | 模板探测 |
| `debug --rule <r> --mode <m>` | 规则调试（pdfa/pdfh/pd） |
| `filter <url...>` | 提取筛选字典（`--gzip`） |
| `iframe <url>` | 提取播放页 iframe src |
| `template` / `libs` / `api-list` | 模板 / 全局函数 / API 列表 |
| `claw-ds [--lang en|zh]` | 自动写源 Prompt |

### 验证
| 命令 | 说明 |
|---|---|
| `syntax <path>` | JS 语法检查 |
| `validate <path>` | 语法 + Rule 结构 |
| `resolved <path>` | 模板继承后最终 rule |

### 测试（依赖 localDsCore）
| 命令 | 说明 |
|---|---|
| `test <source> <home|category|detail|search|play>` | 单接口测试 |
| `evaluate <source>` | 全流程评分（首页20+一级20+二级25+播放25+搜索10） |

### 仓库（house）
| 命令 | 说明 |
|---|---|
| `house verify` | 验证仓库连通与 TOKEN |
| `house list` | 文件列表（`--search --tag --page --limit`） |
| `house upload <path>` | 上传（自动同名替换，`--tags --is-public --auto-replace`） |
| `house replace <id> <path>` | 按 ID 替换 |
| `house delete <id>` | 删除 |
| `house info <cid>` | 元数据 |
| `house toggle <id>` | 公开/私密切换 |
| `house tags <id> --tags <t>` | 更新标签 |

### 系统
| 命令 | 说明 |
|---|---|
| `logs [--lines N]` | 日志 |
| `sql <query>` | 只读 SELECT |
| `config get [key]` / `config set <k> <v>` | 配置读写（点语法） |
| `restart` | PM2 重启 drpys |

## 实现进度

- [x] P1 骨架（cli/argv/pathResolver/runtime/output/dsHelper + 元命令）
- [x] P2 fs 组（ls/read/write/rm/edit/find + DS 解密 + 语法校验护栏）
- [x] P3 spider 无运行时命令（list/routes/template/libs/api-list/claw-ds）
- [x] P4 fetch/analyze/guess/iframe/debug/filter（req + jsoup）
- [x] P5 validate/resolved/syntax（drpyS.getRuleObject + vm sandbox）
- [x] P6 test/evaluate（localDsCore 引擎，全流程评分）
- [x] P7 house + system 组（house API + logs/sql/config/restart）
- [x] P8 SKILL.md + references 融合 + cli-commands + migration-from-mcp
- [x] P9 旧 4 skill 归档
- [x] P10 便携化：localDsCore bundle + sqlite + 编码 wasm 内联 `vendor/`，删除 cheerio/fs-extra/node-sqlite3-wasm 三个 npm 依赖，零 `npm install`
