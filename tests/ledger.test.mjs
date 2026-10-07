import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../ledger.js");

const NOW = 1_700_000_000_000;
let counter = 0;
const fixedUuid = () => `uuid-${(counter += 1)}`;
const fixedNow = () => NOW;

// 可配额限制的内存 storage
function fakeStorage(limit = Infinity) {
  const map = new Map();
  const storage = {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    setItem(k, v) {
      const value = String(v);
      const size = [...map.entries()].reduce((sum, [key, val]) => sum + key.length + val.length, 0) - (map.get(k)?.length || 0);
      if (size + k.length + value.length > limit) {
        const error = new Error("quota");
        error.name = "QuotaExceededError";
        throw error;
      }
      map.set(k, value);
    }
  };
  storage._map = map;
  return storage;
}

function seedState() {
  return L.normalizeState(
    {
      version: 2,
      selectedId: "g1",
      games: [
        {
          id: "g1",
          name: "奥尔良",
          minPlayers: 2,
          maxPlayers: 4,
          duration: 90,
          complexity: "中",
          lastPlayed: "2025-11-20",
          cover: "",
          updatedAt: 100,
          rules: {
            forgets: [
              { id: "r1", text: "遗忘点A", updatedAt: 100 },
              { id: "r2", text: "遗忘点B", updatedAt: 100 }
            ],
            disputes: [{ id: "r3", text: "争议C", updatedAt: 100 }],
            setup: [],
            scoring: []
          }
        }
      ],
      tombstones: {}
    },
    fixedUuid,
    fixedNow()
  );
}

function findEntry(state, gameId, section, ruleId) {
  const game = state.games.find((g) => g.id === gameId);
  return game.rules[section].find((e) => e.id === ruleId);
}

const edit = (state, gameId, section, ruleId, text, time) => {
  const entry = findEntry(state, gameId, section, ruleId);
  entry.text = text;
  entry.updatedAt = time;
};

const remove = (state, ruleId, gameId = "g1", section = "forgets", time = 200) => {
  const game = state.games.find((g) => g.id === gameId);
  game.rules[section] = game.rules[section].filter((e) => e.id !== ruleId);
  state.tombstones[ruleId] = L.makeTomb(ruleId, gameId, section, time);
};

const add = (state, text, ruleId, gameId = "g1", section = "forgets", time = 200) => {
  const game = state.games.find((g) => g.id === gameId);
  game.rules[section].push({ id: ruleId, text, updatedAt: time });
};

test("v1 旧数据升级：字符串条目补齐编号，同内容在两页面算出相同编号", () => {
  const v1 = {
    selectedId: "g1",
    games: [
      {
        id: "g1",
        name: "奥尔良",
        minPlayers: 2,
        maxPlayers: 4,
        duration: 90,
        complexity: "中",
        lastPlayed: "2025-11-20",
        cover: "",
        forgets: ["规则甲", "规则乙"],
        disputes: ["争议甲"],
        setup: [],
        scoring: []
      }
    ]
  };
  counter = 0;
  const a = L.migrate(v1, fixedUuid, fixedNow());
  counter = 100;
  const b = L.migrate(v1, fixedUuid, fixedNow());
  assert.equal(a.version, 2);
  assert.equal(a.games[0].rules.forgets[0].id, b.games[0].rules.forgets[0].id);
  assert.equal(a.games[0].rules.forgets[1].id, b.games[0].rules.forgets[1].id);
  assert.notEqual(a.games[0].rules.forgets[0].id, a.games[0].rules.forgets[1].id);
  assert.equal(a.games[0].rules.forgets[0].text, "规则甲");
});

test("两个页面各自新增不同条目：合并后两条都在", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  add(local, "本页新增", "rL");
  add(incoming, "另一页新增", "rI");
  const merged = L.mergeStates(base, local, incoming, NOW);
  const texts = merged.games[0].rules.forgets.map((e) => e.text);
  assert.deepEqual(texts.sort(), ["另一页新增", "本页新增", "遗忘点A", "遗忘点B"]);
});

