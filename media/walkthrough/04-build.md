# 配置并构建

[Configure](command:imde.configure)  
[Build](command:imde.build)  
[Full Clean & Build](command:imde.fullCleanBuild)

- **Configure**：创建或更新 `build/` 目录中的 CMake 配置。
- **Build**：使用当前 `.config` 执行增量构建。
- **Rebuild / Full Clean & Build**：先清理整个构建目录，再重新配置和构建。

构建会显示在 `IMDE` 集成终端中。编译器错误会同步显示到 Problems 面板。

右下角进度通知支持取消。若需要中止正在运行的构建，点击通知上的关闭按钮。
