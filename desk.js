// 科普视频审稿台网页：登录（GitHub 口令）→ 列表（谁在做、谁交了）→ 打开一集（页面在下面的框里）→ 提交写回私有仓库。
// 这个文件只有程序，不含任何讲稿；讲稿、配音都在私有仓库里，登录后才取得到。纯函数在 core.js。
import { STAGES, STATE_NAME, ago, b64, encPath, isStale, makeResult, normRepo, parseTree, payloadOk, rows, summary } from './core.js';

const APP = '2026-11-11';
const API = 'https://api.github.com';
const $ = (id) => document.getElementById(id);
const S = { repo: '', token: '', login: '', branch: 'main', canPush: false, isPrivate: true, tree: null, desk: null, stage: 'pick', mineOnly: false, claimInfo: {}, current: null, timer: 0 };

// ---------------------------------------------------------------- 存取（浏览器本地）
const ls = {
  get: (k) => { try { return localStorage.getItem('desk.' + k) || sessionStorage.getItem('desk.' + k) || ''; } catch { return ''; } },
  set: (k, v, remember = true) => { try { (remember ? localStorage : sessionStorage).setItem('desk.' + k, v); } catch { /* 隐私模式 */ } },
  del: (k) => { try { localStorage.removeItem('desk.' + k); sessionStorage.removeItem('desk.' + k); } catch { /* 隐私模式 */ } },
};

