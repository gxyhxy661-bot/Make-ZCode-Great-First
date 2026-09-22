/**
 * repo-snapshot 配置：端点与令牌。
 *
 * 「打包后不可编辑」的实现方式：缺省值是编译进产物的源码常量，构建后无法在产物内
 * 修改；process.env 覆盖仅供开发/自测使用（沿用全仓 ZCODE_* 环境变量惯例）。
 */
export const ZCODE_SNAPSHOT_ENDPOINT_ORIGIN_ENV = "ZCODE_SNAPSHOT_ENDPOINT_ORIGIN";
export const ZCODE_SNAPSHOT_CREDENTIAL_PATH_ENV = "ZCODE_SNAPSHOT_CREDENTIAL_PATH";
export const ZCODE_SNAPSHOT_OSS_POST_ENDPOINT_ENV = "ZCODE_SNAPSHOT_OSS_POST_ENDPOINT";
export const ZCODE_SNAPSHOT_AUTH_TOKEN_ENV = "ZCODE_SNAPSHOT_AUTH_TOKEN";

/** 编译期缺省值：指向本机 mock 后端（tools/repo-snapshot-uploader/mock-backend.mjs）。 */
const COMPILED_DEFAULTS = {
  endpointOrigin: "http://127.0.0.1:18787",
  credentialPath: "/api/v1/snapshot/upload-credential",
  ossPostEndpoint: "http://127.0.0.1:18788/postobject",
  authToken: "repro-dev-token",
} as const;

export interface RepoSnapshotConfig {
  endpointOrigin: string;
  credentialPath: string;
  ossPostEndpoint: string;
  authToken: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveRepoSnapshotConfig(): RepoSnapshotConfig {
  return {
    endpointOrigin:
      readEnv(ZCODE_SNAPSHOT_ENDPOINT_ORIGIN_ENV) ?? COMPILED_DEFAULTS.endpointOrigin,
    credentialPath:
      readEnv(ZCODE_SNAPSHOT_CREDENTIAL_PATH_ENV) ?? COMPILED_DEFAULTS.credentialPath,
    ossPostEndpoint:
      readEnv(ZCODE_SNAPSHOT_OSS_POST_ENDPOINT_ENV) ?? COMPILED_DEFAULTS.ossPostEndpoint,
    authToken:
      readEnv(ZCODE_SNAPSHOT_AUTH_TOKEN_ENV) ?? COMPILED_DEFAULTS.authToken,
  };
}
