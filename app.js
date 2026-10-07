const storageKey = "zfl18-boardgame-rule-cards";
const today = new Date();

const RULE_KEYS = ["forgets", "disputes", "setup", "scoring"];

const defaultState = {
  selectedId: "",
  games: [
    {
      id: crypto.randomUUID(),
      name: "奥尔良",
      minPlayers: 2,
      maxPlayers: 4,
      duration: 90,
      complexity: "中",
      lastPlayed: "2025-11-20",
      cover: "",
      forgets: ["商站建造前先确认道路或水路连接", "袋中随从抽完后不是重洗弃堆，而是从已回袋内容继续抽"],
      disputes: ["事件顺序和玩家动作结算先后", "科技板是否能替代所有同类随从"],
      setup: ["按人数放置货物板块", "每位玩家拿起始随从、商人和个人板"],
      scoring: ["货物分数", "商站和市民乘区块", "金币和建筑剩余加分"]
    },
    {
      id: crypto.randomUUID(),
      name: "盖亚计划",
      minPlayers: 1,
      maxPlayers: 4,
      duration: 150,
      complexity: "重",
      lastPlayed: "2025-08-02",
      cover: "",
      forgets: ["联邦连接时卫星数量和能量消耗要一起核对", "研究升到顶必须拿对应科技板限制"],
      disputes: ["被动充能是否能拒绝", "星球改造费用受哪些能力影响"],
      setup: ["随机终局计分板和回合得分板", "按种族设置起始资源和母星"],
      scoring: ["终局计分板", "科技轨排名", "联邦和建筑分"]
    },
    {
      id: crypto.randomUUID(),
      name: "花砖物语",
      minPlayers: 2,
      maxPlayers: 4,
      duration: 45,
      complexity: "轻",
      lastPlayed: "2026-03-15",
      cover: "",
      forgets: ["每轮结束先铺墙再补工厂展示区", "地板线扣分后清空对应砖"],
      disputes: ["同色砖放置限制是否看整面墙", "中央区起始玩家标记是否必须拿"],
      setup: ["按人数放工厂圆盘", "每个圆盘补4块砖"],
      scoring: ["横竖相邻即时分", "完整行列和颜色终局加分"]
    }
  ]
};

// 每条规则带自己的编号；base 是上次同步时的原文，用来判断本条有没有被改过；
// removed 是墓碑（表示删除），conflict 表示两边都改过、需要人工确认。
function makeEntry(text) {
  const value = String(text ?? "");
  return { id: crypto.randomUUID(), text: value, base: value };
}

function isLiveEntry(entry) {
  return !!entry && !entry.removed;
}

function liveEntries(list) {
  return (Array.isArray(list) ? list : []).filter(isLiveEntry);
}

function deepClone(value) {
  return structuredClone(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual(a[key], b[key]));
}

// 旧数据里规则是纯字符串、没有编号，升级时逐条补齐编号与 base。
function migrateState(state) {
  if (!state || typeof state !== "object") state = {};
  if (!Array.isArray(state.games)) state.games = [];
  for (const game of state.games) {
    if (!game || typeof game !== "object") continue;
    for (const key of RULE_KEYS) {
      if (!Array.isArray(game[key])) game[key] = [];
      game[key] = game[key].map((item) => {
        if (item && typeof item === "object" && item.id != null) {
          const text = String(item.text ?? "");
          const entry = { id: item.id, text, base: String(item.base ?? text) };
          if (item.removed) entry.removed = true;
          if (item.conflict) entry.conflict = true;
          return entry;
        }
        return makeEntry(typeof item === "string" ? item : String(item ?? ""));
      });
    }
  }
  if (typeof state.selectedId !== "string") state.selectedId = "";
  return state;
}

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    raw = null;
  }
  let state;
  if (!raw) {
    state = deepClone(defaultState);
  } else {
    try {
      state = JSON.parse(raw);
    } catch {
      state = deepClone(defaultState);
    }
  }
  return migrateState(state);
}

