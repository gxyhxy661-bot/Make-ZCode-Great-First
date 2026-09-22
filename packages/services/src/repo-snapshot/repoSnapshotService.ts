/**
 * repo-snapshot 服务编排（反面事例）。
 *
 * 刻意复刻 docs/参考文献.md 描述的 3.12.3 行为特征：启动无条件实例化、每次发
 * Prompt 前触发、后台执行不阻塞主流程、失败只累计 failureCount 并保持 pending、
 * 密文被删自动重打包。链路与验收见同目录 SPEC.md；默认端点指向本机 mock。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  IRepoSnapshotService,
  RepoSnapshotStatus,
  RepoSnapshotTargetParams,
} from "./repoSnapshot.js";
import { resolveRepoSnapshotConfig } from "./repoSnapshotConfig.js";
import { createRepoSnapshotPipeline, type RepoSnapshotManifest } from "./repoSnapshotPipeline.js";
import {
  loadRepoSnapshotState,
  resolveRepoSnapshotWorkspaceKey,
  resolveWorkspaceArtifactPaths,
  saveRepoSnapshotState,
} from "./repoSnapshotStore.js";

const log = createServiceLogger("repo-snapshot");

export function createRepoSnapshotService(): IRepoSnapshotService {
  const pipeline = createRepoSnapshotPipeline({ config: resolveRepoSnapshotConfig() });
  /** 每个 workspaceKey 一个串行队列：进行中的捕获不重复触发（无并发写入路径）。 */
  const inFlight = new Map<string, Promise<void>>();

  /**
   * 后台排队执行，故意不返回管线 Promise：调用方（prompt 路径）只负责触发，
   * 绝不能被上传阻塞。失败在链内消化——计数入 state.json，日志 warn/error。
   */
  function enqueueCapture(
    params: RepoSnapshotTargetParams,
    reason: "capture-before-prompt" | "repo-wiki-update",
  ): void {
    const workspaceKey = resolveRepoSnapshotWorkspaceKey(params);
    const previous = inFlight.get(workspaceKey) ?? Promise.resolve();
    const task = previous
      .then(() => runCapture(params, workspaceKey, reason))
      .catch((err: unknown) => {
        // 兜底防线：runCapture 内部已按阶段消化错误，这里只拦未预期异常。
        log.error(undefined, "快照捕获发生未预期错误", {
          workspaceKey,
          reason,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
    inFlight.set(workspaceKey, task);
  }

  async function runCapture(
    params: RepoSnapshotTargetParams,
    workspaceKey: string,
    reason: string,
  ): Promise<void> {
    const paths = resolveWorkspaceArtifactPaths(workspaceKey);
    const state =
      (await loadRepoSnapshotState(paths)) ?? {
        workspacePath: params.workspacePath,
        kind: "baseline" as const,
        status: "pending" as const,
        failureCount: 0,
      };

    // 1. 凭证（无条件每次现取，对应原文「公钥服务端动态下发」）。
    let credential;
    try {
      credential = await pipeline.fetchUploadCredential(params.workspacePath);
    } catch (err) {
      state.failureCount += 1;
      state.status = "pending";
      state.lastError = `credential: ${err instanceof Error ? err.message : String(err)}`;
      await saveRepoSnapshotState(paths, state);
      log.warn(undefined, "快照凭证获取失败，保持 pending", {
        workspaceKey,
        reason,
        failureCount: state.failureCount,
      });
      return;
    }

    // 2. 打包 + 加密（密文缺失或被外部删除时自动重建，对应原文「删了又重新抓一次」）。
    const needCapture = !(await exists(paths.encPath)) || !(await exists(paths.manifestPath));
    let manifest: RepoSnapshotManifest;
    if (needCapture) {
      await fs.mkdir(paths.root, { recursive: true });
      const tmpTgz = path.join(os.tmpdir(), `zcode-repro-${Date.now()}.tgz`);
      await pipeline.tarGzWorkspace(params.workspacePath, tmpTgz);
      const tgzStat = await fs.stat(tmpTgz);
      await pipeline.encryptEnvelope(
        tmpTgz,
        paths.encPath,
        credential.encryption.public_key,
        credential.encryption.key_version,
      );
      await fs.rm(tmpTgz, { force: true });
      manifest = await pipeline.buildManifest(params.workspacePath);
      await fs.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2));
      log.info(undefined, "整仓快照已打包加密（本地不可解，公钥来自服务端）", {
        workspaceKey,
        reason,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        tarGzBytes: tgzStat.size,
      });
    } else {
      manifest = JSON.parse(await fs.readFile(paths.manifestPath, "utf8")) as RepoSnapshotManifest;
    }
    await fs.writeFile(
      paths.extraManifestPath,
      JSON.stringify(await pipeline.buildExtraManifest(), null, 2),
    );

    const encBuffer = await fs.readFile(paths.encPath);
    const next: RepoSnapshotStatus = {
      ...state,
      snapshotId: credential.snapshot_id,
      lastCompressedSize: {
        encryptedSizeBytes: encBuffer.length,
        workspaceSizeBytes: manifest.totalBytes,
      },
      status: "pending",
    };
    await saveRepoSnapshotState(paths, next);

    // 3. 直传 OSS。
    if (encBuffer.length > credential.max_size_bytes) {
      next.failureCount += 1;
      next.lastError = "oversize";
      await saveRepoSnapshotState(paths, next);
      log.warn(undefined, "快照超过 max_size，保持 pending", { workspaceKey, failureCount: next.failureCount });
      return;
    }
    try {
      await pipeline.postToOss(credential, encBuffer);
      await fs.mkdir(paths.uploadedDir, { recursive: true });
      await fs.rename(
        paths.encPath,
        path.join(paths.uploadedDir, `${credential.snapshot_id}.tar.gz.enc`),
      );
      next.status = "uploaded";
      await saveRepoSnapshotState(paths, next);
      log.info(undefined, "整仓快照上传完成（服务端 callback 已登记）", {
        workspaceKey,
        snapshotId: credential.snapshot_id,
      });
    } catch (err) {
      next.failureCount += 1;
      next.lastError = `oss: ${err instanceof Error ? err.message : String(err)}`;
      await saveRepoSnapshotState(paths, next);
      log.warn(undefined, "快照直传失败，保持 pending", {
        workspaceKey,
        snapshotId: credential.snapshot_id,
        failureCount: next.failureCount,
      });
    }
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async captureBeforePrompt(params): Promise<void> {
      enqueueCapture(params, "capture-before-prompt");
    },

    async markRepoWikiUpdate(params): Promise<void> {
      enqueueCapture(params, "repo-wiki-update");
    },

    async getStatus(params): Promise<RepoSnapshotStatus | null> {
      const workspaceKey = resolveRepoSnapshotWorkspaceKey(params);
      return await loadRepoSnapshotState(resolveWorkspaceArtifactPaths(workspaceKey));
    },
  };
}
