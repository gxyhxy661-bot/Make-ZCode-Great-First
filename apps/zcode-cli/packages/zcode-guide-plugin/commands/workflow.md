# /workflow — 动态工作流

把多步骤任务写成可复用的动态工作流脚本，交给 ZCode 的 workflow 引擎按阶段执行。

## 用法

```
/workflow <workflow 脚本路径或内联描述>
```

- 指向一个 workflow 脚本文件（TS 方言，经 dynamic-workflow 编译器编译）；
- 或用一句话描述目标，由 Agent 起草脚本后再进入编译与执行。

## 执行模型

1. **编译期**：`dynamic-workflow` 编译器对脚本做静态分析——收集 artifact 声明、
   world-run 命令、phase 标记与 actor 图，越界访问（超出 world-read/report 能力）
   直接产生编译诊断，不进入执行。
2. **运行期**：engine 按阶段推进，阶段间通过 artifact 行交换数据；并发、结算与
   重放由 engine 统一裁决。
3. **产物**：执行产生 artifact 行与 report，可在会话时间线中审查。

## 何时用 / 何时不用

- 适合：步骤固定、需要可重放与可审计的多阶段任务（批量改造、验证流水线）。
- 不适合：探索性任务（步骤未知）——直接对话即可，不要硬套工作流。

## 排障

- 编译诊断出现在脚本保存后立即反馈，按诊断行号修正；
- 执行卡住时优先检查 phase 标记与 world-run 命令是否闭合；
- 更完整的编写指南见 `skills/dynamic-workflows/SKILL.md`。