// 逐条合并：以条目的 base 为共同祖先。对页“没有”不代表删除（可能从不知道），
// 只有墓碑（removed）才算删除，因此对页旧副本不会让已删条目冒出来。
function mergeEntries(localList, remoteList) {
  const local = new Map((localList || []).map((entry) => [entry.id, entry]));
  const remote = new Map((remoteList || []).map((entry) => [entry.id, entry]));
  const ids = new Set([...local.keys(), ...remote.keys()]);
  const out = [];

  for (const id of ids) {
    const l = local.get(id);
    const r = remote.get(id);
    const lRemoved = !!l?.removed;
    const rRemoved = !!r?.removed;

    if (l && r) {
      if (lRemoved && rRemoved) continue;
      if (lRemoved && !rRemoved) {
        if (r.text === r.base) {
          out.push({ id, removed: true }); // 本页删除、对页没动 -> 保持删除并留墓碑
          continue;
        }
        out.push({ id, text: r.text, base: r.text, conflict: true }); // 对页改了，保住文字并标冲突
        continue;
      }
      if (rRemoved && !lRemoved) {
        if (l.text === l.base) {
          out.push({ id, removed: true }); // 对页删除、本页没动 -> 保持删除并留墓碑
          continue;
        }
        out.push({ id, text: l.text, base: l.text, conflict: true });
        continue;
      }
      if (l.text === r.text) {
        out.push({ id, text: l.text, base: l.text });
        continue;
      }
      const lModified = l.text !== l.base;
      const rModified = r.text !== r.base;
      if (lModified && rModified) {
        // 两边都动过：留下两份，标出冲突
        out.push({ id, text: l.text, base: l.text, conflict: true });
        out.push({ id: crypto.randomUUID(), text: r.text, base: r.text, conflict: true, conflictOf: id });
        continue;
      }
      if (lModified) {
        out.push({ id, text: l.text, base: l.text });
      } else if (rModified) {
        out.push({ id, text: r.text, base: r.text });
      } else {
        // 两边都没改却不同（同步点不一致），以较新的对页为准
        out.push({ id, text: r.text, base: r.text });
      }
      continue;
    }

    if (l && !r) {
      // 对页没有这条：可能从不知道，不能当成对页删除；本页新增则保留
      if (lRemoved) {
        out.push({ id, removed: true });
      } else {
        out.push({ id, text: l.text, base: l.text });
      }
      continue;
    }

    if (r && !l) {
      if (rRemoved) {
        out.push({ id, removed: true });
      } else {
        out.push({ id, text: r.text, base: r.text });
      }
      continue;
    }
  }

  return out;
}

function mergeScalar(baseValue, localValue, remoteValue) {
  if (localValue === remoteValue) return localValue;
  const localModified = baseValue === undefined || localValue !== baseValue;
  const remoteModified = baseValue === undefined || remoteValue !== baseValue;
  if (localModified && remoteModified) return localValue; // 两边都改了标量，优先本页
  return localModified ? localValue : remoteValue;
}

function gameUnchangedSince(game, baseGame) {
  if (!game || !baseGame) return false;
  const scalarKeys = ["name", "minPlayers", "maxPlayers", "duration", "complexity", "lastPlayed", "cover"];
  if (scalarKeys.some((key) => baseGame[key] !== game[key])) return false;
  return RULE_KEYS.every((key) => deepEqual(baseGame[key], game[key]));
}

function mergeGame(baseGame, localGame, remoteGame) {
  const merged = {
    id: localGame.id,
    name: mergeScalar(baseGame?.name, localGame.name, remoteGame.name),
    minPlayers: mergeScalar(baseGame?.minPlayers, localGame.minPlayers, remoteGame.minPlayers),
    maxPlayers: mergeScalar(baseGame?.maxPlayers, localGame.maxPlayers, remoteGame.maxPlayers),
    duration: mergeScalar(baseGame?.duration, localGame.duration, remoteGame.duration),
    complexity: mergeScalar(baseGame?.complexity, localGame.complexity, remoteGame.complexity),
    lastPlayed: mergeScalar(baseGame?.lastPlayed, localGame.lastPlayed, remoteGame.lastPlayed),
    cover: localGame.cover || remoteGame.cover // 封面尽量保留非空的
  };
  for (const key of RULE_KEYS) {
    merged[key] = mergeEntries(localGame[key], remoteGame[key]);
  }
  return merged;
}