test("同一条两边都编辑：留下两份并标出冲突", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  edit(local, "g1", "forgets", "r1", "主持改的版本", 201);
  edit(incoming, "g1", "forgets", "r1", "场务改的版本", 202);
  const merged = L.mergeStates(base, local, incoming, NOW);
  const entry = findEntry(merged, "g1", "forgets", "r1");
  assert.equal(L.isConflictEntry(entry), true);
  const texts = L.entryTexts(entry);
  assert.deepEqual(texts.sort(), ["主持改的版本", "场务改的版本"]);
  assert.equal(L.countConflicts(merged), 1);
});

test("一边删除另一边未动：删除生效且产生墓碑", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  remove(local, "r1", "g1", "forgets", 210);
  const merged = L.mergeStates(base, local, incoming, NOW);
  assert.equal(findEntry(merged, "g1", "forgets", "r1"), undefined);
  assert.deepEqual(merged.tombstones.r1, { id: "r1", gameId: "g1", section: "forgets", updatedAt: 210 });
});

test("移除的条目不会因为另一边还留着又冒出来（模拟真实事件流）", () => {
  const base = seedState();
  const afterDelete = JSON.parse(JSON.stringify(base));
  remove(afterDelete, "r1", "g1", "forgets", 210);

  // 另一页基于旧 base，先收到删除页的写入事件并合并
  const merged1 = L.mergeStates(base, base, afterDelete, NOW);
  assert.equal(findEntry(merged1, "g1", "forgets", "r1"), undefined);
  assert.ok(merged1.tombstones.r1);

  // 该页在合并后的状态上新增别的内容并保存，r1 必须保持删除状态
  const newest = JSON.parse(JSON.stringify(merged1));
  add(newest, "新增条目", "rNew", "g1", "forgets", 300);
  const merged2 = L.mergeStates(merged1, merged1, newest, NOW);
  assert.equal(findEntry(merged2, "g1", "forgets", "r1"), undefined);
  assert.ok(merged2.tombstones.r1);
  assert.ok(findEntry(merged2, "g1", "forgets", "rNew"));

  // 再来一轮，任何页面的账本里 r1 都不会复活
  const newest2 = JSON.parse(JSON.stringify(merged2));
  add(newest2, "又一条", "rNew2", "g1", "forgets", 400);
  const merged3 = L.mergeStates(merged2, merged2, newest2, NOW);
  assert.equal(findEntry(merged3, "g1", "forgets", "r1"), undefined);
});

test("一边删除、另一边编辑同一条：保留编辑版并标记删除冲突", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  remove(local, "r1", "g1", "forgets", 210);
  edit(incoming, "g1", "forgets", "r1", "场务补的修订", 220);
  const merged = L.mergeStates(base, local, incoming, NOW);
  const entry = findEntry(merged, "g1", "forgets", "r1");
  assert.ok(entry, "编辑过的版本应保留，等用户裁决");
  assert.equal(L.isConflictEntry(entry), true);
  const versions = entry.versions;
  assert.ok(versions.some((v) => v.deleted === true), "删除版本也要列出");
  assert.ok(versions.some((v) => v.text === "场务补的修订"));
});

test("两边编辑成相同内容：不产生冲突", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  edit(local, "g1", "forgets", "r1", "一致的新文本", 201);
  edit(incoming, "g1", "forgets", "r1", "一致的新文本", 202);
  const merged = L.mergeStates(base, local, incoming, NOW);
  const entry = findEntry(merged, "g1", "forgets", "r1");
  assert.equal(L.isConflictEntry(entry), false);
  assert.equal(entry.text, "一致的新文本");
});

