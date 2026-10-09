# QuickDesign Bridge

为 MasterGo 中的 QuickDesign 插件提供本机 STDIO MCP 服务。多个智能体共享 Bridge，并显式选择目标文档。

## 最少操作的连接方式

在 MasterGo 中打开 QuickDesign → 智能体 → 复制连接说明，将说明交给你的本地智能体。
说明包含本仓库公开安装入口：智能体检查已有安装，缺失时下载安装器、配置客户端并尝试重新加载 MCP。
如果客户端不支持在当前会话加载新 MCP，需要重启客户端或新建会话一次。首次配对仍需核对插件显示的配对 ID 和目标文档。

## 独立安装

要求：macOS/Linux、Node.js >=22.18.0、可访问 GitHub Releases。本版本暂不支持原生 Windows。

固定下载入口：

- [独立安装器 install.mjs](https://github.com/sunpea/quickdesign-bridge/releases/latest/download/install.mjs)
- [SHA256SUMS](https://github.com/sunpea/quickdesign-bridge/releases/latest/download/SHA256SUMS)
- [版本和构建信息](https://github.com/sunpea/quickdesign-bridge/releases/latest/download/build.json)

在临时目录中下载并校验，再运行：

```sh
curl --fail --location --output install.mjs https://github.com/sunpea/quickdesign-bridge/releases/latest/download/install.mjs
curl --fail --location --output SHA256SUMS https://github.com/sunpea/quickdesign-bridge/releases/latest/download/SHA256SUMS
shasum -a 256 -c SHA256SUMS && node install.mjs
```

若下载失败，请先解决网络问题；不要继续执行文件。Linux 也可使用 `sha256sum -c SHA256SUMS` 校验。
安装器自带服务文件，没有 npm 依赖，不需要解压或运行 `npm install`。
也可以克隆本公开仓库后执行 `node scripts/install-mcp.mjs`。

安装生成：

- `~/.quickdesign/quickdesign-mastergo/server.mjs`：固定服务入口。
- `~/.quickdesign/quickdesign-mastergo/mcp.json`：本机绝对路径配置。
- `~/.quickdesign/quickdesign-mastergo/versions/<buildId>/`：完整版本文件。

将安装器打印的 `quickdesign_mastergo` 一项按当前客户端的格式合并到 MCP 配置，保留其他服务和设置。
使用本机绝对路径，不直接填 `~`。安装器只安装文件，不会自动注册客户端或启动服务。
重新加载 MCP 后由客户端启动 STDIO 服务，再调用 `mastergo_status`。

## 交给智能体的说明

请为当前 MasterGo 文档连接 QuickDesign Bridge。优先复用已加载的 quickdesign_mastergo MCP。
若尚未加载，读取 ~/.quickdesign/quickdesign-mastergo/mcp.json 并检查其中的服务路径。
若未安装，先确认 macOS/Linux 和 Node.js >=22.18.0；将上方公开 install.mjs 与 SHA256SUMS 下载到临时目录，校验 SHA-256 后使用本机 Node 的绝对路径执行。
读取生成的 mcp.json，将 quickdesign_mastergo 按当前客户端格式合并到 MCP 配置并尝试重新加载，保留其他服务和已有设置。
若当前会话无法加载新 MCP，明确提示我重启客户端或新建会话，不要重复安装或声称已连接。
工具可用后先调用 mastergo_status；配对前让我核对插件显示的配对 ID 和目标文档；多个文档在线时让我选择目标文档。不要修改画布来测试连接。

## 常见阻塞

- MasterGo 顶部自带 MCP 的启动提示不代表 QuickDesign Bridge 已启动。
- 插件扫描不到服务：检查客户端是否已注册并启动 `quickdesign_mastergo`，查看 MCP 启动日志中的 Node 路径、服务路径和权限。
- WebSocket `ws://127.0.0.1:50679–50686/quickdesign` 是插件和服务的内部通道，不能作为远程 MCP URL。
- 安装后仍无工具：重新加载客户端 MCP，必要时重启客户端或新建会话。
- 更新后报告版本冲突：先完成已有操作，再让所有客户端重新加载；不要强制终止正在写入的服务。

服务仅监听本机回环地址。首次访问文档需要配对，多文档需明确选择；不要重放结果未知的写入。
本仓库仅包含 Bridge 服务及安装工具。