function mergeGames(baseGames, localGames, remoteGames) {
  const base = new Map((baseGames || []).map((game) => [game.id, game]));
  const local = new Map((localGames || []).map((game) => [game.id, game]));
  const remote = new Map((remoteGames || []).map((game) => [game.id, game]));
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const out = [];

  for (const id of ids) {
    const b = base.get(id);
    const l = local.get(id);
    const r = remote.get(id);
    const lRemoved = !!l?.removed;
    const rRemoved = !!r?.removed;

    if (l && r) {
      if (lRemoved && rRemoved) continue;
      if (lRemoved && !rRemoved) {
        if (gameUnchangedSince(r, b)) {
          out.push({ id, removed: true }); // 本页删除、对页没动 -> 保持删除并留墓碑
          continue;
        }
        out.push(r);
        continue;
      }
      if (rRemoved && !lRemoved) {
        if (gameUnchangedSince(l, b)) {
          out.push({ id, removed: true }); // 对页删除、本页没动 -> 保持删除并留墓碑
          continue;
        }
        out.push(l);
        continue;
      }
      out.push(mergeGame(b, l, r));
      continue;
    }

    if (l && !r) {
      if (lRemoved) {
        out.push({ id, removed: true });
      } else {
        out.push(l);
      }
      continue;
    }

    if (r && !l) {
      if (rRemoved) {
        out.push({ id, removed: true });
      } else {
        out.push(r);
      }
      continue;
    }
  }
  return out;
}

function mergeState(baseState, localState, remoteState) {
  const mergedGames = mergeGames(baseState.games, localState.games, remoteState.games);
  let selectedId = mergeScalar(baseState.selectedId, localState.selectedId, remoteState.selectedId);
  if (!mergedGames.some((game) => game.id === selectedId)) {
    selectedId = mergedGames[0]?.id || "";
  }
  return { selectedId, games: mergedGames };
}

function isQuotaError(err) {
  if (!err) return false;
  return (
    err.name === "QuotaExceededError" ||
    err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    err.code === 22 ||
    err.code === 1014
  );
}

let state = loadState();
let syncedState = deepClone(state); // 上次成功同步的内容，作为游戏标量合并的底
let lastSavedState = deepClone(state); // 上次完整保存成功的内容，保存失败时恢复
let lastWrittenSnapshot = null; // 首次保存一定写入（同时把迁移后的新格式落盘）

if (!state.selectedId) state.selectedId = state.games[0]?.id || "";

const els = {
  searchInput: document.querySelector("#searchInput"),
  playerFilter: document.querySelector("#playerFilter"),
  complexityFilter: document.querySelector("#complexityFilter"),
  sortMode: document.querySelector("#sortMode"),
  gameForm: document.querySelector("#gameForm"),
  nameInput: document.querySelector("#nameInput"),
  minPlayersInput: document.querySelector("#minPlayersInput"),
  maxPlayersInput: document.querySelector("#maxPlayersInput"),
  durationInput: document.querySelector("#durationInput"),
  complexityInput: document.querySelector("#complexityInput"),
  lastPlayedInput: document.querySelector("#lastPlayedInput"),
  coverInput: document.querySelector("#coverInput"),
  gameList: document.querySelector("#gameList"),
  detailView: document.querySelector("#detailView"),
  gameCount: document.querySelector("#gameCount"),
  ruleCount: document.querySelector("#ruleCount"),
  staleGame: document.querySelector("#staleGame"),
  visibleCount: document.querySelector("#visibleCount"),
  toast: document.querySelector("#toast")
};

let toastTimer = null;
function notify(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

function restoreLastSaved() {
  state = deepClone(lastSavedState);
  syncedState = deepClone(lastSavedState);
  lastWrittenSnapshot = JSON.stringify(state);
}

// 容量不够时先把旧封面降级成占位、保住规则文字；全部降级仍失败则恢复上一次完整内容。
function saveWithDegradation() {
  const order = [...state.games].sort((a, b) =>
    (a.lastPlayed || "").localeCompare(b.lastPlayed || "")
  );
  for (const game of order) {
    if (!game.cover) continue;
    game.cover = "";
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
      lastWrittenSnapshot = JSON.stringify(state);
      lastSavedState = deepClone(state);
      syncedState = deepClone(state);
      notify("存储空间不足，已把旧封面降级为占位图，规则文字已保留。");
      return true;
    } catch (err) {
      if (!isQuotaError(err)) {
        restoreLastSaved();
        notify("保存失败，已恢复到上一次完整内容。");
        return false;
      }
    }
  }
  restoreLastSaved();
  notify("存储空间不足，移除封面后仍无法保存，已恢复到上一次完整内容。");
  return false;
}

