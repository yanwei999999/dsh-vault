// dsh-vault 本机管理页（由 host 插件在 /vault 提供，仅 127.0.0.1 回环可访问）。
export const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-vault · 本机加密保险库</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; background: #f6f7f9; color: #222; }
  h1 { font-size: 20px; }
  .card { background: #fff; border: 1px solid #e2e4e8; border-radius: 10px; padding: 16px; margin: 14px 0; }
  label { display: block; margin: 8px 0 4px; font-size: 13px; color: #555; }
  input { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
  button { margin-top: 12px; padding: 8px 18px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; font-size: 14px; cursor: pointer; }
  button.ghost { background: #eef1f5; color: #333; margin-left: 6px; }
  button.danger { background: #dc2626; }
  .entry { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px dashed #e5e7eb; }
  .entry:last-child { border-bottom: 0; }
  .muted { color: #888; font-size: 12px; }
  .secret { background: #fff7ed; border-radius: 6px; padding: 8px; margin: 4px 0 8px; font-family: ui-monospace, Consolas, monospace; white-space: pre-wrap; }
  #msg { color: #b91c1c; font-size: 13px; min-height: 18px; }
</style>
</head>
<body>
<h1>🔐 dsh-vault · 本机加密保险库</h1>
<div class="muted">仅本机（127.0.0.1）可访问；输入主密码后，本次 dsh 会话内可查看条目。</div>
<div id="msg"></div>

<div class="card" id="lockBox">
  <label>主密码</label>
  <input type="password" id="pw" autocomplete="off" placeholder="输入主密码解锁">
  <button onclick="unlock()">解锁</button>
  <button class="ghost" onclick="status()">刷新状态</button>
</div>

<div class="card" id="vaultBox" style="display:none">
  <div>已解锁 ✅ <span class="muted" id="statLine"></span>
    <button class="ghost" onclick="lock()">锁定</button>
  </div>
  <div id="entries"></div>
  <hr>
  <label>添加 / 更新条目</label>
  <input id="fName" placeholder="名称，如 github">
  <input id="fUser" placeholder="账号">
  <input id="fPass" type="password" placeholder="密码">
  <input id="fNotes" placeholder="备注（可留空）">
  <button onclick="addEntry()">保存条目</button>
</div>

<script>
const $ = (id) => document.getElementById(id);
function msg(t){ $('msg').textContent = t || ''; }
async function api(path, body) {
  const r = await fetch('/vault/api/' + path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
  return r.json();
}
async function status() {
  const s = await api('status');
  if (s.error) { msg('错误：' + s.error); return; }
  if (!s.initialized) { msg('保险库未初始化：请在 dsh 所在电脑终端运行 dsh-vault init。'); return; }
  if (!s.machineBound) { msg('本机密钥文件缺失，无法解锁。'); return; }
  if (s.locked) {
    $('lockBox').style.display = '';
    $('vaultBox').style.display = 'none';
    msg('');
  } else {
    $('lockBox').style.display = 'none';
    $('vaultBox').style.display = '';
    $('statLine').textContent = s.entryCount + ' 条' + (s.autoUnlock ? ' · 自动解锁已开启' : '');
    renderEntries(s.names || []);
  }
}
async function unlock() {
  const r = await api('unlock', { password: $('pw').value });
  $('pw').value = '';
  if (r.error) { msg('解锁失败：' + r.error); return; }
  msg('已解锁');
  status();
}
async function lock() { await api('lock'); status(); }
function renderEntries(names) {
  const box = $('entries');
  box.innerHTML = '';
  if (!names.length) { box.innerHTML = '<div class="muted">（还没有条目，在下面添加）</div>'; return; }
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'entry';
    row.dataset.name = name;
    row.innerHTML = '<span><b>' + esc(name) + '</b></span>' +
      '<span><button class="ghost" data-action="view">查看</button>' +
      '<button class="ghost danger" data-action="remove">删除</button></span>';
    box.appendChild(row);
  }
}
function bindActions() {
  const box = $('entries');
  box.addEventListener('click', async (ev) => {
    const btn = ev.target && ev.target.closest && ev.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('.entry');
    const name = row ? row.dataset.name : '';
    const action = btn.getAttribute('data-action');
    if (action === 'view') await showEntry(name);
    else if (action === 'remove') await removeEntry(name);
  });
}
async function showEntry(name) {
  const r = await api('get', { name });
  if (r.error) { msg('查看失败：' + r.error); return; }
  msg('');
  const pre = document.createElement('div');
  pre.className = 'secret';
  pre.textContent = '账号：' + r.username + '\n密码：' + r.password + (r.notes ? '\n备注：' + r.notes : '');
  const entryRows = $('entries').children;
  for (const row of entryRows) { if (row.querySelector('b') && row.querySelector('b').textContent === name) { row.after(pre); } }
}
async function removeEntry(name) {
  if (!confirm('删除条目 ' + name + '？')) return;
  const r = await api('remove', { name });
  if (r.error) { msg('删除失败：' + r.error); return; }
  status();
}
async function addEntry() {
  const name = $('fName').value.trim();
  if (!name) { msg('名称不能为空'); return; }
  const r = await api('add', { name, username: $('fUser').value, password: $('fPass').value, notes: $('fNotes').value });
  if (r.error) { msg('保存失败：' + r.error); return; }
  ['fName','fUser','fPass','fNotes'].forEach((id) => $(id).value = '');
  msg('已保存：' + name);
  status();
}
function esc(s){ return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
bindActions();
status();
</script>
</body>
</html>
`;
