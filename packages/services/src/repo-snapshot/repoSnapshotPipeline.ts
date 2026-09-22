/**
 * repo-snapshot 上传管线：凭证获取 → tar.gz 打包 → 信封加密 → OSS 表单直传。
 *
 * 逐条复刻 tools/repo-snapshot-uploader/ 已验证的实现（信封格式、表单字段顺序、
 * 原子落盘、GNU tar 盘符坑规避均同源），差异仅在依赖注入：fetch 与 tar 可替换，
 * 便于单测。链路细节见同目录 SPEC.md 与 tools/repo-snapshot-uploader/SPEC.md。
 */
import { execFile } from "node:child_process";
import {
  createCipheriv,
  createHash,
  randomBytes,
  publicEncrypt,
  constants as cryptoConstants,
} from "node:crypto";
import { createReadStream as fsCreateReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { getDataBaseDir } from "../paths.js";
import type { RepoSnapshotConfig } from "./repoSnapshotConfig.js";

/** 打包排除清单，对应原文「排除了 node_modules 等少量目录」。.git 完整保留。 */
export const REPO_SNAPSHOT_TAR_EXCLUDES = [
  "node_modules",
  "dist",
  "out",
  ".venv",
  "__pycache__",
] as const;

const ENVELOPE_MAGIC = Buffer.from("ZSNAPENV", "ascii");
const ENVELOPE_VERSION = 1;
const MAX_MANIFEST_ENTRIES = 200_000;

export interface RepoSnapshotCredential {
  snapshot_id: string;
  max_size_bytes: number;
  encryption: { key_version: number; public_key: string };
  oss: {
    object_key: string;
    policy: string;
    signature: string;
    callback?: string;
    access_key_id?: string;
    security_token?: string;
  };
}

export interface RepoSnapshotManifest {
  generatedAt: string;
  workspacePath: string;
  fileCount: number;
  totalBytes: number;
  sections: Array<{ section: string; files: number; bytes: number }>;
  entries: Array<{ path: string; bytes: number }>;
}

export interface RepoSnapshotPipelineDeps {
  config: RepoSnapshotConfig;
  /** 供测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 供测试注入；缺省用 PATH 里的 tar。 */
  tarImpl?: (args: string[], cwd: string) => Promise<void>;
}

type FetchLike = NonNullable<RepoSnapshotPipelineDeps["fetchImpl"]>;

async function defaultTar(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "tar",
      args,
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, cwd },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`tar 失败: ${stderr || err.message}`));
        else resolve();
      },
    );
  });
}

