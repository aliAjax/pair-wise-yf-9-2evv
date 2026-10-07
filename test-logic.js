// 测试三路合并、编号补齐、墓碑删除、容量降级与恢复。
// 用 vm 在模拟浏览器环境里加载 app.js，导出内部函数做单元测试，
// 再通过 localStorage 与 storage 事件做集成测试。
const vm = require("vm");
const assert = require("assert");
const fs = require("fs");

class MockElement {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.files = [];
    this._dataset = {};
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener() {}
  closest() {
    return null;
  }
  querySelector() {
    return new MockElement();
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
  select() {}
  click() {}
  get dataset() {
    return this._dataset;
  }
  set dataset(v) {
    this._dataset = v;
  }
}

function createEnv() {
  const store = new Map();
  let quotaOnCover = false;
  const localStorageMock = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      if (quotaOnCover && value.includes("data:image")) {
        const err = new Error("quota");
        err.name = "QuotaExceededError";
        err.code = 22;
        throw err;
      }
      store.set(key, value);
    },
    removeItem: (key) => store.delete(key),
    _setQuotaOnCover: (v) => {
      quotaOnCover = v;
    }
  };

  const elementCache = new Map();
  const documentMock = {
    listeners: {},
    querySelector(sel) {
      if (!elementCache.has(sel)) elementCache.set(sel, new MockElement());
      return elementCache.get(sel);
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
  };

  const windowMock = {
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
  };

  const context = {
    localStorage: localStorageMock,
    document: documentMock,
    window: windowMock,
    console,
    crypto: require("crypto").webcrypto,
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    Date,
    JSON,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    Math,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    parseInt: global.parseInt,
    parseFloat: global.parseFloat
  };
  context.globalThis = context;
  vm.createContext(context);

  return {
    context,
    store,
    localStorageMock,
    documentMock,
    windowMock,
    runApp: () => {
      const code =
        fs.readFileSync("/workspace/app.js", "utf8") +
        "\n;this.__test = { mergeEntries, mergeState, mergeGames, migrateState, makeEntry, liveEntries, isQuotaError, isLiveEntry, getState: () => state, getLastSaved: () => lastSavedState };";
      vm.runInContext(code, context);
    },
    getState: () => JSON.parse(store.get("zfl18-boardgame-rule-cards")),
    setRaw: (value) => store.set("zfl18-boardgame-rule-cards", value),
    dispatchStorage: (newValue) => {
      const handlers = windowMock.listeners.storage || [];
      for (const h of handlers) h({ key: "zfl18-boardgame-rule-cards", newValue });
    }
  };
}

let passed = 0;
function test(name, fn) {
  const env = createEnv();
  fn(env);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function liveTexts(game, key) {
  return game[key].filter((e) => !e.removed).map((e) => e.text);
}

console.log("迁移与编号补齐");

test("旧字符串数组升级为带编号的条目", (env) => {
  env.setRaw(JSON.stringify({
    selectedId: "",
    games: [{
      id: "g1", name: "旧游戏", minPlayers: 2, maxPlayers: 4, duration: 60,
      complexity: "中", lastPlayed: "2025-01-01", cover: "",
      forgets: ["旧规则一", "旧规则二"],
      disputes: [], setup: ["准备"], scoring: []
    }]
  }));
  env.runApp();
  const state = env.getState();
  const g = state.games[0];
  assert.strictEqual(g.name, "旧游戏");
  assert.strictEqual(g.forgets.length, 2);
  assert.ok(g.forgets[0].id, "每条规则应有编号");
  assert.strictEqual(g.forgets[0].text, "旧规则一");
  assert.strictEqual(g.forgets[1].text, "旧规则二");
  assert.ok(g.forgets[0].id !== g.forgets[1].id, "编号应不同");
  assert.strictEqual(g.setup[0].text, "准备");
});

test("已是条目对象的数据保留编号", (env) => {
  env.setRaw(JSON.stringify({
    selectedId: "",
    games: [{
      id: "g1", name: "游戏", minPlayers: 2, maxPlayers: 4, duration: 60,
      complexity: "中", lastPlayed: "2025-01-01", cover: "",
      forgets: [{ id: "fixed-id", text: "规则" }],
      disputes: [], setup: [], scoring: []
    }]
  }));
  env.runApp();
  const g = env.getState().games[0];
  assert.strictEqual(g.forgets[0].id, "fixed-id");
  assert.strictEqual(g.forgets[0].text, "规则");
});

console.log("逐条合并（单元）");

test("两边各改同一条 -> 两份并标冲突", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "x", text: "A版本", base: "原文" }];
  const remote = [{ id: "x", text: "B版本", base: "原文" }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 2, "应留下两份");
  assert.ok(result.every((e) => e.conflict), "两份都应标冲突");
  assert.ok(result.some((e) => e.text === "A版本"));
  assert.ok(result.some((e) => e.text === "B版本"));
});

