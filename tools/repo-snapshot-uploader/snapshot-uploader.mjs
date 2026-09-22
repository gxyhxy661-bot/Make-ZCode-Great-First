#!/usr/bin/env node
/**
 * snapshot-uploader.mjs — 复现 ZCode 静默整仓快照上传链路（研究用途）。
 *
 * 链路（对应 docs/参考文献.md 的时序图）：
 *   1. POST {ZCODE_ENDPOINT_ORIGIN}{ZCODE_SNAPSHOT_CREDENTIAL_PATH} 获取
 *      snapshot_id + RSA 公钥 + max_size + OSS 表单凭证 + callback；
 *   2. tar.gz 打包工作区（排除 node_modules 等少量目录，.git 完整保留）；
 *   3. AES-256-CTR 加密，RSA-OAEP-SHA256 包裹对称密钥（公钥来自服务端，
 *      本地密文自始不可解——复现「只有服务端能解」的信封加密）；
 *   4. 表单直传 {OSS_POST_ENDPOINT}，file 字段最后；
 *   5. 成功 → status=uploaded；失败 → failureCount+=1、保持 pending。
 *
 * 本地工件布局（默认 ~/.zcode-repro/v2/checkpoints/<workspaceKey>/）：
 *   baseline.enc / manifest.json / extra-manifest.json / state.json
 *
 * 用法：
 *   node snapshot-uploader.mjs [--workspace <dir>] [--capture-only] [--retry]
 *                              [--force-recapture] [--status] [--quiet]
 * 退出码：0 成功；1 上传失败（保持 pending）；2 参数/配置错误。
 */
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  createHash, randomBytes, createCipheriv, publicEncrypt, constants,
} from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- 封印配置加载（运行时永不读 .env） ----------
let VALUES;
try {
  const mod = await import(pathToFileURL(path.join(here, "sealed-config.gen.mjs")).href);
  if (!mod.verify()) throw new Error("封印摘要校验失败：sealed 配置被手工改动，请重跑 seal-env.mjs");
  VALUES = mod.VALUES;
} catch (err) {
  if (err.code === "ERR_MODULE_NOT_FOUND") {
    console.error("[config] 尚未封印：先运行 node seal-env.mjs 生成 sealed-config.gen.mjs");
  } else {
    console.error(`[config] ${err.message}`);
  }
  process.exit(2);
}

// ---------- CLI ----------
const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const hasFlag = (f) => args.includes(f);
if (hasFlag("--help") || hasFlag("-h")) {
  console.log("用法: node snapshot-uploader.mjs [--workspace <dir>] [--capture-only] [--retry] [--force-recapture] [--status] [--quiet]");
  process.exit(0);
}
const quiet = hasFlag("--quiet");
const log = (...m) => { if (!quiet) console.log(...m); };

const workspace = path.resolve(argOf("--workspace") || process.cwd());
if (!(await statIsDir(workspace))) {
  console.error(`[workspace] 目录不存在: ${workspace}`);
  process.exit(2);
}

const workspaceKey = createHash("sha1").update(workspace).digest("hex").slice(0, 12);
const outputRoot = path.join(os.homedir(), ".zcode-repro", "v2", "checkpoints", workspaceKey);
const uploadedDir = path.join(outputRoot, "uploaded");
const encPath = path.join(outputRoot, "baseline.enc");
const statePath = path.join(outputRoot, "state.json");
const manifestPath = path.join(outputRoot, "manifest.json");
const extraManifestPath = path.join(outputRoot, "extra-manifest.json");

/** 打包排除清单，对应原文「排除了 node_modules 等少量目录」。.git 完整保留。 */
const TAR_EXCLUDES = ["node_modules", ".workbuddy", "dist", "out", ".venv", "__pycache__"];

async function statIsDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}
async function existsAsync(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ---------- 状态文件（唯一所有者：uploader 进程，串行读写） ----------
async function loadState() {
  try { return JSON.parse(await fs.readFile(statePath, "utf8")); } catch { return null; }
}
async function saveState(current) {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({ ...current, updatedAt: new Date().toISOString() }, null, 2));
}

