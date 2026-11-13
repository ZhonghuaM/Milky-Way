// ==UserScript==
// @name         [银河奶牛] Task 任务队列助手
// @namespace    local.milkyway.task-queue
// @version      1.10.1
// @description  测试服全自动 Task：筛选攒批、数量补齐、技能配装、队尾追加、补料与结算卖店
// @author       Codex
// @match        https://test.milkywayidle.com/*
// @match        https://test.milkywayidlecn.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';
    const VERSION = '1.10.1';
    const SPAM_BACKOFF_MS = 5000;
    const isSpamProtection = message => message.type === 'error'
        && [message.message, message.errorCode, message.error].some(code =>
            code === 'errorNotification.requestSpamProtection' || code === 'requestSpamProtection');
    const INVENTORY = '/item_locations/inventory';
    const COIN = '/items/coin';
    const COWBELL = '/items/cowbell';
    const COWBELL_BAG = '/items/bag_of_10_cowbells';
    const NEVER_SELL = new Set([COIN, COWBELL, COWBELL_BAG, '/items/task_token', '/items/philosophers_mirror']);
    const neverSellItem = itemHrid => NEVER_SELL.has(itemHrid)
        || /^\/items\/ultra(?:_[a-z0-9]+)*_tea$/.test(String(itemHrid));
    const SALE_CATEGORIES = new Set(['/item_categories/equipment', '/item_categories/resource']);
    const SKILLS = new Set(['milking', 'foraging', 'woodcutting',
        'cheesesmithing', 'crafting', 'tailoring', 'cooking', 'brewing']);
    const integer = (n, label = '数量') => {
        if (n == null || !Number.isSafeInteger(Number(n)) || Number(n) < 0) {
            throw new Error(`${label}无效`);
        }
        return Number(n);
    };
    const add = (map, key, n) => { map[key] = integer((map[key] || 0) + n); };
    const activeQuest = q => q.category === '/quest_category/random_task'
        && q.type === '/quest_type/action' && q.status === '/quest_status/in_progress';
    const supported = hrid => SKILLS.has(String(hrid).split('/')[2]);
    const skillName = hrid => {
        const skill = String(hrid).split('/')[2] || '';
        return skill.charAt(0).toUpperCase() + skill.slice(1);
    };
    const questVersion = q => {
        if (q?.updatedAt == null) return null;
        const ms = new Date(q.updatedAt).getTime();
        return Number.isFinite(ms) ? ms : null;
    };
    function actionLoadoutId(action) {
        const ids = [action.characterLoadoutId, action.characterLoadoutID].filter(v => v != null).map(Number);
        if (!ids.length) return 0;
        return ids.every(id => Number.isSafeInteger(id) && id >= 0 && id === ids[0]) ? ids[0] : null;
    }
    const combatQuest = (q, client) => q.category === '/quest_category/random_task'
        && q.status === '/quest_status/in_progress'
        && (q.type === '/quest_type/monster' || (q.type === '/quest_type/action'
            && (client.actionDetailMap?.[q.actionHrid]?.function === '/action_functions/combat'
                || client.actionDetailMap?.[q.actionHrid]?.type === '/action_types/combat')));
    const rerollCoinCost = count => 10000 * 2 ** Math.min(integer(count, '金币刷新次数'), 5);
    const rerollCowbellCost = count => 2 ** Math.min(integer(count, 'Cowbell 刷新次数'), 5);
    function taskTokens(q) {
        try {
            if (typeof q.itemRewardsJSON !== 'string') return null;
            const rewards = JSON.parse(q.itemRewardsJSON);
            if (!Array.isArray(rewards)) return null;
            let total = 0;
            for (const row of rewards) {
                if (!row || typeof row.itemHrid !== 'string' || typeof row.count !== 'number') return null;
                const count = integer(row.count, '奖励数量');
                if (row.itemHrid === '/items/task_token') total = integer(total + count);
            }
            return total;
        } catch { return null; }
    }
    const itemKey = row => `${row.itemHrid}::${Number(row.enhancementLevel || 0)}`;
    const inventoryRows = items => Object.values(items).filter(r => r.itemLocationHrid === INVENTORY);
    function balances(items) {
        const result = {};
        for (const row of inventoryRows(items)) add(result, itemKey(row), integer(row.count));
        return result;
    }
    function actionRemaining(action) {
        if (action.isDone) return 0;
        if (!action.hasMaxCount) return Infinity;
        return Math.max(0, integer(action.maxCount) - integer(action.currentCount));
    }
    function recipe(detail) {
        if (!detail) throw new Error('缺少动作配方，等待完整游戏数据');
        if (!Array.isArray(detail.inputItems)) {
            if (['milking', 'foraging', 'woodcutting'].includes(String(detail.hrid || '').split('/')[2])) return [];
            throw new Error('缺少配方 inputItems');
        }
        return detail.inputItems.map(r => ({...r, count: integer(r.count),
            enhancementLevel: integer(r.enhancementLevel || 0)}));
    }
    function requirements(detail, count) {
        const result = {};
        for (const row of recipe(detail)) add(result, itemKey(row), integer(count) * row.count);
        if (detail.upgradeItemHrid) add(result, `${detail.upgradeItemHrid}::0`, integer(count));
        return result;
    }
    function validShopCosts(shop) {
        return Array.isArray(shop?.costs) && shop.costs.every(cost => cost
            && typeof cost.itemHrid === 'string' && cost.itemHrid.startsWith('/items/')
            && cost.count != null && Number.isSafeInteger(Number(cost.count)) && Number(cost.count) >= 0
            && Number.isSafeInteger(Number(cost.enhancementLevel || 0)) && Number(cost.enhancementLevel || 0) >= 0);
    }
    function findTesterShop(client, itemHrid) {
        const matches = Object.entries(client.shopItemDetailMap || {}).filter(([, shop]) =>
            shop?.itemHrid === itemHrid && shop.category === '/shop_categories/tester');
        const match = matches.find(([, shop]) => validShopCosts(shop)) || matches[0];
        return match ? {shopItemHrid: match[0], shop: match[1]} : null;
    }
    function reservedInputs(actions, client, {forPlanning = false, allowUnknownBackground = forPlanning} = {}) {
        const reserved = {};
        const unbounded = new Set();
        for (const action of Object.values(actions)) {
            if (action.isDone) continue;
            const background = ['/actions/labyrinth/explore', '/actions/enhancing/enhance'].includes(action.actionHrid);
            const detail = client.actionDetailMap?.[action.actionHrid]
                || (allowUnknownBackground && background ? {} : null);
            if (!detail) {
                const error = new Error(`队列动作缺少配方：${action.actionHrid}`);
                if (background) error.code = 'BACKGROUND_RECIPE_UNAVAILABLE';
                throw error;
            }
            const inputs = detail.inputItems || [];
            // Enhancing consumes dynamic resources; reserve the named stacks in
            // addition to static costs. No assumption about future outputs.
            const dynamic = [action.primaryItemHash, action.secondaryItemHash].filter(Boolean);
            const n = actionRemaining(action);
            for (const row of inputs) {
                if (!Number.isFinite(n)) {
                    // Task purchases do not need an infinite work budget.
                    // Sales still protect every known background material.
                    if (!forPlanning) unbounded.add(itemKey(row));
                } else add(reserved, itemKey(row), n * integer(row.count));
            }
            for (const hash of dynamic) {
                const parts = String(hash).split('::');
                if (parts.length !== 4 || !parts[2].startsWith('/items/')) throw new Error('无法识别队列物品 hash');
                const k = `${parts[2]}::${parts[3]}`;
                if (detail.upgradeItemHrid && hash === action.primaryItemHash && Number.isFinite(n)) add(reserved, k, n);
                else unbounded.add(k);
                if (!forPlanning && action.actionHrid === '/actions/enhancing/enhance') {
                    for (const cost of client.itemDetailMap?.[parts[2]]?.enhancementCosts || []) unbounded.add(itemKey(cost));
                }
            }
            if (detail.upgradeItemHrid && !action.primaryItemHash) unbounded.add(`${detail.upgradeItemHrid}::0`);
        }
        return {reserved, unbounded};
    }
    function planningInputs(actions, client) {
        const live = Object.fromEntries(Object.entries(actions).filter(([, a]) => !a.isDone && actionRemaining(a) > 0));
        const {reserved} = reservedInputs(live, client, {forPlanning: true});
        // Keep finite recipe budgets and actual target/protection items.
        // Unbounded background consumption does not block appending Tasks.
        for (const a of Object.values(live)) {
            const detail = client.actionDetailMap[a.actionHrid];
            for (const hash of [a.primaryItemHash, a.secondaryItemHash].filter(Boolean)) {
                if (detail?.upgradeItemHrid && hash === a.primaryItemHash && Number.isFinite(actionRemaining(a))) continue;
                const parts = String(hash).split('::');
                add(reserved, `${parts[2]}::${parts[3]}`, 1);
            }
        }
        return {reserved};
    }
    function buildPlan({quests, actions, items, client}, taskIds, {includeRelated = true, quantityMultiple = 1, taskMultiples = {}, includePurchases = true} = {}) {
        quantityMultiple = integer(quantityMultiple, '数量补齐倍数');
        if (!quantityMultiple) throw new Error('数量补齐倍数必须大于 0');
        const selected = new Set(taskIds.map(String));
        const groups = new Map();
        const skipped = [];
        for (const q of Object.values(quests)) {
            if (!selected.has(String(q.id))) continue;
            if (!activeQuest(q) || !supported(q.actionHrid)) {
                skipped.push({id: String(q.id), reason: '仅支持进行中的采集和制作任务'});
                continue;
            }
            const count = Math.max(0, integer(q.goalCount) - integer(q.currentCount));
            if (!count) continue;
            const g = groups.get(q.actionHrid) || {actionHrid: q.actionHrid, taskIds: [], remaining: 0, covered: 0, actionIds: []};
            g.taskIds.push(String(q.id));
            g.remaining = integer(g.remaining + count);
            groups.set(q.actionHrid, g);
        }
        // Unselected tasks of the same action also consume task progress before
        // selected ones. Include them so a selected later task can finish.
        for (const q of Object.values(quests)) {
            if (!includeRelated || selected.has(String(q.id)) || !activeQuest(q)) continue;
            const g = groups.get(q.actionHrid);
            if (g) {
                g.taskIds.push(String(q.id));
                g.remaining = integer(g.remaining + Math.max(0, integer(q.goalCount) - integer(q.currentCount)));
            }
        }
        const {reserved} = planningInputs(actions, client);
        for (const a of Object.values(actions)) {
            const g = groups.get(a.actionHrid);
            if (g && !a.isDone) { g.covered += actionRemaining(a); g.actionIds.push(String(a.id)); }
        }
        const stock = balances(items);
        const total = {...reserved};
        const entries = [...groups.values()].flatMap(g => {
            const detail = client.actionDetailMap?.[g.actionHrid];
            if (!detail) throw new Error(`缺少任务配方：${g.actionHrid}`);
            let coverage = g.covered;
            return g.taskIds.map(id => Object.values(quests).find(q => String(q.id) === id))
                .sort((a, b) => Number(a.id) - Number(b.id)).map(q => {
                    const remaining = Math.max(0, integer(q.goalCount) - integer(q.currentCount));
                    const covered = Math.min(remaining, coverage);
                    coverage -= covered;
                    const multiple = integer(taskMultiples[String(q.id)] ?? quantityMultiple, '数量补齐倍数');
                    if (!multiple) throw new Error('数量补齐倍数必须大于 0');
                    const count = integer(Math.ceil((remaining - covered) / multiple) * multiple);
                    // Extra actions planned for an earlier Task can finish a
                    // later Task of the same action; never buy them twice.
                    coverage += count - (remaining - covered);
                    const inputs = requirements({...detail, hrid: g.actionHrid}, count);
                    for (const [key, n] of Object.entries(inputs)) add(total, key, n);
                    return {actionHrid: g.actionHrid, actionIds: g.actionIds, taskIds: [String(q.id)],
                        remaining, covered, count, inputs, upgradeItemHrid: detail.upgradeItemHrid || '',
                        name: detail.name || g.actionHrid.split('/').pop()};
                });
        });
        // Sales need material quantities, even when a future purchase is not
        // affordable yet. Do not make selling existing output depend on it.
        if (!includePurchases) return {entries, purchases: [], costs: {}, reserved, skipped};
        const purchases = [];
        for (const [key, n] of Object.entries(total)) {
            // Only buy ingredients of new task actions, never refill unrelated work.
            if (!entries.some(e => (e.inputs[key] || 0) > 0)) continue;
            const missing = Math.max(0, n - (stock[key] || 0));
            if (!missing) continue;
            const [itemHrid, level] = key.split('::');
            if (itemHrid === COIN) throw new Error('金币不足，无法从测试商店补充金币');
            const listing = findTesterShop(client, itemHrid);
            if (!listing) throw new Error(`测试商店没有对应商品：${itemHrid}`);
            const {shopItemHrid} = listing;
            purchases.push({itemHrid, enhancementLevel: integer(level), count: missing, shopItemHrid});
        }
        const costs = {};
        for (const purchase of purchases) {
            const shop = client.shopItemDetailMap[purchase.shopItemHrid];
            if (!Array.isArray(shop.costs)) throw new Error('测试商店价格尚未同步');
            for (const cost of shop.costs) add(costs, itemKey(cost), integer(cost.count) * purchase.count);
        }
        for (const [k, cost] of Object.entries(costs)) {
            if (cost > (stock[k] || 0) - (total[k] || 0)) throw new Error(`购买材料的货币不足：${k}`);
        }
        return {entries, purchases, costs, reserved, skipped};
    }
    function createController(options = {}) {
        const storage = options.storage;
        const now = options.now || Date.now;
        const state = {ready: false, client: null, characterId: '', quests: {}, actions: {}, items: {}, loadouts: null,
            cap: 0, taskSlotCap: null, minTokens: 25, batchTarget: 48, quantityMultiple: 3,
            job: null, owned: {}, ownedLimits: {}, credits: {}, saleCredits: {}, saleCheckpoints: {}, floors: {}, pending: null, cooldownUntil: 0,
            settledActionHrids: {}, observedOutputs: {}, recoverSurplus: true, recoveryNeeded: false,
            autoClaim: true, autoRead: true, unreadTaskCount: null, isTutorialCompleted: false,
            autoQueue: true, rerollCombat: true, cowbellFallback: true, cowbellTaskIds: {}, autoSessionInitialized: false,
            progress: {}, watched: {}, finished: {}, settling: {}, enabled: false, sellOutputs: true, message: '等待游戏完整同步', logs: []};
        let busy = false, writing = false, lastSent = 0, inventoryRevision = 0;
        let epoch = 0;
        const key = () => `MWI_TASK_QUEUE_V1:${state.characterId}`;
        const log = message => {
            if (state.message === message) return;
            state.message = message;
            state.logs.unshift(`${new Date(now()).toLocaleTimeString()} ${message}`);
            state.logs = state.logs.slice(0, 80);
            options.onChange?.();
        };
        const persist = () => {
            if (!state.characterId) return;
            storage?.setItem(key(), JSON.stringify({schema: 1, job: state.job, owned: state.owned,
                ownedLimits: state.ownedLimits, minTokens: state.minTokens, batchTarget: state.batchTarget, quantityMultiple: state.quantityMultiple,
                credits: state.credits, saleCredits: state.saleCredits, saleCheckpoints: state.saleCheckpoints,
                settledActionHrids: state.settledActionHrids, observedOutputs: state.observedOutputs, recoverSurplus: state.recoverSurplus,
                floors: state.floors, progress: state.progress, watched: state.watched, pending: state.pending, cooldownUntil: state.cooldownUntil,
                enabled: state.enabled, sellOutputs: state.sellOutputs, autoClaim: state.autoClaim, autoRead: state.autoRead,
                cowbellFallback: state.cowbellFallback, cowbellTaskIds: state.cowbellTaskIds,
                autoQueue: state.autoQueue, rerollCombat: state.rerollCombat, autoSessionInitialized: state.autoSessionInitialized}));
        };
        const halt = message => { state.enabled = false; log(message); persist(); };
        function coolDown() {
            state.cooldownUntil = Math.max(state.cooldownUntil, now() + SPAM_BACKOFF_MS);
            // The server does not echo a request ID. Only consider our own
            // outstanding operation for a retry, and keep observing its ACK
            // throughout the backoff before deciding whether it still needs work.
            const owner = options.coordinator?.holder?.owner;
            if (state.ready && state.pending && (!owner || owner === 'task-queue')) state.pending.spamRejectedAt = now();
            log(`触发 requestSpamProtection，等待至少 5 秒后按最新状态继续${state.enabled ? '' : '；当前暂停状态保留'}`);
            persist();
        }
        function reconcileSpamBackoff() {
            if (now() < state.cooldownUntil) return;
            if (state.cooldownUntil) {
                state.cooldownUntil = 0;
                persist();
                options.onChange?.();
            }
            const p = state.pending;
            if (!p || p.spamRejectedAt == null || !state.ready) return;
            // A partial result contradicts a simple rejected request. Keep it
            // pending until the exact ACK or a full reconnect reconciles it.
            if (p.externalOverlap || p.responseObserved || p.coinsConfirmed || p.bagConfirmed || p.cowbellsConfirmed || p.oldDiscarded
                || Object.keys(p.candidateIds || {}).length) return;
            state.pending = null;
            persist();
            log('限频等待结束；已观察 5 秒回执，按当前任务、背包和队列重新核算');
        }
        function pruneCowbellModes() {
            for (const id of Object.keys(state.cowbellTaskIds)) {
                if (state.pending?.kind === 'reroll' && state.pending.questId === id) continue;
                const q = state.quests[id];
                if (!q || q.status !== '/quest_status/in_progress'
                    || (activeQuest(q) && supported(q.actionHrid) && taskTokens(q) !== null && taskTokens(q) >= state.minTokens)) {
                    delete state.cowbellTaskIds[id];
                }
            }
        }
        function loadoutFor(actionHrid) {
            const skill = String(actionHrid).split('/')[2], name = skillName(actionHrid);
            if (!SKILLS.has(skill)) throw new Error(`不支持该技能的任务配装：${actionHrid}`);
            if (!state.loadouts) throw new Error('配装列表尚未同步，请完整刷新游戏');
            const matches = Object.entries(state.loadouts).filter(([, row]) => row
                && String(row.name || '').trim().toLowerCase() === skill);
            if (matches.length !== 1) throw new Error(matches.length
                ? `有多个同名 ${name} 配装，请只保留一个`
                : `找不到 ${name} 配装，请将对应技能套装命名为 ${name}`);
            const [key, row] = matches[0];
            const id = integer(row.id ?? key, `${name} 配装 ID`);
            if (!id) throw new Error(`${name} 配装 ID 无效`);
            const owners = [row.characterID, row.characterId].filter(v => v != null);
            if (!owners.length || owners.some(owner => String(owner) !== state.characterId)) throw new Error(`${name} 配装不属于当前角色`);
            const actionType = state.client?.actionDetailMap?.[actionHrid]?.type || `/action_types/${skill}`;
            if (row.actionTypeHrid !== '' && row.actionTypeHrid !== actionType) throw new Error(`${name} 配装的技能类型不匹配`);
            return {id, name: String(row.name).trim()};
        }
        function replaceLoadouts(map) {
            state.loadouts = map && typeof map === 'object' && !Array.isArray(map) ? map : null;
        }
        function isZeroInventoryItem(row) {
            if (!row || !state.characterId || row.itemLocationHrid !== INVENTORY
                || typeof row.itemHrid !== 'string' || !row.itemHrid.startsWith('/items/')
                || typeof row.hash !== 'string' || row.hash.split('::').length !== 4) return false;
            const level = row.enhancementLevel;
            if (!['number', 'string'].includes(typeof level) || String(level).trim() === '' || Number(level) !== 0) return false;
            if (row.count == null || !Number.isSafeInteger(Number(row.count)) || Number(row.count) < 0) return false;
            const owners = [row.characterID, row.characterId].filter(value => value != null);
            if (owners.some(owner => String(owner) !== state.characterId)) return false;
            // Both the explicit level and the actual transaction target must
            // identify +0. Missing or contradictory fields never mean +0.
            return row.hash === `${state.characterId}::${INVENTORY}::${row.itemHrid}::0`;
        }
        function zeroInventoryBalances() {
            return balances(Object.fromEntries(Object.entries(state.items).filter(([, row]) => isZeroInventoryItem(row))));
        }
        function canSellItem(itemHrid) {
            const detail = state.client?.itemDetailMap?.[itemHrid];
            const superDrink = detail?.categoryHrid === '/item_categories/drink'
                && /^\/items\/super_(?:[a-z0-9]+_)*(?:tea|coffee)$/.test(itemHrid);
            return !neverSellItem(itemHrid) && (SALE_CATEGORIES.has(detail?.categoryHrid) || superDrink)
                && Number(detail.sellPrice) > 0;
        }
        function isSaleRow(row, k) {
            return isZeroInventoryItem(row) && !row.isLocked && itemKey(row) === k
                && canSellItem(row.itemHrid);
        }
        function settleSale(checkpoint, release = true) {
            const [kind, id] = checkpoint.split(':');
            const hrid = kind === 'action' ? state.owned[id]
                : state.quests[id]?.actionHrid || Object.keys(state.watched).find(h => state.watched[h].includes(id));
            if (hrid && supported(hrid)) state.settledActionHrids[hrid] = true;
            if (state.saleCheckpoints[checkpoint]) return;
            state.saleCheckpoints[checkpoint] = true;
            // Freeze only the output already observed at this boundary. Later
            // production must wait for another queue ending or claimed Task.
            if (release) {
                state.saleCredits = {...state.credits};
                state.recoveryNeeded = true;
            }
        }
        function finishPending(message = {}) {
            const p = state.pending;
            if (!p) return;
            if (p.kind === 'reroll') {
                const counterField = p.counterField || 'coinRerollCount';
                for (const q of message.endCharacterQuests || []) {
                    const id = String(q.id);
                    if (state.quests[id] !== q) continue; // Ignore rejected stale/terminal updates.
                    if (id === p.questId && q.status === '/quest_status/discarded') p.oldDiscarded = true;
                    if (q.category === '/quest_category/random_task' && q.status === '/quest_status/in_progress'
                        && Number(q[counterField]) === p.beforeRerolls + 1) {
                        if (id === p.questId || !p.beforeQuestIds.includes(id)) p.candidateIds[id] = true;
                    }
                }
                if (message.type === 'items_updated' && inventoryRevision > p.inventoryRevision
                    && message.endCharacterItems?.some(r => itemKey(r) === p.itemKey && r.itemLocationHrid === INVENTORY)) {
                    const stock = balances(state.items)[p.itemKey] || 0;
                    if (stock - p.before - (p.naturalDelta || 0) === -p.count) p.coinsConfirmed = true;
                }
                const candidates = Object.keys(p.candidateIds).filter(id => (id === p.questId || p.oldDiscarded)
                    && state.quests[id]?.status === '/quest_status/in_progress'
                    && Number(state.quests[id]?.[counterField]) === p.beforeRerolls + 1);
                if (candidates.length > 1) { halt('刷新回执对应多个新任务，已暂停；请刷新游戏核对'); return; }
                if (p.coinsConfirmed && candidates.length === 1) {
                    state.pending = null;
                    const q = state.quests[candidates[0]];
                    if (p.currency === 'cowbell') {
                        delete state.cowbellTaskIds[p.questId];
                        state.cowbellTaskIds[candidates[0]] = true;
                    }
                    const currency = p.currency === 'cowbell' ? 'Cowbell' : '金币';
                    log(`${currency}刷新已确认（${p.count} ${currency}）：${combatQuest(q || {}, state.client) ? '仍是战斗任务，将继续刷新' : `任务奖励 ${taskTokens(q) ?? '未知'} 代币，按策略继续筛选和攒批`}`);
                }
            } else if (p.kind === 'open_bag') {
                // The loot popup is evidence of an opening, but is not the
                // authoritative inventory balance. Wait for both item updates;
                // a rate-limit message must not trigger a second opening meanwhile.
                if (message.type === 'loot_opened' && message.openedItem?.itemHrid === COWBELL_BAG
                    && Number(message.openedItem.enhancementLevel || 0) === 0 && Number(message.openedItem.count) === 1) p.responseObserved = true;
                if (message.type === 'items_updated' && inventoryRevision > p.inventoryRevision) {
                    const stock = balances(state.items);
                    const touched = k => message.endCharacterItems?.some(r => itemKey(r) === k && r.itemLocationHrid === INVENTORY);
                    if (touched(p.itemKey) && (stock[p.itemKey] || 0) - p.before - (p.naturalDelta || 0) === -1) p.bagConfirmed = true;
                    if (touched(p.cowbellKey) && (stock[p.cowbellKey] || 0) - p.cowbellBefore - (p.cowbellNaturalDelta || 0) === 10) p.cowbellsConfirmed = true;
                    if (p.bagConfirmed && p.cowbellsConfirmed) {
                        state.pending = null;
                        log('已确认打开 1 个 Bag of 10 Cowbells，10 个 Cowbell 已到账；继续核算刷新费用');
                    }
                }
            } else if (p.kind === 'claim') {
                const confirmed = message.endCharacterQuests?.some(q => String(q.id) === p.questId
                    && state.quests[String(q.id)] === q && q.status === '/quest_status/claimed');
                if (confirmed) {
                    state.pending = null;
                    state.recoveryNeeded = true;
                    log(`已领取 Task ${p.questId} 的奖励`);
                }
            } else if (p.kind === 'read') {
                if (message.type === 'character_info_updated' && message.characterInfo?.unreadTaskCount != null
                    && state.unreadTaskCount < p.beforeUnread) {
                    state.pending = null;
                    log(`Read 已确认；当前未读任务 ${state.unreadTaskCount}`);
                }
            } else if (p.kind === 'queue') {
                const matches = Object.values(state.actions).filter(a => !p.beforeIds.includes(String(a.id))
                    && a.actionHrid === p.actionHrid && a.hasMaxCount === true
                    && Number(a.maxCount) === p.count && (a.primaryItemHash || '') === (p.primaryItemHash || '') && !a.secondaryItemHash
                    && Number(a.difficultyTier || 0) === 0 && actionLoadoutId(a) === (p.characterLoadoutId ?? 0));
                if (matches.length === 1) {
                    const id = String(matches[0].id);
                    state.owned[id] = p.actionHrid;
                    state.ownedLimits[id] = {actionHrid: p.actionHrid, maxCount: p.count};
                    if (state.job && !state.job.queuedActionIds.includes(id)) state.job.queuedActionIds.push(id);
                    state.pending = null;
                    log(`已入队：${p.actionHrid.split('/').pop()} × ${p.count}${p.loadoutName ? ` · 配装 ${p.loadoutName}` : ''}`);
                } else if (matches.length > 1) halt('同一请求出现多个相同队列动作，请刷新后核对');
            } else if (message.type === 'items_updated' && inventoryRevision > p.inventoryRevision
                && message.endCharacterItems?.some(row => itemKey(row) === p.itemKey && row.itemLocationHrid === INVENTORY
                    && (p.kind !== 'sell' || row.hash === p.hash && isZeroInventoryItem(row)))) {
                const stock = (p.kind === 'sell' ? zeroInventoryBalances() : balances(state.items))[p.itemKey] || 0;
                const change = stock - p.before - (p.naturalDelta || 0);
                if ((p.kind === 'buy' && change === p.count)
                    || (p.kind === 'sell' && change === -p.count)) {
                    state.pending = null;
                    log(`${p.kind === 'buy' ? '补料' : '卖店'}已确认：${p.itemKey.split('::')[0].split('/').pop()} +${p.itemKey.split('::')[1]} × ${p.count}`);
                }
            }
            persist();
        }
        function receive(message) {
            try {
                if (message.type === 'init_client_data') {
                    if (message.actionDetailMap && message.itemDetailMap && message.shopItemDetailMap) state.client = message;
                }
                if (message.type === 'init_character_data') {
                    epoch++;
                    const id = String(message.character?.id || '');
                    const rows = ['characterItems', 'characterActions', 'characterQuests'];
                    state.ready = !!id && rows.every(k => Array.isArray(message[k]));
                    if (!state.ready) { halt('缺少角色完整数据，请刷新游戏'); return; }
                    state.characterId = id;
                    replaceLoadouts(message.characterLoadoutMap);
                    state.items = Object.fromEntries(message.characterItems.map(r => [r.hash, r]));
                    state.actions = Object.fromEntries(message.characterActions.filter(a => !a.isDone).map(a => [String(a.id), a]));
                    state.quests = Object.fromEntries(message.characterQuests.map(q => [String(q.id), q]));
                    state.cap = integer(message.characterInfo?.actionQueueCap || 0);
                    state.taskSlotCap = message.characterInfo?.taskSlotCap == null ? null : integer(message.characterInfo.taskSlotCap);
                    state.unreadTaskCount = message.characterInfo?.unreadTaskCount == null ? null : integer(message.characterInfo.unreadTaskCount);
                    state.isTutorialCompleted = message.characterInfo?.isTutorialCompleted === true;
                    const raw = storage?.getItem(key());
                    let hasSaleHistory = false;
                    if (raw) {
                        const saved = JSON.parse(raw);
                        if (saved.schema !== 1) throw new Error('任务记录版本不兼容');
                        hasSaleHistory = saved.saleCheckpoints != null;
                        for (const k of ['job', 'owned', 'credits', 'floors', 'pending', 'enabled', 'sellOutputs']) state[k] = saved[k];
                        state.progress = saved.progress || {};
                        state.cooldownUntil = integer(saved.cooldownUntil ?? 0, '限频等待时间');
                        state.ownedLimits = saved.ownedLimits || {};
                        state.minTokens = integer(saved.minTokens ?? 25, '最低任务代币');
                        state.batchTarget = integer(saved.batchTarget ?? 48, '攒够任务数');
                        state.quantityMultiple = integer(saved.quantityMultiple ?? 3, '数量补齐倍数');
                        if (!state.batchTarget || !state.quantityMultiple) throw new Error('保存的批次策略无效');
                        if (state.job) {
                            state.job.fixedBatch ??= true;
                            // Existing batches retain their original exact
                            // quantities instead of unexpectedly expanding.
                            state.job.quantityMultiple ??= 1;
                            state.job.queuedActionIds ||= [];
                            // Retire the old front-insertion mode without
                            // changing the queue already stored by the server.
                            delete state.job.frontMode;
                        }
                        state.watched = saved.watched || {};
                        state.saleCredits = saved.saleCredits || {};
                        state.saleCheckpoints = saved.saleCheckpoints || {};
                        state.settledActionHrids = saved.settledActionHrids || {};
                        state.observedOutputs = saved.observedOutputs || {};
                        state.recoverSurplus = saved.recoverSurplus !== false;
                        // Existing v1.0 profiles gain the newly requested
                        // maintenance defaults without resetting their batch.
                        state.autoClaim = saved.autoClaim !== false;
                        state.autoRead = saved.autoRead !== false;
                        state.autoQueue = saved.autoQueue !== false;
                        state.rerollCombat = saved.rerollCombat !== false;
                        state.cowbellFallback = saved.cowbellFallback !== false;
                        state.cowbellTaskIds = saved.cowbellTaskIds || {};
                        state.autoSessionInitialized = saved.autoSessionInitialized === true
                            || !!saved.job || Object.keys(saved.owned || {}).length > 0 || Object.keys(saved.credits || {}).length > 0;
                    } else {
                        Object.assign(state, {job: null, owned: {}, credits: {}, saleCredits: {}, saleCheckpoints: {}, settledActionHrids: {}, observedOutputs: {}, recoverSurplus: true, floors: {}, progress: {}, watched: {}, pending: null, enabled: false, sellOutputs: true, autoClaim: true, autoRead: true, autoQueue: true, rerollCombat: true, autoSessionInitialized: false});
                        Object.assign(state, {ownedLimits: {}, minTokens: 25, batchTarget: 48, quantityMultiple: 3, cooldownUntil: 0,
                            cowbellFallback: true, cowbellTaskIds: {}});
                    }
                    if (state.pending?.kind === 'queue') finishPending();
                    // Reconnect can arrive after a Cowbell reroll replaced the
                    // old Task. Carry its selected currency to the unique next
                    // counter in the authoritative snapshot; never replay it.
                    if (state.pending?.kind === 'reroll' && state.pending.currency === 'cowbell') {
                        const p = state.pending;
                        const candidates = Object.values(state.quests).filter(q =>
                            q.category === '/quest_category/random_task' && q.status === '/quest_status/in_progress'
                            && Number(q.cowbellRerollCount) === p.beforeRerolls + 1
                            && (String(q.id) === p.questId || !p.beforeQuestIds.includes(String(q.id))));
                        if (candidates.length === 1 && (!state.quests[p.questId]
                            || state.quests[p.questId].status === '/quest_status/discarded' || String(candidates[0].id) === p.questId)) {
                            state.cowbellTaskIds[String(candidates[0].id)] = true;
                        }
                    }
                    // Recompute missing materials and task work from full server
                    // state. Never replay an old pending transaction packet.
                    // Quest progress and remaining queue determine new work.
                    // A claim still marked completed or an unread balance still
                    // present in this full snapshot can be handled afresh.
                    const pendingClaimId = state.pending?.kind === 'claim' ? state.pending.questId : null;
                    if (state.pending?.kind === 'sell') {
                        const {itemKey: k, count} = state.pending;
                        // Only the submitted quantity is uncertain. Output
                        // observed after sending it was not part of that sale.
                        state.credits[k] = Math.max(0, (state.credits[k] || 0) - count);
                        state.saleCredits[k] = Math.max(0, (state.saleCredits[k] || 0) - count);
                    }
                    state.pending = null;
                    state.finished = {};
                    state.settling = {};
                    state.recoveryNeeded = true;
                    const stock = zeroInventoryBalances();
                    for (const k of Object.keys(state.credits)) state.credits[k] = Math.min(state.credits[k], Math.max(0, (stock[k] || 0) - effectiveSaleFloor(k)));
                    for (const k of Object.keys(state.saleCredits)) state.saleCredits[k] = Math.min(state.saleCredits[k], state.credits[k] || 0);
                    // Restore settlement of recorded output without inventing
                    // production credits. Separately, category cleanup can
                    // authorize current surplus at this reconnect boundary.
                    // Old claims alone do not release legacy output credits.
                    for (const id of Object.keys(state.owned)) {
                        if (!state.actions[id] || actionRemaining(state.actions[id]) === 0) settleSale(`action:${id}`, hasSaleHistory);
                        if (!state.actions[id]) { delete state.owned[id]; delete state.ownedLimits[id]; delete state.progress[id]; }
                        else state.progress[id] = integer(state.actions[id].currentCount);
                    }
                    // Claimed quests can disappear from the full snapshot.
                    // Recover only a specific persisted claim intent; absence
                    // alone does not prove that any other Task was claimed.
                    if (pendingClaimId && Object.values(state.watched).some(ids => ids.includes(pendingClaimId))
                        && (!state.quests[pendingClaimId] || state.quests[pendingClaimId].status === '/quest_status/claimed')) {
                        settleSale(`quest:${pendingClaimId}`);
                    }
                    for (const ids of Object.values(state.watched)) for (const id of ids) {
                        if (state.saleCheckpoints[`quest:${id}`] || state.quests[id]?.status === '/quest_status/claimed') settleSale(`quest:${id}`, hasSaleHistory);
                    }
                    persist();
                    log(`角色已同步；${state.enabled ? '继续已保存的自动流程' : '点击“启动全自动”开始'}`);
                }
                if (message.type === 'character_info_updated') {
                    state.cap = integer(message.characterInfo?.actionQueueCap || state.cap);
                    if (message.characterInfo?.taskSlotCap != null) state.taskSlotCap = integer(message.characterInfo.taskSlotCap);
                    if (message.characterInfo?.unreadTaskCount != null) state.unreadTaskCount = integer(message.characterInfo.unreadTaskCount);
                    if (typeof message.characterInfo?.isTutorialCompleted === 'boolean') state.isTutorialCompleted = message.characterInfo.isTutorialCompleted;
                }
                if (message.type === 'loadouts_updated') replaceLoadouts(message.characterLoadoutMap);
                const completed = message.type === 'action_completed' ? message.endCharacterAction : null;
                // Credit only positive inventory deltas in an owned action's
                // completion packet. Coins, upgraded equipment, purchases and
                // other characters/actions are never production credits.
                const completedId = String(completed?.id || '');
                const isNewCompletion = completed && integer(completed.currentCount) > (state.progress[completedId] ?? -1);
                const taskStillActive = (state.watched[completed?.actionHrid] || []).some(id => activeQuest(state.quests[id] || {}));
                const limit = state.ownedLimits[completedId];
                const finiteTail = limit && limit.actionHrid === completed?.actionHrid
                    && completed.hasMaxCount === true && Number(completed.maxCount) === limit.maxCount
                    && integer(completed.currentCount) <= limit.maxCount;
                const ownOutput = isNewCompletion && (taskStillActive || finiteTail) && state.owned[completedId] === completed.actionHrid;
                // A replay must not roll the absolute inventory backwards after
                // a sale and then manufacture a second output credit.
                if (completed && !isNewCompletion) return;
                if (completed) state.progress[completedId] = integer(completed.currentCount);
                if (completed && integer(completed.currentCount) >= (state.settling[completedId]?.count || Infinity)) delete state.settling[completedId];
                const deltas = message.endCharacterItems || message.updatedCharacterItems || [];
                if (message.type === 'items_updated' && ['buy', 'sell', 'open_bag'].includes(state.pending?.kind)) {
                    const p = state.pending;
                    const relevant = deltas.some(row => itemKey(row) === p.itemKey && row.itemLocationHrid === INVENTORY
                        && (p.kind !== 'sell' || row.hash === p.hash && isZeroInventoryItem(row)));
                    if (relevant) {
                        const incomingStock = inventoryRows({...state.items, ...Object.fromEntries(deltas.map(row => [row.hash, row]))})
                            .filter(row => itemKey(row) === p.itemKey && (p.kind !== 'sell' || isZeroInventoryItem(row)))
                            .reduce((sum, row) => sum + integer(row.count), 0);
                        if (incomingStock - p.before - (p.naturalDelta || 0) !== 0) p.responseObserved = true;
                    }
                    if (p.kind === 'open_bag' && deltas.some(row => itemKey(row) === p.cowbellKey && row.itemLocationHrid === INVENTORY)) {
                        const nextItems = {...state.items, ...Object.fromEntries(deltas.map(row => [row.hash, row]))};
                        if ((balances(nextItems)[p.cowbellKey] || 0) - p.cowbellBefore - (p.cowbellNaturalDelta || 0) !== 0) p.responseObserved = true;
                    }
                }
                for (const row of deltas) {
                    const previous = state.items[row.hash];
                    const difference = integer(row.count) - integer(previous?.count || 0);
                    const k = itemKey(row);
                    if (message.type === 'action_completed' && state.pending?.itemKey === k && row.itemLocationHrid === INVENTORY
                        && (state.pending.kind !== 'sell' || row.hash === state.pending.hash && isZeroInventoryItem(row))) {
                        state.pending.naturalDelta = (state.pending.naturalDelta || 0) + difference;
                    }
                    if (message.type === 'action_completed' && state.pending?.cowbellKey === k && row.itemLocationHrid === INVENTORY) {
                        state.pending.cowbellNaturalDelta = (state.pending.cowbellNaturalDelta || 0) + difference;
                    }
                    if (isZeroInventoryItem(row)) {
                        if (difference < 0) {
                            state.credits[k] = Math.max(0, (state.credits[k] || 0) + difference);
                            state.saleCredits[k] = Math.max(0, (state.saleCredits[k] || 0) + difference);
                        }
                        if (ownOutput && difference > 0 && canSellItem(row.itemHrid)) {
                            add(state.credits, k, difference);
                            (state.observedOutputs[completed.actionHrid] ||= {})[k] = true;
                        }
                    }
                    state.items[row.hash] = row;
                }
                if (deltas.length) inventoryRevision++;
                const updates = [...(message.endCharacterActions || []), ...(completed ? [completed] : [])];
                const queueFinished = updates.some(a => !state.finished[String(a.id)]
                    && state.actions[String(a.id)] && actionRemaining(state.actions[String(a.id)]) > 0 && actionRemaining(a) === 0);
                if (state.pending?.kind === 'queue' && updates.some(a => a.actionHrid === state.pending.actionHrid
                    && !state.pending.beforeIds.includes(String(a.id)))) state.pending.responseObserved = true;
                if (state.pending?.kind === 'read' && (message.endCharacterQuests || []).some(q =>
                    q.category === '/quest_category/random_task' && !state.quests[String(q.id)])) state.pending.responseObserved = true;
                for (const a of message.endCharacterActions || []) {
                    const id = String(a.id);
                    const observed = state.progress[id] ?? state.actions[id]?.currentCount ?? 0;
                    if (a.isDone && state.owned[id] && integer(a.currentCount) > observed) {
                        state.settling[id] = {count: integer(a.currentCount), since: now()};
                    }
                }
                // Process acknowledgement before removing finished actions.
                for (const a of updates) if (!state.finished[String(a.id)]) state.actions[String(a.id)] = a;
                for (const q of message.endCharacterQuests || []) {
                    const id = String(q.id), previous = state.quests[id];
                    const beforeVersion = questVersion(previous), nextVersion = questVersion(q);
                    if (beforeVersion !== null && nextVersion !== null && nextVersion < beforeVersion) continue;
                    // A paid reroll may replace its discarded slot; only the
                    // authorized next counter can reopen that same ID.
                    const expectedReroll = state.pending?.kind === 'reroll' && state.pending.questId === id
                        && q.category === '/quest_category/random_task' && q.status === '/quest_status/in_progress'
                        && Number(q[state.pending.counterField || 'coinRerollCount']) === state.pending.beforeRerolls + 1;
                    const rerollReplacement = previous?.status === '/quest_status/discarded' && expectedReroll;
                    // Claimed/discarded task IDs cannot become actionable again
                    // because an older completion update was replayed.
                    if (!rerollReplacement && ['/quest_status/claimed', '/quest_status/discarded'].includes(previous?.status)) continue;
                    const expectedDiscard = state.pending?.kind === 'reroll' && state.pending.questId === id
                        && q.status === '/quest_status/discarded';
                    // A reused slot may report its new Task before the old
                    // discarded row. Do not let that late terminal row erase
                    // the already observed replacement while payment is pending.
                    if (expectedDiscard && previous?.status === '/quest_status/in_progress'
                        && Number(previous[state.pending.counterField || 'coinRerollCount']) >= state.pending.beforeRerolls + 1) continue;
                    if (!expectedReroll && !expectedDiscard && ['coinRerollCount', 'cowbellRerollCount'].some(field =>
                        previous?.[field] != null && q[field] != null && Number(q[field]) < Number(previous[field]))) continue;
                    state.quests[id] = q;
                    if (q.status === '/quest_status/claimed' && (state.watched[q.actionHrid] || []).includes(id)) settleSale(`quest:${id}`);
                }
                if (message.type === 'discard_random_task') delete state.quests[String(message.discardRandomTaskData?.characterQuestId)];
                if (state.ready && state.enabled) adoptAutomaticTasks();
                finishPending(message);
                if (state.ready) pruneCowbellModes();
                for (const a of message.endCharacterActions || []) if (a.isDone) {
                    delete state.actions[String(a.id)]; state.finished[String(a.id)] = true;
                }
                for (const a of updates) {
                    const id = String(a.id);
                    if (state.owned[id] && !state.settling[id]
                        && (a.isDone || (a === completed && (state.finished[id] || actionRemaining(a) === 0)))) settleSale(`action:${id}`);
                }
                // A different finite queue can release materials held at an
                // earlier Task settlement. Recheck eligible inventory now.
                if (queueFinished) state.recoveryNeeded = true;
                if (isSpamProtection(message)) coolDown();
                else if (message.type === 'error') {
                    if (state.pending) delete state.pending.spamRejectedAt;
                    halt(`游戏返回错误：${message.message || message.errorCode || message.error || '未知错误'}；刷新后按最新状态继续`);
                }
                if (['disconnect', 'socket_closed'].includes(message.type)) {
                    state.ready = false; epoch++;
                    log('连接已断开，等待完整重同步');
                }
                if (state.ready) persist();
                options.onChange?.();
            } catch (error) { state.enabled = false; log(`已暂停：${error.message}`); }
        }
        function plan(ids, includeRelated = true, quantityMultiple = state.job?.quantityMultiple ?? state.quantityMultiple) {
            if (!state.ready || !state.client) throw new Error('请先完整刷新游戏，等待任务、背包、队列与配方全部同步');
            return buildPlan(state, ids, {includeRelated, quantityMultiple});
        }
        function eligibleTasks() {
            return Object.values(state.quests).filter(q => activeQuest(q) && supported(q.actionHrid)
                && integer(q.goalCount) > integer(q.currentCount)
                && taskTokens(q) !== null && taskTokens(q) >= state.minTokens)
                .sort((a, b) => Number(a.id) - Number(b.id));
        }
        function batchStatus() {
            return {eligibleCount: eligibleTasks().length, configuredTarget: state.batchTarget,
                target: state.taskSlotCap > 0 ? Math.min(state.batchTarget, state.taskSlotCap) : state.batchTarget,
                unknownRewards: Object.values(state.quests).filter(q => activeQuest(q) && supported(q.actionHrid)
                    && taskTokens(q) === null).length};
        }
        function initializeSession() {
            if (state.autoSessionInitialized) return;
            state.floors = balances(state.items);
            state.autoSessionInitialized = true;
        }
        function watchBatch() {
            const tasks = state.job.taskIds.map(id => state.quests[id]).filter(q => q && activeQuest(q));
            for (const q of tasks) {
                const watched = state.watched[q.actionHrid] ||= [];
                if (!watched.includes(String(q.id))) watched.push(String(q.id));
            }
            const hrids = new Set(tasks.map(q => q.actionHrid));
            for (const action of Object.values(state.actions)) {
                const id = String(action.id);
                if (!action.isDone && hrids.has(action.actionHrid) && !state.owned[id]) {
                    state.owned[id] = action.actionHrid;
                    state.progress[id] = integer(action.currentCount);
                }
            }
        }
        function newBatch(ids, fixedBatch) {
            initializeSession();
            state.job = {taskIds: ids.map(String), fixedBatch, quantityMultiple: state.quantityMultiple, queuedActionIds: []};
            watchBatch();
            persist();
        }
        function start(ids, config = {}) {
            if (state.pending) throw new Error('上一条请求结果未知，请先刷新游戏再继续');
            if (state.job) throw new Error('已有任务批次，请先继续或结束当前批次');
            const p = plan(ids);
            if (!p.entries.length) throw new Error('没有可处理的生活任务');
            state.sellOutputs = config.sellOutputs !== false;
            newBatch([...new Set(p.entries.flatMap(e => e.taskIds))], state.batchTarget > 1);
            state.enabled = true;
            state.recoveryNeeded = true;
            persist(); log('任务批次已启动');
            return p;
        }
        function startEarly() {
            if (!state.ready || !state.client || state.pending) throw new Error('请等待完整同步及上一条请求确认');
            if (state.job) throw new Error('已有任务批次，请先完成或结束当前批次');
            const eligible = eligibleTasks();
            if (!eligible.length) throw new Error('当前没有达到代币门槛的生活任务');
            newBatch(eligible.slice(0, batchStatus().target).map(q => q.id), true);
            state.enabled = true;
            state.recoveryNeeded = true;
            persist(); log(`提前开工：本批 ${state.job.taskIds.length} 个任务，新任务留到下一批`);
        }
        function adoptAutomaticTasks() {
            if (!state.autoQueue) return;
            initializeSession();
            const eligible = eligibleTasks();
            if (!state.job) {
                if (eligible.length < batchStatus().target) { persist(); return; }
                newBatch(eligible.slice(0, batchStatus().target).map(q => q.id), state.batchTarget > 1);
            }
            // A target of one retains the optional continuous processing mode.
            // Normal batches keep a fixed set even as more Tasks are read.
            if (!state.job.fixedBatch) {
                for (const q of eligible) if (!state.job.taskIds.includes(String(q.id))) state.job.taskIds.push(String(q.id));
            }
            watchBatch();
            persist();
        }
        function canReroll(q) {
            if (q.status !== '/quest_status/in_progress' || q.category !== '/quest_category/random_task'
                || integer(q.currentCount) > 0 || state.job?.taskIds.includes(String(q.id))) return false;
            if (q.actionHrid && (Object.values(state.actions).some(a => a.actionHrid === q.actionHrid && actionRemaining(a) > 0)
                || state.pending?.kind === 'queue' && state.pending.actionHrid === q.actionHrid)) return false;
            return combatQuest(q, state.client) || activeQuest(q) && supported(q.actionHrid)
                && taskTokens(q) !== null && taskTokens(q) < state.minTokens;
        }
        async function rerollNextCombat(candidates = Object.values(state.quests)) {
            if (!state.rerollCombat) return false;
            const task = candidates.find(canReroll);
            if (!task) return false;
            const reason = combatQuest(task, state.client) ? '战斗' : `${taskTokens(task)} 代币低于门槛的`;
            const questId = integer(task.id, '任务 ID');
            if (!questId) throw new Error('任务 ID 无效');
            const coinRerolls = integer(task.coinRerollCount, '金币刷新次数');
            const useCowbells = state.cowbellFallback && (coinRerolls > 20 || state.cowbellTaskIds[String(questId)] === true);
            const counterField = useCowbells ? 'cowbellRerollCount' : 'coinRerollCount';
            if (useCowbells) {
                state.cowbellTaskIds[String(questId)] = true;
                persist();
                if (task.cowbellRerollCount == null) { log(`等待 Task ${questId} 的 Cowbell 刷新次数同步`); return true; }
            }
            const beforeRerolls = integer(task[counterField], '刷新次数');
            const currency = useCowbells ? 'cowbell' : 'coin', label = useCowbells ? 'Cowbell' : '金币';
            const count = useCowbells ? rerollCowbellCost(beforeRerolls) : rerollCoinCost(beforeRerolls);
            const k = `${useCowbells ? COWBELL : COIN}::0`, stock = balances(state.items), before = stock[k] || 0;
            const {reserved, unbounded} = reservedInputs(state.actions, state.client, {allowUnknownBackground: true});
            // Keep known finite reservations without freezing the entire coin
            // balance for indefinite enhancement costs.
            const reservedCurrency = reserved[k] || 0;
            const available = Math.max(0, before - reservedCurrency);
            if (available < count) {
                if (useCowbells) {
                    const bagKey = `${COWBELL_BAG}::0`;
                    const bag = inventoryRows(state.items).find(row => row.itemHrid === COWBELL_BAG
                        && !Number(row.enhancementLevel || 0) && !row.isLocked && integer(row.count) > 0);
                    const bagsAvailable = Math.max(0, (stock[bagKey] || 0) - (reserved[bagKey] || 0));
                    if (bag && bagsAvailable > 0 && !unbounded.has(bagKey)) {
                        log(`Task ${questId} 本次需要 ${count} Cowbell，可用 ${available}；打开 1 个 Bag of 10 Cowbells，等待扣袋及到账确认`);
                        await write({kind: 'open_bag', itemKey: bagKey, before: stock[bagKey] || 0, count: 1, hash: bag.hash,
                            cowbellKey: k, cowbellBefore: before, bagConfirmed: false, cowbellsConfirmed: false},
                            {type: 'open_loot', openLootData: {itemHash: bag.hash, count: 1}});
                        return true;
                    }
                    log(`等待 Cowbell：Task ${questId} 本次需要 ${count}，可用 ${available}，缺少 ${count - available}；背包没有可用的未锁定 10 铃包`);
                    return true;
                }
                log(`等待金币刷新${reason} Task ${questId}：本次需要 ${count} 金币，库存 ${before}，有限队列预留 ${reservedCurrency}，可用 ${available}`);
                return true;
            }
            log(`${reason} Task ${questId}：用 ${count} ${label}刷新，等待任务及扣款确认`);
            await write({kind: 'reroll', currency, counterField, questId: String(questId), beforeRerolls,
                beforeQuestIds: Object.keys(state.quests), candidateIds: {}, oldDiscarded: false,
                coinsConfirmed: false, itemKey: k, before, count}, {type: 'reroll_random_task', rerollRandomTaskData: {
                characterQuestId: questId, useMooPass: false, useCowbells, currentRerollCount: beforeRerolls}});
            return true;
        }
        async function write(operation, payload) {
            if (!state.enabled || !state.ready || state.pending || now() < state.cooldownUntil) return;
            if (!['buy_from_shop', 'new_character_action', 'sell_to_shop', 'claim_character_quest', 'read_random_tasks', 'reroll_random_task', 'open_loot'].includes(payload.type)) throw new Error('不允许的写入类型');
            if (payload.type === 'sell_to_shop') {
                const data = payload.sellToShopData, row = state.items[data?.itemHash];
                if (operation.kind !== 'sell' || !data || operation.hash !== data.itemHash
                    || !isSaleRow(row, operation.itemKey) || !Number.isSafeInteger(data.count) || data.count <= 0
                    || data.count !== operation.count || data.count > Number(row.count)) {
                    throw new Error('出售校验失败：仅允许字段与物品标识一致的未锁定 +0 装备、资源或 Super 茶／咖啡；Food、其他饮料和贤者镜不出售');
                }
                log(`卖店请求：${row.itemHrid.split('/').pop()} +0 × ${data.count}`);
            }
            state.pending = {...operation, inventoryRevision, sentAt: now()};
            persist(); // Durable intent must precede sending a request.
            writing = true;
            try { options.send({...payload, ts: now()}); lastSent = now(); }
            finally { writing = false; }
        }
        function effectiveSaleFloor(k) {
            const [itemHrid, level] = k.split('::');
            return level === '0' && canSellItem(itemHrid) ? 0 : state.floors[k] || 0;
        }
        function saleReservations() {
            const {reserved} = planningInputs(state.actions, state.client);
            const taskIds = new Set(state.job?.taskIds || []);
            if (taskIds.size) {
                const taskMultiples = Object.fromEntries((state.job?.taskIds || []).map(id => [id, state.job.quantityMultiple]));
                const p = buildPlan(state, [...taskIds], {includeRelated: false, quantityMultiple: state.quantityMultiple, taskMultiples, includePurchases: false});
                for (const e of p.entries) for (const [k, n] of Object.entries(e.inputs)) add(reserved, k, n);
            }
            return reserved;
        }
        function saleLimits(k, cache) {
            cache.reserved ||= saleReservations();
            return {floor: effectiveSaleFloor(k), needed: cache.reserved[k] || 0};
        }
        function previewSurplus() {
            if (!state.ready || !state.client) throw new Error('请等待角色、物品和配方完整同步');
            const result = {characterId: state.characterId, rows: []};
            if (!state.autoSessionInitialized) return result;
            // Cleanup follows inventory categories, including old stock that
            // was never attributed to a Task. Unknown categories are excluded.
            const keys = new Set(inventoryRows(state.items).filter(row => isSaleRow(row, itemKey(row))).map(itemKey));
            const stock = zeroInventoryBalances(), cache = {};
            for (const k of keys) {
                const [itemHrid, level] = k.split('::');
                if (level !== '0' || !canSellItem(itemHrid)) continue;
                const row = inventoryRows(state.items).find(r => isSaleRow(r, k));
                if (!row) continue;
                const limits = saleLimits(k, cache);
                const {floor, needed} = limits, known = state.credits[k] || 0;
                const count = Math.max(0, Math.min(row.count, (stock[k] || 0) - floor - needed) - known);
                if (count) result.rows.push({itemKey: k, itemHrid, hash: row.hash, count, stock: stock[k], floor, reserved: needed, known});
            }
            return result;
        }
        function recoverSurplus() {
            if (state.pending) throw new Error('上一条请求尚未确认，稍后再核对补卖余量');
            const {rows} = previewSurplus();
            // Authorize only the current eligible inventory surplus at this
            // cleanup boundary. Existing credits include unsettled production,
            // so preview subtracts them to avoid selling later output early.
            for (const row of rows) {
                add(state.credits, row.itemKey, row.count);
                add(state.saleCredits, row.itemKey, row.count);
            }
            state.recoveryNeeded = false;
            persist();
            if (rows.length) log(`已核对分类库存：${rows.length} 种 +0 装备、资源或 Super 茶／咖啡加入出售；Food、其他饮料、贤者镜和强化物品保留`);
            return rows;
        }
        function nextSale() {
            if (!Object.entries(state.saleCredits).some(([k, n]) => n > 0 && state.credits[k] > 0)) return null;
            const stock = zeroInventoryBalances();
            const cache = {};
            for (const [k, credit] of Object.entries(state.credits)) {
                if (!credit || !state.saleCredits[k]) continue;
                const [itemHrid, level] = k.split('::');
                if (level !== '0' || !canSellItem(itemHrid)) continue;
                const limits = saleLimits(k, cache);
                const count = Math.min(credit, state.saleCredits[k], Math.max(0, (stock[k] || 0) - limits.floor - limits.needed));
                const row = inventoryRows(state.items).find(r => isSaleRow(r, k) && r.count >= count);
                if (row && count > 0) return {kind: 'sell', itemKey: k, count, before: stock[k], hash: row.hash};
            }
            return null;
        }
        async function buyTaskInputs(inputs, reserved) {
            const stock = balances(state.items);
            for (const [k, needed] of Object.entries(inputs)) {
                const shortage = Math.max(0, needed + (reserved[k] || 0) - (stock[k] || 0));
                if (!shortage) continue;
                const [itemHrid, level] = k.split('::');
                if (itemHrid === COIN) throw new Error('金币不足，无法从测试商店补充金币');
                const listing = findTesterShop(state.client, itemHrid);
                if (!listing || !validShopCosts(listing.shop)) throw new Error(`测试商店没有对应商品或价格尚未同步：${itemHrid}`);
                const {shopItemHrid, shop} = listing;
                for (const cost of shop.costs) {
                    const costKey = itemKey(cost), price = integer(cost.count) * shortage;
                    if (price > (stock[costKey] || 0) - (reserved[costKey] || 0) - (inputs[costKey] || 0)) throw new Error(`购买材料的货币不足：${cost.itemHrid}`);
                }
                await write({kind: 'buy', itemKey: k, before: stock[k] || 0, count: shortage}, {
                    type: 'buy_from_shop', buyFromShopData: {shopItemHrid, enhancementLevel: Number(level), count: shortage}});
                return true;
            }
            return false;
        }
        async function tick() {
            reconcileSpamBackoff();
            if (busy || !state.enabled || !state.ready || !state.client) return;
            if (now() < state.cooldownUntil) return;
            if (state.pending) {
                if (now() - state.pending.sentAt > 20000) halt('请求回执超时，已暂停。刷新后按任务和背包实际状态继续，避免重复提交');
                return;
            }
            if (Object.keys(state.settling).length) {
                if (Object.values(state.settling).some(s => now() - s.since > 20000)) halt('队列结束消息已到，任务进度回执仍缺失；请刷新后继续');
                else log('等待已结束动作的任务进度回执，避免重复排队');
                return;
            }
            if (now() - lastSent < 1000) return;
            busy = true;
            let release;
            const savedEpoch = epoch;
            try {
                release = await (options.coordinator?.acquire('task-queue') || Promise.resolve(() => {}));
                if (savedEpoch !== epoch || !state.enabled || !state.ready || state.pending || now() < state.cooldownUntil) return;
                initializeSession();
                adoptAutomaticTasks();
                if (state.autoClaim) {
                    const completedTask = Object.values(state.quests).find(q => q.category === '/quest_category/random_task' && q.status === '/quest_status/completed');
                    if (completedTask) {
                        const questId = integer(completedTask.id, '任务 ID');
                        if (!questId) throw new Error('任务 ID 无效');
                        await write({kind: 'claim', questId: String(questId)}, {type: 'claim_character_quest', claimCharacterQuestData: {characterQuestId: questId}});
                        return;
                    }
                }
                const occupiedSlots = Object.values(state.quests).filter(q => q.category === '/quest_category/random_task'
                    && ['/quest_status/in_progress', '/quest_status/completed'].includes(q.status)).length;
                if (state.autoRead && state.isTutorialCompleted && state.unreadTaskCount > 0
                    && !(state.taskSlotCap > 0 && occupiedSlots >= state.taskSlotCap)) {
                    await write({kind: 'read', beforeUnread: state.unreadTaskCount}, {type: 'read_random_tasks'});
                    return;
                }
                if (state.sellOutputs) {
                    if (state.recoverSurplus && state.recoveryNeeded) {
                        try { recoverSurplus(); } catch (error) {
                            // Unknown background costs can defer sales without
                            // blocking Task purchases or rerolls while batching.
                            if (!state.job && error.code !== 'BACKGROUND_RECIPE_UNAVAILABLE') throw error;
                        }
                    }
                    let sale;
                    try { sale = nextSale(); } catch (error) {
                        if (!state.job && error.code !== 'BACKGROUND_RECIPE_UNAVAILABLE') throw error;
                    }
                    if (sale) {
                        await write(sale, {type: 'sell_to_shop', sellToShopData: {itemHash: sale.hash, count: sale.count}});
                        return;
                    }
                }
                if (!state.job) {
                    if (!await rerollNextCombat()) {
                        const status = batchStatus();
                        log(`攒批中：合格任务 ${status.eligibleCount} / ${status.target}${status.target < status.configuredTarget ? `（角色槽位上限 ${state.taskSlotCap}；设置 ${status.configuredTarget}）` : ''}${status.unknownRewards ? `；${status.unknownRewards} 个任务奖励未同步` : ''}，可点击“提前开工”`);
                    }
                    return;
                }
                const p = plan(state.job.taskIds, false);
                for (const e of p.entries) for (const id of e.actionIds) state.owned[id] = e.actionHrid;
                // Actions cannot address a specific Task. An older outside
                // Task of the same action may consume the new queue's work.
                // Resolve that prerequisite before appending that action;
                // unrelated actions in this batch can still proceed.
                const predecessors = e => state.job.fixedBatch ? Object.values(state.quests).filter(q => activeQuest(q)
                    && q.actionHrid === e.actionHrid && Number(q.id) < Number(e.taskIds[0])
                    && !state.job.taskIds.includes(String(q.id))) : [];
                const needed = p.entries.filter(e => e.count > 0);
                const entry = needed.find(e => !predecessors(e).length);
                if (!entry && needed.length) {
                    const blockedBy = [...new Map(needed.flatMap(predecessors).map(q => [String(q.id), q])).values()];
                    if (!await rerollNextCombat(blockedBy)) {
                        log(`等待同动作前置 Task ${blockedBy.map(q => q.id).join('、')} 处理完成；已有进度、队列覆盖或奖励未知时保留。可结束待排批次后手动纳入这些任务`);
                    }
                    return;
                }
                if (!entry) {
                    const tailsRunning = state.job.queuedActionIds.some(id => state.actions[id] && actionRemaining(state.actions[id]) > 0);
                    if (!p.entries.length && !tailsRunning) { state.job = null; persist(); }
                    if (await rerollNextCombat()) return;
                    log(!p.entries.length ? (tailsRunning ? '本批任务已完成，等待补齐队列结束后结算产出' : '本批任务已完成；继续产出监控与任务自动处理')
                        : '本批任务已被队列覆盖，等待执行并监控产出');
                    return;
                }
                if (!state.cap || Object.keys(state.actions).length >= state.cap) {
                    if (!await rerollNextCombat()) log('队列已满，等待空位后继续追加到队尾');
                    return;
                }
                // Bind the skill loadout to the appended action; the game
                // applies it when the existing queue reaches this Task.
                const loadout = loadoutFor(entry.actionHrid);
                // Recheck only the next Task's shortage. Each purchase and
                // append still waits for its exact acknowledgement.
                const {reserved} = planningInputs(state.actions, state.client);
                if (await buyTaskInputs(entry.inputs, reserved)) return;
                const primaryItemHash = entry.upgradeItemHrid
                    ? inventoryRows(state.items).find(r => r.itemHrid === entry.upgradeItemHrid && !r.enhancementLevel && r.count > 0)?.hash
                    : '';
                if (entry.upgradeItemHrid && !primaryItemHash) throw new Error('升级配方的 +0 主物品尚未到货');
                await write({kind: 'queue', actionHrid: entry.actionHrid, count: entry.count, primaryItemHash,
                    characterLoadoutId: loadout.id, loadoutName: loadout.name, beforeIds: Object.keys(state.actions)}, {type: 'new_character_action', newCharacterActionData: {
                        actionHrid: entry.actionHrid, difficultyTier: 0, hasMaxCount: true, maxCount: entry.count,
                        primaryItemHash, secondaryItemHash: '', enhancingMaxLevel: 0, enhancingProtectionMinLevel: 0,
                        characterLoadoutId: loadout.id, isStartNow: false, confirmedActionValueWarning: false}});
            } catch (error) { halt(`已暂停：${error.message}`); }
            finally {
                // Keep the shared lane until a response arrives, including on
                // user pause. Releasing at send time could misattribute errors.
                if ((state.pending || now() < state.cooldownUntil) && release && options.setTimeout) {
                    const pending = state.pending;
                    const awaitAck = () => {
                        reconcileSpamBackoff();
                        if (state.ready && now() < state.cooldownUntil) { options.setTimeout(awaitAck, 100); return; }
                        if (!pending || state.pending !== pending || !state.ready || now() - pending.sentAt > 20000) {
                            if (pending && state.pending === pending && state.ready) halt('请求回执超时，请刷新后继续');
                            release(); busy = false;
                        } else options.setTimeout(awaitAck, 100);
                    };
                    options.setTimeout(awaitAck, 100);
                } else { release?.(); busy = false; }
            }
        }
        return {state, receive, plan, start, startEarly, batchStatus, tick, nextSale, loadoutFor, previewSurplus, recoverSurplus,
            isWriting: () => writing,
            observeExternalRequest() {
                if (state.pending) { state.pending.externalOverlap = true; persist(); }
            },
            configureTasks(config = {}) {
                const numeric = {};
                for (const k of ['minTokens', 'batchTarget', 'quantityMultiple']) if (config[k] != null) {
                    numeric[k] = integer(config[k], k);
                    if (k !== 'minTokens' && !numeric[k]) throw new Error('攒够任务数与数量补齐倍数必须大于 0');
                }
                Object.assign(state, numeric);
                if ((config.recoverSurplus === true && !state.recoverSurplus) || (config.sellOutputs === true && !state.sellOutputs)) state.recoveryNeeded = true;
                for (const k of ['autoClaim', 'autoRead', 'autoQueue', 'rerollCombat', 'cowbellFallback', 'sellOutputs', 'recoverSurplus']) if (typeof config[k] === 'boolean') state[k] = config[k];
                pruneCowbellModes();
                persist(); options.onChange?.();
            },
            stop() { halt('已暂停；已发送的购买和游戏队列保留'); },
            resume() {
                if (!state.ready || !state.client || state.pending) throw new Error('请刷新并等待完整同步后继续');
                state.enabled = true; state.recoveryNeeded = true;
                initializeSession(); adoptAutomaticTasks(); persist(); log('自动处理已启动，将按面板开关持续处理现有及新增任务');
            },
            clear() {
                if (state.pending) throw new Error('请求未确认，请先刷新核对');
                state.job = null; state.enabled = false; persist(); log('已结束本地待排批次；游戏队列保留');
            }};
    }

    const exports = {buildPlan, requirements, createController, actionRemaining, rerollCoinCost, rerollCowbellCost, taskTokens};
    if (typeof module === 'object' && module.exports) { module.exports = exports; return; }
    if (!['test.milkywayidle.com', 'test.milkywayidlecn.com'].includes(window.location.hostname)) return;
    if (window.__MWI_TASK_QUEUE_LOADED__) return;
    window.__MWI_TASK_QUEUE_LOADED__ = VERSION;

    // Browser integration is below; core stays independently testable.
    const sharedKey = Symbol.for('MWI_SHARED_AUTOMATION_COORDINATOR_V1');
    let shared = window[sharedKey];
    if (shared && (shared.schema !== 1 || typeof shared.acquire !== 'function'
        || typeof shared.publishSocket !== 'function')) return;
    if (!shared) {
        shared = {schema: 1, socket: null, holder: null, waiters: [], socketSubscribers: new Set(),
            acquire(owner) { return new Promise(resolve => { this.waiters.push({owner, resolve, token: Symbol(owner)}); this.grantNext(); }); },
            grantNext() {
                if (this.holder || !this.waiters.length) return;
                const ticket = this.waiters.shift(); this.holder = ticket;
                ticket.resolve(() => { if (this.holder === ticket) { this.holder = null; this.grantNext(); } });
            },
            publishSocket(ws) {
                this.socket = ws || null;
                for (const fn of this.socketSubscribers) { try { fn(this.socket); } catch { /* isolate subscribers */ } }
            },
            subscribeSocket(fn) { this.socketSubscribers.add(fn); if (this.socket) fn(this.socket); return () => this.socketSubscribers.delete(fn); }};
        Object.defineProperty(window, sharedKey, {value: shared});
    } else if (typeof shared.subscribeSocket !== 'function') {
        // Upgrade early enhancer coordinators without replacing their lock.
        const subscribers = new Set(), publish = shared.publishSocket;
        shared.publishSocket = function (ws) {
            const result = publish.call(this, ws); this.socket = ws || null;
            for (const fn of subscribers) { try { fn(this.socket); } catch { /* isolate subscribers */ } }
            return result;
        };
        shared.subscribeSocket = function (fn) { subscribers.add(fn); if (this.socket) fn(this.socket); return () => subscribers.delete(fn); };
    }
    let socket = null, panel = null, paintPending = false;
    const controller = createController({storage: window.localStorage, coordinator: shared,
        send: message => {
            if (!socket || socket.readyState !== 1 || !isGameSocket(socket)) throw new Error('游戏连接未就绪');
            if (pageCharacterId() !== controller.state.characterId) throw new Error('页面角色已切换，请刷新后重试');
            socket.send(JSON.stringify(message));
        }, setTimeout: window.setTimeout.bind(window), onChange: () => {
            if (paintPending || !panel) return;
            paintPending = true; window.setTimeout(() => { paintPending = false; render(); }, 150);
        }});
    const attached = new WeakSet(), retired = new WeakSet(), seen = new WeakSet();
    const expectedHost = window.location.hostname.replace(/^test\./, 'api-test.');
    const enhancerSendMarker = Symbol.for('MWI_SAFE_ENHANCER_SEND_HOOK_V1');
    const ownCaptureMarker = Symbol.for('MWI_TASK_QUEUE_SEND_CAPTURE_V1');
    function pageCharacterId() {
        try {
            const id = new URL(window.location.href).searchParams.get('characterId');
            return /^[1-9]\d*$/.test(id || '') ? id : '';
        } catch { return ''; }
    }
    function isGameSocket(ws) {
        if (!ws || typeof ws.url !== 'string' || !pageCharacterId()) return false;
        try { const u = new URL(ws.url); return u.protocol === 'wss:' && u.hostname === expectedHost
            && u.port === '' && u.pathname === '/ws' && u.searchParams.get('characterId') === pageCharacterId(); } catch { return false; }
    }
    function versionMs(value) {
        if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
        if (typeof value !== 'string' || !value) return null;
        const ms = /^\d+$/.test(value) ? Number(value) : new Date(value).getTime();
        return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
    }
    function completeClientData(message) {
        return message?.type === 'init_client_data' && ['actionDetailMap', 'itemDetailMap', 'shopItemDetailMap'].every(key => {
            const value = message[key]; return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
        });
    }
    /*
     * Minimal LZ-String UTF-16 decoder (MIT, pieroxy/lz-string).
     * The game stores init_client_data in localStorage with
     * compressToUTF16. Keeping the decoder here makes the userscript
     * standalone and avoids a network-time @require dependency.
     */
    function decompressLzStringUtf16(compressed) {
        if (compressed == null) return '';
        if (typeof compressed !== 'string' || compressed.length === 0) {
            return null;
        }
        for (let index = 0; index < compressed.length; index++) {
            if (compressed.charCodeAt(index) < 32) return null;
        }

        const dictionary = [0, 1, 2];
        let enlargeIn = 4;
        let dictionarySize = 4;
        let numberOfBits = 3;
        let entry = '';
        const result = [];
        const data = {
            value: compressed.charCodeAt(0) - 32,
            position: 16384,
            index: 1,
        };

        const readBits = (bitCount) => {
            let bits = 0;
            let power = 1;
            const maxPower = 2 ** bitCount;
            while (power !== maxPower) {
                const valueBit = data.value & data.position;
                data.position >>= 1;
                if (data.position === 0) {
                    data.position = 16384;
                    if (data.index >= compressed.length) {
                        data.value = 0;
                    } else {
                        data.value =
                            compressed.charCodeAt(data.index) - 32;
                    }
                    data.index++;
                }
                if (valueBit > 0) bits |= power;
                power *= 2;
            }
            return bits;
        };

        let next = readBits(2);
        let character;
        if (next === 0) {
            character = String.fromCharCode(readBits(8));
        } else if (next === 1) {
            character = String.fromCharCode(readBits(16));
        } else if (next === 2) {
            return '';
        } else {
            return null;
        }
        dictionary[3] = character;
        let previous = character;
        result.push(character);

        while (data.index <= compressed.length) {
            let code = readBits(numberOfBits);
            if (code === 0) {
                dictionary[dictionarySize++] =
                    String.fromCharCode(readBits(8));
                code = dictionarySize - 1;
                enlargeIn--;
            } else if (code === 1) {
                dictionary[dictionarySize++] =
                    String.fromCharCode(readBits(16));
                code = dictionarySize - 1;
                enlargeIn--;
            } else if (code === 2) {
                return result.join('');
            }

            if (enlargeIn === 0) {
                enlargeIn = 2 ** numberOfBits;
                numberOfBits++;
            }

            if (dictionary[code] != null) {
                entry = dictionary[code];
            } else if (code === dictionarySize) {
                entry = previous + previous.charAt(0);
            } else {
                return null;
            }
            result.push(entry);

            dictionary[dictionarySize++] =
                previous + entry.charAt(0);
            enlargeIn--;
            previous = entry;

            if (enlargeIn === 0) {
                enlargeIn = 2 ** numberOfBits;
                numberOfBits++;
            }
        }
        return null;
    }

    function restoreClientCache(ws) {
        try {
            const expected = versionMs(new URL(ws.url).searchParams.get('versionTimestamp'));
            if (!expected) return false;
            const raw = window.localStorage.getItem('initClientData');
            if (!raw) return false;
            // The official client falls back to plain JSON when compression fails.
            const cached = JSON.parse(raw.trimStart().startsWith('{') ? raw : decompressLzStringUtf16(raw));
            if (!completeClientData(cached) || versionMs(cached.versionTimestamp) !== expected) return false;
            controller.receive(cached); return true;
        } catch { return false; }
    }
    function wrongCharacter(message) {
        const expected = pageCharacterId();
        if (message.type === 'init_character_data' && String(message.character?.id || '') !== expected) return true;
        for (const key of ['characterItems', 'endCharacterItems', 'updatedCharacterItems', 'characterActions', 'endCharacterActions', 'characterQuests', 'endCharacterQuests']) {
            for (const row of Array.isArray(message[key]) ? message[key] : []) {
                const owner = row?.characterID ?? row?.characterId;
                if (owner != null && String(owner) !== expected) return true;
                if (key.includes('Items') && (typeof row?.hash !== 'string' || row.hash.split('::')[0] !== expected)) return true;
            }
        }
        return false;
    }
    function incoming(ws, event, rawData) {
        if (ws !== socket || retired.has(ws) || !isGameSocket(ws) || seen.has(event)) return;
        seen.add(event);
        let message;
        try { message = JSON.parse(rawData); } catch { return; }
        if (!message || typeof message.type !== 'string') return;
        if (wrongCharacter(message)) {
            controller.receive({type: 'socket_closed'});
            controller.stop(); return;
        }
        if (message.type === 'init_client_data') {
            if (!completeClientData(message)) { controller.state.client = null; return; }
        }
        if (message.type === 'close_session') {
            retired.add(ws); controller.state.client = null;
            controller.receive({type: 'socket_closed'}); return;
        }
        controller.receive(message);
    }
    function observeOutgoing(ws, data) {
        if (ws !== socket || !isGameSocket(ws) || controller.isWriting() || !controller.state.ready || !controller.state.pending) return;
        try {
            const type = JSON.parse(data).type;
            if (typeof type === 'string' && !['ping', 'pong'].includes(type)) controller.observeExternalRequest();
            if (typeof type === 'string' && !['ping', 'pong'].includes(type) && !type.startsWith('get_')) {
                controller.stop();
                // No request id exists: do not confirm our operation from a
                // manual write's response; force a full reconciliation instead.
                controller.receive({type: 'socket_closed'});
            }
        } catch { /* non-JSON traffic cannot be attributed */ }
    }
    function attach(ws, source = 'observed') {
        if (!isGameSocket(ws) || retired.has(ws) || attached.has(ws)) return;
        // A late message from an unknown old connection must not displace a
        // live socket. Constructor/shared publications identify replacements.
        if (source === 'observed' && socket && socket.readyState < 2) return;
        if (socket && socket !== ws) retired.add(socket);
        attached.add(ws); socket = ws;
        controller.state.client = null;
        controller.receive({type: 'socket_closed'});
        restoreClientCache(ws);
        ws.addEventListener('message', e => incoming(ws, e, e.data));
        ws.addEventListener('close', () => {
            retired.add(ws);
            if (socket === ws) { controller.state.client = null; controller.receive({type: 'socket_closed'}); }
        });
        ws.addEventListener('error', () => { if (socket === ws) controller.receive({type: 'socket_closed'}); });
        if (shared.socket !== ws) shared.publishSocket(ws);
    }
    const OriginalWebSocket = window.WebSocket;
    const prototype = OriginalWebSocket.prototype;
    // The enhancer requires its send observer to remain the prototype's top
    // layer. If enhancer installed first, manual outgoing observation is not
    // available; shared transaction serialization and exact response matching
    // still apply. Never replace the enhancer hook to add that observation.
    if (!prototype[enhancerSendMarker] && !prototype.send[ownCaptureMarker]) {
        const previousSend = prototype.send;
        const capture = function (data) { attach(this); observeOutgoing(this, data); return previousSend.apply(this, arguments); };
        Object.defineProperty(capture, ownCaptureMarker, {value: true});
        prototype.send = capture;
    }
    const PatchedWebSocket = new Proxy(OriginalWebSocket, {construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget === PatchedWebSocket ? target : newTarget);
        attach(ws, 'constructor'); return ws;
    }});
    window.WebSocket = PatchedWebSocket;
    const dataDescriptor = Object.getOwnPropertyDescriptor(window.MessageEvent.prototype, 'data');
    if (dataDescriptor?.get && dataDescriptor.configurable) {
        Object.defineProperty(window.MessageEvent.prototype, 'data', {...dataDescriptor, get() {
            const value = dataDescriptor.get.call(this);
            const ws = this.currentTarget || this.target;
            if (isGameSocket(ws)) { attach(ws); incoming(ws, this, value); }
            return value;
        }});
    }
    shared.subscribeSocket?.(ws => attach(ws, 'shared'));
    if (shared.socket) attach(shared.socket, 'shared');
    if (globalThis.__MWI_TASK_QUEUE_RUNTIME_TEST_MODE__) {
        globalThis.__MWI_TASK_QUEUE_RUNTIME_TEST_EXPORTS__ = {
            controller, shared, attach, incoming, restoreClientCache, decompressLzStringUtf16,
            get socket() { return socket; }
        };
        return;
    }

    const selected = new Set();
    const escape = text => String(text).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    function render() {
        if (!panel) return;
        const s = controller.state;
        const batch = controller.batchStatus();
        const cooling = Date.now() < s.cooldownUntil;
        panel.querySelector('#status').textContent = `${s.enabled ? cooling ? '限频等待（至少 5 秒）' : '运行中' : '已暂停'} · ${s.ready && s.client ? '同步完成' : '等待完整同步'} · 队列 ${Object.keys(s.actions).length}/${s.cap || '?'} · 未读 Task ${s.unreadTaskCount ?? '?'}\n合格任务 ${batch.eligibleCount} / ${batch.target}${batch.target < batch.configuredTarget ? `（设置 ${batch.configuredTarget}，受角色槽位上限限制）` : ''}${s.job ? ` · 本批 ${s.job.taskIds.length} 个任务，数量按 ${s.job.quantityMultiple} 补齐` : ' · 等待攒批'}\n${s.message}`;
        for (const k of ['minTokens', 'batchTarget', 'quantityMultiple']) {
            const input = panel.getElementById(k);
            if (input.dataset.character !== s.characterId || !input.dataset.dirty) {
                input.value = s[k]; input.dataset.character = s.characterId; delete input.dataset.dirty;
            }
        }
        panel.querySelector('#autoClaim').checked = s.autoClaim;
        panel.querySelector('#autoRead').checked = s.autoRead;
        panel.querySelector('#autoQueue').checked = s.autoQueue;
        panel.querySelector('#rerollCombat').checked = s.rerollCombat;
        panel.querySelector('#cowbellFallback').checked = s.cowbellFallback;
        panel.querySelector('#sell').checked = s.sellOutputs;
        panel.querySelector('#recoverSurplus').checked = s.recoverSurplus;
        const tasks = Object.values(s.quests).filter(q => q.category === '/quest_category/random_task' && !['/quest_status/claimed', '/quest_status/discarded'].includes(q.status));
        panel.querySelector('#tasks').innerHTML = tasks.map(q => {
            const valid = activeQuest(q) && supported(q.actionHrid);
            const tokens = taskTokens(q), inBatch = s.job?.taskIds.includes(String(q.id));
            const qualified = valid && tokens !== null && tokens >= s.minTokens;
            const name = s.client?.actionDetailMap?.[q.actionHrid]?.name || q.actionHrid || q.monsterHrid || 'Task';
            const note = q.status === '/quest_status/completed' ? ' · 已完成，待领取奖励'
                : inBatch ? ' · 本批任务'
                    : combatQuest(q, s.client || {}) ? (s.rerollCombat ? ' · 等待按策略刷新' : ' · 战斗任务不入队')
                        : valid && tokens === null ? ' · 奖励数据未知，等待同步'
                            : valid && !qualified ? (Number(q.currentCount) > 0 ? ' · 已有进度，保留待手动处理' : ' · 低于门槛，已有队列覆盖则保留，否则等待刷新')
                                : qualified && s.autoQueue ? ' · 合格，等待开工' : valid ? '' : ' · 此任务暂不自动排队';
            let loadoutNote = '';
            if (valid) {
                try {
                    const loadout = controller.loadoutFor(q.actionHrid);
                    loadoutNote = ` · 新队列配装：${loadout.name}`;
                    if (Object.values(s.actions).some(a => a.actionHrid === q.actionHrid && actionRemaining(a) > 0
                        && actionLoadoutId(a) !== loadout.id)) loadoutNote += ' · 已有队列配装不同';
                } catch (error) { loadoutNote = ` · ${error.message}`; }
            }
            return `<label class="task"><input type="checkbox" value="${escape(q.id)}" ${(qualified && s.autoQueue) || inBatch || selected.has(String(q.id)) ? 'checked' : ''} ${valid && !s.autoQueue ? '' : 'disabled'}><span>${escape(name.split('/').pop())}<small>${escape(q.currentCount)} / ${escape(q.goalCount)} · ${tokens ?? '?'} 代币${note}${escape(loadoutNote)}</small></span></label>`;
        }).join('') || `<p>${s.ready ? '当前没有已读取的 Task。运行时会持续读取、处理新任务。' : '等待 Task 列表。安装后请完整刷新游戏。'}</p>`;
        panel.querySelector('#log').textContent = s.logs.join('\n');
        panel.querySelector('#start').disabled = !!s.job || !!s.pending;
        panel.querySelector('#early').disabled = !s.ready || !s.client || !!s.job || !!s.pending || !batch.eligibleCount;
    }
    function mount() {
        if (!document.body) { window.setTimeout(mount, 100); return; }
        const host = document.createElement('div'); document.body.append(host);
        panel = host.attachShadow({mode: 'open'});
        panel.innerHTML = `<style>
            :host{font:14px/1.5 system-ui,sans-serif;color:#e8ecf4}*{box-sizing:border-box}
            button,input{font:inherit}button{cursor:pointer;background:#374766;color:white;border:1px solid #617599;border-radius:6px;padding:7px 10px}button:disabled{opacity:.5;cursor:default}
            #toggle{position:fixed;right:14px;top:240px;z-index:2147483643;background:#7350a2}
            #box{position:fixed;right:18px;top:65px;width:min(560px,calc(100vw - 36px));max-height:calc(100vh - 90px);overflow:auto;z-index:2147483646;background:#182333;border:1px solid #76618f;border-radius:12px;padding:18px;box-shadow:0 10px 45px #0009}
            [hidden]{display:none!important}h2{margin:0 0 10px;font-size:18px}#close{float:right;padding:2px 9px}p{margin:10px 0;color:#c0ccdd}#status{white-space:pre-line;background:#24344b;padding:10px;border-radius:6px}
            .task{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #344155}.task input{width:16px}small{display:block;color:#aebbd0}.buttons{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto;font-size:12px}#preview{background:#253348;padding:10px}#start,#early{background:#69508f}.policy{display:flex;gap:10px;flex-wrap:wrap}.policy label{display:flex;flex-direction:column}.policy input{width:130px;color:white;background:#24344b;border:1px solid #617599;padding:4px}
            </style><button id="toggle">📋 Task 队列</button><section id="box" hidden>
            <button id="close" aria-label="关闭">×</button><h2>Task 任务队列 v${VERSION}</h2><div id="status"></div>
            <p>启动一次，持续 Read → 刷新战斗或低奖励任务 → 合格任务攒批开工 → 领取奖励、结算卖店。</p>
            <div class="policy"><label>最低任务代币<input id="minTokens" type="number" min="0" step="1"></label><label>攒够任务数<input id="batchTarget" type="number" min="1" step="1"></label><label>数量补齐倍数<input id="quantityMultiple" type="number" min="1" step="1"></label></div>
            <div class="buttons"><button id="savePolicy">保存策略</button></div><small>默认 25 / 48 / 3。保存后作用于下批；当前批次保留原补齐倍数。任务槽位不足时按角色上限开工。</small>
            <p><label><input type="checkbox" id="autoRead" checked> 有新任务时自动 Read</label><br>
            <label><input type="checkbox" id="autoQueue" checked> 合格生活任务攒够后自动入队</label><br>
            <label><input type="checkbox" id="rerollCombat" checked> 自动刷新战斗或低于代币门槛的任务</label><br>
            <label><input type="checkbox" id="cowbellFallback" checked> 金币刷新超过 20 次后改用 Cowbell，不足时自动开 10 铃包</label><br>
            <label><input type="checkbox" id="autoClaim" checked> 自动领取已完成 Task 的奖励</label><br>
            <label><input type="checkbox" id="sell" checked> 自动出售（总开关）：结算时集中卖店</label><br>
            <label><input type="checkbox" id="recoverSurplus" checked> 启动、重连或结算后，按分类清理背包库存</label></p>
            <div class="buttons"><button id="resume">启动全自动</button><button id="early">提前开工</button><button id="pause">暂停</button><button id="clear">结束待排批次</button></div>
            <small>按每个任务的刷新次数判断；已金币刷新 21 次后，下次开始用 Cowbell。Cowbell 每次费用为 1 / 2 / 4 / 8 / 16 / 32，之后保持 32；不足时每次开 1 袋，到账后再核算。没有可用铃包时等待。</small>
            <p>每个 Task 最多一条队列。默认 1–3 次补到 3，4–6 次补到 6，100 次补到 102；同动作多出的次数会抵扣后续任务。材料从 shop-tester 按补齐后的数量购买。</p>
            <p>补料忽略迷宫、强化等无限／动态动作无法估算的后续耗材。任务补料后追加到队尾，确认入队后继续添加本批其他任务；队列满时等待空位。</p>
            <p>新队列自动使用对应技能同名套装，例如 Brewing 使用 Brewing，Cooking 使用 Cooking（名称不区分大小写）。执行到该条队列时由游戏应用套装。</p>
            <div id="tasks"></div>
            <details><summary>手动选任务与预览</summary><p>关闭“合格生活任务攒够后自动入队”后，可手动勾选任务；手动选择可绕过代币门槛，并包括同动作任务。</p>
            <div class="buttons"><button id="all">全选生活任务</button><button id="none">取消选择</button><button id="previewBtn">预览材料与队列</button><button id="start">补料并追加队列</button></div>
            <pre id="preview">全自动模式无需手动勾选。预览配方按基础消耗准备材料。</pre></details>
            <details><summary>背包分类清理</summary><p>Food 一律不卖。Drink 仅出售 Super 开头的茶和咖啡，Ultra、普通及其他茶饮均保留。Equipment 只卖 +0，所有强化物品均保留。Resource 除贤者镜 Philosopher’s Mirror 外可出售；Loot 和其他分类不出售。清理包含旧库存及后来买入、领奖所得，无需是任务产物或能从测试商店买回。配装不额外保留 +0 装备。</p>
            <p>保留锁定物品、金币、任务代币、Cowbell、10 铃包，以及当前队列和已开工批次所需材料、动作主副物品；需求结束后再清理。出售前再次核对等级字段与物品标识都明确为 +0。</p>
            <button id="surplusPreviewBtn">查看可清理库存</button><pre id="surplusPreview">启动运行、重连、队列结束或领取确认后集中检查。查看清单不会发送出售请求。</pre></details>
            <p>关闭分类清理只停止新的库存检查，已记录的待售数量仍会继续处理；关闭“自动出售”总开关可停止全部出售。已在队列里的同类动作会计入任务；已有队列配装不同会在任务旁提示。</p>
            <details><summary>运行日志</summary><pre id="log"></pre></details></section>`;
        const byId = id => panel.getElementById(id);
        const act = fn => () => { try { fn(); render(); } catch (e) { byId('preview').textContent = e.message; } };
        byId('toggle').onclick = () => { byId('box').hidden = !byId('box').hidden; render(); };
        byId('close').onclick = () => { byId('box').hidden = true; };
        for (const k of ['minTokens', 'batchTarget', 'quantityMultiple']) byId(k).oninput = () => { byId(k).dataset.dirty = '1'; };
        byId('savePolicy').onclick = act(() => {
            const config = {};
            for (const k of ['minTokens', 'batchTarget', 'quantityMultiple']) {
                if (!byId(k).value.trim()) throw new Error('请填写完整的数字策略');
                config[k] = Number(byId(k).value);
            }
            controller.configureTasks(config);
            for (const k of Object.keys(config)) delete byId(k).dataset.dirty;
        });
        for (const name of ['autoClaim', 'autoRead', 'autoQueue', 'rerollCombat', 'cowbellFallback']) byId(name).onchange = act(() => controller.configureTasks({[name]: byId(name).checked}));
        byId('sell').onchange = act(() => controller.configureTasks({sellOutputs: byId('sell').checked}));
        byId('recoverSurplus').onchange = act(() => controller.configureTasks({recoverSurplus: byId('recoverSurplus').checked}));
        byId('surplusPreviewBtn').onclick = () => {
            try {
                const {rows} = controller.previewSurplus();
                byId('surplusPreview').textContent = rows.length ? rows.map(row =>
                    `${controller.state.client.itemDetailMap[row.itemHrid]?.name || row.itemHrid}：可清理 ${row.count}（背包 ${row.stock}，材料及必需物品预留 ${row.reserved}，已有产出或待售记录 ${row.known}）`).join('\n')
                    : '当前没有尚未记录的可清理库存。Food、非 Super 茶／咖啡的饮料、贤者镜、强化或锁定物品、当前材料及必需物品仍保留。';
            } catch (error) { byId('surplusPreview').textContent = error.message; }
        };
        byId('tasks').onchange = e => {
            const task = controller.state.quests[e.target.value];
            if (!task) return;
            for (const q of Object.values(controller.state.quests)) {
                if (q.actionHrid !== task.actionHrid || !activeQuest(q)) continue;
                if (e.target.checked) selected.add(String(q.id)); else selected.delete(String(q.id));
            }
            render();
        };
        byId('all').onclick = act(() => { for (const q of Object.values(controller.state.quests)) if (activeQuest(q) && supported(q.actionHrid)) selected.add(String(q.id)); });
        byId('none').onclick = act(() => selected.clear());
        byId('previewBtn').onclick = act(() => {
            const p = controller.plan([...selected]);
            byId('preview').textContent = ['本批追加到队尾。', ...p.entries.map(e => `Task ${e.taskIds[0]} · ${e.name}：剩余 ${e.remaining}，已覆盖 ${e.covered} → ${e.count ? `1 条队列 × ${e.count} · 配装 ${controller.loadoutFor(e.actionHrid).name}` : '无需追加'}`), '\n预计补料（执行前重新核算）：', ...p.purchases.map(b => `${controller.state.client.itemDetailMap[b.itemHrid]?.name || b.itemHrid} +${b.enhancementLevel} × ${b.count}`), ...(p.purchases.length ? [] : ['无需购买材料']), ...Object.entries(p.costs).map(([key, n]) => `预计花费 ${controller.state.client.itemDetailMap[key.split('::')[0]]?.name || key.split('::')[0]} × ${n}`)].join('\n');
        });
        byId('start').onclick = act(() => controller.start([...selected], {sellOutputs: byId('sell').checked}));
        byId('pause').onclick = act(() => controller.stop());
        byId('resume').onclick = act(() => controller.resume());
        byId('early').onclick = act(() => controller.startEarly());
        byId('clear').onclick = act(() => controller.clear());
        document.addEventListener('keydown', e => { if (e.key === 'Escape') byId('box').hidden = true; });
        render();
    }
    mount();
    window.setInterval(() => { controller.tick(); }, 500);
})();
