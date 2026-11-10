# 准备 IMDE 工程

IMDE 只会在包含 `imde.json` 的 SDK 工程中启用。

1. 使用 VS Code 打开 SDK 工程目录。
2. 如果工程位于工作区子目录，设置 `imde.projectDir` 指向包含 `imde.json` 的目录。
3. 打开左侧活动栏中的 **IMDE** 图标，可以看到 Environment、Build & Config 和 Artifacts 三个视图。

工程识别成功后，状态检查与构建命令会自动定位到正确的 SDK 根目录。

> 如果 IMDE 显示 “not an IMDE project”，先确认 `imde.json` 存在，再检查 `imde.projectDir`。
