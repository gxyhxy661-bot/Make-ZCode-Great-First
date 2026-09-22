---
name: dynamic-workflows
description: 编写、编译与调试 ZCode 动态工作流脚本：阶段（phase）、产物（artifact）、世界读取（world-run）与报告（report）的核心模型与边界。
---

# 动态工作流编写指南

动态工作流是 ZCode 的一种**可编译、可重放**的任务脚本形态：你用 TS 方言写一个
workflow 脚本，dynamic-workflow 编译器先做静态分析（能力收窄 + 诊断），再由引擎
按阶段执行。

## 核心模型

| 概念 | 含义 | 关键约束 |
| --- | --- | --- |
| Phase（阶段） | 执行的最小推进单位，脚本里用 phase 标记声明 | 阶段标记必须闭合，孤立标记是编译诊断 |
| Artifact（产物） | 阶段间交换数据的行式记录 | 必须先声明（`ARTIFACT_ID_PATTERN` 约束），禁止隐式创建 |
| World-run（世界读取/执行） | 与真实世界交互的命令（shell、网络等） | 能力受 `WORLD_READ_CAPS` 收窄；未声明的命令编译期报错 |
| Report（报告） | 面向用户的结构化输出 | 能力受 `REPORT_CAPS` 收窄 |
| Actor 图 | 阶段/产物的依赖图 | 由编译器从脚本推导，用于并发与结算 |

## 编写流程

1. **声明产物**：脚本顶部声明本次工作流会产出的 artifact（id 必须匹配
   `ARTIFACT_ID_PATTERN`，家族见 `ARTIFACT_REGISTRY`）。
2. **划分阶段**：把任务拆成有明确输入输出的阶段，用 phase 标记分隔。
3. **声明世界交互**：每个与外部交互的命令都要落在 world-run 能力范围内；
   编译器会收集 `WORLD_RUN` 命令并做静态核对。
4. **产出报告**：用 report 能力输出结论；不要在工作流里直接打印面向用户的散文。

## 编译与诊断

- 编译入口是 `compileWorkflowScript`（`SCRIPT_FILE_NAME` 约定）；
- 诊断分家族：artifact 声明冲突（`ARTIFACT_PRIMARY_CONFLICT_CODE`）、phase 标记
  （`PHASE_MARKER_CODE`）、world-run 字面量（`WORLD_RUN_LITERAL_CODE`）等；
- **编译失败不执行**：诊断是硬边界，不要试图绕过能力收窄。

## 调试

- 先看编译诊断，再谈执行；
- 执行期问题按阶段定位：engine 的结算（settlement）记录会指出卡住的 artifact 行；
- 并发问题检查 actor 图：阶段间的数据依赖是否真的允许并行。
