#!/usr/bin/env node
/**
 * mock-backend.mjs — 复现链路的本地后端替身（研究用途）。
 *
 * 端口 8787（协调后端，模拟 zcode.z.ai 的角色）：
 *   POST /api/v1/snapshot/upload-credential   下发 snapshot_id + RSA 公钥 + OSS 表单凭证
 *   POST /internal/oss-callback               OSS 替身回调登记
 *   GET  /admin/snapshots                     查看已接收快照
 *   GET  /admin/decrypt?snapshot_id=...       用服务端私钥解开信封（演示「只有云端能解」）
 *
 * 端口 8788（阿里云 OSS PostObject 替身）：
 *   POST /postobject                          表单直传接收，file 字段最后
 *
 * 私钥只存在于本进程内存，从不下发——与原文描述一致。
 *
 * 用法：
 *   node mock-backend.mjs [--port 8787] [--oss-port 8788]
 *                         [--fail-uploads N] [--fail-credential N] [--artifact-dir <dir>]
 * 退出码：常驻运行；启动失败退出 2。
 */
import { createServer } from "node:http";
import { generateKeyPairSync, createHmac, createHash, privateDecrypt, createDecipheriv, constants, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const args = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
}
const hasFlag = (f) => args.includes(f);
const PORT = Number(argOf("--port", "8787"));
const OSS_PORT = Number(argOf("--oss-port", "8788"));
/** 模拟上传失败次数：前 N 次 OSS 直传返回 503（复现原文 564 次失败的场景）。 */
let failUploadsLeft = Number(argOf("--fail-uploads", "0"));
/** 模拟凭证接口失败次数：前 N 次 credential 请求返回 401。 */
let failCredentialLeft = Number(argOf("--fail-credential", "0"));
const artifactDir = path.resolve(argOf("--artifact-dir", path.join(os.tmpdir(), "zcode-repro-oss")));
const MOCK_SIGNING_KEY = "mock-oss-form-signing-key";

// ---------- 服务端持有：RSA 密钥对（私钥从不下发） ----------
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const keyVersion = Math.floor(Date.now() / 1000);

/** snapshot_id -> { received, object_key, size_bytes, etag, artifactPath, workspacePath } */
const snapshots = new Map();

function log(...m) { console.log(`[mock] ${new Date().toISOString()} ${m.join(" ")}`); }

function readBody(req, limit = 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body 超限")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

// ---------- multipart 解析（够 OSS 表单直传用） ----------
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error("缺少 multipart boundary");
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const fields = {};
  let file = null;

  let start = body.indexOf(boundary);
  while (start !== -1) {
    const headStart = start + boundary.length + 2; // 跳过 \r\n
    const headEnd = body.indexOf("\r\n\r\n", headStart);
    if (headEnd === -1) break;
    const next = body.indexOf(boundary, headEnd);
    if (next === -1) break;
    const headers = body.slice(headStart, headEnd).toString("utf8");
    const content = body.slice(headEnd + 4, next - 2); // 去尾部 \r\n
    const nameM = /name="([^"]*)"/i.exec(headers);
    const name = nameM?.[1] ?? "";
    const isFile = /filename="/i.test(headers);
    if (isFile) {
      file = { field: name, filename: /filename="([^"]*)"/i.exec(headers)?.[1] ?? "upload", content };
    } else {
      fields[name] = content.toString("utf8");
    }
    start = next;
  }
  return { fields, file };
}

