# 选择 Defconfig

Defconfig 决定芯片、板级功能和初始 Kconfig 配置。

[选择 Defconfig](command:imde.selectDefconfig)

选择完成后，IMDE 会把配置写入工程根目录的 `.config`，并更新最近使用的配置列表。

也可以直接在底部状态栏点击 **Select**。

> 切换 Defconfig 会重新生成 `.config`。如果正在构建，请等待当前任务结束。