test("两边改后内容相同 -> 只留一份", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "x", text: "相同", base: "原文" }];
  const remote = [{ id: "x", text: "相同", base: "原文" }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, "相同");
  assert.ok(!result[0].conflict);
});

test("只有一边改 -> 取改过的", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "x", text: "原文", base: "原文" }];
  const remote = [{ id: "x", text: "B版本", base: "原文" }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, "B版本");
});

test("本页删除、对页没动 -> 保持删除并留墓碑", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "x", text: "原文", base: "原文", removed: true }];
  const remote = [{ id: "x", text: "原文", base: "原文" }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1, "应保留墓碑，防止对页旧副本让它冒出来");
  assert.ok(result[0].removed);
});

test("对页删除、本页没动 -> 保持删除并留墓碑", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "x", text: "原文", base: "原文" }];
  const remote = [{ id: "x", text: "原文", base: "原文", removed: true }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1, "应保留墓碑");
  assert.ok(result[0].removed);
});

test("本页删除、对页改过 -> 保住对页内容并标冲突", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "x", text: "原文", base: "原文", removed: true }];
  const remote = [{ id: "x", text: "B版本", base: "原文" }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, "B版本");
  assert.ok(result[0].conflict);
});

test("对页删除、本页改过 -> 保住本页内容并标冲突", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "x", text: "A版本", base: "原文" }];
  const remote = [{ id: "x", text: "原文", base: "原文", removed: true }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, "A版本");
  assert.ok(result[0].conflict);
});

test("两边都删除 -> 墓碑", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "x", text: "原文", base: "原文", removed: true }];
  const remote = [{ id: "x", text: "原文", base: "原文", removed: true }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 0);
});

test("本页新增 -> 保留", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "new", text: "新增", base: "新增" }];
  const remote = [];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, "新增");
});

test("对页新增 -> 保留", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [];
  const remote = [{ id: "new", text: "新增", base: "新增" }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, "新增");
});

test("两边新增不同条目 -> 都保留", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  const local = [{ id: "a", text: "A新增", base: "A新增" }];
  const remote = [{ id: "b", text: "B新增", base: "B新增" }];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 2);
  assert.ok(result.some((e) => e.text === "A新增"));
  assert.ok(result.some((e) => e.text === "B新增"));
});

test("对页从不知道本页有条目 -> 本页条目保留（不会被当成对页删除）", (env) => {
  env.runApp();
  const { mergeEntries } = env.context.__test;
  // 本页有一条，对页列表里根本没有这条（对页从不知道）
  const local = [{ id: "x", text: "本页独有", base: "本页独有" }];
  const remote = [];
  const result = mergeEntries(local, remote);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, "本页独有");
});

console.log("逐条合并（集成 storage 事件）");

