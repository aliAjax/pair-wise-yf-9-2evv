/* 桌游规则遗忘点卡片库 —— 界面层
 * 本地账能力在 ledger.js：条目编号、双页面逐条合并、冲突标记、
 * 墓碑防复活、容量不足封面降级、完整备份恢复、v1 旧数据升级。
 */
const today = new Date();

const SECTION_TITLES = {
  forgets: "容易忘的规则",
  disputes: "常见争议",
  setup: "开局准备",
  scoring: "计分提醒"
};

const notices = [];
let editingTarget = null; // 正在内联编辑的条目：{gameId, section, ruleId}

const store = new ZflLedger.LedgerStore({
  onNotice: (notice) => {
    if (notice.kind === "degraded" && notices.some((n) => n.kind === "degraded" && n.message === notice.message)) return;
    notices.push(notice);
  }
});
store.load();
let state = store.state;

const els = {
  noticeBar: document.querySelector("#noticeBar"),
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
  visibleCount: document.querySelector("#visibleCount")
};

// ---------- 操作（改完统一提交，由账本负责落盘和跨页合并） ----------

function commitAndRender() {
  store.commit();
  state = store.state;
  renderAll();
}

function selectedGame() {
  return state.games.find((item) => item.id === state.selectedId) || state.games[0] || null;
}

function daysSince(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return Math.max(0, Math.floor((today - date) / 86400000));
}

function entryText(entry) {
  return ZflLedger.isConflictEntry(entry)
    ? entry.versions.filter((v) => !v.deleted).map((v) => v.text).join(" / ")
    : entry.text;
}

function allEntries(game) {
  return ZflLedger.RULE_SECTIONS.flatMap((key) => game.rules[key]);
}