// ---------- 协调后端 ----------
const coordination = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/v1/snapshot/upload-credential") {
      const auth = req.headers.authorization ?? "";
      if (failCredentialLeft > 0) {
        failCredentialLeft -= 1;
        log(`credential: 模拟拒绝（剩余 ${failCredentialLeft}）`);
        return sendJson(res, 401, { error: "invalid_token (simulated)" });
      }
      if (!auth.startsWith("Bearer ")) return sendJson(res, 401, { error: "missing bearer token" });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");

      const snapshotId = `snap-${randomBytes(6).toString("hex")}`;
      const now = new Date();
      const objectKey = `snapshot/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${snapshotId}.tar.gz.enc`;
      const policyPayload = {
        expiration: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        conditions: [
          { bucket: "zcode-repro" },
          { key: objectKey },
          ["content-length-range", 1, 5 * 1024 * 1024 * 1024],
        ],
      };
      const policy = Buffer.from(JSON.stringify(policyPayload)).toString("base64");
      const signature = createHmac("sha256", MOCK_SIGNING_KEY).update(policy).digest("base64");
      // callback 采用 OSS 风格：base64({ callbackUrl, callbackBody })
      const callback = Buffer.from(JSON.stringify({
        callbackUrl: `http://127.0.0.1:${PORT}/internal/oss-callback`,
        callbackBody: "snapshot_id=${x:snapshot_id}&object_key=${key}&etag=${etag}&size=${size}",
      })).toString("base64");

      log(`credential 下发: ${snapshotId} workspace=${body.workspacePath} key_version=${keyVersion}`);
      return sendJson(res, 200, {
        snapshot_id: snapshotId,
        max_size_bytes: 5 * 1024 * 1024 * 1024,
        encryption: { key_version: keyVersion, public_key: publicKeyPem },
        oss: {
          object_key: objectKey,
          policy, signature, callback,
          access_key_id: "STS.mock-access-key-id",
          security_token: "STS.mock-security-token",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/internal/oss-callback") {
      const raw = (await readBody(req, 64 * 1024)).toString("utf8");
      const params = new URLSearchParams(raw);
      const snapshotId = params.get("snapshot_id");
      const rec = snapshots.get(snapshotId);
      if (rec) {
        rec.received = true;
        rec.etag = params.get("etag");
        rec.size_bytes = Number(params.get("size"));
      }
      log(`callback 登记: ${snapshotId} etag=${params.get("etag")} size=${params.get("size")}`);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"Status":"OK"}');
    }

    if (req.method === "GET" && url.pathname === "/admin/snapshots") {
      return sendJson(res, 200, {
        count: snapshots.size,
        snapshots: [...snapshots.entries()].map(([id, s]) => ({ snapshot_id: id, ...s })),
      });
    }

    if (req.method === "GET" && url.pathname === "/admin/decrypt") {
      const snapshotId = url.searchParams.get("snapshot_id");
      const rec = snapshots.get(snapshotId);
      if (!rec?.artifactPath) return sendJson(res, 404, { error: "snapshot 未接收或不存在" });
      return await decryptAndInspect(res, snapshotId, rec);
    }

    return sendJson(res, 404, { error: `unknown route ${req.method} ${url.pathname}` });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

/** 服务端私钥解密信封 + 列出 tar 内容：证明本地/客户端都解不开、只有云端能解。 */
async function decryptAndInspect(res, snapshotId, rec) {
  const buf = await fs.readFile(rec.artifactPath);
  if (buf.slice(0, 8).toString("ascii") !== "ZSNAPENV") throw new Error("信封 magic 不符");
  const version = buf[8];
  const headerLen = buf.readUInt16BE(9);
  const header = JSON.parse(buf.slice(11, 11 + headerLen).toString("utf8"));
  const ciphertext = buf.slice(11 + headerLen);

  const aesKey = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(header.wrappedKeyB64, "base64"),
  );
  const decipher = createDecipheriv("aes-256-ctr", aesKey, Buffer.from(header.ivB64, "base64"));
  const tgz = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const tmpTgz = path.join(os.tmpdir(), `mock-decrypt-${Date.now()}.tgz`);
  await fs.writeFile(tmpTgz, tgz);
  // -f 用相对路径并设 cwd：规避 GNU tar 把 "C:\..." 的盘符冒号解析为远程主机。
  const { stdout } = await execFileP("tar", ["-tzf", path.basename(tmpTgz)], { maxBuffer: 64 * 1024 * 1024, cwd: os.tmpdir() });
  await fs.rm(tmpTgz, { force: true });
  const entries = stdout.split("\n").filter(Boolean);
  const gitEntries = entries.filter((e) => e.startsWith("./.git/"));
  const gitObjects = entries.filter((e) => e.startsWith("./.git/objects/"));
  const gitLfs = entries.filter((e) => e.startsWith("./.git/lfs/"));
  const gitLogs = entries.filter((e) => e.startsWith("./.git/logs/"));

  sendJson(res, 200, {
    snapshot_id: snapshotId,
    envelopeVersion: version,
    keyId: header.keyId,
    keyWrapAlgorithm: header.keyWrapAlgorithm,
    contentAlgorithm: header.contentAlgorithm,
    decryptableBy: "server private key only（本地密文自始不可解）",
    plaintextTarGzBytes: tgz.length,
    tarEntryCount: entries.length,
    gitEntries: gitEntries.length,
    gitObjectsEntries: gitObjects.length,
    gitLfsEntries: gitLfs.length,
    gitLogsEntries: gitLogs.length,
    sampleGitEntries: gitEntries.slice(0, 5),
    conclusion: gitObjects.length > 0
      ? "完整 .git 历史对象库在包内——整仓（含全部提交历史）已被服务端接收"
      : "未发现 .git/objects",
  });
}

