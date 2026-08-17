# 🔐 dsh-vault

**本机加密账号密码保险库 · DeepSeek Harness（dsh）插件 + CLI**

把账号 / 密码加密存在**你这台电脑**上，只有**这台电脑**、输入**主密码**之后才能打开；
解锁后，dsh 里的 agent 可以自己调用工具读取凭据（帮你登录、填表、查余额）。

> 安全：AES-256-GCM + 本机绑定密钥，主密码不进磁盘、不进聊天记录；保险库数据**不会**上传到本仓库。

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-dsh--vault-black?logo=github)](https://github.com/yanwei999999/dsh-vault)

---

## ✨ 特性

- **AES-256-GCM 加密**：密钥由主密码经 PBKDF2-SHA256（60 万轮）派生；首次初始化为本机生成随机 `machine.key`（32 字节）绑定。
- **双重绑定**：密文离开本机（没有 `machine.key`）也解不开；复制到别的电脑一样打不开。
- **主密码不落盘**：不存储、不打印、不进 LLM、不经过聊天记录；解锁状态只存在 dsh 进程内存，**重启 dsh 后自动重新锁定**。
- **条目名也加密**：解锁前什么都看不到。
- **仅本机访问**：管理页 `/vault` 由 dsh 的 web 服务器提供，默认只绑 `127.0.0.1` 回环。
- **防爆破**：连续 5 次密码错误锁定 60 秒。
- **Agent 可读**：解锁后 dsh 的 agent 经 `vault_status` / `vault_list` / `vault_get` 直接读取凭据。
- **全功能 CLI**：`init` / `add` / `list` / `get` / `remove` / `passwd` / `status`。

---

## 🚀 快速开始（Quick Start）

### 1) 安装插件到你的 dsh profile

```bash
# 从本仓库（GitHub）直接安装到 web profile：
dsh plugin --profile web add git+https://github.com/yanwei999999/dsh-vault.git
# 或本地开发：dsh plugin --profile web add file:E:/path/to/dsh-vault
```

### 2) 重启 dsh web（插件在下次启动时生效）

重启后：
- 打开 <http://127.0.0.1:3080/vault> 输入主密码，即可**解锁 / 查看 / 添加 / 删除**条目。
- 同一 dsh 会话里，agent 可通过 `vault_status` / `vault_list` / `vault_get` 读写凭据。

### 3) 首次初始化（在 dsh 所在电脑的终端）

```bash
dsh-vault init        # 首次：设置主密码，生成本机密钥文件
dsh-vault add github  # 添加条目（交互输入账号 / 密码 / 备注）
dsh-vault status      # 查看状态（不需要密码）
```

---

## 🛠 CLI 参考

```bash
dsh-vault init                # 首次：设置主密码，生成本机密钥文件
dsh-vault add <name>          # 添加条目（交互输入账号/密码/备注）
dsh-vault list                # 列出条目名（需主密码）
dsh-vault get <name>          # 查看某条（需主密码）
dsh-vault remove <name>       # 删除条目（需主密码）
dsh-vault passwd              # 修改主密码（重加密全部条目）
dsh-vault status              # 保险库状态（不需要密码）
```

脚本 / 测试场景可用环境变量 `DSH_VAULT_PASSWORD` 提供主密码
（注意它会在进程环境里短暂存在，请按需使用）。

---

## 🤖 与 dsh 的交互流程（示例）

1. 你：`dsh-vault init` + `dsh-vault add github`（先存好账号密码）。
2. 你在 dsh web 里对 agent 说「帮我登录 github」。
3. agent 调用 `vault_get github` → 发现已锁定 → 让你到 <http://127.0.0.1:3080/vault> 解锁。
4. 你解锁后，agent 重试 `vault_get github` → 拿到账号密码帮你操作。

> 提示：agent 通过 `vault_get` 取到的密码会出现在对话记录中（这是让它帮你登录的前提），请按需使用。

---

## 📁 文件位置与备份

```
~/.dsh/vault/vault.json    加密保险库数据（可备份，但离开本机无 machine.key 打不开）
~/.dsh/vault/machine.key   本机绑定密钥（不要外传；换电脑需连它一起迁移）
```

- **备份**：把 `vault.json` + `machine.key` 一起备份（它们是配套的）；单独备份 `vault.json` 而丢失 `machine.key` 则无法解密。
- **迁移**：换电脑时，把这两个文件一起拷到新电脑的同一路径。

---

## 🔒 安全模型与边界

完整说明见 [`SECURITY.md`](./SECURITY.md)（保护点、明确「不防御什么」、以及「上传到 GitHub 不会泄露真实凭据」的说明）。

要点：
- 主密码**绝不落盘**；解锁状态仅存进程内存。
- 保险库数据（`vault.json` / `machine.key` / `.credentials.yaml`）已在本仓库 `.gitignore` **排除**，公开仓库不包含任何真实凭据。
- 防爆破锁定位 60 秒；仅限 `127.0.0.1` 回环访问。

---

## 📦 开发 / 构建

```bash
git clone https://github.com/yanwei999999/dsh-vault.git
cd dsh-vault
# 纯 Node（>=18），无构建步骤；Node 原样运行
node bin/dsh-vault.mjs status
node test/smoke.mjs          # 冒烟测试
```

---

## 📄 License

[MIT](./LICENSE) © yanwei999999

---

*本仓库是 `@dsh-vault` 的开源实现。绝不在仓库中存储任何用户真实凭据。*
