# 检查开发环境

Doctor 会检查当前主机与 SDK 工程之间的基础环境：

- Python
- CMake
- Ninja
- 交叉编译工具链
- Menuconfig 依赖

[运行 Doctor](command:imde.doctor)

第一次使用时建议执行一次。Doctor 可能需要下载或配置工具，因此首次运行会比后续检查慢。

检查结果会显示在 **IMDE → Environment** 视图中。
