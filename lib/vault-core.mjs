/**
 * dsh-vault 加密核心（CLI 与 host 插件共用，零第三方依赖）。
 *
 * 安全模型：
 *  - 主密码不落盘、不进 LLM、不打印。
 *  - AES-256-GCM 加密；密钥 = PBKDF2-SHA256(主密码, 本机 machine.key, 600000 轮)。
 *  - 首次初始化生成随机 machine.key（32 字节）绑定本机：密文离开本机后，
 *    即使知道主密码也解不开（缺少本机密钥文件）。
 *  - 条目名同样加密：解锁前看不到任何条目信息。
 *  - 保险库文件里存一个加密的 check 哨兵，用于校验主密码是否正确。
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const KDF_ITERATIONS = 600_000;
export const VAULT_VERSION = 1;
const CHECK_KIND = "dsh-vault-check";

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function expandHomePath(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  const base = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), ".dsh");
  return resolve(expandHomePath(base));
}

export function vaultDir() {
  return join(resolveDshHome(), "vault");
}

export function vaultFilePath() {
  return join(vaultDir(), "vault.json");
}

export function machineKeyPath() {
  return join(vaultDir(), "machine.key");
}

/**
 * 可选「自动解锁」密钥文件路径。
 * 方案 A（本机自动解锁）：用户显式开启后，把派生的主密钥写入该文件；
 * dsh 进程每次启动用它自动解锁，agent 无需用户再手动输主密码。
 * 删除此文件即恢复手动解锁。开启即等同于「信任本机无恶意程序」。
 */
export function autoUnlockKeyPath() {
  return join(vaultDir(), "auto.key");
}

/** 读取自动解锁密钥；未开启返回 null。 */
export function loadAutoUnlockKey() {
  const p = autoUnlockKeyPath();
  return existsSync(p) ? readFileSync(p) : null;
}

/**
 * 开启自动解锁：用主密码派生主密钥并写入 auto.key（本机文件，含派生出的主密钥）。
 * 写入前会先用主密码解锁校验，保证密码正确才开启。
 */
export function setAutoUnlockKey(password) {
  const machineKey = loadMachineKey();
  if (machineKey === null) throw new Error("未找到本机密钥文件 machine.key——保险库未在本机初始化。");
  const { key } = unlockVault(password);
  writeFileSync(autoUnlockKeyPath(), key);
  return autoUnlockKeyPath();
}

/** 关闭自动解锁：删除 auto.key，恢复手动解锁。 */
export function clearAutoUnlockKey() {
  const p = autoUnlockKeyPath();
  if (existsSync(p)) rmSync(p);
  return !existsSync(p);
}

/**
 * 用已派生的主密钥直接解锁（供自动解锁使用，跳过主密码输入）。
 * 校验本机密钥文件 + 校验哨兵 + 解密全部条目名。
 */
export function unlockVaultWithKey(key) {
  const machineKey = loadMachineKey();
  if (machineKey === null) {
    throw new Error("未找到本机密钥文件 machine.key——保险库未在本机初始化，或密钥文件被移走。");
  }
  const vault = readVault();
  if (vault === null) throw new Error("保险库不存在，请先运行 dsh-vault init。");
  let check;
  try {
    check = decryptWithKey(key, vault.check);
  } catch {
    throw new Error("自动解锁密钥无效，或保险库已改密/被重置。请删除自动解锁文件后手动解锁，或重新开启自动解锁。");
  }
  if (!check || check.kind !== CHECK_KIND) throw new Error("保险库校验失败。");
  const names = new Map();
  for (const entry of vault.entries) {
    const record = decryptWithKey(key, entry.record);
    names.set(record.name, { id: entry.id, record });
  }
  return { key, vault, names };
}

// ---------------------------------------------------------------------------
// 本机密钥文件
// ---------------------------------------------------------------------------

export function loadMachineKey() {
  const p = machineKeyPath();
  return existsSync(p) ? readFileSync(p) : null;
}

export function loadOrCreateMachineKey() {
  const p = machineKeyPath();
  if (existsSync(p)) return readFileSync(p);
  mkdirSync(vaultDir(), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(p, key);
  return key;
}

// ---------------------------------------------------------------------------
// 加解密
// ---------------------------------------------------------------------------

export function deriveMasterKey(password, machineKey) {
  return pbkdf2Sync(String(password), machineKey, KDF_ITERATIONS, 32, "sha256");
}

/** 加密任意 JSON 可序列化对象。 */
export function encryptWithKey(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final()]);
  return {
    v: VAULT_VERSION,
    i: iv.toString("base64"),
    t: cipher.getAuthTag().toString("base64"),
    c: ct.toString("base64"),
  };
}

/** 解密；主密码/机器密钥不对时抛错。 */
export function decryptWithKey(key, rec) {
  const iv = Buffer.from(rec.i, "base64");
  const tag = Buffer.from(rec.t, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(Buffer.from(rec.c, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

// ---------------------------------------------------------------------------
// 保险库文件
// ---------------------------------------------------------------------------

export function readVault() {
  const p = vaultFilePath();
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function writeVault(vault) {
  mkdirSync(vaultDir(), { recursive: true });
  writeFileSync(vaultFilePath(), JSON.stringify(vault, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// 初始化 / 解锁
// ---------------------------------------------------------------------------

/** 首次初始化：生成本机密钥文件 + 空保险库 + 校验哨兵。已存在则拒绝。 */
export function createVault(password) {
  if (readVault() !== null) throw new Error("保险库已存在：" + vaultFilePath());
  const machineKey = loadOrCreateMachineKey();
  const key = deriveMasterKey(password, machineKey);
  const check = encryptWithKey(key, { kind: CHECK_KIND });
  writeVault({ version: VAULT_VERSION, check, entries: [] });
  return { vaultFile: vaultFilePath(), machineKeyFile: machineKeyPath() };
}

/**
 * 用主密码解锁：校验机器密钥文件 + 校验哨兵。
 * @returns {{ key: Buffer, vault: object, names: Map<string, {id, record}> }}
 * @throws 主密码错误 / 非本机 / 未初始化。
 */
export function unlockVault(password) {
  const machineKey = loadMachineKey();
  if (machineKey === null) {
    throw new Error("未找到本机密钥文件 machine.key——保险库未在本机初始化，或密钥文件被移走。");
  }
  const vault = readVault();
  if (vault === null) throw new Error("保险库不存在，请先运行 dsh-vault init。");
  const key = deriveMasterKey(password, machineKey);
  let check;
  try {
    check = decryptWithKey(key, vault.check);
  } catch {
    throw new Error("主密码错误。");
  }
  if (!check || check.kind !== CHECK_KIND) throw new Error("保险库校验失败。");
  const names = new Map();
  for (const entry of vault.entries) {
    const record = decryptWithKey(key, entry.record);
    names.set(record.name, { id: entry.id, record });
  }
  return { key, vault, names };
}

/** 用新主密码重加密全部条目（改密）。 */
export function reencryptAll(oldPassword, newPassword) {
  const { key, vault, names } = unlockVault(oldPassword);
  const machineKey = loadMachineKey();
  const newKey = deriveMasterKey(newPassword, machineKey);
  vault.check = encryptWithKey(newKey, { kind: CHECK_KIND });
  for (const entry of vault.entries) {
    const record = decryptWithKey(key, entry.record);
    entry.record = encryptWithKey(newKey, record);
  }
  writeVault(vault);
  return names.size;
}
