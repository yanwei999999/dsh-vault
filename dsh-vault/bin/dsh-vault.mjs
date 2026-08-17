#!/usr/bin/env node
/**
 * dsh-vault 命令行：初始化 / 添加 / 查看 / 删除 / 改密 保险库条目。
 *
 * 用法：
 *   dsh-vault init                首次初始化（设置主密码，生成本机密钥文件）
 *   dsh-vault add <name>          添加/更新条目（交互输入账号、密码、备注）
 *   dsh-vault list                列出条目名（需要主密码）
 *   dsh-vault get <name>          查看某条完整信息（需要主密码）
 *   dsh-vault remove <name>       删除条目（需要主密码）
 *   dsh-vault passwd              修改主密码（需要旧密码）
 *   dsh-vault status              保险库状态（不需要密码）
 *
 * 主密码不会回显、不会落盘。脚本/测试场景可用环境变量 DSH_VAULT_PASSWORD 提供
 * 主密码（注意：用环境变量意味着该密码会短暂存在于进程环境里）。
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  readVault,
  writeVault,
  createVault,
  unlockVault,
  reencryptAll,
  encryptWithKey,
  vaultFilePath,
  vaultDir,
  machineKeyPath,
  loadMachineKey,
} from "../lib/vault-core.mjs";

const [, , cmd, arg] = process.argv;

function printHelp() {
  process.stdout.write(`dsh-vault — 本机加密账号密码保险库（DSH 插件配套 CLI）

用法：
  dsh-vault init                首次初始化（设置主密码，生成本机密钥文件）
  dsh-vault add <name>          添加/更新条目
  dsh-vault list                列出条目名（需要主密码）
  dsh-vault get <name>          查看某条完整信息（需要主密码）
  dsh-vault remove <name>       删除条目（需要主密码）
  dsh-vault passwd              修改主密码（需要旧密码）
  dsh-vault status              保险库状态（不需要密码）
  dsh-vault --help
`);
}

function passwordFromEnv() {
  const v = process.env.DSH_VAULT_PASSWORD;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 交互式输入（支持隐藏回显）；stdin 关闭/中断时报错而非静默退出。 */
function askHidden(prompt, { confirm = false } = {}) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    let settled = false;
    const success = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(err);
    };
    rl.on("close", () =>
      fail(new Error("输入流已关闭，无法继续交互（脚本场景请用 DSH_VAULT_PASSWORD / DSH_VAULT_ENTRY_* 环境变量提供输入）。")),
    );
    rl.on("SIGINT", () => fail(new Error("已取消。")));
    rl._writeToOutput = (stringToWrite) => {
      if (muted) rl.output.write("*");
      else rl.output.write(stringToWrite);
    };
    const readOnce = (q) =>
      new Promise((res) => {
        rl.question(q + " ", (answer) => {
          rl.output.write("\n");
          res(answer);
        });
        // question 已同步写出提示；之后的回显一律掩码
        muted = true;
      });
    (async () => {
      const first = await readOnce(prompt);
      if (!confirm) {
        success(first);
        return;
      }
      muted = false;
      const second = await readOnce("再次输入确认");
      success(first === second ? first : null);
    })().catch(fail);
  });
}

function askPlain(prompt) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const success = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(err);
    };
    rl.on("close", () =>
      fail(new Error("输入流已关闭，无法继续交互（脚本场景请用 DSH_VAULT_ENTRY_* 环境变量提供输入）。")),
    );
    rl.on("SIGINT", () => fail(new Error("已取消。")));
    rl.question(prompt + " ", success);
  });
}

async function masterPassword(label) {
  const fromEnv = passwordFromEnv();
  if (fromEnv !== null) return fromEnv;
  const pw = await askHidden(label, { confirm: false });
  if (pw === null) process.exit(1);
  return pw;
}

// ---------------------------------------------------------------------------

async function cmdInit() {
  if (readVault() !== null) {
    process.stderr.write("保险库已存在：" + vaultFilePath() + "（如需重置请先删除该文件）。\n");
    process.exit(1);
  }
  let pw = passwordFromEnv();
  if (pw === null) {
    pw = await askHidden("设置主密码", { confirm: true });
    if (pw === null) {
      process.stderr.write("两次输入不一致。\n");
      process.exit(1);
    }
  }
  if (pw.length === 0) {
    process.stderr.write("主密码不能为空。\n");
    process.exit(1);
  }
  const created = createVault(pw);
  process.stdout.write(
    `✔ 保险库已创建：${created.vaultFile}\n✔ 本机密钥文件：${created.machineKeyFile}（请勿删除/外传；换电脑需连它一起迁移）\n`,
  );
}

