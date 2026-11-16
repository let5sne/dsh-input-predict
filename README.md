# DSH 输入预测插件

输入框为空时，根据当前会话预测用户的下一条消息，并以占位提示（placeholder）的形式显示在输入框内。提示不是草稿内容；用户按 Tab 后，才通过 DSH 的修订号保护接口插入真实草稿，不会自动发送。

> 包名 `@let5sne/dsh-input-predict`，版本 1.0.0，MIT 许可证。支持 DSH **0.2.2-rc.3**。插件使用当前版本的局部输入标记核验编辑器身份，标记不匹配时会保守停用预测，不猜测其他输入框。通过 GitHub Release 分发，未发布到 npm。

## 已实现功能

- **入口图标**：位于输入框下方、模型选择控件左侧。灰色为未开启，深色为已开启；点击切换，选择保存在当前浏览器，Desktop 重启后保留。
- **占位提示**：开启后，输入框为空时把预测的下一条消息显示在输入框内，替代原生占位文字，右侧标注 `Tab`。提示不写入草稿、不参与发送。
- **随草稿显隐**：输入任何内容即隐藏提示；清空后恢复显示同一条预测，不重复请求。有附件时不显示。未开启时不显示、不请求。
- **刷新时机**：每个会话上下文只预测一次并缓存；助手完成新一轮、会话有新活动或连接重建时重新预测。助手运行或消息发送中暂停显示。
- **采纳与忽略**：输入框获得焦点且为空时，按 Tab 插入提示文本，按 Esc 忽略到下一轮。只有插入成功才消费 Tab；无提示时 Tab 保持原生焦点导航。插入可一次撤销。
- **兼容保护**：输入法组合、`@` / `/` 菜单、输入结构不兼容或编辑器锁定时不请求、不拦截按键。
- 同一输入框至多一个在途请求；有防抖、请求取消、迟到响应丢弃和缓存过期。
- Host 端过滤与近期用户消息高度重复的候选，并要求模型预测对最新助手回复的跟进，而不是复述上一条消息。
- Host 预测 Remote 在读取会话和调用模型之前执行 Session 资源授权，并限制上下文、输出、超时、会话最小间隔和全局并发。
- 默认跟随 profile 默认模型，也可单独配置 provider/model；没有新增外部凭据存储。
- 卸载插件会移除槽位、监听器和计时器，并取消请求。

## 安装

在 DSH 的插件市场中添加索引：

```text
https://raw.githubusercontent.com/let5sne/dsh-prompt-enhance/main/market/index.json
```

