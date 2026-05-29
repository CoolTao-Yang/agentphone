# agentphone 使用说明

让你用手机（PWA + APK）通过 Tailscale 远程驱动桌面（WSL / macOS / Linux）上的 Claude Code。

---

## 0. 一句话

> 桌面跑 `agentphone` server，手机装 PWA / APK，登同一个 Tailscale 网络，**手机就能看 / 改 / 接管桌面 CLI 的会话**。

```
┌─────────────────┐      Tailscale       ┌──────────────────────────┐
│  手机 PWA/APK   │ ───────────────────  │  WSL/桌面 上的            │
│                 │   (你的私网, 不出局域) │  agentphone server       │
│  React-like     │                      │  + 它管的 claude.exe      │
│  chat UI        │                      │  + 它跟看的 cmax CLI      │
└─────────────────┘                      └──────────────────────────┘
```

---

## 1. 第一次安装（桌面）

只需要做一次。

```bash
# 1. 安装 Tailscale（如果还没装），登录到你自己的 tailnet
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 2. 克隆 + 装依赖
git clone https://github.com/CoolTao-Yang/agentphone.git
cd agentphone
npm install

# 3. (可选) 配 corp net 代理 — ByteDance / 内网必须填这个
mkdir -p ~/.config/agentphone
cat >> ~/.config/agentphone/env <<'EOF'
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1,10.*,172.16.*,192.168.*
EOF

# 4. 安装 systemd autostart（开机自动跑）
bash scripts/install-autostart.sh
```

启动起来，bash 会打印类似：

```
═══════════════════════════════════════════════════
📱  agentphone server on :8765
📂  default cwd:    /home/yzt/test
🤖  claude account: cmax (auto-detected)
🔑  token:          b23a804c65538eb7 (persisted)

Bookmark this on your phone (Chrome → Add to Home Screen).
It auto-redirects with the current token so it never goes stale:
   http://100.119.115.75:8765/launch
═══════════════════════════════════════════════════
```

记住 `http://100.119.115.75:8765/launch`（你的 Tailscale IP 替换）。

---

## 2. 手机端（两种安装方式）

### A. PWA（推荐 — 0 下载）

1. 用手机 Chrome 打开桌面打印的那条 `/launch` URL
2. 浏览器右上角菜单 → **添加到主屏幕**
3. 主屏幕上点 agentphone 图标 → 像 app 一样开

适合：你不想下 APK / 想立刻试

### B. APK（推荐 — 长期用更稳）

1. 手机 Chrome 打开 `http://<你的tailscale-ip>:8765/dist/agentphone.apk`
2. 下载 → 安装（系统问"未知来源"，允许一次）
3. 桌面图标"agentphone"
4. **首次打开 APK** 它会要你填 server URL，填 `http://<你的tailscale-ip>:8765`
5. 点连接，从此自动登录

适合：长期用 + 想做语音 / Push notification

---

## 3. 核心概念 — 三种 cowork 模式

```
              你想干嘛?
                  │
   ┌──────────────┼──────────────┬─────────────────┐
   ↓              ↓              ↓                 ↓
看 CLI 在干嘛  插一句给 CLI  fork 出独立 session  开新对话
   ↓              ↓              ↓                 ↓
👀 跟看        📤 注入         🔀 fork-history    +新建独立
```

### 👀 跟看（默认）

桌面 CLI 在跑啥，手机自动同步显示（live, 事件驱动）。你**完全不需要按任何东西**，打开 PWA 自动就跟看着当前 cmax CLI 的 session。

- 不需要桌面有人操作
- 适合：你在桌面写代码，扫一眼手机看 CLI 进度

### 📤 注入到 CLI queue (β)

你在 follow mode 里点 banner 上的 **📤 注入到 CLI** → 输入框解锁。你打字 → 直接写到 cmax CLI 的 jsonl 当作 queued user prompt。

- ⚠ **必须有人在桌面按 Enter 才真的让 claude.exe 跑**
- 适合：你和你的桌面 CLI **同时活跃**（在家 / 桌面没锁屏）

### 🔀 fork + 继承上下文 (α with history)

你在 follow mode 里点 banner 上的 **🔀 fork 新 session** → 立刻：
- 创建独立的手机 session B
- **B 的第一条 prompt 自动带上 A 的整段历史作为 context**
- B 后续的每个 turn 会摘要 mirror 回 A 的 jsonl 作 system entry（看得见但不影响 A 的 API context）

- 你可以从手机独立跑完全自动的对话
- 不需要桌面有人配合
- 适合：你出门 / 锁屏 / 沙发上想接续聊但不打扰桌面 CLI

### 🔗 把 fork 出来的 B 真正合并回 A

B 聊一阵后，banner 上有 **🔗 合并整段到 CLI** 按钮 → 把 B 的全部 user/assistant 对话**拼成一条 user message** 注入 A 的 queue。回到桌面按 Enter，cmax 的 claude.exe **真把 B 的内容当作 A 的 context** 接续聊。

---

## 4. 操作快速参考

### Header 按钮

