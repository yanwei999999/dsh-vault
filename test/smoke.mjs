// dsh-vault 冒烟测试：加密核心 + host 插件（工具注册 / web 路由 / 解锁 / 读取 / 锁定 / 本机绑定）。
// 运行：node test/smoke.mjs   （使用临时 DSH_HOME，不碰真实保险库）

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVault, unlockVault, encryptWithKey, writeVault, vaultDir, machineKeyPath } from "../lib/vault-core.mjs";

const MASTER = "test-master-password-2026";
const PASS = "super-secret-pass-xyz";

const home = mkdtempSync(join(tmpdir(), "dsh-vault-test-"));
process.env.DSH_HOME = home;

// ---- 初始化 + 手动写入一条（等价于 CLI add）----
createVault(MASTER);
{
  const { key, vault } = unlockVault(MASTER);
  const record = { name: "github", username: "yanwei999999", password: PASS, notes: "测试条目" };
  vault.entries.push({ id: "e1", updatedAt: Date.now(), record: encryptWithKey(key, record) });
  writeVault(vault);
}

// ---- 明文检查：vault.json 里不得出现任何敏感字段 ----
{
  const raw = readFileSync(join(vaultDir(), "vault.json"), "utf8");
  for (const secret of [PASS, "yanwei999999", "github", "super-secret"]) {
    assert.ok(!raw.includes(secret), "vault.json 不应包含明文：" + secret);
  }
  console.log("✔ 密文落盘：vault.json 无明文（名称/账号/密码均加密）");
}

// ---- 加载 host 插件，挂到假 ctx ----
const registeredTools = [];
const registeredRoutes = [];
const fakeCtx = {
  webServer: { register: (r) => registeredRoutes.push(r) },
  get: (key) => (key === "tools" ? { register: (t) => registeredTools.push(t) } : undefined),
};
const { apply } = await import("../lib/index.js");
apply(fakeCtx);

const toolNames = registeredTools.map((t) => t.name).sort();
assert.deepEqual(toolNames, ["vault_get", "vault_list", "vault_status"]);
console.log("✔ 插件注册了 3 个 agent 工具：", toolNames.join(", "));

const routePaths = registeredRoutes.map((r) => r.path).sort();
assert.ok(routePaths.includes("/vault"));
assert.ok(routePaths.includes("/vault/api/unlock"));
assert.ok(routePaths.includes("/vault/api/get"));
console.log("✔ 插件注册了本机 web 路由：", routePaths.join(", "));

// ---- 用假 req/res 调 web 路由 ----
function callRoute(path, body) {
  const route = registeredRoutes.find((r) => r.path === path);
  assert.ok(route, "缺少路由 " + path);
  return new Promise((resolve) => {
    const chunks = [Buffer.from(JSON.stringify(body ?? {}))];
    const req = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
      },
    };
    const res = {
      writeHead: (s, h) => void 0,
      end: (d) => resolve(JSON.parse(d)),
    };
    route.handler(req, res);
  });
}

const locked = await callRoute("/vault/api/status", {});
assert.equal(locked.initialized, true);
assert.equal(locked.locked, true);
assert.equal(locked.entryCount, 1);
assert.deepEqual(locked.names, []);
console.log("✔ 未解锁时：状态显示 locked，看不到任何条目名");

const wrongPw = await callRoute("/vault/api/unlock", { password: "wrong-password" });
assert.ok(wrongPw.error, "错误密码应返回 error");
console.log("✔ 错误密码被拒绝：" + wrongPw.error);

const ok = await callRoute("/vault/api/unlock", { password: MASTER });
assert.ok(!ok.error, "正确密码应解锁成功：" + (ok.error || ""));
assert.equal(ok.locked, false);
assert.deepEqual(ok.names, ["github"]);
console.log("✔ 正确主密码解锁成功，条目名可见：github");

const rec = await callRoute("/vault/api/get", { name: "github" });
assert.equal(rec.username, "yanwei999999");
assert.equal(rec.password, PASS);
console.log("✔ 解锁后可通过 /vault/api/get 读到账号密码");

const tool = registeredTools.find((t) => t.name === "vault_get");
const toolResult = await tool.execute({ name: "github" });
assert.ok(toolResult.content.includes(PASS), "agent 工具应能取到密码");
console.log("✔ agent 工具 vault_get 取到凭据");

await callRoute("/vault/api/lock", {});
const toolLocked = await tool.execute({ name: "github" });
assert.ok(toolLocked.content.includes("已锁定"), "锁定后工具应提示解锁");
console.log("✔ 锁定后 agent 工具拒绝读取并给出解锁指引");

// ---- 本机绑定：把 vault.json 复制到另一台"电脑"（无 machine.key），应打不开 ----
const home2 = mkdtempSync(join(tmpdir(), "dsh-vault-test2-"));
{
  mkdirSync(join(home2, "vault"), { recursive: true });
  copyFileSync(join(vaultDir(), "vault.json"), join(home2, "vault", "vault.json"));
  process.env.DSH_HOME = home2;
  assert.throws(() => unlockVault(MASTER), /machine\.key|密钥文件/);
  console.log("✔ 本机绑定生效：只有 vault.json 的其它电脑，即使有主密码也打不开");
}

// ---- 清理 ----
process.env.DSH_HOME = home;
rmSync(home, { recursive: true, force: true });
rmSync(home2, { recursive: true, force: true });
console.log("\n全部冒烟测试通过 ✅");