function saveState() {
  let snapshot;
  try {
    snapshot = JSON.stringify(state);
  } catch {
    restoreLastSaved();
    notify("保存失败，已恢复到上一次完整内容。");
    return false;
  }
  if (snapshot === lastWrittenSnapshot) return true; // 内容没变，不写、不触发同步
  try {
    localStorage.setItem(storageKey, snapshot);
    lastWrittenSnapshot = snapshot;
    lastSavedState = deepClone(state);
    syncedState = deepClone(state);
    return true;
  } catch (err) {
    if (isQuotaError(err)) return saveWithDegradation();
    restoreLastSaved();
    notify("保存失败，已恢复到上一次完整内容。");
    return false;
  }
}

function daysSince(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return Math.max(0, Math.floor((today - date) / 86400000));
}

function getAllRules(game) {
  return liveEntries([
    ...game.forgets,
    ...game.disputes,
    ...game.setup,
    ...game.scoring
  ]).map((entry) => entry.text);
}

function liveGames() {
  return state.games.filter((game) => !game.removed);
}

function getFilteredGames() {
  const keyword = els.searchInput.value.trim();
  const player = els.playerFilter.value;
  const complexity = els.complexityFilter.value;
  const games = liveGames().filter((game) => {
    const text = `${game.name}${getAllRules(game).join("")}`;
    const matchesKeyword = !keyword || text.includes(keyword);
    const matchesPlayer =
      player === "all" || (Number(player) >= game.minPlayers && Number(player) <= game.maxPlayers);
    const matchesComplexity = complexity === "all" || game.complexity === complexity;
    return matchesKeyword && matchesPlayer && matchesComplexity;
  });

  if (els.sortMode.value === "name") return games.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  if (els.sortMode.value === "complexity") {
    const rank = { 轻: 1, 中: 2, 重: 3 };
    return games.sort((a, b) => rank[b.complexity] - rank[a.complexity]);
  }
  return games.sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed));
}

function renderSummary() {
  const games = liveGames();
  const allRuleCount = games.reduce((sum, game) => sum + getAllRules(game).length, 0);
  const stale = [...games].sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed))[0];
  els.gameCount.textContent = games.length;
  els.ruleCount.textContent = allRuleCount;
  els.staleGame.textContent = stale ? `${daysSince(stale.lastPlayed)}天` : "-";
}

