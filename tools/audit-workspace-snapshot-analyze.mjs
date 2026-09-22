/**
 * 审计脚本的分析层：目录遍历 + 可疑痕迹识别。
 * 从 audit-workspace-snapshot-artifacts.mjs 拆出，纯只读、无网络请求。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 扫描上限，防止在超大目录上失控。 */
const MAX_SCAN_FILES = 200_000;
/** 单个候选文件读取上限：超过则不读内容，只按体积与文件名报告。 */
const MAX_TEXT_READ_BYTES = 4 * 1024 * 1024;
/** 体积告警阈值。 */
const LARGE_FILE_BYTES = 5 * 1024 * 1024;
/** 目录深度上限。 */
const MAX_DEPTH = 12;

/** 状态文件里出现这些键，说明它描述的是「某个工作区的快照任务」。 */
const STATE_KEY_HINTS = [
  "workspacePath",
  "workspace_path",
  "failureCount",
  "failure_count",
  "lastCompressedSize",
  "encryptedSizeBytes",
  "workspaceSizeBytes",
  "snapshotId",
  "snapshot_id",
  "uploadCredential",
  "upload_credential",
];

/** 清单文件里出现这些片段，说明它枚举了 .git 内部结构或快照元信息。 */
const MANIFEST_HINTS = [
  ".git/lfs",
  ".git\\lfs",
  ".git/objects",
  ".git\\objects",
  ".git/logs",
  "repo_snapshot_extra_manifest",
  "captureBeforePrompt",
  "repo-wiki-update",
];

/** 常见的密文块扩展名。 */
const BLOB_EXTENSIONS = new Set([".enc", ".age", ".gpg", ".encrypted"]);

/** 语义上通常承载「待上传队列／重试／检查点」的目录名。 */
const SUSPECT_DIR_NAMES = new Set([
  "pending",
  "retry",
  "retries",
  "queue",
  "outbox",
  "checkpoints",
  "snapshots",
  "uploads",
]);

const TEXT_LIKE_EXTENSIONS = new Set([
  "",
  ".json",
  ".jsonl",
  ".txt",
  ".state",
  ".meta",
  ".manifest",
  ".log",
]);

function relativeDirChain(rel) {
  const parts = rel.split(path.sep);
  const chain = [];
  for (let i = 1; i <= parts.length; i += 1) chain.push(parts.slice(0, i).join(path.sep));
  return chain;
}

/**
 * 遍历目录，收集文件清单与逐目录体积聚合。全程只读。
 */
