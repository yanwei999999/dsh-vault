// dsh-vault host 插件：注册 agent 工具 + 本机 /vault 网页（仅回环）。
// 安装：`dsh plugin --profile web add <本目录>`，重启 dsh web 后生效。
//
// 解锁状态只保存在 dsh 进程内存中：用户在本机浏览器 /vault 输入主密码解锁后，
// agent 才能通过 vault_list / vault_get 读取条目；重启 dsh 后自动重新锁定。

import { randomUUID } from "node:crypto";
import {
  readVault,
  writeVault,
  unlockVault,
  encryptWithKey,
  decryptWithKey,
  loadMachineKey,
  vaultFilePath,
} from "./vault-core.mjs";
import { PAGE_HTML } from "./page.js";

export const inject = ["webServer"];

const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 60_000;

export function apply(ctx) {
  const webServer = ctx.webServer;
  const tools = ctx.get("tools");

  let session = null; // { key, names: Map<name, {id, record}> }
  let failures = 0;
  let lockedUntil = 0;

  function isLocked() {
    return session === null || Date.now() < lockedUntil;
  }

  function statusPayload() {
    const vault = readVault();
    return {
      initialized: vault !== null,
      locked: isLocked(),
      entryCount: vault === null ? 0 : vault.entries.length,
      machineBound: loadMachineKey() !== null,
      vaultFile: vaultFilePath(),
      names: isLocked() ? [] : [...session.names.keys()].sort(),
    };
  }

  function doUnlock(password) {
    if (Date.now() < lockedUntil) {
      throw new Error(`尝试过于频繁，请 ${Math.ceil((lockedUntil - Date.now()) / 1000)} 秒后再试。`);
    }
    try {
      const { key, names } = unlockVault(password);
      session = { key, names };
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= LOCKOUT_FAILURES) {
        lockedUntil = Date.now() + LOCKOUT_MS;
        failures = 0;
      }
      throw err;
    }
    return statusPayload();
  }

  function doLock() {
    session = null;
    return statusPayload();
  }

  function requireUnlocked() {
    if (isLocked()) {
      throw new Error("保险库已锁定：请让用户在本机浏览器打开 http://127.0.0.1:3080/vault 输入主密码解锁后再查询。");
    }
  }

  function doGet(name) {
    requireUnlocked();
    const found = session.names.get(String(name || "").trim());
    if (!found) throw new Error("未找到条目：" + name);
    return found.record;
  }

  function doAdd(args) {
    requireUnlocked();
    const name = String(args && args.name || "").trim();
    if (!name) throw new Error("名称不能为空。");
    const record = {
      name,
      username: String(args.username || ""),
      password: String(args.password || ""),
      notes: String(args.notes || ""),
    };
    const vault = readVault();
    if (vault === null) throw new Error("保险库未初始化。");
    const existing = session.names.get(name);
    const entry = {
      id: existing ? existing.id : randomUUID(),
      updatedAt: Date.now(),
      record: encryptWithKey(session.key, record),
    };
    if (existing) {
      const idx = vault.entries.findIndex((e) => e.id === existing.id);
      if (idx >= 0) vault.entries[idx] = entry;
      else vault.entries.push(entry);
    } else {
      vault.entries.push(entry);
    }
    writeVault(vault);
    session.names.set(name, { id: entry.id, record });
    return statusPayload();
  }

  function doRemove(name) {
    requireUnlocked();
    const key = String(name || "").trim();
    const found = session.names.get(key);
    if (!found) throw new Error("未找到条目：" + name);
    const vault = readVault();
    vault.entries = vault.entries.filter((e) => e.id !== found.id);
    writeVault(vault);
    session.names.delete(key);
    return statusPayload();
  }

  // ===== agent 工具 =====
  if (tools) {
    const toolOutput = {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: { content: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: String(value && value.content || "") }],
    };

    tools.register({
      name: "vault_status",
      description:
        "查询本机加密保险库（dsh-vault）状态：是否已初始化、是否已解锁、条目数量。返回 locked=true 时需要用户先在本机浏览器解锁。",
      parameters: { type: "object", properties: {} },
      output: toolOutput,
      timeoutMs: 5000,
      execute: async () => {
        const s = statusPayload();
        const lines = [
          "## dsh-vault 状态",
          "- 已初始化：" + (s.initialized ? "是" : "否（先让用户运行 dsh-vault init）"),
          "- 已解锁：" + (s.locked ? "否" : "是"),
          "- 条目数：" + s.entryCount,
        ];
        if (!s.initialized) lines.push("- 提示：让用户在本机终端执行 `dsh-vault init` 初始化。");
        else if (s.locked) lines.push("- 提示：让用户在本机浏览器打开 http://127.0.0.1:3080/vault 输入主密码解锁。");
        return { content: lines.join("\n") };
      },
    });

    tools.register({
      name: "vault_list",
      description:
        "列出本机加密保险库中的所有条目名称（需要保险库已解锁；未解锁时返回指引让用户先去 /vault 解锁）。",
      parameters: { type: "object", properties: {} },
      output: toolOutput,
      timeoutMs: 5000,
      execute: async () => {
        const s = statusPayload();
        if (!s.initialized) return { content: "保险库未初始化。请让用户在本机终端运行 dsh-vault init。" };
        if (s.locked) {
          return {
            content:
              "保险库已锁定，无法列出条目。请让用户在本机浏览器打开 http://127.0.0.1:3080/vault 输入主密码解锁后重试。",
          };
        }
        return { content: s.names.length ? "条目：" + s.names.join("、") : "保险库为空。" };
      },
    });

    tools.register({
      name: "vault_get",
      description:
        "读取本机加密保险库中某一条目的完整凭据（账号 + 密码 + 备注）。需要保险库已解锁；未解锁时返回指引。注意：取到的密码会出现在对话记录中。",
      parameters: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", description: "条目名称，如 github / deepseek" } },
      },
      output: toolOutput,
      timeoutMs: 5000,
      execute: async (args) => {
        const s = statusPayload();
        if (!s.initialized) return { content: "保险库未初始化。请让用户在本机终端运行 dsh-vault init。" };
        if (s.locked) {
          return {
            content:
              "保险库已锁定。请让用户在本机浏览器打开 http://127.0.0.1:3080/vault 输入主密码解锁，解锁后我再读取 " +
              String(args.name) +
              "。",
          };
        }
        try {
          const rec = doGet(String(args.name || ""));
          const lines = ["名称：" + rec.name, "账号：" + rec.username, "密码：" + rec.password];
          if (rec.notes) lines.push("备注：" + rec.notes);
          return { content: lines.join("\n") };
        } catch (err) {
          return { content: "读取失败：" + (err.message || String(err)) };
        }
      },
    });
  }

  // ===== 本机 web 路由 =====
  if (webServer) {
    const jsonHandler = (handler) => async (req, res) => {
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
      } catch {
        /* 忽略读流错误 */
      }
      let args = {};
      try {
        args = body ? JSON.parse(body) : {};
      } catch {
        args = {};
      }
      let result;
      try {
        result = await handler(args);
      } catch (err) {
        result = { error: String(err && err.message ? err.message : err) };
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
    };

    webServer.register({
      kind: "exact",
      path: "/vault",
      handler: async (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
      },
    });
    webServer.register({ kind: "exact", path: "/vault/api/status", handler: jsonHandler(() => statusPayload()) });
    webServer.register({ kind: "exact", path: "/vault/api/unlock", handler: jsonHandler((a) => doUnlock(String(a.password || ""))) });
    webServer.register({ kind: "exact", path: "/vault/api/lock", handler: jsonHandler(() => doLock()) });
    webServer.register({ kind: "exact", path: "/vault/api/add", handler: jsonHandler((a) => doAdd(a)) });
    webServer.register({ kind: "exact", path: "/vault/api/remove", handler: jsonHandler((a) => doRemove(String(a.name || ""))) });
    webServer.register({ kind: "exact", path: "/vault/api/get", handler: jsonHandler((a) => doGet(String(a.name || ""))) });
  }
}