| 按钮 | 干什么 |
|---|---|
| ☰ | 打开 session 抽屉 |
| 🔄 | 手动刷新当前 session |
| max | effort 等级（点切换 low/med/high/xhigh/max） |
| ⚡ | yolo（自动批准所有 tool 调用） |
| 🔈 | 朗读 assistant 回复（中文 TTS） |
| ⚙ | 调试日志面板 |

### Drawer

- **+ 新建**：开一个完全独立的新 session（不继承任何历史）
- **搜索框**：按 label / cwd / 首句搜
- **每条 session**：
  - **绿色 ● live**：cmax CLI 上正在 idle 但在线
  - **黄色 ● thinking**：cmax CLI 正在跑这条
  - **✎ 重命名** / **✕ 删除**

### Tool 卡片

cmax 想调工具时弹一张可折叠的卡。三个选项：
1. **✓ 批准**
2. **✗ 拒绝**
3. **本轮其他 同 tool 自动 approve**（checkbox）
4. **以后 同 tool 自动 approve**（checkbox，持久化）

---

## 5. Settings 同步

桌面浏览器 + 手机 APK + 手机 PWA 同时开。在任一端改 effort 或自动批准设置，**别的端 0.1 秒内自动同步**（CRDT 版本号 + broadcast）。

俩端同时改 → 冲突的那端弹 toast "另一端已更新设置，已同步" + 自动 rebase 到 server 当前值。

---

## 6. Push notifications

第一次发 prompt 时浏览器问"允许通知吗？"→ 允许。

之后每次 turn_done（claude 回完一条）→ 手机锁屏弹通知 `✅ Claude 回完了 / <对话末尾 180 字符>`。

- 点通知 → 自动 focus PWA / 切到那条 session
- 适合：扔家里跑长 task，出门也能看进度

不想要 push？浏览器设置里关 notification。

---

## 7. 常见问题

### 手机连上但发不了 prompt
- **banner 显示 follow mode + 🔒 cmax 拥有此 session · 不能发送**
  - 这是正确行为。直接看下面"为啥不能直接和 cmax 同 session 聊"
  - 想加东西：点 📤 注入到 CLI
  - 想独立聊：点 🔀 fork 新 session
- **banner 没显示但 send 按钮灰**：检查输入框是不是空的

### 桌面 CLI 突然死了 / claude.exe 不响应
- 桌面 corp net 时通常是 `HTTPS_PROXY` 没继承。检查：
  ```bash
  systemctl --user show agentphone.service -p Environment
  ```
- 应该看到 `HTTPS_PROXY=http://127.0.0.1:7897`。如果没有，编辑 `~/.config/agentphone/env` 加上，然后 `systemctl --user restart agentphone.service`

### Markdown 表格没渲染好
- 已经修了（v31）。如果还有问题，发图给作者

### APK 装完打开就跳浏览器
- 装的是老版（v6 之前的）。下个最新 APK：`http://<你的-ip>:8765/dist/agentphone.apk`

### 为啥不能直接让手机和 cmax 同 session 聊
- **不行物理上的原因**：两个 claude.exe 同时 `--resume <jsonl>` 互相抢着写 assistant block，**必然** race。一方会以 `ede_diagnostic` 错误退出
- **我们的解法**：要么 📤 inject（cmax 处理，单 owner），要么 🔀 fork-with-history（独立 session 但继承上下文）

---

## 8. 升级

```bash
cd ~/agentphone
git pull
systemctl --user restart agentphone.service
```

手机端：
- PWA：硬刷一次（Chrome 下拉手势 / Ctrl+Shift+R）拉新 SW 缓存
- APK：从 server 重新下 `dist/agentphone.apk` 装一遍

---

## 9. 多 account（cmax / cpro1 / cpro2 / ...）

如果 `~/.claude-accounts/` 下你有多个 account dir：

server 启动时**自动检测**，默认用第一个发现的（一般 cmax）。

**临时换**：编辑 `~/.config/agentphone/env`：

```bash
CLAUDE_CONFIG_DIR=/home/yzt/.claude-accounts/cpro1
```

然后 `systemctl --user restart agentphone.service`。

（运行时通过 UI 切换的 feature 在 P1 TODO 上，暂时还要重启 server）

---

## 10. 协议 + 架构（给开发者）

- 设计文档：[`DESIGN.md`](./DESIGN.md)
- 多 harness 抽象层：`server/harness/`
- WS 协议：`shared/types.ts`
- HarnessAdapter interface：`server/harness/types.ts`
- 想加新 harness（Codex / Cursor / opencode / ...）：照着 `server/harness/codex/adapter.ts` 这个 stub 实现 4 个方法就行

License: MIT。clay 的 jsonl-watcher 来源代码也 MIT 标了 attribution。hapi 是 AGPL-3.0 所以我们只参考了它的架构思路、没拷贝代码。

---

## 11. Bug / 反馈

直接发到 https://github.com/CoolTao-Yang/agentphone/issues 或者从手机 PWA 开 ⚙ 调试日志面板复制内容粘过来。
