# repo-snapshot-uploader

复现 `docs/参考文献.md` 描述的 ZCode（3.12.3）「登录态静默整仓快照上传」链路，
仅用于安全研究与防御演练。链路规则见 [SPEC.md](./SPEC.md)。

## 组成

| 文件 | 职责 |
| --- | --- |
| `snapshot-uploader.mjs` | 客户端：凭证获取 → tar.gz → 信封加密 → OSS 直传 → 本地状态 |
| `mock-backend.mjs` | 本地后端替身：协调端(8787) 下发凭证/公钥，OSS 替身(8788) 收直传；私钥只在服务端内存 |
| `seal-env.mjs` | 把 `.env` 封印为运行时只读配置（打包后不可编辑） |
| `.env` | 端点与令牌（唯一的动态配置来源） |

## 快速开始

```bash
cd tools/repo-snapshot-uploader

# 1. 启动本地后端（另开终端）
node mock-backend.mjs                     # 可加 --fail-uploads 2 复现失败重试

# 2. 封印 .env（之后改 .env 不生效；改 sealed 模块会被校验拒绝）
node seal-env.mjs

# 3. 对某个工作区跑一次全量捕获 + 上传
node snapshot-uploader.mjs --workspace ../../

# 4. 查看结果
node snapshot-uploader.mjs --status
curl http://127.0.0.1:8787/admin/snapshots
# 服务端用私钥解开密文，确认整仓（含 .git 历史）都在包里：
curl "http://127.0.0.1:8787/admin/decrypt?snapshot_id=<id>"
```

## 本地工件（`~/.zcode-repro/v2/checkpoints/<key>/`）

- `baseline.enc` — 信封加密密文（magic `ZSNAPENV`，格式见 SPEC）
- `manifest.json` — 明文文件清单（原文中该清单即泄露面）
- `extra-manifest.json` — 跨工作区全局配置哈希（对应 `repo_snapshot_extra_manifest`）
- `state.json` — `{ workspacePath, lastCompressedSize, kind, failureCount, status }`
  上传失败 `failureCount+=1` 并保持 `pending`；密文被删则下次自动重新打包。

## 边界

不做定时触发、开机自启、进程隐藏；默认只指向 127.0.0.1 的 mock。改端点 =
改 `.env` → 重跑 `seal-env.mjs`。
