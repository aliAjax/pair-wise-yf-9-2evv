// 浏览器环境冒烟测试：用 jsdom 加载真实的 index.html + ledger.js + app.js
const { JSDOM } = require("/tmp/jsdom-check/node_modules/jsdom");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ledgerSrc = fs.readFileSync(path.join(root, "ledger.js"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8");

const storageMap = new Map();
let failures = 0;

function makeWindow() {
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
      clear: () => storageMap.clear()
    }
  });
  window.eval(ledgerSrc);
  window.eval(appSrc);
  return window;
}

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    failures += 1;
  } else {
    console.log("PASS:", message);
  }
}

const stateOf = (win) => win.__zfl.state;
const storeOf = (win) => win.__zfl.store;

function sendStorage(win, key, value) {
  const event = new win.Event("storage");
  Object.defineProperty(event, "key", { value: key });
  Object.defineProperty(event, "newValue", { value });
  win.dispatchEvent(event);
}

function findGame(win, id) {
  return stateOf(win).games.find((g) => g.id === id);
}

// 页面 A 首次加载（建立默认账）
const winA = makeWindow();
const docA = winA.document;
const mainKey = winA.ZflLedger.MAIN_KEY;
const backupKey = winA.ZflLedger.BACKUP_KEY;
assert(storageMap.has(mainKey), "首次加载后写入主账");
assert(storageMap.has(backupKey), "首次加载后建立完整备份");
assert(docA.querySelectorAll(".game-card").length === 3, "渲染 3 张默认桌游卡片");

const gameA = stateOf(winA).games.find((g) => g.name === "奥尔良");
const gid = gameA.id;
const ruleId = gameA.rules.forgets[0].id;
assert(typeof ruleId === "string" && ruleId.length > 0, "规则带自己的编号");

// 页面 B 打开第二个标签页
const winB = makeWindow();
const docB = winB.document;
assert(docB.querySelectorAll(".game-card").length === 3, "页面 B 加载到同一收藏");

// A、B 同时编辑同一条规则
findGame(winA, gid).rules.forgets[0].text = "主持改成的内容";
findGame(winA, gid).rules.forgets[0].updatedAt = 2000;
storeOf(winA).commit();
const editedByA = storageMap.get(mainKey);

findGame(winB, gid).rules.forgets[0].text = "场务改成的内容";
findGame(winB, gid).rules.forgets[0].updatedAt = 2100;
sendStorage(winB, mainKey, editedByA);

const conflictB = findGame(winB, gid).rules.forgets.find((e) => e.id === ruleId);
assert(conflictB && conflictB.conflict === true, "同一条两边都动过：合并后标记冲突");
const conflictTexts = conflictB.versions.filter((v) => !v.deleted).map((v) => v.text).sort();
assert(
  JSON.stringify(conflictTexts) === JSON.stringify(["主持改成的内容", "场务改成的内容"]),
  "冲突留下两份内容"
);
assert(docB.querySelectorAll(".conflict-item").length >= 1, "界面渲染冲突裁决卡片");

// A 再收到 B 合并后的结果，两边对齐
sendStorage(winA, mainKey, storageMap.get(mainKey));
assert(JSON.stringify(stateOf(winA)) === JSON.stringify(stateOf(winB)), "两个页面再次同步后账本完全一致");

// 界面新增/删除规则（在裁决冲突之前操作，避免选中游戏变化干扰）
docB.querySelector(`[data-game-id="${gid}"]`).dispatchEvent(new winB.MouseEvent("click", { bubbles: true }));
docB.querySelector("#ruleTypeInput").value = "forgets";
docB.querySelector("#ruleTextInput").value = "通过界面新加的提醒";
docB.querySelector("#ruleForm").dispatchEvent(new winB.Event("submit", { bubbles: true, cancelable: true }));
const added = findGame(winB, gid).rules.forgets.some((e) => e.text === "通过界面新加的提醒");
assert(added, "界面新增规则写入账本");

const newId = findGame(winB, gid).rules.forgets.find((e) => e.text === "通过界面新加的提醒").id;
docB.querySelector(`[data-delete-rule="${newId}"]`).dispatchEvent(new winB.MouseEvent("click", { bubbles: true }));
assert(
  !findGame(winB, gid).rules.forgets.some((e) => e.id === newId) && !!stateOf(winB).tombstones[newId],
  "界面删除后条目移除并留下墓碑"
);

// 在 B 页面裁决冲突：保留"主持改成的内容"
const conflictAfter = findGame(winB, gid).rules.forgets.find((e) => e.id === ruleId);
const resolveIndex = conflictAfter.versions.findIndex((v) => !v.deleted && v.text === "主持改成的内容");
const btn = docB.querySelector(`[data-resolve-rule="${ruleId}"][data-version-index="${resolveIndex}"]`);
assert(!!btn, "冲突条目有'保留这份'按钮");
btn.dispatchEvent(new winB.MouseEvent("click", { bubbles: true }));
const resolved = findGame(winB, gid).rules.forgets.find((e) => e.id === ruleId);
assert(!resolved.conflict && resolved.text === "主持改成的内容", "裁决后冲突消失，采用选中版本");

// A 同步裁决结果
sendStorage(winA, mainKey, storageMap.get(mainKey));
const resolvedA = findGame(winA, gid).rules.forgets.find((e) => e.id === ruleId);
assert(resolvedA.text === "主持改成的内容" && !resolvedA.conflict, "裁决结果同步到另一页面");

// 删除防复活：B 删一条，A 收到事件后同步
const rid2 = findGame(winB, gid).rules.forgets[1].id;
{
  const g = findGame(winB, gid);
  g.rules.forgets = g.rules.forgets.filter((e) => e.id !== rid2);
  stateOf(winB).tombstones[rid2] = { id: rid2, gameId: gid, section: "forgets", updatedAt: 3000 };
  storeOf(winB).commit();
}
sendStorage(winA, mainKey, storageMap.get(mainKey));
const goneA =
  !findGame(winA, gid).rules.forgets.some((e) => e.id === rid2) && !!stateOf(winA).tombstones[rid2];
assert(goneA, "删除在另一页面生效并带墓碑，旧条目不复活");

// v1 旧数据升级
storageMap.clear();
storageMap.set(
  mainKey,
  JSON.stringify({
    selectedId: "old-g",
    games: [
      {
        id: "old-g",
        name: "旧游戏",
        minPlayers: 2,
        maxPlayers: 4,
        duration: 60,
        complexity: "轻",
        lastPlayed: "2026-01-01",
        cover: "",
        forgets: ["旧规则一", "旧规则二"],
        disputes: [],
        setup: [],
        scoring: []
      }
    ]
  })
);
const winC = makeWindow();
const docC = winC.document;
const migrated = findGame(winC, "old-g");
assert(migrated && migrated.rules.forgets.every((e) => typeof e.id === "string"), "v1 旧数据升级后每条规则都有编号");
assert(migrated.rules.forgets.map((e) => e.text).join(",") === "旧规则一,旧规则二", "升级后规则文字不变");
assert(winC.__zfl.notices.some((n) => n.kind === "migrated"), "升级时给出提示");
assert(docC.querySelectorAll(".game-card").length === 1, "升级后界面正常渲染旧游戏");

console.log(failures ? `\n${failures} 个失败项` : "\n冒烟测试全部通过");
process.exitCode = failures ? 1 : 0;
