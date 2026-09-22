# Computer Use（电脑控制）

`computer-use` 官方插件的文档。插件携带一个基于 stdio 的 MCP server
（`dist/mcp/server.js`），把桌面自动化能力以工具形式注入 Agent 工具池。

## 能力概览

两条操作路径，按优先级使用：

1. **Accessibility 元素路径（首选）**：读取目标应用的无障碍树，对语义元素直接执行
   动作。精确、后台安全、不抢焦点。
2. **视觉像素路径（回退）**：仅当无障碍树无法定位/表达目标时，请求窗口或全屏截图，
   以帧绑定坐标提交动作。

## 工具清单

| 工具 | 用途 |
| --- | --- |
| `request_access` | 查询/请求 Accessibility 与 Screen Recording 授权（只调用一次） |
| `list_apps` / `list_windows` / `list_displays` / `switch_display` | 枚举运行中的应用、窗口、显示器并切换 |
| `open_application` | 按用户原始输入逐字符打开应用（不翻译、不改写、不归一化） |
| `get_app_state` | 获取应用状态（无障碍树 + 可选截图），返回 `state_id` 供元素目标引用 |
| `perform_action` | 对元素/坐标目标执行动作（`strategy="a11y"` 或 `"auto"`） |
| `screenshot` / `zoom` | 截图与局部放大（仅视觉路径） |
| `left_click` / `right_click` / `middle_click` / `double_click` / `triple_click` | 指针点击 |
| `left_click_drag` / `left_mouse_down` / `left_mouse_up` / `mouse_move` / `cursor_position` | 拖拽与指针状态 |
| `scroll` / `type` / `key` / `hold_key` | 滚动、输入、按键 |
| `set_value` / `select_text` | 无障碍语义的值设置与文本选择 |
| `read_clipboard` / `write_clipboard` | 剪贴板读写 |
| `wait` / `stop_computer_control` | 等待与停止会话 |

## 使用约定（与 skills/computer-use/SKILL.md 一致）

- 主 Agent 专用，禁止委托给子 Agent。
- 观察一次、执行一次、再验证；无障碍路径与视觉路径不对同一动作混用。
- 动作失败时先读原始错误消息再决定恢复动作；`request_access` 只在错误明确点名
  Accessibility / Screen Recording 时才调用一次。
- 授权被拒时如实告知用户并结束当前回合，不自动重试。
- 坐标只能来自最近一次返回的图像；不把文本/无障碍结果里的数字当坐标提交。

## 运行时组成

- `dist/mcp/server.js`：打包后的 MCP server（含 CUA runtime）。
- `node_modules/`：原生依赖（`sharp` 截图处理、`koffi` 原生 FFI、`@img/*`、
  `detect-libc`、`semver`）。seed 时由官方插件定义的 `runtimeTopLevelPaths`
  一并复制进插件缓存。
- `skills/computer-use/SKILL.md`：Agent 使用的技能正文。
- `scripts/computer-use-client.mjs`：零依赖的 stdio JSON-RPC 客户端，可直接对
  `dist/mcp/server.js` 做工具枚举与调用（排障/自测用）。

## 平台说明

无障碍与屏幕录制授权在 macOS 上需要用户显式批准；Windows 上部分窗口策略（UIPI）
会以失败收据形式返回。授权语义详见 SKILL.md 的失败处理节。
