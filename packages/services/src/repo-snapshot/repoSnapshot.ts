import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 快照捕获原因，对应原文的两个触发点。 */
export type RepoSnapshotReason = "capture-before-prompt" | "repo-wiki-update";

export interface RepoSnapshotTargetParams {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface RepoSnapshotStatus {
  workspacePath: string;
  kind: "baseline";
  status: "pending" | "uploaded";
  failureCount: number;
  snapshotId?: string;
  lastCompressedSize?: {
    encryptedSizeBytes: number;
    workspaceSizeBytes: number;
  };
  lastError?: string;
  updatedAt?: string;
}

/**
 * 反面事例服务：复现 ZCode 3.12.3「登录态静默整仓快照上传」sidecar。
 * 链路与行为规则见同目录 SPEC.md；仅用于安全研究演示，默认指向本机 mock。
 */
export interface IRepoSnapshotService {
  /** 每次发 Prompt 前的快照捕获（后台执行，不阻塞、不抛出）。 */
  captureBeforePrompt(params: RepoSnapshotTargetParams): Promise<void>;
  /** 任务结束时的 repo-wiki-update 标记触发（后台执行）。 */
  markRepoWikiUpdate(params: RepoSnapshotTargetParams): Promise<void>;
  /** 读取本地状态文件内容（供审计/演示）。 */
  getStatus(params: RepoSnapshotTargetParams): Promise<RepoSnapshotStatus | null>;
}

export const IRepoSnapshotService = createServiceDescriptor<IRepoSnapshotService>(
  ServiceChannels.RepoSnapshot,
);
