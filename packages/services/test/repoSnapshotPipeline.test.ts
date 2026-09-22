import assert from "node:assert/strict";
import { privateDecrypt, createDecipheriv, generateKeyPairSync, constants } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRepoSnapshotPipeline } from "../src/repo-snapshot/repoSnapshotPipeline.js";
import { resolveRepoSnapshotWorkspaceKey } from "../src/repo-snapshot/repoSnapshotStore.js";
import { createRepoSnapshotService } from "../src/repo-snapshot/repoSnapshotService.js";
import type { RepoSnapshotStatus } from "../src/repo-snapshot/repoSnapshot.js";
import { setDataBaseDir } from "../src/paths.js";

const noopTar = async () => {};

function baseConfig(overrides?: Partial<Parameters<typeof createRepoSnapshotPipeline>[0]["config"]>) {
  return {
    endpointOrigin: "http://127.0.0.1:1",
    credentialPath: "/credential",
    ossPostEndpoint: "http://127.0.0.1:1/postobject",
    authToken: "test-token",
    ...overrides,
  };
}

test("信封加密回环：服务端私钥可解，明文一致", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repo-snap-env-"));
  try {
    const plain = join(dir, "payload.bin");
    const plainBuf = Buffer.from("tar.gz-bytes-".repeat(1024));
    await writeFile(plain, plainBuf);
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const encPath = join(dir, "baseline.enc");

    const pipeline = createRepoSnapshotPipeline({
      config: baseConfig(),
      tarImpl: noopTar,
    });
    await pipeline.encryptEnvelope(plain, encPath, publicKey.export({ type: "spki", format: "pem" }), 7);

    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(encPath);
    assert.equal(buf.subarray(0, 8).toString("ascii"), "ZSNAPENV");
    const headerLen = buf.readUInt16BE(9);
    const header = JSON.parse(buf.subarray(11, 11 + headerLen).toString("utf8"));
    assert.equal(header.keyWrapAlgorithm, "rsa-oaep-sha256");
    assert.equal(header.keyId, "7");

    const aesKey = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(header.wrappedKeyB64, "base64"),
    );
    const decipher = createDecipheriv("aes-256-ctr", aesKey, Buffer.from(header.ivB64, "base64"));
    const plain2 = Buffer.concat([decipher.update(buf.subarray(11 + headerLen)), decipher.final()]);
    assert.ok(plain2.equals(plainBuf));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspaceKey 规则：workspaceIdentity 优先且 trim，path 兜底", () => {
  const byPath = resolveRepoSnapshotWorkspaceKey({ workspacePath: "/ws/a" });
  assert.equal(byPath, resolveRepoSnapshotWorkspaceKey({ workspacePath: "/ws/a" }));
  assert.equal(
    resolveRepoSnapshotWorkspaceKey({ workspacePath: "/ws/a", workspaceIdentity: "  id-1  " }),
    resolveRepoSnapshotWorkspaceKey({ workspacePath: "/ws/b", workspaceIdentity: "id-1" }),
  );
  assert.notEqual(byPath, resolveRepoSnapshotWorkspaceKey({ workspacePath: "/ws/b" }));
});

test("凭证接口失败：failureCount 递增且状态保持 pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repo-snap-fail-"));
  const previousToken = process.env.ZCODE_SNAPSHOT_ENDPOINT_ORIGIN;
  process.env.ZCODE_SNAPSHOT_ENDPOINT_ORIGIN = "http://127.0.0.1:1"; // 不可达端口
  try {
    setDataBaseDir(dir);
    const service = createRepoSnapshotService();
    const params = { workspacePath: dir };
    await service.captureBeforePrompt(params);
    // 后台执行：轮询等待状态落盘。
    let status: RepoSnapshotStatus | null = null;
    for (let i = 0; i < 50 && !status; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await service.getStatus(params);
    }
    assert.ok(status);
    assert.equal(status.status, "pending");
    assert.equal(status.failureCount, 1);
    assert.match(status.lastError ?? "", /credential/);
  } finally {
    if (previousToken === undefined) delete process.env.ZCODE_SNAPSHOT_ENDPOINT_ORIGIN;
    else process.env.ZCODE_SNAPSHOT_ENDPOINT_ORIGIN = previousToken;
    await rm(dir, { recursive: true, force: true });
  }
});

/** 本地 mock：credential + OSS 直传 + callback，验证全链路成功置 uploaded。 */
function startMockBackend(): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/v1/snapshot/upload-credential") {
        const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            snapshot_id: "snap-test",
            max_size_bytes: 1 << 30,
            encryption: {
              key_version: 1,
              public_key: publicKey.export({ type: "spki", format: "pem" }),
            },
            oss: {
              object_key: "snapshot/test.tar.gz.enc",
              policy: Buffer.from("{}").toString("base64"),
              signature: "sig",
              callback: Buffer.from(
                JSON.stringify({ callbackUrl: `http://127.0.0.1:${(req.socket.localPort ?? 0)}/callback`, callbackBody: "" }),
              ).toString("base64"),
            },
          }),
        );
        return;
      }
      if (req.method === "POST" && url === "/postobject") {
        received.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"Status":"OK"}');
        return;
      }
      if (req.method === "POST" && url === "/callback") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, received });
    });
  });
}

test("全链路成功：prompt 前触发捕获，服务端接收后状态 uploaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repo-snap-ok-"));
  const { server, port, received } = await startMockBackend();
  const previousOrigin = process.env.ZCODE_SNAPSHOT_ENDPOINT_ORIGIN;
  const previousOss = process.env.ZCODE_SNAPSHOT_OSS_POST_ENDPOINT;
  process.env.ZCODE_SNAPSHOT_ENDPOINT_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.ZCODE_SNAPSHOT_OSS_POST_ENDPOINT = `http://127.0.0.1:${port}/postobject`;
  try {
    setDataBaseDir(dir);
    const service = createRepoSnapshotService();
    const params = { workspacePath: dir };
    await service.captureBeforePrompt(params);
    let status: RepoSnapshotStatus | null = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await service.getStatus(params);
      if (status?.status === "uploaded") break;
    }
    assert.ok(status, "状态文件应已落盘");
    assert.equal(status.status, "uploaded");
    assert.equal(status.failureCount, 0);
    assert.equal(status.snapshotId, "snap-test");
    assert.ok(received.length >= 1, "OSS 替身应收到至少一次直传");
    assert.ok(received[0]!.length > 0);
  } finally {
    if (previousOrigin === undefined) delete process.env.ZCODE_SNAPSHOT_ENDPOINT_ORIGIN;
    else process.env.ZCODE_SNAPSHOT_ENDPOINT_ORIGIN = previousOrigin;
    if (previousOss === undefined) delete process.env.ZCODE_SNAPSHOT_OSS_POST_ENDPOINT;
    else process.env.ZCODE_SNAPSHOT_OSS_POST_ENDPOINT = previousOss;
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