async function walkTree(root) {
  const files = [];
  const dirBytes = new Map();
  const dirFiles = new Map();
  const unreadable = [];
  let truncated = false;
  let maxDepthSeen = 0;

  const stack = [{ rel: "", depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.depth > MAX_DEPTH) {
      truncated = true;
      continue;
    }
    const abs = current.rel ? path.join(root, current.rel) : root;

    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      unreadable.push({ path: abs, reason: String(error?.code ?? error) });
      continue;
    }

    for (const entry of entries) {
      const childRel = current.rel ? path.join(current.rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push({ rel: childRel, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true;
        continue;
      }

      const childAbs = path.join(root, childRel);
      let stat;
      try {
        stat = await fs.stat(childAbs);
      } catch (error) {
        unreadable.push({ path: childAbs, reason: String(error?.code ?? error) });
        continue;
      }

      files.push({ abs: childAbs, rel: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
      maxDepthSeen = Math.max(maxDepthSeen, current.depth + 1);

      // 把文件体积累加到它的每一级祖先目录上（不含文件自身）。
      if (current.rel) {
        for (const dir of relativeDirChain(current.rel)) {
          dirBytes.set(dir, (dirBytes.get(dir) ?? 0) + stat.size);
          dirFiles.set(dir, (dirFiles.get(dir) ?? 0) + 1);
        }
      }
    }
  }

  return { files, dirBytes, dirFiles, unreadable, truncated, maxDepthSeen };
}

async function readTextIfSmall(file) {
  if (file.size > MAX_TEXT_READ_BYTES) return null;
  try {
    return await fs.readFile(file.abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * 分析扫描结果，产出发现项。纯函数，便于自检。
 */
async function analyze(tree) {
  const findings = [];

  const encryptedBlobs = tree.files.filter((file) =>
    BLOB_EXTENSIONS.has(path.extname(file.rel).toLowerCase()),
  );
  for (const blob of encryptedBlobs) {
    findings.push({
      kind: "encrypted-blob",
      severity: "high",
      path: blob.rel,
      sizeBytes: blob.size,
      mtime: new Date(blob.mtimeMs).toISOString(),
      note: "疑似已打包加密的工作区快照密文块。密钥若由服务端下发，本地无法解密。",
    });
  }

  const largeFiles = tree.files
    .filter((file) => file.size >= LARGE_FILE_BYTES && !encryptedBlobs.includes(file))
    .sort((a, b) => b.size - a.size)
    .slice(0, 20);
  for (const file of largeFiles) {
    findings.push({
      kind: "large-file",
      severity: "medium",
      path: file.rel,
      sizeBytes: file.size,
      mtime: new Date(file.mtimeMs).toISOString(),
      note: "体积异常的文件，建议确认其用途。",
    });
  }

  const suspectDirs = new Set();
  for (const dir of tree.dirBytes.keys()) {
    const parts = dir.split(path.sep);
    if (parts.some((part) => SUSPECT_DIR_NAMES.has(part.toLowerCase()))) suspectDirs.add(dir);
  }
  for (const dir of suspectDirs) {
    findings.push({
      kind: "suspect-directory",
      severity: "medium",
      path: dir,
      sizeBytes: tree.dirBytes.get(dir) ?? 0,
      fileCount: tree.dirFiles.get(dir) ?? 0,
      note: "目录名语义指向待上传队列／重试／检查点。",
    });
  }

  const textCandidates = tree.files.filter((file) =>
    TEXT_LIKE_EXTENSIONS.has(path.extname(file.rel).toLowerCase()),
  );
  for (const file of textCandidates) {
    const text = await readTextIfSmall(file);
    if (text === null) continue;

    const matchedStateKeys = STATE_KEY_HINTS.filter((key) => text.includes(key));
    if (matchedStateKeys.length >= 2) {
      const workspaceMatches = [...text.matchAll(/"workspace(?:Path|_path)"\s*:\s*"([^"]+)"/g)].map(
        (match) => match[1],
      );
      findings.push({
        kind: "snapshot-state",
        severity: "high",
        path: file.rel,
        sizeBytes: file.size,
        mtime: new Date(file.mtimeMs).toISOString(),
        matchedKeys: matchedStateKeys,
        workspacePaths: workspaceMatches,
        note: "该文件记录了某个工作区的快照任务状态（含失败计数／压缩体积等）。",
      });
      continue;
    }

    const matchedManifestHints = MANIFEST_HINTS.filter((hint) => text.includes(hint));
    if (matchedManifestHints.length > 0) {
      findings.push({
        kind: "snapshot-manifest",
        severity: "high",
        path: file.rel,
        sizeBytes: file.size,
        mtime: new Date(file.mtimeMs).toISOString(),
        matchedHints: matchedManifestHints,
        note: "该文件枚举了 .git 内部结构或快照元信息，可用于判断打包范围。",
      });
    }
  }

  const topLevel = [...tree.dirBytes.entries()]
    .filter(([dir]) => !dir.includes(path.sep))
    .map(([dir, bytes]) => ({ dir, bytes, files: tree.dirFiles.get(dir) ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    findings,
    summary: {
      totalFiles: tree.files.length,
      totalBytes: tree.files.reduce((sum, file) => sum + file.size, 0),
      maxDepthSeen: tree.maxDepthSeen,
      truncated: tree.truncated,
      unreadableCount: tree.unreadable.length,
      encryptedBlobCount: encryptedBlobs.length,
      encryptedBlobBytes: encryptedBlobs.reduce((sum, file) => sum + file.size, 0),
    },
    topLevel,
    unreadable: tree.unreadable,
  };
}

export { walkTree, analyze };