test("冲突保留两份后，两个页面都选同一边：冲突消除", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  edit(local, "g1", "forgets", "r1", "版本一", 201);
  edit(incoming, "g1", "forgets", "r1", "版本二", 202);
  const conflictState = L.mergeStates(base, local, incoming, NOW);
  const conflict = findEntry(conflictState, "g1", "forgets", "r1");
  assert.ok(conflict.versions);

  const resolve = (state) => {
    const entry = findEntry(state, "g1", "forgets", "r1");
    const picked = entry.versions.filter((v) => !v.deleted).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    delete entry.versions;
    delete entry.conflict;
    entry.text = picked.text;
    entry.updatedAt = 300;
  };
  const resolvedLocal = JSON.parse(JSON.stringify(conflictState));
  const resolvedIncoming = JSON.parse(JSON.stringify(conflictState));
  resolve(resolvedLocal);
  resolve(resolvedIncoming);
  const merged = L.mergeStates(conflictState, resolvedLocal, resolvedIncoming, NOW);
  const entry = findEntry(merged, "g1", "forgets", "r1");
  assert.equal(L.isConflictEntry(entry), false);
  assert.equal(entry.text, "版本二");
});

test("整卡一边删除、另一边在加规则：保留另一页修改后的卡片", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  local.games = local.games.filter((g) => g.id !== "g1");
  add(incoming, "场务刚加的", "rNew");
  const merged = L.mergeStates(base, local, incoming, NOW);
  assert.equal(merged.games.length, 1);
  assert.ok(findEntry(merged, "g1", "forgets", "rNew"));
});

test("整卡两边都删：不保留", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  local.games = [];
  incoming.games = [];
  const merged = L.mergeStates(base, local, incoming, NOW);
  assert.equal(merged.games.length, 0);
  assert.deepEqual(merged.tombstones, {});
});

test("容量不足：先降级最久未玩的封面，规则文字完整保留，主账和备份都能落盘", () => {
  const state = seedState();
  state.games[0].cover = "data:image/png;base64," + "x".repeat(2000);
  state.games[0].lastPlayed = "2025-11-20";
  state.games.push({
    id: "g2",
    name: "新玩的",
    minPlayers: 1,
    maxPlayers: 4,
    duration: 60,
    complexity: "轻",
    lastPlayed: "2026-05-01",
    cover: "data:image/png;base64," + "y".repeat(2000),
    coverDegraded: false,
    updatedAt: 100,
    rules: { forgets: [{ id: "g2r", text: "新玩的规则", updatedAt: 100 }], disputes: [], setup: [], scoring: [] }
  });
  const storage = fakeStorage(8000);
  const result = L.persistBoth(storage, state, null, NOW);
  assert.equal(result.ok, true);
  assert.ok(result.degraded.includes("g1"), "最久未玩的 g1 封面先被降级");
  const saved = JSON.parse(storage.getItem(L.MAIN_KEY));
  const g1 = saved.games.find((g) => g.id === "g1");
  assert.equal(g1.cover, "");
  assert.equal(g1.coverDegraded, true);
  assert.equal(g1.rules.forgets.length, 2);
  // 备份必须写成功
  assert.ok(storage.getItem(L.BACKUP_KEY));
  const backup = JSON.parse(storage.getItem(L.BACKUP_KEY)).state;
  const backupG1 = backup.games.find((g) => g.id === "g1");
  assert.equal(
    backupG1.cover,
    "data:image/png;base64," + "x".repeat(2000),
    "备份里保留刚剥下的完整封面"
  );
  assert.equal(backup.games.find((g) => g.id === "g1").rules.forgets.length, 2);
});

