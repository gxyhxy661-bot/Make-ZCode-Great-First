#!/usr/bin/env node
/**
 * 只读审计：检查本机应用数据目录中，「工作区被静默打包上传」留下的可观测痕迹。
 *
 * 背景：部分 AI 编程客户端会把整个工作区——包含完整 .git 历史（objects / LFS 缓存 /
 * reflog）与全局配置——打包后用服务端下发的公钥加密，再直传对象存储。加密私钥只在
 * 云端，本地密文无法解密，所以只能依靠留存在本地的「状态文件」「清单」与「待重试
 * 密文块」来反推发生过什么。
 *
 * 本工具是只读的：
 *   - 不删除、不移动、不修改任何文件；
 *   - 不发起任何网络请求；
 *   - 不读取文件内容以外的任何系统信息。
 * 它只输出报告。任何封堵动作都必须由使用者显式执行。
 *
 * 用法：
 *   node tools/audit-workspace-snapshot-artifacts.mjs
 *   node tools/audit-workspace-snapshot-artifacts.mjs --root "C:/Users/Administrator/.zcode"
 *   node tools/audit-workspace-snapshot-artifacts.mjs --json
 *   node tools/audit-workspace-snapshot-artifacts.mjs --fail-on-findings
 *   node tools/audit-workspace-snapshot-artifacts.mjs --self-test
 *
 * 退出码：0 正常；1 命中可疑痕迹且指定了 --fail-on-findings；2 参数错误。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkTree, analyze } from "./audit-workspace-snapshot-analyze.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    root: path.join(os.homedir(), ".zcode"),
    json: false,
    failOnFindings: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-on-findings") {
      options.failOnFindings = true;
    } else if (arg === "--self-test") {
      options.selfTest = true;
    } else if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) fail("用法错误：--root 需要一个目录参数。");
      options.root = value;
      i += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "只读审计本机数据目录中的工作区快照痕迹。",
          "",
          "  --root <dir>          要扫描的根目录，默认 ~/.zcode",
          "  --json                以 JSON 输出结果",
          "  --fail-on-findings    命中可疑痕迹时退出码为 1",
          "  --self-test           用临时合成样本自检，不扫描真实目录",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      fail(`用法错误：无法识别的参数 ${arg}`);
    }
  }
  return options;
}


function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const SEVERITY_LABEL = { high: "[高]", medium: "[中]", low: "[低]" };

function formatReport(root, result) {
  const lines = [];
  lines.push("=".repeat(72));
  lines.push("工作区快照痕迹审计（只读）");
  lines.push(`扫描根目录：${root}`);
  lines.push(`扫描时间：${new Date().toISOString()}`);
  lines.push("=".repeat(72));

  const { summary } = result;
  lines.push("");
  lines.push("--- 概览 ---");
  lines.push(`文件总数：${summary.totalFiles}`);
  lines.push(`占用总量：${formatBytes(summary.totalBytes)}`);
  lines.push(`目录深度：${summary.maxDepthSeen}`);
  if (summary.truncated) {
    lines.push("注意：扫描触发了上限，结果不完整（目录过深或文件过多）。");
  }
  if (summary.unreadableCount > 0) {
    lines.push(`无法读取的路径：${summary.unreadableCount} 个（多为权限或占用）。`);
  }

  if (result.topLevel.length > 0) {
    lines.push("");
    lines.push("--- 顶层目录占用 ---");
    for (const item of result.topLevel) {
      lines.push(`  ${formatBytes(item.bytes).padStart(10)}  ${item.files} 个文件  ${item.dir}/`);
    }
  }

  lines.push("");
  if (result.findings.length === 0) {
    lines.push("--- 未发现可疑痕迹 ---");
    lines.push("本次扫描没有命中加密块、快照状态文件或快照清单。");
  } else {
    lines.push(`--- 发现 ${result.findings.length} 项 ---`);
    for (const finding of result.findings) {
      lines.push("");
      lines.push(`${SEVERITY_LABEL[finding.severity] ?? ""} ${finding.kind}  ${finding.path}`);
      if (finding.sizeBytes !== undefined) lines.push(`     体积：${formatBytes(finding.sizeBytes)}`);
      if (finding.fileCount !== undefined) lines.push(`     文件数：${finding.fileCount}`);
      if (finding.mtime) lines.push(`     修改时间：${finding.mtime}`);
      if (finding.matchedKeys) lines.push(`     命中键：${finding.matchedKeys.join(", ")}`);
      if (finding.matchedHints) lines.push(`     命中片段：${finding.matchedHints.join(", ")}`);
      if (finding.workspacePaths?.length) {
        lines.push(`     关联工作区：${finding.workspacePaths.join(", ")}`);
      }
      lines.push(`     说明：${finding.note}`);
    }

    const highCount = result.findings.filter((item) => item.severity === "high").length;
    if (highCount > 0) {
      lines.push("");
      lines.push("--- 建议的下一步（需由你显式执行，本工具不做任何改动） ---");
      lines.push("  1. 先备份：把命中的目录整体复制一份到本机之外的位置。");
      lines.push("  2. 确认这些痕迹对应的客户端版本与登录状态，再决定如何处置。");
      lines.push("  3. 需要封堵时，按平台给数据目录加写入锁（macOS chflags uchg /");
      lines.push("     Linux chattr +i / Windows 用 ACL 或 attrib 拒绝写入）。");
      lines.push("  4. 重跑本工具对比，确认没有新的密文块产生。");
    }
  }

  lines.push("");
  lines.push("提示：本工具只读，未删除、未修改、未联网。");
  lines.push("");
  return lines.join("\n");
}

async function withSelfTestFixture(run) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-audit-fixture-"));
  try {
    const checkpoints = path.join(fixtureRoot, "v2", "checkpoints");
    const pending = path.join(checkpoints, "pending");
    await fs.mkdir(pending, { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, "cli", "db"), { recursive: true });

    await fs.writeFile(path.join(pending, "baseline.tar.gz.enc"), Buffer.alloc(313_070_842 % 4096));
    await fs.writeFile(
      path.join(checkpoints, "state.json"),
      JSON.stringify(
        {
          workspacePath: "/Users/example/myprojects/private-repo",
          lastCompressedSize: { encryptedSizeBytes: 313_070_842, workspaceSizeBytes: 345_549_173 },
          kind: "baseline",
          failureCount: 564,
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(checkpoints, "manifest.json"),
      JSON.stringify({ entries: [".git/lfs/objects/ab/cd", ".git/objects/pack", ".git/logs/HEAD"] }),
    );
    await fs.writeFile(path.join(fixtureRoot, "cli", "db", "db.sqlite"), Buffer.alloc(2048));

    return await run(fixtureRoot);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.selfTest) {
    const outcome = await withSelfTestFixture(async (fixtureRoot) => {
      const tree = await walkTree(fixtureRoot);
      const result = await analyze(tree);
      return { fixtureRoot, result };
    });
    const kinds = outcome.result.findings.map((item) => item.kind).sort();
    const expected = ["encrypted-blob", "snapshot-manifest", "snapshot-state"];
    const missing = expected.filter((kind) => !kinds.includes(kind));
    const ok = missing.length === 0;
    process.stdout.write(
      [
        "自检：在临时合成样本上运行审计。",
        `  合成目录：${outcome.fixtureRoot}（已清理）`,
        `  命中类型：${kinds.join(", ")}`,
        `  结果：${ok ? "通过" : `未命中预期类型 ${missing.join(", ")}`}`,
        "",
      ].join("\n"),
    );
    process.exit(ok ? 0 : 1);
  }

  let rootStat;
  try {
    rootStat = await fs.stat(options.root);
  } catch {
    process.stderr.write(`扫描根目录不存在：${options.root}\n`);
    process.stderr.write("用 --root <dir> 指定其他目录。\n");
    process.exit(2);
  }
  if (!rootStat.isDirectory()) {
    process.stderr.write(`扫描根目录不是目录：${options.root}\n`);
    process.exit(2);
  }

  const tree = await walkTree(options.root);
  const result = await analyze(tree);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ root: options.root, generatedAt: new Date().toISOString(), ...result }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(formatReport(options.root, result));
  }

  const hasHigh = result.findings.some((item) => item.severity === "high");
  process.exit(options.failOnFindings && hasHigh ? 1 : 0);
}

await main();