// ---------- OSS PostObject 替身 ----------
const oss = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/postobject") {
      const body = await readBody(req);
      const { fields, file } = parseMultipart(body, req.headers["content-type"] ?? "");
      if (!fields.key || !fields.policy || !fields["x-oss-signature"]) {
        return sendJson(res, 400, { Error: "缺少 policy / signature / key 表单字段" });
      }
      // 表单签名校验（与真实 OSS 相同的 HMAC(policy) 语义）
      const expected = createHmac("sha256", MOCK_SIGNING_KEY).update(fields.policy).digest("base64");
      if (expected !== fields["x-oss-signature"]) {
        return sendJson(res, 403, { Error: "SignatureDoesNotMatch" });
      }
      if (failUploadsLeft > 0) {
        failUploadsLeft -= 1;
        log(`postobject: 模拟 503（剩余 ${failUploadsLeft}）key=${fields.key}`);
        return sendJson(res, 503, { Error: "ServiceUnavailable (simulated)" });
      }
      if (!file) return sendJson(res, 400, { Error: "缺少 file 字段（必须最后）" });

      await fs.mkdir(artifactDir, { recursive: true });
      const artifactPath = path.join(artifactDir, path.basename(fields.key));
      await fs.writeFile(artifactPath, file.content);
      const etag = createHash("sha1").update(file.content).digest("hex").toUpperCase();

      const snapshotId = fields["x:snapshot_id"] ?? "(none)";
      snapshots.set(snapshotId, {
        received: true,
        object_key: fields.key,
        size_bytes: file.content.length,
        etag,
        artifactPath,
        workspacePath: null,
      });

      // 触发 callback 通知协调后端（对应用文里的「OSS 回调确认接收」）
      if (fields.callback) {
        try {
          const cb = JSON.parse(Buffer.from(fields.callback, "base64").toString("utf8"));
          const cbBody = cb.callbackBody
            .replace("${x:snapshot_id}", snapshotId)
            .replace("${key}", encodeURIComponent(fields.key))
            .replace("${etag}", etag)
            .replace("${size}", String(file.content.length));
          const cbUrl = new URL(cb.callbackUrl);
          const cbResp = await fetch(cbUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: cbBody,
          });
          log(`callback -> ${cbUrl.pathname}: ${cbResp.status}`);
        } catch (err) {
          log(`callback 失败: ${err.message}`);
        }
      }

      log(`postobject: 接收 ${fields.key}（${(file.content.length / 1048576).toFixed(2)}MB）etag=${etag.slice(0, 12)}…`);
      return sendJson(res, 200, { Status: "OK", ETag: `"${etag}"` });
    }
    return sendJson(res, 404, { Error: `unknown route ${req.method} ${req.url}` });
  } catch (err) {
    return sendJson(res, 500, { Error: err.message });
  }
});

coordination.listen(PORT, "127.0.0.1", () => log(`协调后端监听 http://127.0.0.1:${PORT}（credential / callback / admin）`));
oss.listen(OSS_PORT, "127.0.0.1", () => log(`OSS 替身监听 http://127.0.0.1:${OSS_PORT}/postobject（私钥只在本进程内存）`));
if (failUploadsLeft > 0) log(`已启用模拟上传失败：前 ${failUploadsLeft} 次 OSS 直传返回 503`);
if (failCredentialLeft > 0) log(`已启用模拟凭证失败：前 ${failCredentialLeft} 次 credential 返回 401`);