function renderList() {
  const games = getFilteredGames();
  els.visibleCount.textContent = `${games.length}个匹配`;
  els.gameList.innerHTML =
    games
      .map((game) => {
        const selected = game.id === state.selectedId ? "selected" : "";
        return `
          <article class="game-card ${selected}" data-game-id="${game.id}">
            <div class="cover">
              ${
                game.cover
                  ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />`
                  : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`
              }
              <span class="stale-ribbon">${daysSince(game.lastPlayed)}天未玩</span>
            </div>
            <div class="game-body">
              <h3>${escapeHtml(game.name)}</h3>
              <div class="game-meta">
                <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
                <span class="pill">${game.duration}分钟</span>
                <span class="pill heavy">${escapeHtml(game.complexity)}</span>
              </div>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">没有符合筛选的桌游。</p>`;
}

let editingRuleId = null;

function renderDetail() {
  const game = liveGames().find((item) => item.id === state.selectedId) || liveGames()[0];
  if (!game) {
    els.detailView.innerHTML = `<p class="empty">先添加一个桌游。</p>`;
    return;
  }
  state.selectedId = game.id;
  els.detailView.innerHTML = `
    <div class="quick-card">
      <div class="detail-cover">
        ${game.cover ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />` : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`}
      </div>
      <div>
        <h2>${escapeHtml(game.name)}</h2>
        <div class="game-meta">
          <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
          <span class="pill">${game.duration}分钟</span>
          <span class="pill heavy">${escapeHtml(game.complexity)}</span>
          <span class="pill">${daysSince(game.lastPlayed)}天未玩</span>
        </div>
      </div>
      ${renderRuleSection("容易忘的规则", "forgets", game.forgets)}
      ${renderRuleSection("常见争议", "disputes", game.disputes)}
      ${renderRuleSection("开局准备", "setup", game.setup)}
      ${renderRuleSection("计分提醒", "scoring", game.scoring)}
      <form class="add-rule" id="ruleForm">
        <select id="ruleTypeInput">
          <option value="forgets">容易忘的规则</option>
          <option value="disputes">常见争议</option>
          <option value="setup">开局准备</option>
          <option value="scoring">计分提醒</option>
        </select>
        <textarea id="ruleTextInput" rows="3" placeholder="补充一条聚会前要看的提醒" required></textarea>
        <button class="primary" type="submit">加入规则卡片</button>
      </form>
      <div class="detail-actions">
        <button id="playedTodayBtn" type="button">标记今天玩过</button>
        <button id="deleteGameBtn" type="button">删除桌游</button>
      </div>
    </div>
  `;
}

function renderRuleSection(title, key, items) {
  const live = liveEntries(items);
  return `
    <section class="rule-section">
      <h3>${title}</h3>
      <ul class="rule-list">
        ${
          live
            .map((entry) => {
              if (editingRuleId === entry.id) {
                return `
                  <li class="rule-editing">
                    <input class="rule-edit-input" data-rule-edit-input value="${escapeHtml(entry.text)}" />
                    <div class="rule-edit-actions">
                      <button type="button" data-rule-save="${entry.id}">保存</button>
                      <button type="button" data-rule-cancel="${entry.id}">取消</button>
                    </div>
                  </li>
                `;
              }
              return `
                <li class="${entry.conflict ? "conflict" : ""}">
                  <span class="rule-text">${escapeHtml(entry.text)}</span>
                  ${entry.conflict ? '<span class="conflict-badge">冲突</span>' : ""}
                  <div class="rule-actions">
                    <button type="button" title="编辑" data-rule-edit="${entry.id}">编辑</button>
                    <button type="button" title="删除" data-rule-delete="${entry.id}">×</button>
                  </div>
                </li>
              `;
            })
            .join("") || `<li><span>暂无内容。</span></li>`
        }
      </ul>
    </section>
  `;
}

function renderAll() {
  saveState();
  renderSummary();
  renderList();
  renderDetail();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function addGame(event) {
  event.preventDefault();
  const minPlayers = Number(els.minPlayersInput.value);
  const maxPlayers = Math.max(minPlayers, Number(els.maxPlayersInput.value));
  const cover = await readFileAsDataUrl(els.coverInput.files[0]);
  const game = {
    id: crypto.randomUUID(),
    name: els.nameInput.value.trim(),
    minPlayers,
    maxPlayers,
    duration: Number(els.durationInput.value),
    complexity: els.complexityInput.value,
    lastPlayed: els.lastPlayedInput.value,
    cover,
    forgets: ["本局开始前先补充容易忘的规则。"].map(makeEntry),
    disputes: [],
    setup: ["整理组件并按人数调整初始设置。"].map(makeEntry),
    scoring: ["确认终局计分项和即时得分项。"].map(makeEntry)
  };
  state.games.unshift(game);
  state.selectedId = game.id;
  els.gameForm.reset();
  setDefaultDate();
  renderAll();
}

function setDefaultDate() {
  const date = new Date();
  date.setMonth(date.getMonth() - 2);
  els.lastPlayedInput.value = date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  const amp = "&" + "amp;";
  const lt = "&" + "lt;";
  const gt = "&" + "gt;";
  const quot = "&" + "quot;";
  const apos = "&" + "#039;";
  return String(value)
    .replaceAll("&", amp)
    .replaceAll("<", lt)
    .replaceAll(">", gt)
    .replaceAll('"', quot)
    .replaceAll("'", apos);
}

// 多页签同步：另一页写入后，用三路合并把对方的改动并进来，而不是整体覆盖。
function handleStorageEvent(event) {
  if (event.key !== storageKey) return;
  let incoming;
  try {
    incoming = JSON.parse(event.newValue);
  } catch {
    return;
  }
  if (!incoming) return;
  incoming = migrateState(incoming);
  const merged = mergeState(syncedState, state, incoming);
  state = merged;
  syncedState = deepClone(merged);
  lastSavedState = deepClone(merged);
  if (deepEqual(merged, incoming)) {
    lastWrittenSnapshot = JSON.stringify(merged); // 内容已在存储里，避免重复写
  } else {
    try {
      localStorage.setItem(storageKey, JSON.stringify(merged));
      lastWrittenSnapshot = JSON.stringify(merged);
    } catch (err) {
      if (isQuotaError(err)) saveWithDegradation();
    }
  }
  if (uiEditing) {
    pendingRemoteMerge = true; // 正在输入，先别重绘以免吃掉输入
  } else {
    renderAll();
  }
}

let uiEditing = false;
let pendingRemoteMerge = false;

document.addEventListener("focusin", (event) => {
  if (event.target.closest("input, textarea, select")) uiEditing = true;
});

document.addEventListener("focusout", (event) => {
  if (!event.target.closest("input, textarea, select")) return;
  const to = event.relatedTarget;
  const stillEditing = !!(to && to.closest("input, textarea, select"));
  if (!stillEditing) {
    uiEditing = false;
    if (pendingRemoteMerge) {
      pendingRemoteMerge = false;
      renderAll();
    }
  }
});

window.addEventListener("storage", handleStorageEvent);

els.searchInput.addEventListener("input", renderAll);
els.playerFilter.addEventListener("change", renderAll);
els.complexityFilter.addEventListener("change", renderAll);
els.sortMode.addEventListener("change", renderAll);
els.gameForm.addEventListener("submit", addGame);

els.gameList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-game-id]");
  if (!card) return;
  editingRuleId = null; // 切换桌游时放弃未保存的编辑
  state.selectedId = card.dataset.gameId;
  renderAll();
});

