# 图形化配置与 Pinmux

[打开 GUI Config](command:imde.guiConfig)

GUI Config 可以浏览 Kconfig 菜单、修改选项、查看依赖关系，并将结果保存到 `.config`。

[打开 Pinmux](command:imde.pinmux)

Pinmux 会从工程中的芯片和 BSP 文件发现可用配置，支持：

- 查看芯片引脚与复用功能
- 配置 GPIO、上下拉、驱动能力和 Owner
- 检查引脚冲突
- 生成 `board_pinmux.c` 和 `board_pins.h`

应用配置时请避免同时从终端执行修改 `.config` 或 BSP 的命令。
