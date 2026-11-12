// 审稿台网页的纯函数（不碰网络、不碰页面）：仓库文件树 → 每集状态；node 也能跑（desk/check.mjs 钉住）。
// 仓库布局见 pipeline/desk.py 开头：tasks/<阶段>/<片子>/page.html、claims/<阶段>/<片子>.json、results/<阶段>/<片子>/<账号>.json、imported/<阶段>/<片子>.json

// 顺序就是流程（11-12 用户定）：挑版本（哪段想改当场改）→ 配音前对着文字细改 → 配音 → 听评
export const STAGES = { pick: '三选一', edit: '细改', listen: '听评' };
export const STAGE_HINT = {
  pick: '三版盲挑：选总体用哪版，哪段想用别版就点那一栏，想改字当场改',
  edit: '配音之前对着整篇文字改：点哪句改哪句，改定了才去配音',
  listen: '对着配音听：有没有念错、停顿不对，最后的微调',
};
export const STALE_HOURS = 12; // 认领超过这么久没交，别人可以直接接手
export const NO_DOMAIN = '其他';

/** git/trees?recursive=1 的 tree 数组 → { tasks, claims, results, imported, sha }（每样按阶段 → 片子） */
export function parseTree(entries) {
  const t = { tasks: {}, claims: {}, results: {}, imported: {}, sha: {} };
  for (const st of Object.keys(STAGES)) {
    t.tasks[st] = {};
    t.claims[st] = {};
    t.results[st] = {};
    t.imported[st] = {};
  }
  for (const e of entries || []) {
    if (!e || e.type !== 'blob' || typeof e.path !== 'string') continue;
    t.sha[e.path] = e.sha;
    const p = e.path.split('/');
    if (!STAGES[p[1]]) continue;
    if (p[0] === 'tasks' && p.length === 4 && p[3] === 'page.html') t.tasks[p[1]][p[2]] = { page: e.path, pageSha: e.sha, metaSha: '' };
    else if (p[0] === 'claims' && p.length === 3 && p[2].endsWith('.json')) t.claims[p[1]][p[2].slice(0, -5)] = e.path;
    else if (p[0] === 'results' && p.length === 4 && p[3].endsWith('.json')) (t.results[p[1]][p[2]] = t.results[p[1]][p[2]] || []).push(p[3].slice(0, -5));
    else if (p[0] === 'imported' && p.length === 3 && p[2].endsWith('.json')) t.imported[p[1]][p[2].slice(0, -5)] = e.path;
  }
  for (const st of Object.keys(STAGES)) {
    for (const pid of Object.keys(t.tasks[st])) t.tasks[st][pid].metaSha = t.sha[`tasks/${st}/${pid}/meta.json`] || '';
    for (const pid of Object.keys(t.results[st])) t.results[st][pid].sort();
  }
  return t;
}

/** 片子排序：先按领域、再按集号、再按上中下、再按名字 */
const PART_ORDER = { 上: 1, 中: 2, 下: 3 };
export function sortKey(pid, ep) {
  const e = ep || {};
  return [String(e.domain || ''), String(e.episode || ''), PART_ORDER[e.part] || 9, pid];
}

/** 一行属于哪个领域（没标的归「其他」） */
export function domainOf(r) {
  return ((r && r.ep) || {}).domain || NO_DOMAIN;
}

/** 这些行里有哪几个领域（去重、排好序；「其他」放最后） */
export function domainsOf(rs) {
  const ds = [...new Set(rs.map(domainOf))].sort();
  return ds.filter((d) => d !== NO_DOMAIN).concat(ds.includes(NO_DOMAIN) ? [NO_DOMAIN] : []);
}
function cmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/** 一个阶段的每一行：state = imported（已导入流水线）/ done（有人交了）/ mine（我在做）/ taken（别人在做）/ free（没人做） */
export function rows(tree, desk, claimInfo, me, stage) {
  const eps = (desk && desk.episodes) || {};
  const pids = Object.keys((tree && tree.tasks[stage]) || {});
  pids.sort((a, b) => cmp(sortKey(a, eps[a]), sortKey(b, eps[b])));
  return pids.map((pid) => {
    const hasClaim = !!tree.claims[stage][pid];
    const info = (claimInfo || {})[`${stage}/${pid}`];
    const claim = hasClaim ? info || { by: '', at: '' } : null;
    const results = (tree.results[stage][pid] || []).slice();
    const imported = !!tree.imported[stage][pid];
    let state = 'free';
    if (imported) state = 'imported';
    else if (results.length) state = 'done';
    else if (claim) state = claim.by && claim.by === me ? 'mine' : 'taken';
    return { stage, pid, ep: eps[pid] || {}, claim, results, imported, mineDone: results.includes(me), state };
  });
}