然后在市场中安装“输入预测”（`@let5sne/dsh-input-predict`）。也可以从 [GitHub Releases](https://github.com/let5sne/dsh-input-predict/releases) 下载 tarball，或在插件管理中安装本地目录。

本地开发时在项目目录运行：

```sh
npm install --ignore-scripts
npm run build
npm test
npm run check
```

安装或重建 `client.js` 后刷新页面（或新开一个会话），让浏览器加载最新的模块。安装后：

1. 打开会话，在输入框下方、模型选择左侧找到输入预测图标。
2. 点击图标使其变为深色。首次安装默认关闭，因此仅安装不会自动发起模型请求。
3. 等助手本轮结束、输入框为空时，预测会以占位提示出现在输入框内；聚焦输入框后按 Tab 采纳。

`npm run build` 生成浏览器入口 `client.js`（源文件在 `web/`）。`npm run check` 检查 JavaScript 语法、导出文件、bundle patch 和两种 locale。

## 配置

Host 配置位于插件行 `input-predict` 的 `config`：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | Host 总开关；`false` 时不读取会话或调用模型 |
| `provider` / `model` | 未设置 | 必须同时设置；省略时跟随 profile 默认模型 |
| `reasoningEffort` | 未设置 | 仅显式配置时传入；不继承主对话的推理强度 |
| `debounceMs` | `900` | 输入框清空或新一轮结束后发起预测前的等待时间 |
| `historyMessages` | `12` | 最多发送的近期文本消息数 |
| `historyChars` | `12000` | 历史文本总字符预算 |
| `draftChars` | `6000` | 接受的最长草稿 |
| `outputChars` | `600` | 接受的最长候选 |
| `maxTokens` | `256` | 模型输出 token 上限 |
| `timeoutMs` | `15000` | 单次预测超时 |
| `maxConcurrent` | `2` | 进程内同时进行的预测数 |
| `minIntervalMs` | `1500` | 同一会话两次预测的最小间隔 |

会话上下文只取当前有效消息面中的 `user` 和 `assistant` 文本块；排除思考、system/developer 指令、工具输出、附件二进制和其他会话。Host 在模型调用前后比较上下文版本，变化即丢弃结果。页面在收到会话活动和连接变化时丢弃缓存的预测，缓存最长保留 5 分钟。Tab 采纳是同步操作，不额外发起网络校验；事件通知存在延迟，因此不宣称跨进程的“采纳瞬间上下文”原子一致性。

## 隐私与费用

开启预测后，打开的会话在输入框为空时会把近期会话文本发送给所配置模型的服务商，并产生额外模型用量；每轮对话最多请求一次。预测不会写入会话历史、自动发送、启动 Agent 回合或执行工具。未采纳的预测仅保存在当前页面内存中，并随会话活动或连接变化清除。

## 兼容性与已知限制

- 仅面向当前安装版本 `0.2.2-rc.3` 开发。DSH 尚无公开的输入框身份、焦点、选区和输入法订阅契约；插件在自身槽位附近读取当前实现使用的 `data-conversation-content`、`data-composer-seat`、`data-composer-input`、`data-composer-card` 与 `data-trigger-menu` 标记，并严格核对 slot 的 `sessionId`。这些不是稳定公共 API，升级 DSH 后必须重新验证。
- 无法唯一映射编辑器、会话身份不符、存在多个输入根、未知输入浮层或文档级菜单/对话框时，插件停止预测并保留原生 Tab。
- 输入菜单无法仅靠 `defaultPrevented` 判断；插件直接检查菜单标记，存在菜单时不请求、不拦截按键。
- 占位提示在 `conversation.input.overlay` 槽位内按原生占位文字的位置绘制，显示时仅隐藏本会话输入框的原生占位文字。字号或边距随 DSH 版本变化时可能出现轻微错位。
- 浏览器集成测试需要本机登录的 DSH 页面；本仓库不包含绕过认证、读取浏览器 profile 或劫持会话数据的脚本。
- 单元测试和 Gateway 授权测试覆盖了确定行为，但不能替代所有输入法、窄布局、真实鼠标/键盘组合及模型质量的验证。

## 代码结构

```text
index.js                    Host bundle 入口、Config、Service 注册
host/predictor.js           上下文裁剪、模型调用、预算、并发、取消与输出校验
host/remote.js              Session 资源授权的公开 Remote 注册
web/client.js               图标开关、输入框内占位提示、locale、快捷键与 Remote 调用
web/prediction-store.js     图标与提示共享的开关状态
web/enabled-preference.js   开关选择的浏览器持久化
web/prediction-controller.js 无框架预测缓存与显隐状态机
web/input-bridge.js         版本限定、失配关闭的输入桥接
client.js                   构建后的浏览器模块（由 web/ 生成）
cordis.patch.yml            bundle 行
locale/{zh,en}.json         展示标题与说明
tests/                      Host、状态机、输入桥接和 Gateway 授权测试
```

## 验证

```sh
npm test
npm run check
npm pack --dry-run
```

测试包含：空输入框才请求与显示、输入后隐藏且清空后恢复同一预测、关闭时取消并隐藏、迟到响应不能覆盖新预测、菜单/输入法/运行态暂停、采纳失败不消费按键、缓存过期、复述过滤、取消/超时、越权调用在读取前拒绝、上下文预算、并发和最小间隔、输出严格解析，以及 Session 资源授权集成测试。

真实浏览器中的明暗主题、输入法候选窗、`@` / `/` 菜单、多个输入框、引用 chip 和窄布局仍需在目标 DSH 页面复核；这些项目前不声称已全部人工验证。

## 许可与分发

MIT 许可证。包名为 `@let5sne/dsh-input-predict`，源码位于 [let5sne/dsh-input-predict](https://github.com/let5sne/dsh-input-predict)。版本通过 Git 提交与 GitHub Release 分发；npm 尚未发布。