test("对页新增一条，合并后本页与对页条目都在", (env) => {
  env.runApp();
  const base = env.getState();
  const gameId = base.games[0].id;
  const remote = JSON.parse(JSON.stringify(base));
  remote.games[0].forgets.push({ id: "remote-new", text: "对页新增的规则", base: "对页新增的规则" });
  const remoteStr = JSON.stringify(remote);
  env.setRaw(remoteStr);
  env.dispatchStorage(remoteStr);
  const g = env.getState().games.find((x) => x.id === gameId);
  const texts = liveTexts(g, "forgets");
  assert.ok(texts.includes("对页新增的规则"));
  assert.ok(texts.includes("商站建造前先确认道路或水路连接"));
});

test("对页删除一条，合并后该条不再出现且保留墓碑", (env) => {
  env.runApp();
  const base = env.getState();
  const gameId = base.games[0].id;
  const entryId = base.games[0].forgets[0].id;
  const remote = JSON.parse(JSON.stringify(base));
  remote.games[0].forgets.find((e) => e.id === entryId).removed = true;
  const remoteStr = JSON.stringify(remote);
  env.setRaw(remoteStr);
  env.dispatchStorage(remoteStr);
  const g = env.getState().games.find((x) => x.id === gameId);
  const texts = liveTexts(g, "forgets");
  assert.ok(!texts.includes("商站建造前先确认道路或水路连接"));
  const tombstone = g.forgets.find((e) => e.id === entryId);
  assert.ok(tombstone && tombstone.removed);
});

test("连续两个对页各新增一条，合并后两条都在", (env) => {
  env.runApp();
  const base = env.getState();
  const gameId = base.games[0].id;
  const remoteA = JSON.parse(JSON.stringify(base));
  remoteA.games[0].forgets.push({ id: "remote-a", text: "对页A新增", base: "对页A新增" });
  const remoteAStr = JSON.stringify(remoteA);
  env.setRaw(remoteAStr);
  env.dispatchStorage(remoteAStr);
  // 第二个对页写入：以 base 为共同起点新增另一条（不知道 A 的新增）
  const remoteB = JSON.parse(JSON.stringify(base));
  remoteB.games[0].forgets.push({ id: "remote-b", text: "对页B新增", base: "对页B新增" });
  const remoteBStr = JSON.stringify(remoteB);
  env.setRaw(remoteBStr);
  env.dispatchStorage(remoteBStr);
  const g = env.getState().games.find((x) => x.id === gameId);
  const texts = liveTexts(g, "forgets");
  assert.ok(texts.includes("对页A新增"), "A的新增不应被B的旧基线顶掉");
  assert.ok(texts.includes("对页B新增"));
});

console.log("容量与恢复");

test("容量不足时降级旧封面、保住规则文字", (env) => {
  const coverState = {
    selectedId: "",
    games: [{
      id: "g1", name: "封面游戏", minPlayers: 2, maxPlayers: 4, duration: 60,
      complexity: "中", lastPlayed: "2025-01-01", cover: "data:image/png;base64,AAA",
      forgets: ["重要规则"], disputes: [], setup: [], scoring: []
    }]
  };
  env.setRaw(JSON.stringify(coverState));
  env.localStorageMock._setQuotaOnCover(true);
  env.runApp();
  const state = env.getState();
  assert.strictEqual(state.games[0].cover, "", "封面应降级为占位");
  assert.ok(liveTexts(state.games[0], "forgets").includes("重要规则"), "规则文字应保留");
});

test("降级后仍失败则恢复上一次完整内容", (env) => {
  const coverState = {
    selectedId: "",
    games: [{
      id: "g1", name: "封面游戏", minPlayers: 2, maxPlayers: 4, duration: 60,
      complexity: "中", lastPlayed: "2025-01-01", cover: "data:image/png;base64,AAA",
      forgets: ["重要规则"], disputes: [], setup: [], scoring: []
    }]
  };
  env.setRaw(JSON.stringify(coverState));
  env.localStorageMock.setItem = () => {
    const err = new Error("quota");
    err.name = "QuotaExceededError";
    err.code = 22;
    throw err;
  };
  env.runApp();
  const t = env.context.__test;
  // 恢复后内存中的 state 应回到上一次完整保存的内容（封面与规则文字都在）
  assert.strictEqual(t.getState().games[0].cover, "data:image/png;base64,AAA");
  assert.ok(liveTexts(t.getState().games[0], "forgets").includes("重要规则"));
  // 且与 lastSavedState 的封面、规则一致
  assert.strictEqual(t.getLastSaved().games[0].cover, "data:image/png;base64,AAA");
  assert.ok(liveTexts(t.getLastSaved().games[0], "forgets").includes("重要规则"));
});