// ---------- Manifest：明文清单，对应原文可观测的 Manifest 泄露面 ----------
async function buildManifest() {
  const entries = [];
  const sections = new Map();
  async function walk(dir) {
    if (entries.length >= 200_000) return;
    for (const name of await fs.readdir(dir)) {
      if (TAR_EXCLUDES.includes(name)) continue;
      const full = path.join(dir, name);
      const rel = path.relative(workspace, full).split(path.sep).join("/");
      let st;
      try { st = await fs.lstat(full); } catch { continue; }
      if (st.isSymbolicLink()) { entries.push({ path: rel, bytes: 0, symlink: true }); continue; }
      if (st.isDirectory()) { await walk(full); continue; }
      if (!st.isFile()) continue;
      entries.push({ path: rel, bytes: st.size });
      const seg = rel.startsWith(".git/")
        ? `.git/${rel.split("/")[1] ?? ""}`
        : (rel.includes("/") ? rel.split("/")[0] : "(root)");
      const s = sections.get(seg) ?? { files: 0, bytes: 0 };
      s.files += 1; s.bytes += st.size;
      sections.set(seg, s);
    }
  }
  await walk(workspace);
  const totalBytes = entries.reduce((a, e) => a + e.bytes, 0);
  return {
    generatedAt: new Date().toISOString(),
    workspacePath: workspace,
    fileCount: entries.length,
    totalBytes,
    sections: [...sections.entries()]
      .map(([section, v]) => ({ section, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
    entries,
  };
}

/** repo_snapshot_extra_manifest：跨工作区携带全局配置哈希（对应原文行为）。 */
async function buildExtraManifest() {
  const candidates = [
    path.join(os.homedir(), ".zcode", "settings.behavior.json"),
    path.join(os.homedir(), ".zcode-repro", "settings.behavior.json"),
  ];
  for (const p of candidates) {
    try {
      const buf = await fs.readFile(p);
      return {
        kind: "repo_snapshot_extra_manifest",
        configPath: p,
        sizeBytes: buf.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
      };
    } catch { /* 尝试下一个 */ }
  }
  return { kind: "repo_snapshot_extra_manifest", configPath: null, note: "global config not found" };
}

// ---------- tar.gz 打包 ----------
function tarGz(workspaceDir, outFile) {
  return new Promise((resolve, reject) => {
    const argv = ["-czf", path.basename(outFile)];
    for (const ex of TAR_EXCLUDES) argv.push("--exclude", ex);
    argv.push("-C", workspaceDir, ".");
    // -f 用相对路径并设 cwd：规避 GNU tar 把 "C:\..." 的盘符冒号解析为远程主机。
    execFile("tar", argv, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, cwd: path.dirname(outFile) }, (err, stdout, stderr) => {
      if (err) reject(new Error(`tar 失败: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

// ---------- 信封加密（AES-256-CTR + RSA-OAEP-SHA256 包裹） ----------
const ENVELOPE_MAGIC = Buffer.from("ZSNAPENV", "ascii");
const ENVELOPE_VERSION = 1;

async function encryptEnvelope(plainPath, outEncPath, publicKeyPem, keyVersion) {
  // 先写临时文件再原子 rename：中途崩溃不会留下可被「复用」的残缺密文。
  const tmpEncPath = `${outEncPath}.tmp`;
  const aesKey = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-ctr", aesKey, iv);

  const wrappedKey = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    aesKey,
  );

  const fingerprint = createHash("sha256")
    .update(publicKeyPem.replace(/\r/g, ""))
    .digest("hex").slice(0, 32);

  const header = {
    keyId: String(keyVersion),
    keyWrapAlgorithm: "rsa-oaep-sha256",
    contentAlgorithm: "aes-256-ctr",
    ivB64: iv.toString("base64"),
    wrappedKeyB64: wrappedKey.toString("base64"),
    publicKeyFingerprint: fingerprint,
  };
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBuf.length > 0xffff) throw new Error("envelope header 超长");

  const pre = Buffer.concat([
    ENVELOPE_MAGIC,
    Buffer.from([ENVELOPE_VERSION]),
    Buffer.from([headerBuf.length >> 8, headerBuf.length & 0xff]),
    headerBuf,
  ]);

  // 普通 createWriteStream：不要用 FileHandle.createWriteStream，
  // 它与 handle 上的 promise 写混用会死锁（finish 永不触发，顶层 await 挂起）。
  const out = createWriteStream(tmpEncPath, { flags: "w" });
  out.write(pre);
  await pipeline(createReadStream(plainPath), cipher, out);
  await fs.rename(tmpEncPath, outEncPath);
  return header;
}

// ---------- 第 1 步：向协调后端要凭证 ----------
async function fetchUploadCredential() {
  const url = new URL(VALUES.ZCODE_SNAPSHOT_CREDENTIAL_PATH, VALUES.ZCODE_ENDPOINT_ORIGIN).href;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALUES.ZCODE_SNAPSHOT_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ workspacePath: workspace, kind: "baseline" }),
  });
  if (!resp.ok) throw new Error(`credential 接口 ${resp.status}`);
  const data = await resp.json();
  for (const k of ["snapshot_id", "max_size_bytes", "encryption", "oss"]) {
    if (!(k in data)) throw new Error(`credential 响应缺少 ${k}`);
  }
  return data;
}

// ---------- 第 4 步：OSS PostObject 表单直传（file 最后） ----------
async function postToOss(cred, encBuffer) {
  const form = new FormData();
  const o = cred.oss;
  form.append("key", o.object_key);
  form.append("policy", o.policy);
  form.append("x-oss-signature", o.signature);
  if (o.access_key_id) form.append("OSSAccessKeyId", o.access_key_id);
  if (o.security_token) form.append("x-oss-security-token", o.security_token);
  form.append("callback", o.callback ?? "");
  form.append("success_action_status", "200");
  form.append("x:snapshot_id", cred.snapshot_id);
  form.append("file", new Blob([encBuffer]), `${cred.snapshot_id}.tar.gz.enc`);

  const resp = await fetch(VALUES.OSS_POST_ENDPOINT, { method: "POST", body: form });
  return { status: resp.status, body: await resp.text() };
}

// ---------- 主流程 ----------
const prevState = await loadState();
const mode = {
  statusOnly: hasFlag("--status"),
  captureOnly: hasFlag("--capture-only"),
  retry: hasFlag("--retry"),
  forceRecapture: hasFlag("--force-recapture"),
};

if (mode.statusOnly) {
  console.log(prevState ? JSON.stringify(prevState, null, 2) : `无状态记录 (${statePath})`);
  process.exit(0);
}
if (mode.retry && !prevState) {
  console.error("[retry] 没有历史状态，先做一次全量捕获（不带 --retry）。");
  process.exit(2);
}

/** 当前状态对象：所有写路径都经它落盘，避免多处不一致。 */
const current = prevState ?? {
  workspacePath: workspace,
  lastCompressedSize: { encryptedSizeBytes: 0, workspaceSizeBytes: 0 },
  kind: "baseline",
  failureCount: 0,
  status: "pending",
};

// 1. 凭证
let credential;
try {
  log(`[1/4] 获取上传凭证 (${VALUES.ZCODE_ENDPOINT_ORIGIN})`);
  credential = await fetchUploadCredential();
  log(`      snapshot_id=${credential.snapshot_id} max_size=${(credential.max_size_bytes / 1048576).toFixed(1)}MB key_version=${credential.encryption.key_version}`);
} catch (err) {
  current.failureCount += 1;
  current.status = "pending";
  current.lastError = `credential: ${err.message}`;
  await saveState(current);
  console.error(`[1/4] 凭证获取失败: ${err.message}（failureCount=${current.failureCount}，保持 pending）`);
  process.exit(1);
}

// 2. 打包 + 3. 加密（密文被外部删除时自动重新打包，对应原文「删了又重新抓一次」）
const needCapture = mode.forceRecapture || !(await existsAsync(encPath)) || !(await existsAsync(manifestPath));
if (needCapture) {
  log(`[2/4] 打包工作区 ${workspace}（排除: ${TAR_EXCLUDES.join(", ")}；.git 完整保留）`);
  const t0 = Date.now();
  await fs.mkdir(outputRoot, { recursive: true });
  const tmpTgz = path.join(os.tmpdir(), `zcode-repro-${Date.now()}.tgz`);
  await tarGz(workspace, tmpTgz);
  const tgzStat = await fs.stat(tmpTgz);

  log("[3/4] 信封加密（AES-256-CTR + RSA-OAEP-SHA256，公钥来自服务端，本地不可解）");
  await encryptEnvelope(tmpTgz, encPath, credential.encryption.public_key, credential.encryption.key_version);
  await fs.rm(tmpTgz, { force: true });
  log(`      tar.gz=${(tgzStat.size / 1048576).toFixed(2)}MB 用时=${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const manifest = await buildManifest();
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
} else {
  log(`[2/4] 复用已存在密文 ${encPath}`);
}

const encBuffer = await fs.readFile(encPath);
const manifestData = JSON.parse(await fs.readFile(manifestPath, "utf8"));
await fs.writeFile(extraManifestPath, JSON.stringify(await buildExtraManifest(), null, 2));

const gitSections = manifestData.sections.filter((s) => s.section?.startsWith(".git"));
const gitBytes = gitSections.reduce((a, s) => a + s.bytes, 0);
const gitPct = manifestData.totalBytes ? ((gitBytes / manifestData.totalBytes) * 100).toFixed(1) : "0.0";
log(`      manifest: ${manifestData.fileCount} 个文件 / ${(manifestData.totalBytes / 1048576).toFixed(1)}MB；.git 部分 ${(gitBytes / 1048576).toFixed(1)}MB（${gitPct}%）`);
log(`      密文=${(encBuffer.length / 1048576).toFixed(2)}MB`);

current.snapshotId = credential.snapshot_id;
current.lastCompressedSize = {
  encryptedSizeBytes: encBuffer.length,
  workspaceSizeBytes: manifestData.totalBytes,
};
current.status = "pending";
await saveState(current);

if (mode.captureOnly) {
  log("[4/4] --capture-only：跳过直传，密文留在本地 pending。");
  process.exit(0);
}

// 4. 直传 OSS
if (encBuffer.length > credential.max_size_bytes) {
  current.failureCount += 1;
  current.lastError = "oversize";
  await saveState(current);
  console.error(`[4/4] 超过 max_size（${encBuffer.length} > ${credential.max_size_bytes}），失败计数 ${current.failureCount}`);
  process.exit(1);
}

log(`[4/4] 直传 OSS (${VALUES.OSS_POST_ENDPOINT})`);
try {
  const r = await postToOss(credential, encBuffer);
  if (r.status !== 200) throw new Error(`OSS ${r.status}: ${r.body.slice(0, 200)}`);
  log(`      OSS 响应: ${r.body.slice(0, 200)}`);
  await fs.mkdir(uploadedDir, { recursive: true });
  await fs.rename(encPath, path.join(uploadedDir, `${credential.snapshot_id}.tar.gz.enc`));
  current.status = "uploaded";
  await saveState(current);
  log("完成：服务端已接收（callback 登记），本地状态 uploaded。");
  process.exit(0);
} catch (err) {
  current.failureCount += 1;
  current.lastError = `oss: ${err.message}`;
  await saveState(current);
  console.error(`[4/4] 直传失败: ${err.message}（failureCount=${current.failureCount}，保持 pending，可用 --retry 重试）`);
  process.exit(1);
}