test("备份始终包含最新规则；封面在主账被多轮降级后仍能从备份取回", () => {
  const storage = fakeStorage(Infinity);
  const initial = seedState();
  initial.games[0].cover = "data:image/png;base64,FULL-COVER";
  const first = L.persistBoth(storage, initial, null, NOW);
  assert.equal(first.ok, true);
  const backup1 = JSON.parse(storage.getItem(L.BACKUP_KEY)).state;
  assert.equal(backup1.games[0].cover, "data:image/png;base64,FULL-COVER");

  // 存储吃紧：总配额只够"无封面主账 + 含一份封面的备份"，放不下两份封面
  const noCoverMain = first.serialized.replaceAll("data:image/png;base64,FULL-COVER", "");
  const backupRaw = storage.getItem(L.BACKUP_KEY);
  const quotaBytes = noCoverMain.length + backupRaw.length + 200;
  const capMap = new Map();
  const limited = {
    getItem: (k) => (capMap.has(k) ? capMap.get(k) : null),
    removeItem: (k) => capMap.delete(k),
    setItem(k, v) {
      const value = String(v);
      const otherSize = [...capMap.entries()].reduce((sum, [kk, vv]) => (kk === k ? sum : sum + kk.length + vv.length), 0);
      if (otherSize + k.length + value.length > quotaBytes) {
        const error = new Error("quota");
        error.name = "QuotaExceededError";
        throw error;
      }
      capMap.set(k, value);
    }
  };
  // 把已有的完整备份带进受限环境
  capMap.set(L.BACKUP_KEY, backupRaw);

  const degradedState = JSON.parse(JSON.stringify(first.state));
  degradedState.games[0].rules.forgets.push({ id: "r9", text: "容量紧张时新加的规则", updatedAt: NOW });
  const previous = L.readBackup(limited, fixedUuid, fixedNow());
  const result = L.persistBoth(limited, degradedState, previous, NOW);
  assert.equal(result.ok, true);
  assert.ok(result.degraded.includes(degradedState.games[0].id), "主账封面被降级");
  assert.equal(result.state.games[0].cover, "");

  const backupAfter = JSON.parse(limited.getItem(L.BACKUP_KEY)).state;
  assert.equal(backupAfter.games[0].cover, "data:image/png;base64,FULL-COVER", "备份仍有完整封面");
  assert.ok(backupAfter.games[0].rules.forgets.some((e) => e.text === "容量紧张时新加的规则"), "备份规则是最新的");

  // 恢复：从备份拿回完整封面 + 最新规则
  const restored = L.readBackup(limited, fixedUuid, fixedNow()).state;
  assert.equal(restored.games[0].cover, "data:image/png;base64,FULL-COVER");
  assert.ok(restored.games[0].rules.forgets.some((e) => e.text === "容量紧张时新加的规则"));
});

test("主账损坏时用上次完整备份恢复", () => {
  const storage = fakeStorage();
  const state = seedState();
  storage.setItem(L.MAIN_KEY, JSON.stringify(state));
  storage.setItem(L.BACKUP_KEY, JSON.stringify({ savedAt: NOW, state }));
  storage.setItem(L.MAIN_KEY, "{损坏的JSON");

  const notices = [];
  const store = new L.LedgerStore({ storage, uuid: fixedUuid, now: fixedNow, onNotice: (n) => notices.push(n) });
  store.load();
  assert.equal(store.state.games.length, 1);
  assert.equal(store.state.games[0].name, "奥尔良");
  assert.ok(notices.some((n) => n.kind === "recovered"));
});

test("保存失败后重试：配额恢复时成功落盘", () => {
  const storage = fakeStorage();
  const store = new L.LedgerStore({ storage, uuid: fixedUuid, now: fixedNow });
  store.load();
  store.state.games[0].cover = "data:image/png;base64," + "z".repeat(5000);

  // 让存储一直爆满
  const originalSet = storage.setItem.bind(storage);
  storage.setItem = function (k, v) {
    if (k === L.MAIN_KEY && String(v).length > 1000) {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    }
    return originalSet(k, v);
  };
  const failed = store.commit();
  assert.equal(failed.ok, false);
  assert.equal(store.saveError, true);

  // 封面清空后（相当于容量恢复），重试成功
  storage.setItem = originalSet;
  store.state.games[0].cover = "";
  const retried = store.retrySave();
  assert.equal(retried.ok, true);
  assert.equal(store.saveError, false);
});

