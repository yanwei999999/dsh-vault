# dsh-vault

本机加密账号密码保险库，作为 **DeepSeek Harness（dsh）插件**使用。

> 把账号密码加密存在本机，只有**这台电脑**、输入**主密码**之后才能打开；
> 解锁后，dsh 里的 agent 可以自己调用工具读取凭据（例如帮你登录、填表、查余额）。

## 安全模型

- **加密**：AES-256-GCM；密钥由主密码经 PBKDF2-SHA256（60 万轮）派生。
- **本机绑定**：首次初始化生成随机 `machine.key`（32 字节）绑定本机；密文即使复制到
  别的电脑，没有这个密钥文件也解不开。
- **主密码不落盘**：不存储、不打印、不进 LLM、不经过聊天记录。
- **条目名也加密**：解锁前什么都看不到；解锁状态只存在 dsh 进程内存里，
  **重启 dsh 后自动重新锁定**。
- **仅本机访问**：管理页 `/vault` 由 dsh 的 web 服务器提供，默认只绑 `127.0.0.1` 回环。
- **防爆破**：连续 5 次密码错误锁定 60 秒。
- 提示：agent 通过 `vault_get` 取到的密码会出现在对话记录中（这是让它帮你登录的前提），请按需使用。

## 安装

```bash
# 1) 克隆/下载本仓库，然后安装到你的 web profile：
dsh plugin --profile web add <本目录路径或GitHub地址>
#    例如： dsh plugin --profile web add file:E:/path/to/dsh-vault

# 2) 重启 dsh web（插件在下次启动时生效）
```

重启后：
- 打开 <http://127.0.0.1:3080/vault> 输入主密码解锁 / 添加 / 查看 / 删除条目。
- 同一 dsh 会话里，agent 可以通过工具 `vault_status` / `vault_list` / `vault_get` 读取凭据。

## 初始化与 CLI（在 dsh 所在电脑的终端）

```bash
dsh-vault init                # 首次：设置主密码，生成本机密钥文件
dsh-vault add github          # 添加条目（交互输入账号/密码/备注）
dsh-vault list                # 列出条目名（需主密码）
dsh-vault get github          # 查看某条（需主密码）
dsh-vault remove github       # 删除条目（需主密码）
dsh-vault passwd              # 修改主密码（重加密全部条目）
dsh-vault status              # 保险库状态（不需要密码）
```

脚本/测试场景可用环境变量 `DSH_VAULT_PASSWORD` 提供主密码（注意它会在进程环境里短暂存在）。

## 文件位置

```
~/.dsh/vault/vault.json    加密保险库数据（可备份，但离开本机无 machine.key 打不开）
~/.dsh/vault/machine.key   本机绑定密钥（不要外传；换电脑需连它一起迁移）
```

## 与 dsh 的交互流程（示例）

1. 你：`dsh-vault init` + `dsh-vault add github`（存好账号密码）。
2. 你在 dsh web 里对 agent 说「帮我登录 github」。
3. agent 调用 `vault_get github` → 发现已锁定 → 让你到 <http://127.0.0.1:3080/vault> 解锁。
4. 你解锁后，agent 重试 `vault_get github` → 拿到账号密码帮你操作。

## License

[MIT](./LICENSE)