function getFilteredGames() {
  const keyword = els.searchInput.value.trim();
  const player = els.playerFilter.value;
  const complexity = els.complexityFilter.value;
  const games = state.games.filter((game) => {
    const text = `${game.name}${allEntries(game).map(entryText).join("")}`;
    const matchesKeyword = !keyword || text.includes(keyword);
    const matchesPlayer = player === "all" || (Number(player) >= game.minPlayers && Number(player) <= game.maxPlayers);
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

// ---------- 渲染 ----------

function renderNotices() {
  const visible = notices.filter((notice) => notice.dismissed !== true);
  if (!visible.length) {
    els.noticeBar.innerHTML = "";
    return;
  }
  els.noticeBar.innerHTML = visible
    .map((notice, index) => {
      const actions = [];
      if (notice.kind === "saveError") {
        actions.push(`<button type="button" data-notice-action="retry">重试保存</button>`);
        actions.push(`<button type="button" data-notice-action="restore">用上次完整内容恢复</button>`);
      }
      actions.push(`<button type="button" data-notice-index="${index}" data-notice-action="dismiss">知道了</button>`);
      return `
        <div class="notice notice-${notice.kind}">
          <span>${escapeHtml(notice.message)}</span>
          <div class="notice-actions">${actions.join("")}</div>
        </div>
      `;
    })
    .join("");
}

function renderSummary() {
  const allRuleCount = state.games.reduce((sum, game) => sum + allEntries(game).length, 0);
  const stale = [...state.games].sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed))[0];
  els.gameCount.textContent = state.games.length;
  els.ruleCount.textContent = allRuleCount;
  els.staleGame.textContent = stale ? `${daysSince(stale.lastPlayed)}天` : "-";
}

function coverHtml(game) {
  if (game.cover) return `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />`;
  return `<span>${escapeHtml(game.name.slice(0, 2))}</span>${
    game.coverDegraded ? `<em class="cover-degraded" title="存储空间不足，封面已降级成占位">封面已降级</em>` : ""
  }`;
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
              ${coverHtml(game)}
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

function renderRuleSection(game, key) {
  const title = SECTION_TITLES[key];
  const items = game.rules[key];
  return `
    <section class="rule-section">
      <h3>${title}</h3>
      <ul class="rule-list">
        ${
          items
            .map((entry) => {
              if (ZflLedger.isConflictEntry(entry)) return renderConflictItem(game, key, entry);
              return renderNormalItem(game, key, entry);
            })
            .join("") || `<li><span>暂无内容。</span></li>`
        }
      </ul>
    </section>
  `;
}

function renderNormalItem(game, key, entry) {
  const isEditing =
    editingTarget && editingTarget.gameId === game.id && editingTarget.section === key && editingTarget.ruleId === entry.id;
  if (isEditing) {
    return `
      <li class="editing">
        <textarea rows="2" data-edit-id="${entry.id}">${escapeHtml(entry.text)}</textarea>
        <div class="row-actions">
          <button type="button" data-save-rule="${entry.id}" data-rule-key="${key}">保存</button>
          <button type="button" data-cancel-edit="${entry.id}">取消</button>
        </div>
      </li>
    `;
  }
  return `
    <li>
      <span>${escapeHtml(entry.text)}</span>
      <div class="row-actions">
        <button type="button" title="编辑" data-edit-rule="${entry.id}" data-rule-key="${key}">改</button>
        <button type="button" title="删除" data-delete-rule="${entry.id}" data-rule-key="${key}">×</button>
      </div>
    </li>
  `;
}

function renderConflictItem(game, key, entry) {
  const versions = entry.versions
    .map((version, versionIndex) => {
      if (version.deleted) {
        return `
          <li class="conflict-version conflict-deleted">
            <span>（另一方已删除此条）</span>
            <button type="button" data-resolve-rule="${entry.id}" data-rule-key="${key}" data-version-index="${versionIndex}">确认删除</button>
          </li>`;
      }
      return `
        <li class="conflict-version">
          <span>${escapeHtml(version.text)}</span>
            <button type="button" data-resolve-rule="${entry.id}" data-rule-key="${key}" data-version-index="${versionIndex}">保留这份</button>
          </li>`;
    })
    .join("");
  return `
    <li class="conflict-item">
      <div class="conflict-head"><strong>冲突</strong><span>这条规则两边都动过，请裁决保留哪份</span></div>
      <ul class="conflict-versions">${versions}</ul>
    </li>
  `;
}

function renderDetail() {
  const game = selectedGame();
  if (!game) {
    state.selectedId = "";
    els.detailView.innerHTML = `<p class="empty">先添加一个桌游。</p>`;
    return;
  }
  state.selectedId = game.id;
  els.detailView.innerHTML = `
    <div class="quick-card">
      <div class="detail-cover">
        ${coverHtml(game, "detail")}
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
      ${ZflLedger.RULE_SECTIONS.map((key) => renderRuleSection(game, key)).join("")}
      <form class="add-rule" id="ruleForm">
        <select id="ruleTypeInput">
          ${ZflLedger.RULE_SECTIONS.map((key) => `<option value="${key}">${SECTION_TITLES[key]}</option>`).join("")}
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

function renderAll() {
  renderNotices();
  renderSummary();
  renderList();
  renderDetail();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- 新增桌游 ----------

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
  const now = Date.now();
  const seedEntry = (text) => ({ id: crypto.randomUUID(), text, updatedAt: now });
  const game = {
    id: crypto.randomUUID(),
    name: els.nameInput.value.trim(),
    minPlayers,
    maxPlayers,
    duration: Number(els.durationInput.value),
    complexity: els.complexityInput.value,
    lastPlayed: els.lastPlayedInput.value,
    cover,
    coverDegraded: false,
    updatedAt: now,
    rules: {
      forgets: [seedEntry("本局开始前先补充容易忘的规则。")],
      disputes: [],
      setup: [seedEntry("整理组件并按人数调整初始设置。")],
      scoring: [seedEntry("确认终局计分项和即时得分项。")]
    }
  };
  state.games.unshift(game);
  state.selectedId = game.id;
  els.gameForm.reset();
  setDefaultDate();
  commitAndRender();
}

function setDefaultDate() {
  const date = new Date();
  date.setMonth(date.getMonth() - 2);
  els.lastPlayedInput.value = date.toISOString().slice(0, 10);
}

// ---------- 事件 ----------

// 筛选/排序只改变展示，不写账本
els.searchInput.addEventListener("input", renderAll);
els.playerFilter.addEventListener("change", renderAll);
els.complexityFilter.addEventListener("change", renderAll);
els.sortMode.addEventListener("change", renderAll);
els.gameForm.addEventListener("submit", addGame);

els.gameList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-game-id]");
  if (!card) return;
  state.selectedId = card.dataset.gameId;
  editingTarget = null;
  renderAll();
});

els.detailView.addEventListener("submit", (event) => {
  if (event.target.id !== "ruleForm") return;
  event.preventDefault();
  const game = selectedGame();
  if (!game) return;
  const key = document.querySelector("#ruleTypeInput").value;
  const text = document.querySelector("#ruleTextInput").value.trim();
  if (!text) return;
  game.rules[key].push({ id: crypto.randomUUID(), text, updatedAt: Date.now() });
  commitAndRender();
});

els.detailView.addEventListener("click", (event) => {
  const game = selectedGame();
  if (!game) return;

  const deleteBtn = event.target.closest("[data-delete-rule]");
  const editBtn = event.target.closest("[data-edit-rule]");
  const saveBtn = event.target.closest("[data-save-rule]");
  const cancelBtn = event.target.closest("[data-cancel-edit]");
  const resolveBtn = event.target.closest("[data-resolve-rule]");
  const playedButton = event.target.closest("#playedTodayBtn");
  const deleteGameButton = event.target.closest("#deleteGameBtn");

  if (deleteBtn) {
    const key = deleteBtn.dataset.ruleKey;
    const ruleId = deleteBtn.dataset.deleteRule;
    const entry = game.rules[key].find((item) => item.id === ruleId);
    if (!entry) return;
    game.rules[key] = game.rules[key].filter((item) => item.id !== ruleId);
    // 留下墓碑：其他页面再保存时，这条不会因为它们还留着而复活
    state.tombstones[ruleId] = { id: ruleId, gameId: game.id, section: key, updatedAt: Date.now() };
    editingTarget = null;
    commitAndRender();
  }

  if (editBtn) {
    editingTarget = { gameId: game.id, section: editBtn.dataset.ruleKey, ruleId: editBtn.dataset.editRule };
    renderAll();
    const textarea = els.detailView.querySelector(`[data-edit-id="${CSS.escape(editingTarget.ruleId)}"]`);
    if (textarea) textarea.focus();
  }

  if (cancelBtn) {
    editingTarget = null;
    renderAll();
  }

  if (saveBtn) {
    const key = saveBtn.dataset.ruleKey;
    const ruleId = saveBtn.dataset.saveRule;
    const textarea = els.detailView.querySelector(`[data-edit-id="${CSS.escape(ruleId)}"]`);
    const text = textarea ? textarea.value.trim() : "";
    const entry = game.rules[key].find((item) => item.id === ruleId);
    if (entry && text) {
      entry.text = text;
      entry.updatedAt = Date.now();
      editingTarget = null;
      commitAndRender();
    }
  }

  if (resolveBtn) {
    const key = resolveBtn.dataset.ruleKey;
    const ruleId = resolveBtn.dataset.resolveRule;
    const versionIndex = Number(resolveBtn.dataset.versionIndex);
    const entry = game.rules[key].find((item) => item.id === ruleId);
    if (!entry || !ZflLedger.isConflictEntry(entry)) return;
    const version = entry.versions[versionIndex];
    if (!version) return;
    const position = game.rules[key].findIndex((item) => item.id === ruleId);
    if (version.deleted) {
      game.rules[key].splice(position, 1);
      state.tombstones[ruleId] = { id: ruleId, gameId: game.id, section: key, updatedAt: Date.now() };
    } else {
      game.rules[key][position] = { id: ruleId, text: version.text, updatedAt: Date.now() };
    }
    commitAndRender();
  }

  if (playedButton) {
    game.lastPlayed = new Date().toISOString().slice(0, 10);
    game.updatedAt = Date.now();
    commitAndRender();
  }

  if (deleteGameButton) {
    state.games = state.games.filter((item) => item.id !== game.id);
    for (const [tombId, tomb] of Object.entries(state.tombstones)) {
      if (tomb.gameId === game.id) delete state.tombstones[tombId];
    }
    state.selectedId = state.games[0]?.id || "";
    editingTarget = null;
    commitAndRender();
  }
});

// 通知条上的操作
els.noticeBar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-notice-action]");
  if (!button) return;
  const index = Number(button.dataset.noticeIndex);
  const action = button.dataset.noticeAction;
  if (action === "dismiss") {
    notices[index].dismissed = true;
    renderAll();
  }
  if (action === "retry") {
    const result = store.retrySave();
    if (result.ok) {
      notices
        .filter((n) => n.kind === "saveError" && !n.sticky)
        .forEach((n) => (n.dismissed = true));
      state = store.state;
    }
    renderAll();
  }
  if (action === "restore") {
    const ok = store.restoreBackup();
    if (ok) {
      state = store.state;
      editingTarget = null;
    }
    renderAll();
  }
});

// ---------- 多页面对齐：别的页面写入后逐条合并 ----------

window.addEventListener("storage", (event) => {
  if (event.key !== ZflLedger.MAIN_KEY) return;
  const result = store.sync(event.newValue);
  if (result.merged) {
    state = store.state;
    renderAll();
  }
});

setDefaultDate();
renderAll();

// 调试/自动化钩子（页面内只读视图，写入仍走界面操作和 commit）
window.__zfl = {
  get state() {
    return state;
  },
  set state(value) {
    state = value;
  },
  get store() {
    return store;
  },
  get notices() {
    return notices;
  }
};
