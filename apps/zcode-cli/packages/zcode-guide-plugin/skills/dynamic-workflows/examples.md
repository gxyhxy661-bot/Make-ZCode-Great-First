# 动态工作流示例

以下示例为**示意稿**：展示脚本的结构与声明方式，具体 API 以当前
`@zcode/dynamic-workflow` 导出（`compileWorkflowScript` / `ARTIFACT_REGISTRY` /
`WORLD_READ_CAPS` / `REPORT_CAPS`）为准。

## 示例 1：两阶段代码检查

```ts
// 声明：本工作流产出一个 findings 产物。
artifact findings: Row[];

phase collect {
  // world-run：只读命令，落在 world-read 能力内。
  const diff = WORLD_RUN(`git diff --name-only main...HEAD`);
  for (const file of diff.split("\n").filter(Boolean)) {
    report.progress(`检查 ${file}`);
    // 阶段内调用 Agent 工具分析文件，把结论写入产物行。
    findings.push(await analyze(file));
  }
}

phase settle {
  // 结算：汇总 findings，输出结构化报告。
  report.summary(`${findings.length} 个发现`, findings);
}
```

## 示例 2：批量重构（带并发）

```ts
artifact rewrites: Row[];

phase plan {
  const targets = WORLD_RUN(`git ls-files '*.ts'`).split("\n").filter(Boolean);
  for (const t of targets) rewrites.push({ file: t, done: false });
}

phase apply {
  // 阶段内相互独立的行可并行；引擎按 actor 图与并发上限调度。
  await parallel(rewrites, async (row) => {
    row.result = await rewrite(row.file);
    row.done = true;
  });
}

phase verify {
  const failed = rewrites.filter((r) => !r.done);
  report.summary(`完成 ${rewrites.length - failed.length}/${rewrites.length}`, failed);
}
```

## 反例：不要这样写

- **未声明的 artifact**：直接 `push` 到未在顶部声明的产物 → 编译诊断
  （artifact hoisting / declaration 冲突）。
- **越界的 world-run**：引用未在能力范围内的命令（如写操作落在只读阶段）→ 编译失败。
- **孤立 phase 标记**：声明了阶段却没有任何语句 → `PHASE_MARKER` 诊断。