export const STATE_NAME = { imported: '已导入', done: '已完成', mine: '我在做', taken: '有人在做', free: '没人做' };

/** 各状态的个数 */
export function summary(rs) {
  const s = { total: rs.length, imported: 0, done: 0, mine: 0, taken: 0, free: 0 };
  for (const r of rs) s[r.state] += 1;
  return s;
}

/** 还没人交的有几集 */
export function openCount(rs) {
  const s = summary(rs);
  return s.total - s.imported - s.done;
}

/** 做完这一集接着做哪一集：同一张表里它后面第一条「没人做 / 我在做」的，后面没有就从头找；没有回 null */
export function nextRow(rs, pid) {
  const i = rs.findIndex((r) => r.pid === pid);
  const order = rs.slice(i + 1).concat(rs.slice(0, Math.max(i, 0)));
  return order.find((r) => r.pid !== pid && (r.state === 'free' || r.state === 'mine')) || null;
}

/** 第一次来落在哪：有活的第一个领域、那个领域里有活的第一个阶段（都没有就第一个领域、第一个有页面的阶段） */
export function firstStop(byStage, domains) {
  const stages = Object.keys(STAGES);
  for (const d of domains) for (const st of stages) if (openCount((byStage[st] || []).filter((r) => domainOf(r) === d))) return { domain: d, stage: st };
  for (const d of domains) for (const st of stages) if ((byStage[st] || []).some((r) => domainOf(r) === d)) return { domain: d, stage: st };
  return { domain: domains[0] || '', stage: stages[0] };
}

/** 地址栏 # 后面那段 ↔ { domain, stage, pid }（刷新、后退、发链接都落回原处） */
export function makeHash(v) {
  const parts = [v.domain || '', v.stage || ''];
  if (v.pid) parts.push(v.pid);
  return '#/' + parts.map(encodeURIComponent).join('/');
}
export function parseHash(h) {
  const p = String(h || '').replace(/^#\/?/, '').split('/').map((x) => { try { return decodeURIComponent(x); } catch { return ''; } });
  return { domain: p[0] || '', stage: STAGES[p[1]] ? p[1] : '', pid: p[2] || '' };
}

/** 草稿在浏览器里的名字（一个仓库、一个阶段、一集一份） */
export function draftKey(repo, stage, pid) {
  return `draft:${repo}:${stage}:${pid}`;
}

/** 「3 分钟前」 */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '刚才';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

export function isStale(claim, now = Date.now()) {
  const t = Date.parse((claim && claim.at) || '');
  return Number.isFinite(t) && now - t > STALE_HOURS * 3600 * 1000;
}

/** UTF-8 字符串 → base64（GitHub 的 contents 接口要 base64） */
export function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 仓库里的路径 → URL 路径（每段各自转义） */
export function encPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

/** 「账号/仓库」：也认整条 github.com 链接、带 .git 的 */
export function normRepo(s) {
  return String(s || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '').replace(/\.git$/, '');
}

/** 交上去的那份：页面导出的原样 + 谁、什么时候、对着哪份页面 */
export function makeResult(stage, pid, me, payload, task, app, now = new Date()) {
  return { stage, project: pid, by: me, at: now.toISOString(), app, task: { page_sha: (task && task.pageSha) || '', meta_sha: (task && task.metaSha) || '' }, payload };
}

/** 页面交上来的是不是这一集这一阶段的 */
export function payloadOk(stage, pid, msg) {
  return !!(msg && msg.desk === 'submit' && msg.stage === stage && msg.payload && msg.payload.project === pid);
}