test("非配额错误时恢复且不崩溃", (env) => {
  env.runApp();
  const base = env.getState();
  env.localStorageMock.setItem = () => {
    throw new Error("generic failure");
  };
  env.dispatchStorage(JSON.stringify(base));
  const state = env.getState();
  assert.strictEqual(state.games[0].name, base.games[0].name);
});

console.log("多页签端到端（共享 localStorage）");

test("两个页签各自新增不同规则，最终收敛且不丢条目", () => {
  // 共享同一个 store
  const store = new Map();
  const quotaOnCover = false;
  function makeEnv() {
    const localStorageMock = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, value); },
      removeItem: (key) => store.delete(key),
      _setQuotaOnCover: () => {}
    };
    const elementCache = new Map();
    const documentMock = {
      listeners: {},
      querySelector(sel) {
        if (!elementCache.has(sel)) elementCache.set(sel, new MockElement());
        return elementCache.get(sel);
      },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    };
    const windowMock = {
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    };
    const context = {
      localStorage: localStorageMock,
      document: documentMock,
      window: windowMock,
      console,
      crypto: require("crypto").webcrypto,
      structuredClone: (v) => JSON.parse(JSON.stringify(v)),
      Date, JSON, Map, Set, Object, Array, String, Number, Boolean, Error, Math,
      setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
      parseInt: global.parseInt, parseFloat: global.parseFloat
    };
    context.globalThis = context;
    vm.createContext(context);
    const code = fs.readFileSync("/workspace/app.js", "utf8");
    vm.runInContext(code, context);
    return {
      context,
      getState: () => JSON.parse(store.get("zfl18-boardgame-rule-cards")),
      setState: (v) => store.set("zfl18-boardgame-rule-cards", JSON.stringify(v)),
      dispatchStorage: (newValue) => {
        const handlers = windowMock.listeners.storage || [];
        for (const h of handlers) h({ key: "zfl18-boardgame-rule-cards", newValue });
      }
    };
  }

  const tabA = makeEnv();
  const tabB = makeEnv();
  const gameId = tabA.getState().games[0].id;

  // 页签 A 新增一条规则并写入共享存储
  const stateA = tabA.getState();
  stateA.games[0].forgets.push({ id: "from-a", text: "主持补充的规则", base: "主持补充的规则" });
  tabA.setState(stateA);
  // 页签 B 收到 A 的写入通知
  tabB.dispatchStorage(JSON.stringify(stateA));

  // 页签 B 在合并后的基础上再新增一条
  const stateB = tabB.getState();
  stateB.games[0].forgets.push({ id: "from-b", text: "场务补充的争议", base: "场务补充的争议" });
  tabB.setState(stateB);
  // 页签 A 收到 B 的写入通知
  tabA.dispatchStorage(JSON.stringify(stateB));

  // 两个页签应收敛成一致，且两条新规则都在
  const finalA = tabA.getState();
  const finalB = tabB.getState();
  assert.deepStrictEqual(finalA, finalB, "两个页签应收敛到相同状态");
  const texts = liveTexts(finalA.games.find((g) => g.id === gameId), "forgets");
  assert.ok(texts.includes("主持补充的规则"));
  assert.ok(texts.includes("场务补充的争议"));
  // 原有的规则也还在
  assert.ok(texts.includes("商站建造前先确认道路或水路连接"));
});

console.log(`\n${passed} 项测试通过`);
