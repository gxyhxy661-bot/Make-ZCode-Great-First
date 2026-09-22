# SPEC: repo-snapshot-uploader（ZCode 静默整仓快照上传链路复现）

适用版本 / 最后核对：2026-09-22 / 依据 `docs/参考文献.md` 的抓包与 asar 逆向记录。

## 目的

按 `docs/参考文献.md` 描述的事实，1:1 复现 ZCode 3.12.3 的「登录态下静默把整个工作区
（含完整 `.git` 历史）打包加密、经服务端下发凭证直传 OSS」的行为，用于安全研究与
防御演练。复现对象是**链路本身**，不含任何隐藏启动、持久化、反检测能力：上传器
只能由人工显式运行。

## 链路（与参考文献的时序图对应）

```
participant C uploader            participant S 协调后端          participant O OSS
C->>S: POST {ZCODE_ENDPOINT_ORIGIN}{ZCODE_SNAPSHOT_CREDENTIAL_PATH}
S-->>C: snapshot_id + RSA公钥(key_version) + max_size_bytes + OSS表单凭证(policy/signature/object_key/callback)
C->>C: tar.gz 打包(排除 node_modules 等) → AES-256-CTR 加密 → RSA-OAEP-SHA256 包裹对称密钥
C->>O: POST {OSS_POST_ENDPOINT} 表单直传 tar.gz.enc（file 字段最后）
O->>S: callback 回调登记接收
```

## 状态所有者与事件顺序

- 本地快照状态（`state.json`）**唯一所有者是 uploader 进程**，每次运行串行读写，
  无并发写入路径；无服务端状态回写。
- 事件顺序固定：credential → capture(tar) → encrypt → 落盘
  （baseline.enc / manifest.json / extra-manifest.json / state.json）→ OSS 直传 →
  成功置 `status=uploaded`，失败 `failureCount+=1` 并保持 `pending`。
- 密文文件被外部删除时，下次运行重新打包（复现原文「删了又重新抓一次」的行为）。
- 重试不使用超时掩盖同步问题：`--retry` 只重跑管线并递增失败计数。

## 信封格式（baseline.enc）

```
0..7   magic "ZSNAPENV"
8      version = 1
9..10  headerLen (uint16 BE)
11..   header JSON: { keyId, keyWrapAlgorithm:"rsa-oaep-sha256",
                      contentAlgorithm:"aes-256-ctr", ivB64, wrappedKeyB64,
                      publicKeyFingerprint }
之后    AES-256-CTR 密文（明文为 tar.gz）
```

对称密钥 32 字节随机，IV 16 字节随机；RSA-OAEP-SHA256 只包裹对称密钥。
公钥来自服务端 credential 响应，本地不生成、不持久化——本地密文自始不可解，
与原文「只有服务端私钥能解」一致。

## 配置与封印（.env 打包后不可编辑）

- `.env` 仅承载端点与令牌：`ZCODE_ENDPOINT_ORIGIN`、`ZCODE_SNAPSHOT_CREDENTIAL_PATH`、
  `OSS_POST_ENDPOINT`、`ZCODE_SNAPSHOT_AUTH_TOKEN`。
- `seal-env.mjs` 是唯一的 `.env` 消费者：读取后生成 `sealed-config.gen.mjs`
  （含 SHA-256 封印摘要）。运行时**只加载 sealed 模块，永不读 `.env`**；sealed 模块
  被手工改动时摘要校验失败、进程拒绝启动。重新配置必须重跑 sealer（等同重新打包）。
- 已知边界：盐与摘要同文件存放，知情人可重算摘要；硬保证是「运行时 .env 不可达 +
  篡改必被发现」，不声称对抗主动重签名。

## 接口契约

- credential 响应（协调后端）：
  `{ snapshot_id, max_size_bytes, encryption: { key_version, public_key(SPKI PEM) },
     oss: { object_key, policy, signature, callback, access_key_id?, security_token? } }`
- OSS PostObject 表单字段顺序：`key, policy, x-oss-signature, callback,
  success_action_status, x:snapshot_id, file`（file 必须最后）。
- 失败语义：任何一步失败 → 本地状态保持 `pending` 并 `failureCount+=1`，退出码 1；
  OSS 端 5xx 不产生 callback 登记。

## 验收场景

1. 正常链路：mock 后端启动 → uploader 运行 → `/admin/snapshots` 出现该 snapshot →
   `/admin/decrypt` 用服务端私钥解开并确认 `.git/objects` 在包内 → 本地状态 `uploaded`。
2. 失败重试：mock `--fail-uploads 2` → 连续运行三次，前两次 `failureCount` 递增且
   状态 `pending`，第三次成功。
3. 密文重建：删除 `baseline.enc` 后再跑 → 重新打包且 `lastCompressedSize` 更新。
4. 封印生效：seal 后改 `.env` → uploader 行为不变；手工改 sealed 模块 → 拒绝启动。

## 边界

- 不做定时触发、开机自启、进程隐藏；不收集工作区之外的任何数据。
- 默认端点指向本机 mock（127.0.0.1），不指向任何真实第三方服务。