test("restoreBackup：主账被意外改坏后用上一次完整内容恢复", () => {
  const storage = fakeStorage();
  const backupState = seedState();
  storage.setItem(L.BACKUP_KEY, JSON.stringify({ savedAt: NOW, state: backupState }));
  // 主账写入半截损坏了，备份仍是上次完整内容
  storage.setItem(L.MAIN_KEY, "{主账损坏");

  const store = new L.LedgerStore({ storage, uuid: fixedUuid, now: fixedNow });
  const loaded = store.load();
  assert.equal(loaded.recovered, true);
  assert.equal(store.state.games.length, 1, "加载时就应回退到完整备份");
  assert.equal(store.state.games[0].name, "奥尔良");

  // 用户也可显式再恢复一次，结果同样是完整内容
  const ok = store.restoreBackup();
  assert.equal(ok, true);
  assert.equal(store.state.games.length, 1);
  const main = JSON.parse(storage.getItem(L.MAIN_KEY));
  assert.equal(main.games[0].name, "奥尔良");
});

test("合并满足交换律和幂等：多个页面反复同步不会漂移", () => {
  const base = seedState();
  const local = JSON.parse(JSON.stringify(base));
  const incoming = JSON.parse(JSON.stringify(base));
  // local：改 r1 + 新增 rL
  edit(local, "g1", "forgets", "r1", "主持版", 200);
  add(local, "本页新增", "rL", "g1", "forgets", 200);
  // incoming：改 r1 成别的 + 删除 r2
  edit(incoming, "g1", "forgets", "r1", "场务版", 300);
  remove(incoming, "r2", "g1", "forgets", 300);

  const mAB = L.mergeStates(base, local, incoming, NOW);
  const mBA = L.mergeStates(base, incoming, local, NOW);
  assert.equal(JSON.stringify(mAB), JSON.stringify(mBA), "交换两个页面的位置结果一致");

  // 之后所有页面都基于合并结果，再反复互相同步多轮
  let current = mAB;
  for (let k = 0; k < 5; k += 1) {
    current = L.mergeStates(current, JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(current)), NOW);
  }
  assert.equal(JSON.stringify(current), JSON.stringify(mAB), "反复同步结果幂等不漂移");
  assert.equal(L.isConflictEntry(findEntry(current, "g1", "forgets", "r1")), true);
  assert.ok(!current.games[0].rules.forgets.some((e) => e.id === "r2"));
  assert.ok(current.tombstones.r2);
  assert.ok(current.games[0].rules.forgets.some((e) => e.id === "rL"));
});

test("两个 LedgerStore 模拟两个页面：合并、墓碑和冲突都对上", () => {
  const storage = fakeStorage();
  let seq = 0;
  const uuid = () => `u${(seq += 1)}`;
  const tabA = new L.LedgerStore({ storage, uuid, now: () => 1000 });
  const tabB = new L.LedgerStore({ storage, uuid, now: () => 1000 });
  tabA.load();
  tabB.load();

  const gid = tabA.state.games[0].id;
  const rid = tabA.state.games[0].rules.forgets[0].id;

  // A 删除一条；B 编辑同一条
  const removeInTab = (store) => {
    const game = store.state.games.find((g) => g.id === gid);
    game.rules.forgets = game.rules.forgets.filter((e) => e.id !== rid);
    store.state.tombstones[rid] = { id: rid, gameId: gid, section: "forgets", updatedAt: 1100 };
  };
  removeInTab(tabA);
  tabA.commit();

  const gameB = tabB.state.games.find((g) => g.id === gid);
  gameB.rules.forgets[0].text = "B 页面改的";
  gameB.rules.forgets[0].updatedAt = 1200;

  // B 收到 A 写入的事件
  const noticesB = [];
  tabB.onNotice = (n) => noticesB.push(n);
  tabB.sync(storage.getItem(L.MAIN_KEY));
  // 同步时 B 的本地编辑也一并提交了
  const entry = tabB.state.games.find((g) => g.id === gid).rules.forgets.find((e) => e.id === rid);
  assert.ok(L.isConflictEntry(entry), "删改冲突应保留两份");
  assert.ok(noticesB.some((n) => n.kind === "conflicts"));

  // A 随后收到 B 合并后的结果，两边完全一致
  tabA.sync(storage.getItem(L.MAIN_KEY));
  assert.deepEqual(JSON.parse(JSON.stringify(tabA.state)), JSON.parse(JSON.stringify(tabB.state)));
});
