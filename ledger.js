/*
 * 桌游规则卡片本地账（数据层）
 *
 * - v2 账：每条规则自带稳定编号；删除留下墓碑，防止别的页面把旧条目"复活"
 * - 两个页面同时改同一张卡片时按 base/local/incoming 三路逐条合并
 * - 同一条两边都动过：留下两份并标 conflict；删改冲突保留可裁决的版本
 * - 容量不足：按"最久未玩"顺序把封面降级成占位，优先保住规则文字
 * - 主账写入失败不覆盖旧账；另存"上一次完整内容"备份，可整份恢复
 * - v1 旧数据（规则是纯字符串）升级时补齐编号，同一内容在各页面生成相同编号
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.ZflLedger = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAIN_KEY = "zfl18-boardgame-rule-cards";
  const BACKUP_KEY = "zfl18-boardgame-rule-cards:backup";
  const VERSION = 2;
  const TOMB_TTL_MS = 60 * 24 * 3600 * 1000;
  const RULE_SECTIONS = ["forgets", "disputes", "setup", "scoring"];
  const SCALAR_FIELDS = ["name", "minPlayers", "maxPlayers", "duration", "complexity", "lastPlayed"];
  const FIELD_DEFAULTS = {
    name: "",
    minPlayers: 1,
    maxPlayers: 4,
    duration: 60,
    complexity: "中",
    lastPlayed: ""
  };

  // ---------- 基础工具 ----------

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function defaultUuid() {
    return crypto.randomUUID();
  }

  function defaultNow() {
    return Date.now();
  }

  function isQuotaError(error) {
    return (
      !!error &&
      (error.name === "QuotaExceededError" ||
        error.code === 22 ||
        error.code === 1014 ||
        /quota/i.test(String(error.message || "")))
    );
  }

  // FNV-1a 双种子哈希：让旧数据升级时，同一规则在任何页面都算出同一个编号
  function fnv1a(text, basis) {
    let hash = basis >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function deterministicId(parts) {
    const text = parts.join("");
    const a = fnv1a(text, 0x811c9dc5);
    const b = fnv1a(text, 0x811c9dc5 ^ 0x9e3779b9);
    return `mig-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
  }

  function makeEntry(text, uuid, now) {
    return { id: uuid(), text: String(text), updatedAt: now };
  }

  function makeTomb(id, gameId, section, now) {
    return { id, gameId, section, updatedAt: now };
  }

  function isConflictEntry(entry) {
    return !!entry && entry.conflict === true && Array.isArray(entry.versions);
  }

  function entryTexts(entry) {
    if (isConflictEntry(entry)) {
      return entry.versions.filter((v) => !v.deleted).map((v) => v.text);
    }
    return entry ? [entry.text] : [];
  }

  // ---------- 初始数据 ----------

  function createDefaultState(uuid = defaultUuid, now = defaultNow) {
    const game = (name, fields, forgets, disputes, setup, scoring) => ({
      id: uuid(),
      name,
      minPlayers: fields[0],
      maxPlayers: fields[1],
      duration: fields[2],
      complexity: fields[3],
      lastPlayed: fields[4],
      cover: "",
      coverDegraded: false,
      updatedAt: now,
      rules: {
        forgets: forgets.map((text) => makeEntry(text, uuid, now)),
        disputes: disputes.map((text) => makeEntry(text, uuid, now)),
        setup: setup.map((text) => makeEntry(text, uuid, now)),
        scoring: scoring.map((text) => makeEntry(text, uuid, now))
      }
    });

    return {
      version: VERSION,
      selectedId: "",
      games: [
        game(
          "奥尔良",
          [2, 4, 90, "中", "2025-11-20"],
          ["商站建造前先确认道路或水路连接", "袋中随从抽完后不是重洗弃堆，而是从已回袋内容继续抽"],
          ["事件顺序和玩家动作结算先后", "科技板是否能替代所有同类随从"],
          ["按人数放置货物板块", "每位玩家拿起始随从、商人和个人板"],
          ["货物分数", "商站和市民乘区块", "金币和建筑剩余加分"]
        ),
        game(
          "盖亚计划",
          [1, 4, 150, "重", "2025-08-02"],
          ["联邦连接时卫星数量和能量消耗要一起核对", "研究升到顶必须拿对应科技板限制"],
          ["被动充能是否能拒绝", "星球改造费用受哪些能力影响"],
          ["随机终局计分板和回合得分板", "按种族设置起始资源和母星"],
          ["终局计分板", "科技轨排名", "联邦和建筑分"]
        ),
        game(
          "花砖物语",
          [2, 4, 45, "轻", "2026-03-15"],
          ["每轮结束先铺墙再补工厂展示区", "地板线扣分后清空对应砖"],
          ["同色砖放置限制是否看整面墙", "中央区起始玩家标记是否必须拿"],
          ["按人数放工厂圆盘", "每个圆盘补4块砖"],
          ["横竖相邻即时分", "完整行列和颜色终局加分"]
        )
      ],
      tombstones: {}
    };
  }

  // ---------- 归一化与旧数据升级 ----------

  function normalizeVersion(raw, now) {
    if (!raw || typeof raw !== "object") return { deleted: true, updatedAt: now };
    if (raw.deleted === true) return { deleted: true, updatedAt: Number(raw.updatedAt) || now };
    return { text: String(raw.text == null ? "" : raw.text), updatedAt: Number(raw.updatedAt) || now };
  }

  function normalizeEntry(raw, uuid, now) {
    if (typeof raw === "string") return makeEntry(raw, uuid, now);
    if (!raw || typeof raw !== "object") return makeEntry("", uuid, now);
    const id = String(raw.id || uuid());
    if (raw.conflict === true || Array.isArray(raw.versions)) {
      const versions = (Array.isArray(raw.versions) ? raw.versions : []).map((v) => normalizeVersion(v, now));
      return {
        id,
        conflict: true,
        updatedAt: Number(raw.updatedAt) || Math.max(0, ...versions.map((v) => v.updatedAt)),
        versions
      };
    }
    return { id, text: String(raw.text == null ? "" : raw.text), updatedAt: Number(raw.updatedAt) || now };
  }

  function normalizeGame(raw, uuid, now) {
    const source = raw && typeof raw === "object" ? raw : {};
    const id = String(source.id || uuid());
    const rules = {};
    for (const section of RULE_SECTIONS) {
      const list = source.rules && Array.isArray(source.rules[section]) ? source.rules[section] : [];
      rules[section] = list.map((entry) => normalizeEntry(entry, uuid, now));
    }
    const game = { id, rules };
    for (const field of SCALAR_FIELDS) {
      game[field] = source[field] == null ? FIELD_DEFAULTS[field] : source[field];
    }
    game.cover = typeof source.cover === "string" ? source.cover : "";
    game.coverDegraded = source.coverDegraded === true;
    game.updatedAt = Number(source.updatedAt) || now;
    return game;
  }

  function normalizeTombstones(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      out[id] = {
        id: String(value.id || id),
        gameId: String(value.gameId || ""),
        section: RULE_SECTIONS.includes(value.section) ? value.section : RULE_SECTIONS[0],
        updatedAt: Number(value.updatedAt) || 0
      };
    }
    return out;
  }

  function normalizeState(raw, uuid = defaultUuid, now = defaultNow) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("账本数据结构无效");
    }
    const games = Array.isArray(raw.games) ? raw.games.map((g) => normalizeGame(g, uuid, now)) : [];
    return {
      version: VERSION,
      selectedId: typeof raw.selectedId === "string" ? raw.selectedId : "",
      games,
      tombstones: normalizeTombstones(raw.tombstones)
    };
  }

  // v1：规则按 forgets/disputes/setup/scoring 存成纯字符串，没有编号
  function migrateV1(raw, uuid, now) {
    const games = (Array.isArray(raw.games) ? raw.games : []).map((source) => {
      const game = normalizeGame(
        { id: source && source.id ? String(source.id) : uuid(), rules: {} },
        uuid,
        now
      );
      for (const field of SCALAR_FIELDS) {
        if (source && source[field] != null) game[field] = source[field];
      }
      if (source && typeof source.cover === "string") game.cover = source.cover;
      for (const section of RULE_SECTIONS) {
        const list = source && Array.isArray(source[section]) ? source[section] : [];
        game.rules[section] = list.map((item, index) => {
          if (item && typeof item === "object") return normalizeEntry(item, uuid, now);
          return {
            id: deterministicId([game.id, section, index, String(item)]),
            text: String(item),
            updatedAt: now
          };
        });
      }
      return game;
    });
    return { version: VERSION, selectedId: typeof raw.selectedId === "string" ? raw.selectedId : "", games, tombstones: {} };
  }

  function migrate(raw, uuid = defaultUuid, now = defaultNow) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("账本数据结构无效");
    }
    if (raw.version >= VERSION) return normalizeState(raw, uuid, now);
    return migrateV1(raw, uuid, now);
  }

  function parseStored(text, uuid = defaultUuid, now = defaultNow) {
    const raw = JSON.parse(text);
    return migrate(raw, uuid, now);
  }

  // ---------- 三路合并 ----------

  function versionsOf(state) {
    if (!state) return [];
    if (state.kind === "tomb") return [{ deleted: true, updatedAt: state.value.updatedAt }];
    const entry = state.value;
    if (isConflictEntry(entry)) return entry.versions.map((v) => ({ ...v }));
    return [{ text: entry.text, updatedAt: entry.updatedAt }];
  }

  function maxTime(values) {
    return values.reduce((max, v) => Math.max(max, Number(v) || 0), 0);
  }

  // 两边都相对 base 动过同一条：汇总所有版本，去重后决定是否冲突
  function reconcileBothChanged(id, localState, incomingState, now) {
    const merged = new Map();
    for (const version of [...versionsOf(localState), ...versionsOf(incomingState)]) {
      const key = version.deleted ? "deleted" : `text:${version.text}`;
      const existing = merged.get(key);
      if (!existing || version.updatedAt > existing.updatedAt) merged.set(key, { ...version });
    }
    const versions = [...merged.values()];
    const lives = versions.filter((v) => !v.deleted);
    const deleted = versions.filter((v) => v.deleted);
    const updatedAt = maxTime(versions) || now;

    if (lives.length === 0) {
      return { kind: "tomb", value: { id, updatedAt } };
    }
    lives.sort((a, b) => b.updatedAt - a.updatedAt || a.text.localeCompare(b.text));
    if (lives.length === 1 && deleted.length === 0) {
      return { kind: "live", value: { id, text: lives[0].text, updatedAt } };
    }
    return {
      kind: "live",
      value: { id, conflict: true, updatedAt, versions: [...lives, ...deleted] }
    };
  }

  function mergeSection(gameId, section, baseEntries, localEntries, incomingEntries, baseTombs, localTombs, incomingTombs, now) {
    const indexList = (entries) => {
      const map = new Map();
      for (const entry of entries || []) {
        if (!map.has(entry.id)) map.set(entry.id, { kind: "live", value: entry });
      }
      return map;
    };
    const tombMap = (tombs) => {
      const map = new Map();
      for (const tomb of tombs || []) map.set(tomb.id, { kind: "tomb", value: tomb });
      return map;
    };
    const bMap = indexList(baseEntries);
    const lMap = indexList(localEntries);
    const iMap = indexList(incomingEntries);
    const bT = tombMap(baseTombs);
    const lT = tombMap(localTombs);
    const iT = tombMap(incomingTombs);

    function stateOf(liveMap, tombMap, ruleId) {
      return liveMap.get(ruleId) || tombMap.get(ruleId);
    }

    // 统一成可比较的形状（活条目 / 删除标记），避免"活条目 vs 墓碑"形状不同造成误判
    function comparable(state) {
      if (!state) return undefined;
      if (state.kind === "tomb") return { deleted: true, updatedAt: state.value.updatedAt };
      const entry = state.value;
      if (isConflictEntry(entry)) {
        return {
          conflict: true,
          updatedAt: entry.updatedAt,
          versions: normalizeVersionsForCompare(entry.versions)
        };
      }
      return { text: entry.text, updatedAt: entry.updatedAt };
    }

    function normalizeVersionsForCompare(versions) {
      return [...versions]
        .map((v) => (v.deleted ? { deleted: true, updatedAt: v.updatedAt } : { text: v.text, updatedAt: v.updatedAt }))
        .sort((a, b) => {
          if (a.deleted !== b.deleted) return a.deleted ? 1 : -1;
          if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
          return String(a.text).localeCompare(String(b.text));
        });
    }

    const sameState = (a, b) => deepEqual(comparable(a), comparable(b));

    const ids = new Set([...bMap.keys(), ...lMap.keys(), ...iMap.keys(), ...bT.keys(), ...lT.keys(), ...iT.keys()]);
    const result = new Map(); // ruleId -> live state | tomb marker

    for (const id of ids) {
      const b = stateOf(bMap, bT, id);
      const l = stateOf(lMap, lT, id);
      const i = stateOf(iMap, iT, id);

      let picked;
      if (sameState(l, i)) picked = l;
      else if (sameState(l, b)) picked = i; // 本页没动，用另一页（含另一页的删除）
      else if (sameState(i, b)) picked = l; // 另一页没动，用本页
      else picked = reconcileBothChanged(id, l, i, now);

      // 两边都没有该条目：base 是墓碑就保留；base 是活条目则视为两边都删了
      if (!picked && b) {
        picked =
          b.kind === "tomb"
            ? { kind: "tomb", value: b.value }
            : { kind: "tomb", value: { id, gameId, section, updatedAt: b.value.updatedAt || now } };
      }

      if (picked && picked.kind === "live") {
        result.set(id, { kind: "live", value: picked.value });
      } else if (picked && picked.kind === "tomb") {
        const updatedAt = picked.value
          ? picked.value.updatedAt
          : maxTime([...versionsOf(l), ...versionsOf(i)]);
        result.set(id, { kind: "tomb", value: { id, gameId, section, updatedAt } });
      }
    }

    // 顺序必须对两个页面完全一致：冲突条目排最前（提示先裁决），其余按编号排序
    const liveIds = [...result.keys()].filter((id) => result.get(id).kind === "live");
    liveIds.sort((a, b) => {
      const ea = result.get(a).value;
      const eb = result.get(b).value;
      if (isConflictEntry(ea) !== isConflictEntry(eb)) return isConflictEntry(ea) ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    const entries = liveIds.map((id) => clone(result.get(id).value));
    const tombstones = [];
    for (const [id, picked] of result) {
      if (picked.kind === "tomb") tombstones.push(clone(picked.value));
    }
    return { entries, tombstones };
}

  function field3(baseValue, localValue, incomingValue) {
    if (deepEqual(localValue, incomingValue)) return clone(localValue);
    if (deepEqual(localValue, baseValue)) return clone(incomingValue);
    if (deepEqual(incomingValue, baseValue)) return clone(localValue);
    // 同一字段两边都改且内容不同：按序列化结果确定性取一份，保证两个页面结论一致
    return JSON.stringify(localValue) <= JSON.stringify(incomingValue) ? clone(localValue) : clone(incomingValue);
  }

  // 容量不足触发的封面降级是系统行为，不算用户对封面的修改
  function systemDegradedCover(side, base) {
    return side && base && side.cover === "" && side.coverDegraded === true && base.cover;
  }

  function gameUnchangedByUser(side, base) {
    if (!base) return side == null;
    if (!side) return false;
    const view = clone(side);
    if (systemDegradedCover(side, base)) {
      view.cover = base.cover;
      view.coverDegraded = base.coverDegraded === true;
    }
    return deepEqual(view, base);
  }

  function mergeGameFields(base, local, incoming) {
    const merged = { id: local.id, rules: local.rules };
    for (const field of SCALAR_FIELDS) {
      merged[field] = field3(base ? base[field] : undefined, local[field], incoming[field]);
    }
    const lCover = systemDegradedCover(local, base) ? (base ? base.cover : "") : local.cover;
    const iCover = systemDegradedCover(incoming, base) ? (base ? base.cover : "") : incoming.cover;
    merged.cover = field3(base ? base.cover : undefined, lCover, iCover);
    merged.coverDegraded = merged.cover ? false : local.coverDegraded === true || incoming.coverDegraded === true;
    merged.updatedAt = Math.max(
      base ? base.updatedAt || 0 : 0,
      local.updatedAt || 0,
      incoming.updatedAt || 0
    );
    return merged;
  }

  function tombsByGame(state) {
    const map = new Map();
    for (const tomb of Object.values(state.tombstones || {})) {
      if (!map.has(tomb.gameId)) map.set(tomb.gameId, new Map());
      const perGame = map.get(tomb.gameId);
      if (!perGame.has(tomb.section)) perGame.set(tomb.section, []);
      perGame.get(tomb.section).push(tomb);
    }
    return map;
  }

  function mergeStates(base, local, incoming, now = defaultNow()) {
    const bIndex = new Map((base.games || []).map((g) => [g.id, g]));
    const lIndex = new Map((local.games || []).map((g) => [g.id, g]));
    const iIndex = new Map((incoming.games || []).map((g) => [g.id, g]));
    const bTombs = tombsByGame(base);
    const lTombs = tombsByGame(local);
    const iTombs = tombsByGame(incoming);

    const orderedIds = [];
    const seen = new Set();
    for (const index of [lIndex, iIndex, bIndex]) {
      for (const id of index.keys()) {
        if (!seen.has(id)) {
          orderedIds.push(id);
          seen.add(id);
        }
      }
    }

    const games = [];
    const allTombstones = [];

    const carrySideTombs = (tombsIndex, gameId) => {
      const perGame = tombsIndex.get(gameId);
      if (!perGame) return;
      for (const list of perGame.values()) allTombstones.push(...list);
    };

    for (const id of orderedIds) {
      const b = bIndex.get(id);
      const l = lIndex.get(id);
      const i = iIndex.get(id);
      let winner = null;

      if (l && i) {
        winner = "both";
      } else if (l && !i) {
        // 本页留着、另一页删了整张卡：只有本页相对 base 没动过时才接受删除
        const localChanged = !gameUnchangedByUser(l, b);
        winner = localChanged ? "local" : null;
      } else if (i && !l) {
        const incomingChanged = !gameUnchangedByUser(i, b);
        winner = incomingChanged ? "incoming" : null;
      }
      // 两边都没有：整卡已在双方账本中删除，不保留

      if (winner === "both") {
        const mergedGame = mergeGameFields(b, l, i);
        mergedGame.rules = {};
        for (const section of RULE_SECTIONS) {
          const result = mergeSection(
            id,
            section,
            b ? b.rules[section] : [],
            l.rules[section],
            i.rules[section],
            bTombs.get(id)?.get(section),
            lTombs.get(id)?.get(section),
            iTombs.get(id)?.get(section),
            now
          );
          mergedGame.rules[section] = result.entries;
          allTombstones.push(...result.tombstones);
        }
        carrySideTombs(lTombs, id);
        carrySideTombs(iTombs, id);
        carrySideTombs(bTombs, id);
        games.push(mergedGame);
      } else if (winner === "local") {
        games.push(clone(l));
        carrySideTombs(lTombs, id);
      } else if (winner === "incoming") {
        games.push(clone(i));
        carrySideTombs(iTombs, id);
      }
      // winner === null：整张卡被删除（或两页都没有），其墓碑随卡片一起清掉
    }

    const liveIds = new Set();
    for (const game of games) {
      for (const section of RULE_SECTIONS) {
        for (const entry of game.rules[section]) liveIds.add(entry.id);
      }
    }
    const gameIds = new Set(games.map((g) => g.id));
    const tombIndex = new Map();
    for (const tomb of allTombstones) {
      if (!gameIds.has(tomb.gameId) || liveIds.has(tomb.id)) continue;
      const existing = tombIndex.get(tomb.id);
      if (!existing || tomb.updatedAt > existing.updatedAt) tombIndex.set(tomb.id, clone(tomb));
    }

    return {
      version: VERSION,
      selectedId: field3(base.selectedId || "", local.selectedId || "", incoming.selectedId || "") || "",
      games,
      tombstones: Object.fromEntries([...tombIndex.values()].map((t) => [t.id, t]))
    };
  }

  function countConflicts(state) {
    let count = 0;
    for (const game of state.games || []) {
      for (const section of RULE_SECTIONS) {
        for (const entry of game.rules[section]) if (isConflictEntry(entry)) count += 1;
      }
    }
    return count;
  }

  // ---------- 容量降级与完整备份 ----------

  function lastPlayedTime(game) {
    const time = new Date(`${game.lastPlayed}T00:00:00`).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  // 尝试写入主账；配额不够时，按"最久未玩"顺序一张张把封面降级成占位。
  // 同时保证"完整备份"放得下：备份会保留刚被剥下的封面；若仍超配额，
  // 就继续剥更老的封面（主账和备份一起降级），直到两份都能落盘。
  function persistBoth(storage, desired, previous, now, saveAt) {
    const work = normalizeState(clone(desired));
    const degraded = [];
    const removedCovers = {};

    const trySet = (key, value) => {
      try {
        storage.setItem(key, value);
        return true;
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        return false;
      }
    };

    const pruneOldTombs = (s) => {
      const cutoff = now - TOMB_TTL_MS;
      let changed = false;
      for (const [id, tomb] of Object.entries(s.tombstones)) {
        if (tomb.updatedAt < cutoff) {
          delete s.tombstones[id];
          changed = true;
        }
      }
      return changed;
    };

    const buildSerial = (backupState) => ({
      main: JSON.stringify(work),
      backup: JSON.stringify({ savedAt: saveAt || now, state: backupState })
    });

    // 候选封面：主账里还在的封面优先剥；如果备份仍放不下，连上次保留在备份里的
    // 完整封面也要放弃（旧封面优先，规则文字始终保留）。
    const candidates = () => {
      const list = work.games
        .filter((g) => g.cover)
        .map((g) => ({ id: g.id, cover: g.cover, lastPlayed: lastPlayedTime(g), phase: 0 }));
      const backupState = buildBackupState(previous, work);
      fillStrippedCovers(backupState, removedCovers);
      const mainIds = new Set(list.map((g) => g.id));
      for (const g of backupState.games) {
        if (g.cover && !mainIds.has(g.id) && !removedCovers[g.id]) {
          list.push({ id: g.id, cover: g.cover, lastPlayed: lastPlayedTime(g), phase: 1 });
        }
      }
      return list.sort((a, b) => a.phase - b.phase || a.lastPlayed - b.lastPlayed || (a.id < b.id ? -1 : 1));
    };

    const writeBoth = () => {
      const backupState = buildBackupState(previous, work);
      fillStrippedCovers(backupState, removedCovers);
      const serial = buildSerial(backupState);
      if (trySet(MAIN_KEY, serial.main) && trySet(BACKUP_KEY, serial.backup)) {
        return { ok: true, state: work, serialized: serial.main, degraded, removedCovers, backupState };
      }
      return { ok: false };
    };

    let attempt = writeBoth();
    if (attempt.ok) return attempt;

    for (const candidate of candidates()) {
      const target = work.games.find((g) => g.id === candidate.id);
      if (target && target.cover) {
        // 剥主账里的封面：记入 removedCovers，备份仍保留这份完整封面
        removedCovers[target.id] = target.cover;
        target.cover = "";
        target.coverDegraded = true;
        degraded.push(target.id);
      } else {
        // 主账早已剥完、只在备份里的封面：配额仍不够时放弃这份备份封面
        delete removedCovers[candidate.id];
        if (target) target.coverDegraded = true;
      }
      attempt = writeBoth();
      if (attempt.ok) return attempt;
    }

    // 全部封面都降级后还放不下：清理过期墓碑（最后手段，规则文字一字不动）
    if (pruneOldTombs(work)) {
      attempt = writeBoth();
      if (attempt.ok) return attempt;
    }

    return { ok: false, state: work, degraded, removedCovers };
  }

  function readBackup(storage, uuid, now) {
    const text = storage.getItem(BACKUP_KEY);
    if (!text) return null;
    try {
      const raw = JSON.parse(text);
      const state = raw && raw.state ? migrate(raw.state, uuid, now) : migrate(raw, uuid, now);
      return { savedAt: raw && raw.savedAt ? raw.savedAt : null, state };
    } catch {
      return null;
    }
  }

  // 备份保持"完整"：被降级的封面用上次完整备份里的封面补回，规则等内容始终用最新
  function buildBackupState(previous, current) {
    const backup = normalizeState(clone(current));
    if (previous) {
      const oldGames = new Map(previous.state.games.map((g) => [g.id, g]));
      for (const game of backup.games) {
        if (!game.cover && game.coverDegraded) {
          const old = oldGames.get(game.id);
          if (old && old.cover) {
            game.cover = old.cover;
            game.coverDegraded = false;
          }
        }
      }
    }
    return backup;
  }

  function fillStrippedCovers(backupState, removedCovers) {
    const index = new Map(backupState.games.map((g) => [g.id, g]));
    for (const [gameId, cover] of Object.entries(removedCovers || {})) {
      const game = index.get(gameId);
      if (game && cover) {
        game.cover = cover;
        game.coverDegraded = false;
      }
    }
  }

  // ---------- Store ----------

  class LedgerStore {
    constructor(options = {}) {
      this.storage = options.storage || (typeof localStorage !== "undefined" ? localStorage : null);
      this.uuid = options.uuid || defaultUuid;
      this.now = options.now || defaultNow;
      this.onNotice = options.onNotice || (() => {});
      this.state = null;
      this.base = null;
      this.lastWritten = "";
      this.saveError = false;
    }

    emit(notice) {
      this.onNotice({ id: this.uuid(), ...notice });
    }

    load() {
      const mainText = this.storage.getItem(MAIN_KEY);
      let state = null;
      let migrated = false;
      let recovered = false;

      if (mainText == null) {
        state = createDefaultState(this.uuid, this.now());
      } else {
        try {
          const parsed = JSON.parse(mainText);
          migrated = !(parsed && parsed.version >= VERSION);
          state = migrate(parsed, this.uuid, this.now());
        } catch {
          const backup = readBackup(this.storage, this.uuid, this.now());
          if (backup) {
            state = backup.state;
            recovered = true;
          } else {
            state = createDefaultState(this.uuid, this.now());
            recovered = true;
          }
        }
      }

      this.state = state;
      const previous = readBackup(this.storage, this.uuid, this.now());
      const result = persistBoth(this.storage, this.state, previous, this.now());
      if (result.ok) {
        this.state = result.state;
        this.base = clone(result.state);
        this.lastWritten = result.serialized;
      } else {
        // 连首次写入都失败：内存里照常使用，等用户操作时重试
        this.base = clone(this.state);
        this.saveError = true;
      }

      if (recovered) this.emit({ kind: "recovered", message: "主账无法读取，已用上次完整备份恢复。" });
      if (migrated) this.emit({ kind: "migrated", message: "旧版数据已升级：为每条规则补齐了编号。" });
      if (result.degraded.length) {
        this.emit({ kind: "degraded", degraded: result.degraded, message: this.degradedMessage(result.degraded) });
      }
      if (!result.ok) this.emitSaveError();
      return { migrated, recovered };
    }

    degradedMessage(ids) {
      const names = ids
        .map((id) => this.state.games.find((g) => g.id === id)?.name)
        .filter(Boolean)
        .join("、");
      return `存储空间不足，已把 ${names || ids.length} 款桌游的旧封面降级成占位，规则文字全部保留。`;
    }

    emitSaveError() {
      this.saveError = true;
      this.emit({
        kind: "saveError",
        sticky: true,
        message: "保存失败：浏览器存储容量不足，本次改动还在本页内存里。可重试保存，或用上次完整内容恢复。"
      });
    }

    commit() {
      const previous = readBackup(this.storage, this.uuid, this.now());
      const result = persistBoth(this.storage, this.state, previous, this.now());
      if (!result.ok) {
        this.emitSaveError();
        return result;
      }
      this.state = result.state;
      this.base = clone(result.state);
      this.lastWritten = result.serialized;
      this.saveError = false;

      if (result.degraded.length) {
        this.emit({ kind: "degraded", degraded: result.degraded, message: this.degradedMessage(result.degraded) });
      }
      return result;
    }

    // 收到另一个页面写入的账本：三路合并后落盘
    sync(serialized) {
      if (serialized == null || serialized === this.lastWritten) return { merged: false };
      let incoming;
      try {
        incoming = parseStored(serialized, this.uuid, this.now());
      } catch {
        return { merged: false };
      }
      const beforeConflicts = countConflicts(this.state);
      const merged = mergeStates(this.base, this.state, incoming, this.now());
      this.state = merged;
      const result = this.commit();
      const conflictCount = countConflicts(merged);
      if (conflictCount > beforeConflicts) {
        this.emit({
          kind: "conflicts",
          count: conflictCount,
          message: `合并另一页面的改动后有 ${conflictCount} 条规则两边都动过，已留下两份并标出冲突，请在卡片上裁决。`
        });
      }
      return { merged: true, ...result };
    }

    retrySave() {
      const result = this.commit();
      return result;
    }

    restoreBackup() {
      const backup = readBackup(this.storage, this.uuid, this.now());
      if (!backup) return false;
      // 以这份完整备份本身作为"上次完整内容"，恢复后备份保持不变
      const result = persistBoth(this.storage, backup.state, backup, this.now());
      if (!result.ok) {
        this.emitSaveError();
        return false;
      }
      this.state = result.state;
      this.base = clone(result.state);
      this.lastWritten = result.serialized;
      this.saveError = false;
      this.emit({ kind: "restored", message: "已用上一次完整内容恢复整本账。" });
      if (result.degraded.length) {
        this.emit({ kind: "degraded", degraded: result.degraded, message: this.degradedMessage(result.degraded) });
      }
      return true;
    }
  }

  return {
    MAIN_KEY,
    BACKUP_KEY,
    VERSION,
    RULE_SECTIONS,
    createDefaultState,
    migrate,
    migrateV1,
    normalizeState,
    parseStored,
    deterministicId,
    makeEntry,
    makeTomb,
    isConflictEntry,
    entryTexts,
    mergeStates,
    mergeSection,
    countConflicts,
    persistBoth,
    readBackup,
    buildBackupState,
    fillStrippedCovers,
    LedgerStore
  };
});
