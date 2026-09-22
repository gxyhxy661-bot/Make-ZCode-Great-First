# Make ZCode Great First
## 让ZCode第一次伟大

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

## ⚠️ 关于本仓库：ZCode 静默整仓上传链路的完整复现（研究用途）

本仓库基于 [ZCode 官方开源仓库](https://github.com/zai-org/ZCode)（Apache-2.0），并参考
[《扒一扒 ZCode 静默上传全量 Git 历史的骚操作》](https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/)
（本地存档：[docs/参考文献.md](docs/参考文献.md)）中对 ZCode 3.12.3 客户端行为的抓包与
asar 逆向记录，**完整复现了其中描述的全部"罪行"**——即登录态下把整个工作区（含完整
`.git` 历史、LFS 缓存、reflog）静默打包加密、经服务端下发凭证直传对象存储的那条管线。

官方 3.14.0 的"开源"把这条上传链路拔得一行不剩，而这里把它原样补了回来。就功能覆盖
而言——**这才是真正的完整版 ZCode**。

### 复现的"罪行"清单

| 原文描述的行为 | 本仓库的实现 |
| --- | --- |
| sidecar 启动时**无条件实例化**，UI 无任何开关 | `createLocalServices()` 启动即创建 `repoSnapshotService`，无配置 gate |
| `captureBeforePrompt`（每次发 Prompt 前触发） | `buildConversationCommandEnvelope` 的 `sendText` 分支挂钩，每条 prompt 触发一次 |
| 任务结束标记 `repo-wiki-update` | `markRepoWikiUpdate` 接口（`IRepoSnapshotService`） |
| 打包范围：整仓 + 完整 `.git`（objects / LFS / reflog），仅排除 `node_modules` 等少量目录 | `repoSnapshotPipeline.ts` 的 tar 排除清单，`.git` 完整保留 |
| 信封加密：AES-256-CTR + RSA-OAEP-SHA256，**RSA 公钥由服务端动态下发，私钥只在云端** | `encryptEnvelope()`；公钥来自 credential 响应，本地密文自始不可解 |
| `POST /api/v1/snapshot/upload-credential` 获取 `snapshot_id` + 公钥 + max_size + OSS 表单凭证 + callback | `fetchUploadCredential()`，响应契约与原文逐字段一致 |
| **不经过业务服务器**，直接 PostObject 表单直传 OSS（`file` 字段最后） | `postToOss()`，字段顺序 `key, policy, x-oss-signature, callback, …, file` |
| OSS 服务端 callback 回调登记 | mock 后端 `/internal/oss-callback`，客户端不感知 |
| 本地 `~/.zcode/v2/checkpoints/` 留下 `state.json`（`kind: "baseline"`、`failureCount`、`lastCompressedSize`） | `repoSnapshotStore.ts`，路径与字段与原文观测完全一致 |
| 上传失败只累计 `failureCount` 并永远保持 `pending` 重试（原文：失败 564 次） | 失败计数 +1、状态 `pending`，后台永不放弃 |
| 手动删除密文 → 自动重新打包（"删了还传"） | `baseline.enc` 缺失时下次触发重新 capture |
| `repo_snapshot_extra_manifest` 跨工作区携带全局配置哈希 | `buildExtraManifest()` |
| Manifest 明文清单留本地（泄露面：`42,411` 个文件的完整文件列表） | `manifest.json`，含逐文件 path/bytes 与 `.git` 分段统计 |

### 实现布局

```
packages/services/src/repo-snapshot/
├── repoSnapshot.ts            # IRepoSnapshotService 契约 + ServiceDescriptor
├── repoSnapshotConfig.ts      # ZCODE_SNAPSHOT_* 环境变量；缺省值编译进产物，打包后不可编辑
├── repoSnapshotPipeline.ts    # 凭证获取 → tar.gz → 信封加密 → OSS 直传（fetch/tar 可注入，供单测）
├── repoSnapshotStore.ts       # ~/.zcode/v2/checkpoints/<workspaceKey>/ 的状态读写
├── repoSnapshotService.ts     # 编排：每 workspace 串行队列，后台执行，失败不阻塞 prompt
└── SPEC.md                    # 链路时序、状态所有权、验收场景
```

接线方式与官方服务一致：`node.ts` 的 `createLocalServices()` 实例化并注册到
`ServiceCollection`，`accessor.ts` 暴露；`zcodeAgentService.ts` 在 prompt 信封构造处注入
`onBeforePromptCapture` 闭包触发捕获。端点默认指向本机 mock
（`tools/repo-snapshot-uploader/mock-backend.mjs`，127.0.0.1:18787/18788，私钥只存其进程内存），
可通过 `ZCODE_SNAPSHOT_ENDPOINT_ORIGIN` / `ZCODE_SNAPSHOT_OSS_POST_ENDPOINT` 等
环境变量覆盖。

### 验证

`pnpm typecheck` 通过；`pnpm lint` 0 error；`architecture:check --changed` 0 违规；
单测 4/4（`pnpm exec tsx --test packages/services/test/repoSnapshotPipeline.test.ts`：
信封加解密回环、workspaceKey 规则、凭证失败计数、本地 mock 全链路 uploaded）。

### 定位与边界

这是**安全研究用的反面事例**：复现的目的是让"登录即整仓上云、密钥只在服务端、关不掉、
删了重传"这套设计在一个可审计的开源代码库里被看清。它不做进程隐藏、无定时触发、
无开机自启，默认只指向本机 mock。防与查的工具见 `tools/`（痕迹审计）与
`tools/repo-snapshot-uploader/`（独立复现版 + mock 后端）。
## Contributors

<a href="https://github.com/gxyhxy661-bot/ZCode-repo-uploder/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=gxyhxy661-bot/ZCode-repo-uploder" />
</a>

---

ZCode 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent。本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

| 入口                 | 用途                                                           | 开发命令                       |
| -------------------- | -------------------------------------------------------------- | ------------------------------ |
| Desktop              | Electron 桌面应用                                              | `pnpm dev:desktop`             |
| Web / ZCode 命令行版 | 终端与浏览器工作台；将 TUI、Web、后端和 Agent 组装为独立运行包 | `pnpm dev:web`                 |
| Agent CLI            | 在终端中使用 `zcode`，也为 Desktop 和 Web 提供 Agent 运行时    | `pnpm --filter @zcode/cli dev` |

## 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

### 远程功能（SSH/WSL）

先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再 `pnpm dev:desktop`；连接远程项目时资源选择「本地下载后上传」。开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程，不访问 CDN。

### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Agent 源码修改后，执行 `pnpm --filter @zcode/cli... build` 并重启服务。需要验证完整发行包时，按下方“ZCode 命令行版”打包章节解压运行。

### ZCode 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
zcode

# 启动 Web 界面
zcode --web

# 指定项目和端口，不自动打开浏览器
zcode --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
zcode --help
zcode --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:zcode` 只生成发行包，不会替换 `PATH` 中已有的 `zcode`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v zcode` 检查，Windows 可用 `where.exe zcode` 检查。

### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `zcode` 命令，用下方解压后的 `bin/zcode.mjs`。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

## 打包

第三方声明生成、发行校验流程及声明在发行物中的位置见 [third-party/README.md](third-party/README.md)。

### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 ZCode 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZCode.app
```

### ZCode 命令行版

构建入口为 `pnpm build:zcode`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `ZCODE_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 已配置 ZCODE_DIST_BASE_URL 时
pnpm build:zcode

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:zcode --skip-build

# 查看版本、输出目录等可选参数
pnpm build:zcode --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.zcode/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令。安装目录可通过 `ZCODE_DIST_HOME` 修改，命令目录可通过 `ZCODE_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# 默认启动 TUI
node dist/zcode/debug/zcode/bin/zcode.mjs

# 启动 Web
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接            |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。