async function cmdAdd() {
  const name = String(arg || "").trim();
  if (!name) {
    process.stderr.write("用法：dsh-vault add <name>\n");
    process.exit(1);
  }
  const pw = await masterPassword("主密码");
  const { key, vault, names } = unlockVault(pw);
  const env = (name) => {
    const v = process.env[name];
    return typeof v === "string" ? v : null;
  };
  const username = (env("DSH_VAULT_ENTRY_USER") ?? (await askPlain("账号"))).trim();
  const password = env("DSH_VAULT_ENTRY_PASSWORD") ?? (await askHidden("密码"));
  const notes = (env("DSH_VAULT_ENTRY_NOTES") ?? (await askPlain("备注（可留空）"))).trim();
  const record = { name, username, password, notes };
  const existing = names.get(name);
  const entry = { id: existing ? existing.id : randomUUID(), updatedAt: Date.now(), record: encryptWithKey(key, record) };
  if (existing) {
    const idx = vault.entries.findIndex((e) => e.id === existing.id);
    vault.entries[idx] = entry;
  } else {
    vault.entries.push(entry);
  }
  writeVault(vault);
  process.stdout.write(`✔ 已保存条目：${name}\n`);
}

async function cmdList() {
  const pw = await masterPassword("主密码");
  const { names } = unlockVault(pw);
  const list = [...names.keys()].sort();
  process.stdout.write("条目（" + list.length + "）：\n");
  for (const name of list) process.stdout.write("  " + name + "\n");
}

async function cmdGet() {
  const name = String(arg || "").trim();
  if (!name) {
    process.stderr.write("用法：dsh-vault get <name>\n");
    process.exit(1);
  }
  const pw = await masterPassword("主密码");
  const { names } = unlockVault(pw);
  const rec = names.get(name);
  if (!rec) {
    process.stderr.write("未找到条目：" + name + "\n");
    process.exit(1);
  }
  process.stdout.write(`名称：${rec.record.name}\n账号：${rec.record.username}\n密码：${rec.record.password}\n`);
  if (rec.record.notes) process.stdout.write(`备注：${rec.record.notes}\n`);
}

async function cmdRemove() {
  const name = String(arg || "").trim();
  if (!name) {
    process.stderr.write("用法：dsh-vault remove <name>\n");
    process.exit(1);
  }
  const pw = await masterPassword("主密码");
  const { vault, names } = unlockVault(pw);
  const existing = names.get(name);
  if (!existing) {
    process.stderr.write("未找到条目：" + name + "\n");
    process.exit(1);
  }
  vault.entries = vault.entries.filter((e) => e.id !== existing.id);
  writeVault(vault);
  process.stdout.write(`✔ 已删除条目：${name}\n`);
}

async function cmdPasswd() {
  const oldPw = await masterPassword("旧主密码");
  let newPw = process.env.DSH_VAULT_NEW_PASSWORD ?? null;
  if (newPw === null) {
    newPw = await askHidden("新主密码", { confirm: true });
    if (newPw === null) {
      process.stderr.write("两次输入不一致。\n");
      process.exit(1);
    }
  }
  if (newPw.length === 0) {
    process.stderr.write("主密码不能为空。\n");
    process.exit(1);
  }
  const count = reencryptAll(oldPw, newPw);
  process.stdout.write(`✔ 主密码已修改，共重加密 ${count} 条。\n`);
}

function cmdStatus() {
  const vault = readVault();
  process.stdout.write(`保险库目录：${vaultDir()}\n`);
  process.stdout.write(`保险库文件：${vaultFilePath()}${vault === null ? "（不存在）" : ""}\n`);
  process.stdout.write(`本机密钥文件：${machineKeyPath()}${loadMachineKey() === null ? "（不存在）" : ""}\n`);
  if (vault !== null) process.stdout.write(`已存条目：${vault.entries.length}\n`);
}

// ---------------------------------------------------------------------------

const main = async () => {
  switch (cmd) {
    case "init": await cmdInit(); break;
    case "add": await cmdAdd(); break;
    case "list": await cmdList(); break;
    case "get": await cmdGet(); break;
    case "remove": await cmdRemove(); break;
    case "passwd": await cmdPasswd(); break;
    case "status": cmdStatus(); break;
    case "--help": case "-h": case undefined: printHelp(); break;
    default:
      process.stderr.write("未知命令：" + cmd + "\n");
      printHelp();
      process.exit(1);
  }
};

main().catch((err) => {
  process.stderr.write("错误：" + (err && err.message ? err.message : String(err)) + "\n");
  process.exit(1);
});