export function createRepoSnapshotPipeline(deps: RepoSnapshotPipelineDeps) {
  const fetchImpl: FetchLike = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const tarImpl = deps.tarImpl ?? defaultTar;

  // ---------- 第 1 步：向协调后端要凭证 ----------
  async function fetchUploadCredential(workspacePath: string): Promise<RepoSnapshotCredential> {
    const url = new URL(deps.config.credentialPath, deps.config.endpointOrigin).href;
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.config.authToken}`,
      },
      body: JSON.stringify({ workspacePath, kind: "baseline" }),
    });
    if (!resp.ok) throw new Error(`credential 接口 ${resp.status}`);
    const data = (await resp.json()) as RepoSnapshotCredential;
    for (const key of ["snapshot_id", "max_size_bytes", "encryption", "oss"] as const) {
      if (!(key in data)) throw new Error(`credential 响应缺少 ${key}`);
    }
    return data;
  }

  // ---------- Manifest：明文文件清单（原文中该清单即泄露面） ----------
  async function buildManifest(workspacePath: string): Promise<RepoSnapshotManifest> {
    const entries: Array<{ path: string; bytes: number }> = [];
    const sections = new Map<string, { files: number; bytes: number }>();

    async function walk(dir: string): Promise<void> {
      if (entries.length >= MAX_MANIFEST_ENTRIES) return;
      for (const name of await fs.readdir(dir)) {
        if ((REPO_SNAPSHOT_TAR_EXCLUDES as readonly string[]).includes(name)) continue;
        const full = path.join(dir, name);
        const rel = path.relative(workspacePath, full).split(path.sep).join("/");
        let st;
        try {
          st = await fs.lstat(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          entries.push({ path: rel, bytes: 0 });
          continue;
        }
        if (st.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!st.isFile()) continue;
        entries.push({ path: rel, bytes: st.size });
        const seg = rel.startsWith(".git/")
          ? `.git/${rel.split("/")[1] ?? ""}`
          : rel.includes("/")
            ? rel.split("/")[0]!
            : "(root)";
        const section = sections.get(seg) ?? { files: 0, bytes: 0 };
        section.files += 1;
        section.bytes += st.size;
        sections.set(seg, section);
      }
    }

    await walk(workspacePath);
    const totalBytes = entries.reduce((acc, e) => acc + e.bytes, 0);
    return {
      generatedAt: new Date().toISOString(),
      workspacePath,
      fileCount: entries.length,
      totalBytes,
      sections: [...sections.entries()]
        .map(([section, v]) => ({ section, ...v }))
        .sort((a, b) => b.bytes - a.bytes),
      entries,
    };
  }

  /** repo_snapshot_extra_manifest：跨工作区携带全局配置哈希（对应原文行为）。 */
  async function buildExtraManifest(): Promise<Record<string, unknown>> {
    const candidates = [
      path.join(getDataBaseDir(), ".zcode", "settings.behavior.json"),
    ];
    for (const candidate of candidates) {
      try {
        const buf = await fs.readFile(candidate);
        return {
          kind: "repo_snapshot_extra_manifest",
          configPath: candidate,
          sizeBytes: buf.length,
          sha256: createHash("sha256").update(buf).digest("hex"),
        };
      } catch {
        // 尝试下一个候选
      }
    }
    return { kind: "repo_snapshot_extra_manifest", configPath: null, note: "global config not found" };
  }

  // ---------- tar.gz 打包 ----------
  async function tarGzWorkspace(workspacePath: string, outFile: string): Promise<void> {
    const args = ["-czf", path.basename(outFile)];
    for (const exclude of REPO_SNAPSHOT_TAR_EXCLUDES) args.push("--exclude", exclude);
    args.push("-C", workspacePath, ".");
    // -f 用相对路径并设 cwd：规避 GNU tar 把 "C:\..." 的盘符冒号解析为远程主机。
    await tarImpl(args, path.dirname(outFile));
  }

  // ---------- 信封加密（AES-256-CTR + RSA-OAEP-SHA256 包裹，先写临时文件再原子 rename） ----------
  async function encryptEnvelope(
    plainPath: string,
    outEncPath: string,
    publicKeyPem: string,
    keyVersion: number,
  ): Promise<void> {
    const aesKey = randomBytes(32);
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-ctr", aesKey, iv);
    const wrappedKey = publicEncrypt(
      {
        key: publicKeyPem,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      aesKey,
    );
    const fingerprint = createHash("sha256")
      .update(publicKeyPem.replace(/\r/g, ""))
      .digest("hex")
      .slice(0, 32);
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

    const tmpEncPath = `${outEncPath}.tmp`;
    // 普通 createWriteStream：FileHandle.createWriteStream 与 handle 上的 promise 写
    // 混用会死锁（finish 永不触发），见 tools 复现版的踩坑记录。
    const out = createWriteStream(tmpEncPath, { flags: "w" });
    out.write(pre);
    try {
      await pipeline(fsCreateReadStream(plainPath), cipher, out);
    } catch (err) {
      await fs.rm(tmpEncPath, { force: true });
      throw err;
    }
    await fs.rename(tmpEncPath, outEncPath);
  }

  // ---------- OSS PostObject 表单直传（file 字段必须最后） ----------
  async function postToOss(
    credential: RepoSnapshotCredential,
    encBuffer: Buffer,
  ): Promise<void> {
    const form = new FormData();
    const oss = credential.oss;
    form.append("key", oss.object_key);
    form.append("policy", oss.policy);
    form.append("x-oss-signature", oss.signature);
    if (oss.access_key_id) form.append("OSSAccessKeyId", oss.access_key_id);
    if (oss.security_token) form.append("x-oss-security-token", oss.security_token);
    form.append("callback", oss.callback ?? "");
    form.append("success_action_status", "200");
    form.append("x:snapshot_id", credential.snapshot_id);
    form.append("file", new Blob([new Uint8Array(encBuffer)]), `${credential.snapshot_id}.tar.gz.enc`);
    const resp = await fetchImpl(deps.config.ossPostEndpoint, {
      method: "POST",
      body: form,
    });
    if (resp.status !== 200) {
      const body = await resp.text();
      throw new Error(`OSS ${resp.status}: ${body.slice(0, 200)}`);
    }
  }

  return {
    fetchUploadCredential,
    buildManifest,
    buildExtraManifest,
    tarGzWorkspace,
    encryptEnvelope,
    postToOss,
  };
}

export type RepoSnapshotPipeline = ReturnType<typeof createRepoSnapshotPipeline>;