// ---------------------------------------------------------------- GitHub 接口
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { Authorization: `Bearer ${S.token}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const init = { method, headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(API + path, init);
  } catch {
    const e = new Error('连不上 GitHub（网络断了？）');
    e.status = 0;
    throw e;
  }
  if (r.status === 204) return null;
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).message || ''; } catch { /* 不是 json */ }
    const e = new Error(`${r.status} ${msg}`);
    e.status = r.status;
    throw e;
  }
  return raw ? r.text() : r.json();
}
const R = () => `/repos/${S.repo}`;
const C = (p) => `${R()}/contents/${encPath(p)}`;
const ref = () => `?ref=${encodeURIComponent(S.branch)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function explain(e) {
  if (!e) return '不知道哪里错了';
  if (e.status === 401) return '口令不对或已过期：退出后重新登录';
  if (e.status === 403) return '没有权限（口令的 Contents 要选 Read and write），或者一小时内请求太多';
  if (e.status === 404) return '找不到（仓库名写错了，或口令没有这个仓库的权限）';
  if (e.status === 409) return '仓库正忙（别人同时在交），再点一次';
  return e.message || String(e);
}

async function getText(path) { return api(C(path) + ref(), { raw: true }); }
async function getJson(path) { return JSON.parse(await getText(path)); }
async function shaOf(path) {
  try { return (await api(C(path) + ref())).sha; } catch (e) { if (e.status === 404) return ''; throw e; }
}
/** 写一个 json 文件；sha 给了 = 覆盖，不给 = 新建（已经在就 422）。别人同时在交时 409，等一下再试 */
async function putJson(path, obj, message, sha) {
  const body = { message, content: b64(JSON.stringify(obj, null, 1) + '\n'), branch: S.branch };
  if (sha) body.sha = sha;
  for (let i = 0; ; i++) {
    try { return await api(C(path), { method: 'PUT', body }); } catch (e) {
      if (e.status === 409 && i < 5) { await sleep(500 * (i + 1)); continue; }
      throw e;
    }
  }
}
async function delFile(path, sha, message) {
  for (let i = 0; ; i++) {
    try { return await api(C(path), { method: 'DELETE', body: { message, sha, branch: S.branch } }); } catch (e) {
      if (e.status === 409 && i < 5) { await sleep(500 * (i + 1)); continue; }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- 登录
async function enter(repo, token, remember) {
  S.repo = normRepo(repo);
  S.token = String(token || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(S.repo)) throw new Error('审稿仓库写成「账号/仓库名」');
  if (!S.token) throw new Error('贴上口令');
  const me = await api('/user');
  S.login = me.login;
  const info = await api(R());
  S.branch = info.default_branch || 'main';
  S.canPush = !!(info.permissions && info.permissions.push);
  S.isPrivate = !!info.private;
  ls.set('repo', S.repo);
  ls.del('token');
  ls.set('token', S.token, remember);
}

function showLogin(msg = '') {
  clearInterval(S.timer);
  $('login').hidden = false;
  $('list').hidden = true;
  $('task').hidden = true;
  $('top').hidden = true;
  const q = new URLSearchParams(location.search).get('repo');
  $('repo').value = normRepo(q || ls.get('repo') || '');
  $('loginmsg').textContent = msg;
}

// ---------------------------------------------------------------- 列表
async function refresh() {
  let t;
  try {
    t = await api(`${R()}/git/trees/${encodeURIComponent(S.branch)}?recursive=1`);
  } catch (e) {
    if (e.status === 409 || e.status === 404) t = { tree: [] }; // 空仓库
    else throw e;
  }
  S.tree = parseTree(t.tree || []);
  try { S.desk = await getJson('desk.json'); } catch { S.desk = S.desk || { episodes: {} }; }
  const need = [];
  for (const st of Object.keys(STAGES)) {
    for (const [pid, path] of Object.entries(S.tree.claims[st])) {
      const key = `${st}/${pid}`;
      const sha = S.tree.sha[path];
      if (S.claimInfo[key] && S.claimInfo[key].sha === sha) continue;
      if ((S.tree.results[st][pid] || []).length || S.tree.imported[st][pid]) continue; // 交了的不用知道谁认领的
      need.push(getJson(path).then((c) => { S.claimInfo[key] = { ...c, sha }; }).catch(() => {}));
    }
  }
  await Promise.all(need);
  renderList();
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}

function renderList() {
  $('login').hidden = true;
  $('task').hidden = true;
  $('list').hidden = false;
  $('top').hidden = false;
  $('who').textContent = `${S.login} · ${S.repo}${S.canPush ? '' : ' · 只读（口令没有写权限，交不了）'}${S.isPrivate ? '' : ' · ⚠ 这个仓库是公开的'}`;
  // 阶段页签
  const tabs = $('tabs');
  tabs.textContent = '';
  for (const [st, name] of Object.entries(STAGES)) {
    const rs = rows(S.tree, S.desk, S.claimInfo, S.login, st);
    const sm = summary(rs);
    const open = sm.total - sm.imported - sm.done;
    tabs.append(el('button', { class: st === S.stage ? 'on' : '', onclick: () => { S.stage = st; renderList(); } }, `${name}（${open ? `还剩 ${open}` : sm.total ? '都做完了' : '没有'}）`));
  }
  tabs.append(el('label', { class: 'mine' }, el('input', { type: 'checkbox', checked: S.mineOnly, onchange: (e) => { S.mineOnly = e.target.checked; renderList(); } }), ' 只看我的'));
  // 进度
  const all = rows(S.tree, S.desk, S.claimInfo, S.login, S.stage);
  const sm = summary(all);
  const bar = $('progress');
  bar.textContent = '';
  if (sm.total) {
    const seg = (n, cls) => (n ? el('span', { class: 'seg ' + cls, style: `flex:${n}` }) : null);
    bar.append(el('div', { class: 'bar' }, seg(sm.imported, 'imported'), seg(sm.done, 'done'), seg(sm.mine + sm.taken, 'taken'), seg(sm.free, 'free')));
    bar.append(el('div', { class: 'legend' },
      `共 ${sm.total} 集：`, el('i', { class: 'imported' }), `已导入 ${sm.imported}　`, el('i', { class: 'done' }), `已完成 ${sm.done}　`,
      el('i', { class: 'taken' }), `在做 ${sm.mine + sm.taken}（我 ${sm.mine}）　`, el('i', { class: 'free' }), `没人做 ${sm.free}`));
  }
  // 表
  const tb = $('rows');
  tb.textContent = '';
  const rs = S.mineOnly ? all.filter((r) => r.state === 'mine' || r.mineDone || (r.claim && r.claim.by === S.login)) : all;
  if (!rs.length) tb.append(el('tr', {}, el('td', { colspan: 3, class: 'empty' }, all.length ? '没有我的' : '这个阶段还没有要审的')));
  for (const r of rs) {
    const ep = r.ep || {};
    const what = el('div', {}, el('b', {}, ep.title || r.pid), el('div', { class: 'sub' }, [ep.episode, ep.part && `${ep.part}集`, ep.frames && `第 ${ep.frames} 帧`, r.pid].filter(Boolean).join(' · ')));
    let st = STATE_NAME[r.state];
    if (r.state === 'taken' || r.state === 'mine') st += r.claim && r.claim.by ? `：${r.claim.by}，${ago(r.claim.at)}` : '';
    if (r.state === 'done' || r.state === 'imported') st += `：${r.results.join('、')}`;
    const label = { free: '开始', mine: '继续', taken: isStale(r.claim) ? '接手' : '看看', done: r.mineDone ? '再看 / 改' : '看看', imported: '看看' }[r.state];
    tb.append(el('tr', { class: 's-' + r.state },
      el('td', {}, what),
      el('td', { class: 'state' }, el('span', { class: 'dot ' + r.state }), st),
      el('td', {}, el('button', { onclick: () => openTask(r).catch((e) => alert('打不开：' + explain(e))) }, label))));
  }
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!$('list').hidden) refresh().catch(() => {}); }, 60000);
}

// ---------------------------------------------------------------- 打开一集
async function openTask(r) {
  const { stage, pid } = r;
  const claimPath = `claims/${stage}/${pid}.json`;
  if (r.state === 'taken') {
    const c = r.claim || {};
    const stale = isStale(c);
    const ok = confirm(`${c.by || '有人'} ${ago(c.at)}认领了这一集${stale ? '（已经很久了）' : ''}。\n\n仍要打开吗？${stale ? '打开就算你接手。' : ''}\n你交的会单独存一份，不会覆盖 ${c.by || '对方'} 的。`);
    if (!ok) return;
    if (stale && S.canPush) {
      try { await putJson(claimPath, { by: S.login, at: new Date().toISOString(), stage, project: pid, took_over: c.by || '' }, `接手 ${STAGES[stage]}：${pid}（${S.login}）`, S.tree.sha[claimPath]); } catch { /* 接手失败也照样能看 */ }
    }
  } else if (r.state === 'free' && S.canPush) {
    try {
      await putJson(claimPath, { by: S.login, at: new Date().toISOString(), stage, project: pid }, `认领 ${STAGES[stage]}：${pid}（${S.login}）`);
    } catch (e) {
      if (e.status === 422) { // 刚被别人认领了
        await refresh();
        const info = S.claimInfo[`${stage}/${pid}`] || {};
        if (info.by && info.by !== S.login && !confirm(`${info.by} 刚刚认领了这一集。仍要打开吗？你交的会单独存一份。`)) return;
      } else throw e;
    }
  }
  $('list').hidden = true;
  $('task').hidden = false;
  const ep = r.ep || {};
  // 一集讲稿拆成上 / 中 / 下几条片子时标题相同（11-11 试点 69a/b/c）：顶上也带集号、哪一段、第几帧
  $('tasktitle').textContent = `${STAGES[stage]} · ${ep.title || pid}` + ([ep.episode, ep.part && `${ep.part}集`, ep.frames && `第 ${ep.frames} 帧`].filter(Boolean).length
    ? `（${[ep.episode, ep.part && `${ep.part}集`, ep.frames && `第 ${ep.frames} 帧`].filter(Boolean).join(' · ')}）` : '');
  $('taskmsg').textContent = '取页面中…';
  freshFrame('');
  const task = S.tree.tasks[stage][pid];
  S.current = { stage, pid, pageSha: task.pageSha, metaSha: task.metaSha };
  $('release').hidden = !(r.state === 'free' || r.state === 'mine');
  const html = await getText(task.page);
  if (!S.current || S.current.pid !== pid) return;
  freshFrame(html);
  $('taskmsg').textContent = r.mineDone ? '你交过这一集；再提交会覆盖你那一份（旧的在仓库历史里）' : '做完点页面最底下的提交按钮';
}

/** 每次换页面都换一个新的框（同一个沙箱框反复换 srcdoc 时，第二个页面会整页画不出来，11-11 实测）；页面先放进去再挂上 */
function freshFrame(html) {
  const old = $('frame');
  const f = document.createElement('iframe');
  for (const a of ['id', 'title', 'sandbox']) f.setAttribute(a, old.getAttribute(a));
  f.srcdoc = html;
  old.replaceWith(f);
}

async function backToList() {
  S.current = null;
  freshFrame('');
  await refresh();
}

async function release() {
  if (!S.current) return;
  const { stage, pid } = S.current;
  const path = `claims/${stage}/${pid}.json`;
  try {
    const sha = await shaOf(path);
    if (sha) {
      const c = await getJson(path);
      if (c.by === S.login) await delFile(path, sha, `放弃认领 ${STAGES[stage]}：${pid}（${S.login}）`);
    }
  } catch (e) { alert('没放掉：' + explain(e)); return; }
  await backToList();
}

// 页面（框里）点了提交 → 写进 results/<阶段>/<片子>/<我>.json → 回一句话给页面
window.addEventListener('message', async (ev) => {
  const frame = $('frame');
  if (!S.current || ev.source !== frame.contentWindow) return;
  const d = ev.data || {};
  if (d.desk !== 'submit') return;
  const ack = (ok, text) => ev.source.postMessage({ desk: 'ack', ok, text }, '*');
  const { stage, pid } = S.current;
  if (!payloadOk(stage, pid, d)) return ack(false, '页面和这一集对不上，没有提交：回列表重新打开再试');
  if (!S.canPush) return ack(false, '你的口令没有写权限，交不上：口令的 Contents 要选 Read and write，重新登录');
  const path = `results/${stage}/${pid}/${S.login}.json`;
  try {
    const sha = await shaOf(path);
    await putJson(path, makeResult(stage, pid, S.login, d.payload, S.current, APP), `${STAGES[stage]}提交：${pid}（${S.login}）`, sha);
    const tm = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    ack(true, `已提交（${tm}）。可以点上面「← 回列表」做下一集；想改就改完再点一次，会覆盖你这一份。`);
    $('taskmsg').textContent = `已提交（${tm}）`;
    $('release').hidden = true;
  } catch (e) {
    ack(false, '没交上：' + explain(e) + '。别关这页，过一会儿再点一次。');
  }
});

// ---------------------------------------------------------------- 启动
async function start() {
  $('enter').addEventListener('click', async () => {
    $('loginmsg').textContent = '登录中…';
    try {
      await enter($('repo').value, $('token').value, $('remember').checked);
      $('token').value = '';
      await refresh();
    } catch (e) { showLogin('登录不上：' + (e.status ? explain(e) : e.message)); }
  });
  $('logout').addEventListener('click', () => { ls.del('token'); S.token = ''; showLogin('已退出（这台电脑上的口令删掉了）'); });
  $('refresh').addEventListener('click', () => refresh().catch((e) => alert('刷新不了：' + explain(e))));
  $('back').addEventListener('click', () => backToList().catch(() => {}));
  $('release').addEventListener('click', () => release());
  const repo = ls.get('repo');
  const token = ls.get('token');
  const q = normRepo(new URLSearchParams(location.search).get('repo') || '');
  if (token && repo && (!q || q === repo)) {
    try {
      await enter(repo, token, !!localStorage.getItem('desk.token'));
      await refresh();
      return;
    } catch (e) { showLogin('上次的口令用不了：' + explain(e)); return; }
  }
  showLogin();
}
start();
