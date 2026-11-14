# bash-slice


- 当前：`v0.1.0`
- 最新：`v0.1.0`（[Releases](https://github.com/QUNIXNG/bash-slice/releases)）
Pi 扩展：把过长的 bash / PowerShell 输出压成「头部 + 关键错误行 + 尾部」，减少送入模型的终端文本。

## 特点

- 保留开头 40 行、结尾 60 行，以及中段最多 40 条错误或警告。
- 去掉 ANSI 控制码，进度条只保留最终状态。
- 只有输出超过 120 行或 8192 字节，且至少能减少 15% 时才切片。
- 小输出、已经切片的输出不重复处理。
- 同步处理模型读取的 `content` 和 `structuredContent.output`。
- Pi 已保存完整输出时附上原文路径；未落盘时明确说明。

## 安装

将 `bash-slice.ts` 放到用户级 Pi 扩展目录：

```text
~/.pi/agent/extensions/bash-slice.ts
```

重新加载扩展后生效。

## 命令

```text
/slice on
/slice off
/slice status
/slice selftest
```

`status` 显示本会话触发次数和节省量；`selftest` 检查纯函数与工具钩子接线。