els.detailView.addEventListener("submit", (event) => {
  if (event.target.id !== "ruleForm") return;
  event.preventDefault();
  const game = state.games.find((item) => item.id === state.selectedId);
  if (!game) return;
  const key = document.querySelector("#ruleTypeInput").value;
  const text = document.querySelector("#ruleTextInput").value.trim();
  if (!text) return;
  game[key].push(makeEntry(text));
  renderAll();
});

els.detailView.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const input = event.target.closest("[data-rule-edit-input]");
  if (!input) return;
  event.preventDefault();
  const saveButton = input.closest("li").querySelector("[data-rule-save]");
  saveButton?.click();
});

els.detailView.addEventListener("click", (event) => {
  const ruleEditButton = event.target.closest("[data-rule-edit]");
  const ruleSaveButton = event.target.closest("[data-rule-save]");
  const ruleCancelButton = event.target.closest("[data-rule-cancel]");
  const ruleDeleteButton = event.target.closest("[data-rule-delete]");
  const playedButton = event.target.closest("#playedTodayBtn");
  const deleteButton = event.target.closest("#deleteGameBtn");
  const game = state.games.find((item) => item.id === state.selectedId);
  if (!game) return;

  if (ruleEditButton) {
    editingRuleId = ruleEditButton.dataset.ruleEdit;
    renderAll();
    const input = els.detailView.querySelector("[data-rule-edit-input]");
    input?.focus();
    input?.select();
    return;
  }

  if (ruleSaveButton) {
    const id = ruleSaveButton.dataset.ruleSave;
    const li = ruleSaveButton.closest("li");
    const input = li.querySelector("[data-rule-edit-input]");
    const text = input.value.trim();
    for (const key of RULE_KEYS) {
      const entry = game[key].find((item) => item.id === id);
      if (entry) {
        if (text) {
          entry.text = text;
          entry.base = text;
        } else {
          entry.removed = true; // 清空内容视为删除
        }
        break;
      }
    }
    editingRuleId = null;
    renderAll();
    return;
  }

  if (ruleCancelButton) {
    editingRuleId = null;
    renderAll();
    return;
  }

  if (ruleDeleteButton) {
    const id = ruleDeleteButton.dataset.ruleDelete;
    for (const key of RULE_KEYS) {
      const entry = game[key].find((item) => item.id === id);
      if (entry) {
        entry.removed = true; // 墓碑：对页旧副本不会让它冒出来
        break;
      }
    }
    renderAll();
    return;
  }

  if (playedButton) {
    game.lastPlayed = new Date().toISOString().slice(0, 10);
    renderAll();
    return;
  }

  if (deleteButton) {
    const gameToDelete = state.games.find((item) => item.id === game.id);
    if (gameToDelete) gameToDelete.removed = true; // 墓碑：删除同步到对页
    state.selectedId = state.games.find((item) => !item.removed)?.id || "";
    renderAll();
  }
});

setDefaultDate();
renderAll();
