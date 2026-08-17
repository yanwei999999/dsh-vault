# baomi（保密）

收录本机安全 / 加密相关的 DeepSeek Harness (dsh) 工具与插件。

## 当前内容

### [`dsh-vault`](./dsh-vault)

**本机加密账号密码保险库**（dsh 插件 + CLI）：

- AES-256-GCM 加密，主密码 + 本机 `machine.key` 双重绑定；
- 只有**这台电脑**且输入**主密码**才能打开，重启 dsh 后自动重新锁定；
- 解锁后，dsh 里的 agent 可经工具 `vault_status` / `vault_list` / `vault_get` 直接读取凭据；
- 附带本机管理页（`/vault`）与命令行工具 `dsh-vault`；
- 详细说明见 [`dsh-vault/README.md`](./dsh-vault/README.md)，安全边界见 [`dsh-vault/SECURITY.md`](./dsh-vault/SECURITY.md)。

> 提示：插件源码在 `dsh-vault/`；`node_modules` 与保险库数据（`vault.json` / `machine.key`）**绝不进仓库**，安装时用
> `dsh plugin --profile web add` 从本目录链接，或发布成 npm 包后安装。

## License

MIT —— 见各子目录的 `LICENSE`。
