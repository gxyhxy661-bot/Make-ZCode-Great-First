/**
 * repo-snapshot 本地状态存储：state.json / manifest.json / extra-manifest.json /
 * baseline.enc 的落盘布局，与原文观测到的 `~/.zcode/v2/checkpoints/` 结构一致。
 *
 * 状态唯一所有者是 repoSnapshotService；本模块只做无并发假设的读写原语。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDataBaseDir } from "../paths.js";
import type { RepoSnapshotStatus } from "./repoSnapshot.js";

/** 全仓约定的身份 key：workspaceIdentity 优先，workspacePath 兜底。 */
export function resolveRepoSnapshotWorkspaceKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  const identity = params.workspaceIdentity?.trim() || params.workspacePath;
  return createHash("sha1").update(identity).digest("hex").slice(0, 12);
}

/** 与原文一致的状态根目录：<dataBaseDir>/.zcode/v2/checkpoints/。 */
export function repoSnapshotCheckpointsRoot(): string {
  return path.join(getDataBaseDir(), ".zcode", "v2", "checkpoints");
}

export interface RepoSnapshotWorkspacePaths {
  root: string;
  encPath: string;
  uploadedDir: string;
  statePath: string;
  manifestPath: string;
  extraManifestPath: string;
}

export function resolveWorkspaceArtifactPaths(workspaceKey: string): RepoSnapshotWorkspacePaths {
  const root = path.join(repoSnapshotCheckpointsRoot(), workspaceKey);
  return {
    root,
    encPath: path.join(root, "baseline.enc"),
    uploadedDir: path.join(root, "uploaded"),
    statePath: path.join(root, "state.json"),
    manifestPath: path.join(root, "manifest.json"),
    extraManifestPath: path.join(root, "extra-manifest.json"),
  };
}

export async function loadRepoSnapshotState(
  paths: RepoSnapshotWorkspacePaths,
): Promise<RepoSnapshotStatus | null> {
  try {
    return JSON.parse(await fs.readFile(paths.statePath, "utf8")) as RepoSnapshotStatus;
  } catch {
    return null;
  }
}

export async function saveRepoSnapshotState(
  paths: RepoSnapshotWorkspacePaths,
  state: RepoSnapshotStatus,
): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  const payload = JSON.stringify(
    { ...state, updatedAt: new Date().toISOString() },
    null,
    2,
  );
  // 状态文件同样原子落盘，避免读侧看到半截 JSON。
  const tmpPath = `${paths.statePath}.tmp`;
  await fs.writeFile(tmpPath, payload);
  await fs.rename(tmpPath, paths.statePath);
}
