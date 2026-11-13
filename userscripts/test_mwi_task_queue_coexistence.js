#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const names = {task: 'mwi_task_queue.user.js', enhancer: 'mwi_safe_enhancer.user.js', market: 'mwi_market_keeper.user.js'};
const sources = Object.fromEntries(Object.entries(names).map(([key, file]) => [key, fs.readFileSync(path.join(__dirname, file), 'utf8')]));
const VERSION = 1770000000000;
const URL_BASE = 'wss://api-test.milkywayidle.com/ws?characterId=123';
const GAME_URL = `${URL_BASE}&versionTimestamp=${VERSION}`;
const ACTION = '/actions/milking/cow';
const ITEM = '/items/milk';
const INV = '/item_locations/inventory';
const RESOURCE = '/item_categories/resource';
const EQUIPMENT = '/item_categories/equipment';
const CURRENCY = '/item_categories/currency';
const MILKING_LOADOUT_ID = 18;
const FORAGING_LOADOUT_ID = 19;
const lifeLoadouts = characterID => Object.fromEntries([
    [MILKING_LOADOUT_ID, 'Milking'], [FORAGING_LOADOUT_ID, 'Foraging'],
].map(([id, name]) => [id, {id, characterID, name, actionTypeHrid: `/action_types/${name.toLowerCase()}`,
    isDefault: true, suppressValidation: false, useExactEnhancement: false,
    wearableMap: {}, foodItemHrids: [], drinkItemHrids: [], abilityMap: {}}]));
const client = () => ({type: 'init_client_data', versionTimestamp: new Date(VERSION).toISOString(),
    actionDetailMap: {[ACTION]: {hrid: ACTION, name: 'Milk', type: '/action_types/milking', function: '/action_functions/gathering', inputItems: [], dropTable: [{itemHrid: ITEM}]}},
    itemDetailMap: {[ITEM]: {name: 'Milk', categoryHrid: RESOURCE, sellPrice: 1, isTradable: true}},
    shopItemDetailMap: {'/shop_items/test/milk': {itemHrid: ITEM, category: '/shop_categories/tester', costs: [{itemHrid: '/items/coin', count: 1}]}},
    gameModeDetailMap: {standard: {marketRestricted: false}}});
const full = (id = 123) => ({type: 'init_character_data', character: {id, gameMode: 'standard'},
    characterInfo: {actionQueueCap: 5, marketListingCap: 20}, characterSetting: {hasAcceptedTradingRules: true},
    characterItems: [], characterActions: [], characterQuests: [{id: 77, category: '/quest_category/random_task', type: '/quest_type/action',
        actionHrid: ACTION, status: '/quest_status/in_progress', goalCount: 5, currentCount: 0,
        itemRewardsJSON: JSON.stringify([{itemHrid: '/items/task_token', count: 25}])}], characterLoadoutMap: lifeLoadouts(id), myMarketListings: []});
function realm() {
    class MessageEvent {
        constructor(type, {data} = {}) { this.type = type; this._data = data; this.currentTarget = null; }
        get data() { return this._data; }
    }
    class WebSocket {
        static OPEN = 1;
        constructor(url = GAME_URL) { this.url = url; this.readyState = 1; this.sent = []; this.listeners = new Map(); }
        addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
        send(data) { this.sent.push(String(data)); }
        emit(type, event = {}) { event.currentTarget = this; for (const fn of [...(this.listeners.get(type) || [])]) fn.call(this, event); }
    }
    const storage = new Map(), timers = [];
    const setTimeout = fn => { timers.push(fn); return timers.length; }, clearTimeout = () => {};
    const location = {hostname: 'test.milkywayidle.com', origin: 'https://test.milkywayidle.com', href: 'https://test.milkywayidle.com/?characterId=123', search: '?characterId=123'};
    const window = {location, WebSocket, MessageEvent, localStorage: {getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)},
        setTimeout, clearTimeout, setInterval: () => 0, addEventListener() {}, requestAnimationFrame: () => 0, confirm: () => true, prompt: () => null, alert() {}};
    const context = {window, document: {body: {}, documentElement: {}, querySelector: () => null, querySelectorAll: () => []},
        WebSocket, MessageEvent, URL, URLSearchParams, Intl, setTimeout, clearTimeout, console: {log() {}, warn() {}, error() {}},
        __MWI_TASK_QUEUE_RUNTIME_TEST_MODE__: true, __MWI_SAFE_ENHANCER_RUNTIME_TEST_MODE__: true, __MWI_MARKET_KEEPER_RUNTIME_TEST_MODE__: true};
    vm.createContext(context);
    return {context, window, MessageEvent, WebSocket, storage, timers};
}
function install(name, r) {
    vm.runInContext(sources[name], r.context, {filename: names[name]});
    const key = {task: '__MWI_TASK_QUEUE_RUNTIME_TEST_EXPORTS__', enhancer: '__MWI_SAFE_ENHANCER_RUNTIME_TEST_EXPORTS__', market: '__MWI_MARKET_KEEPER_RUNTIME_TEST_EXPORTS__'}[name];
    const api = r.context[key]; assert.ok(api, `${name} exports`);
    if (name !== 'task') api.Network.install();
    return api;
}
function message(r, socket, data, repeats = 1) {
    const event = new r.MessageEvent('message', {data: JSON.stringify(data)}); event.currentTarget = socket;
    for (let i = 0; i < repeats; i++) void event.data;
    socket.emit('message', event); return event;
}
async function lockTest(shared) {
    const a = await shared.acquire('task-test'); let granted = false;
    const b = shared.acquire('enhancer-test').then(release => { granted = true; return release; });
    await Promise.resolve(); assert.equal(granted, false); a(); const release = await b; release();
    assert.equal(shared.holder, null);
}
async function orderTest(order) {
    const r = realm(), installed = {};
    for (const name of order) installed[name] = install(name, r);
    const {task, enhancer, market} = installed;
    assert.equal(task.shared, enhancer.SharedAutomation || r.window[Symbol.for('MWI_SHARED_AUTOMATION_COORDINATOR_V1')]);
    enhancer.Network.assertHookIntegrity();
    const socket = new r.window.WebSocket(GAME_URL);
    assert.equal(task.socket, socket); assert.equal(enhancer.State.socket, socket); assert.equal(market.State.socket, socket);
    let fullCount = 0; const receive = task.controller.receive;
    task.controller.receive = packet => { if (packet.type === 'init_character_data') fullCount++; return receive(packet); };
    message(r, socket, client()); message(r, socket, full(), 3);
    assert.equal(fullCount, 1, 'getter and listener deduplicate repeated event.data reads');
    assert.equal(task.controller.state.ready, true); assert.equal(task.controller.state.characterId, '123');
    assert.ok(task.controller.state.client.actionDetailMap[ACTION]);
    let observations = 0;
    const originalObserve = enhancer.Network.observeOutgoing;
    enhancer.Network.observeOutgoing = function (...args) { observations++; return originalObserve.apply(this, args); };
    socket.send(JSON.stringify({type: 'new_character_action', newCharacterActionData: {actionHrid: ACTION, hasMaxCount: true, maxCount: 5, isStartNow: false}}));
    assert.equal(socket.sent.length, 1, order.join(' -> ')); assert.equal(observations, 1, 'enhancer sees every Task/socket write exactly once');
    enhancer.Network.assertHookIntegrity();
    const replacement = new r.window.WebSocket(GAME_URL);
    message(r, replacement, client()); message(r, replacement, full());
    message(r, socket, {...full(), characterActions: [{id: 999, actionHrid: ACTION, currentCount: 0, maxCount: 10, hasMaxCount: true}]});
    assert.equal(task.socket, replacement); assert.equal(task.controller.state.actions['999'], undefined, 'retired socket cannot restore stale full state');
    message(r, replacement, full(456));
    assert.equal(task.controller.state.ready, false, 'cross-character full is rejected'); assert.equal(task.controller.state.characterId, '123');
    await lockTest(task.shared);
}
function captureTest() {
    const sendRealm = realm(), preexisting = new sendRealm.window.WebSocket(GAME_URL);
    const sendTask = install('task', sendRealm);
    preexisting.send(JSON.stringify({type: 'ping'}));
    assert.equal(sendTask.socket, preexisting, 'outgoing fallback adopts preexisting socket without enhancer');
    const r = realm(), old = new r.window.WebSocket(GAME_URL), task = install('task', r);
    message(r, old, client()); message(r, old, full());
    assert.equal(task.socket, old, 'page data getter adopts preexisting connection'); assert.equal(task.controller.state.ready, true);
    const replacement = new r.window.WebSocket(GAME_URL); message(r, replacement, client()); message(r, replacement, full());
    const foreign = new r.window.WebSocket(GAME_URL.replace('characterId=123', 'characterId=456'));
    message(r, foreign, full(456)); assert.equal(task.socket, replacement);
    message(r, replacement, {type: 'items_updated', endCharacterItems: [{hash: `456::${INV}::${ITEM}::0`, itemHrid: ITEM, itemLocationHrid: INV, count: 5}]});
    assert.equal(task.controller.state.ready, false, 'cross-character item delta is rejected');
    assert.deepEqual(Object.keys(task.controller.state.items), []);
}
function lateEnhancerTest() {
    const r = realm(), task = install('task', r), socket = new r.window.WebSocket(GAME_URL);
    const enhancer = install('enhancer', r); let observed = 0;
    const original = enhancer.Network.observeOutgoing;
    enhancer.Network.observeOutgoing = function (...args) { observed++; return original.apply(this, args); };
    socket.send(JSON.stringify({type: 'get_character_actions'}));
    assert.equal(observed, 1, 'later enhancer wraps the existing Task prototype observer');
    enhancer.Network.assertHookIntegrity(); assert.equal(task.socket, socket);
}
function cacheTest() {
    for (const compressed of [true, false]) {
        const r = realm(); r.storage.set('initClientData', compressed ? compressLzStringUtf16(JSON.stringify(client())) : JSON.stringify(client()));
        const task = install('task', r); const socket = new r.window.WebSocket(GAME_URL);
        message(r, socket, full()); assert.ok(task.controller.state.client, 'cache supplies omitted init_client_data');
        assert.equal(task.controller.state.client.versionTimestamp, client().versionTimestamp);
        const mismatch = new r.window.WebSocket(`${URL_BASE}&versionTimestamp=${VERSION + 1}`);
        assert.equal(task.controller.state.client, null, 'stale version cache is rejected');
        message(r, mismatch, client()); assert.ok(task.controller.state.client, 'network full replaces stale cache');
        new r.window.WebSocket(`${URL_BASE}&versionTimestamp=0`); assert.equal(task.controller.state.client, null, 'version zero waits for full rules');
    }
    const r = realm(); r.storage.set('initClientData', 'malformed'); const task = install('task', r);
    new r.window.WebSocket(GAME_URL); assert.equal(task.controller.state.client, null);
}
function manualWriteTest() {
    const r = realm(), task = install('task', r), enhancer = install('enhancer', r), socket = new r.window.WebSocket(GAME_URL);
    message(r, socket, client()); message(r, socket, full());
    task.controller.state.pending = {kind: 'queue', actionHrid: ACTION, count: 5, beforeIds: []};
    task.controller.state.enabled = true;
    socket.send(JSON.stringify({type: 'new_character_action', newCharacterActionData: {actionHrid: ACTION}}));
    assert.equal(task.controller.state.enabled, false); assert.equal(task.controller.state.ready, false, 'manual mutation prevents ambiguous acknowledgement');
    assert.equal(socket.sent.length, 1, 'manual game request still forwards'); enhancer.Network.assertHookIntegrity();
}
function compressLzStringUtf16(input) {
    if (input == null) return '';
    const dictionary = Object.create(null);
    const dictionaryToCreate = Object.create(null);
    let dictionarySize = 3;
    let numberOfBits = 2;
    let enlargeIn = 2;
    let word = '';
    const output = [];
    let outputValue = 0;
    let outputPosition = 0;

    const writeBit = (bit) => {
        outputValue = (outputValue << 1) | bit;
        if (outputPosition === 14) {
            output.push(String.fromCharCode(outputValue + 32));
            outputPosition = 0;
            outputValue = 0;
        } else {
            outputPosition++;
        }
    };
    const writeBits = (count, rawValue) => {
        let value = rawValue;
        for (let bit = 0; bit < count; bit++) {
            writeBit(value & 1);
            value >>= 1;
        }
    };
    const growDictionaryIfNeeded = () => {
        if (enlargeIn !== 0) return;
        enlargeIn = 2 ** numberOfBits;
        numberOfBits++;
    };
    const emitWord = (value) => {
        if (dictionaryToCreate[value]) {
            const characterCode = value.charCodeAt(0);
            if (characterCode < 256) {
                writeBits(numberOfBits, 0);
                writeBits(8, characterCode);
            } else {
                writeBits(numberOfBits, 1);
                writeBits(16, characterCode);
            }
            enlargeIn--;
            growDictionaryIfNeeded();
            delete dictionaryToCreate[value];
        } else {
            writeBits(numberOfBits, dictionary[value]);
        }
        enlargeIn--;
        growDictionaryIfNeeded();
    };

    for (const character of String(input)) {
        if (!Object.prototype.hasOwnProperty.call(
            dictionary,
            character
        )) {
            dictionary[character] = dictionarySize++;
            dictionaryToCreate[character] = true;
        }
        const combined = word + character;
        if (Object.prototype.hasOwnProperty.call(
            dictionary,
            combined
        )) {
            word = combined;
            continue;
        }
        emitWord(word);
        dictionary[combined] = dictionarySize++;
        word = character;
    }
    if (word) emitWord(word);
    writeBits(numberOfBits, 2);
    while (true) {
        outputValue <<= 1;
        if (outputPosition === 14) {
            output.push(String.fromCharCode(outputValue + 32));
            break;
        }
        outputPosition++;
    }
    return output.join('') + ' ';
}

function enhancerFirstLimitationTest() {
    const r = realm(), enhancer = install('enhancer', r), original = r.window.WebSocket.prototype.send;
    const task = install('task', r), socket = new r.window.WebSocket(GAME_URL);
    message(r, socket, client()); message(r, socket, full());
    task.controller.state.pending = {kind: 'queue', actionHrid: ACTION, count: 5, beforeIds: []};
    task.controller.state.enabled = true;
    socket.send(JSON.stringify({type: 'new_character_action', newCharacterActionData: {actionHrid: ACTION}}));
    assert.equal(r.window.WebSocket.prototype.send, original, 'enhancer-first preserves the unmodified enhancer hook');
    assert.equal(Object.hasOwn(socket, 'send'), false, 'no socket-local hook bypasses integrity checks');
    assert.equal(task.controller.state.ready, true, 'documented limit: enhancer-first cannot observe a manual request before its response');
    enhancer.Network.assertHookIntegrity();
}
function activeEnhancerRun(id) {
    return {id, characterId: '123', active: true, stopRequested: false, interferenceDetected: false,
        integrityFailure: '', allowedExternalTypes: new Set(), ownedActionIds: new Set(),
        ownedRemovalPending: new Map(), ownedOrderValidationPending: false,
        marketPostInventoryBarriers: new Map(), marketFinalSweepPending: false,
        marketFinalSweepPhase: 'idle', marketSteadyMonitoring: false};
}
async function maintenanceOrderTest(order) {
    const r = realm(); let clockMs = VERSION;
    r.context.Date = class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clockMs])); }
        static now() { return clockMs; }
    };
    const installed = {};
    for (const name of order) installed[name] = install(name, r);
    const {task, enhancer} = installed, socket = new r.window.WebSocket(GAME_URL);
    message(r, socket, client());
    const snapshot = full();
    snapshot.characterInfo = {...snapshot.characterInfo, unreadTaskCount: 2, isTutorialCompleted: true};
    snapshot.characterQuests = [{...snapshot.characterQuests[0], currentCount: 5, status: '/quest_status/completed'}];
    message(r, socket, snapshot);
    const run = activeEnhancerRun(700); enhancer.State.run = run; enhancer.State.blockedReason = '';
    const writes = () => socket.sent.map(raw => JSON.parse(raw).type);
    const flushAckTimer = () => {
        const index = r.timers.findIndex(fn => fn.name === 'awaitAck');
        assert.ok(index >= 0, 'a pending maintenance transaction schedules its lock-release check');
        r.timers.splice(index, 1)[0]();
    };
    task.controller.configureTasks({autoQueue: false, rerollCombat: false,
        minTokens: 0, batchTarget: 1, quantityMultiple: 1});
    task.controller.resume();
    await task.controller.tick();
    assert.deepEqual(writes(), ['claim_character_quest'], `${order.join(' -> ')}: claim precedes Read`);
    assert.equal(JSON.parse(socket.sent[0]).claimCharacterQuestData.characterQuestId, 77);
    assert.equal(task.controller.state.pending.kind, 'claim');
    assert.equal(task.shared.holder.owner, 'task-queue');
    assert.equal(run.stopRequested, false, 'automatic claim does not stop active enhancer');
    assert.equal(run.allowedExternalTypes.has('claim_character_quest'), true);
    let competitorGranted = false;
    const competitor = task.shared.acquire('market-keeper-test').then(release => { competitorGranted = true; return release; });
    clockMs += 1500; await task.controller.tick(); await Promise.resolve();
    assert.deepEqual(writes(), ['claim_character_quest'], 'claim awaiting acknowledgement prevents Read');
    assert.equal(competitorGranted, false, 'market lane remains queued while claim awaits acknowledgement');
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [{...snapshot.characterQuests[0], id: 999, status: '/quest_status/claimed'}]});
    assert.equal(task.controller.state.pending.kind, 'claim', 'another quest cannot acknowledge the claim');
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [{...snapshot.characterQuests[0], status: '/quest_status/claimed'}]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    const releaseCompetitor = await competitor;
    const waitingRead = task.controller.tick(); await Promise.resolve();
    assert.deepEqual(writes(), ['claim_character_quest'], 'Read waits while another script holds the shared lane');
    releaseCompetitor(); await waitingRead;
    assert.deepEqual(writes(), ['claim_character_quest', 'read_random_tasks']);
    assert.equal(task.controller.state.pending.kind, 'read');
    assert.equal(task.shared.holder.owner, 'task-queue');
    assert.equal(run.stopRequested, false, 'automatic Read does not stop active enhancer');
    assert.equal(run.allowedExternalTypes.has('read_random_tasks'), true);
    const newQuest = {...snapshot.characterQuests[0], id: 78, currentCount: 0, status: '/quest_status/in_progress'};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [newQuest]});
    assert.equal(task.controller.state.pending.kind, 'read', 'new quest alone does not acknowledge unread balance consumption');
    message(r, socket, {type: 'character_info_updated', characterInfo: {...snapshot.characterInfo, unreadTaskCount: 2}});
    assert.equal(task.controller.state.pending.kind, 'read', 'unchanged unread count cannot acknowledge Read');
    clockMs += 1500; await task.controller.tick();
    assert.equal(socket.sent.length, 2, 'unconfirmed Read is not repeated');
    message(r, socket, {type: 'character_info_updated', characterInfo: {...snapshot.characterInfo, unreadTaskCount: 0}});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    assert.equal(task.shared.holder, null);
    await task.controller.tick();
    assert.deepEqual(writes(), ['claim_character_quest', 'read_random_tasks'], 'claimed quest and zero unread balance produce no duplicate writes');
    assert.equal(task.controller.state.quests['78'].status, '/quest_status/in_progress');
    assert.equal(run.stopRequested, false); assert.equal(run.interferenceDetected, false);
    assert.equal(enhancer.State.blockedReason, ''); enhancer.Network.assertHookIntegrity();
}
async function rerollOrderTest(order) {
    const r = realm(); let clockMs = VERSION;
    r.context.Date = class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clockMs])); }
        static now() { return clockMs; }
    };
    const installed = {};
    for (const name of order) installed[name] = install(name, r);
    const {task, enhancer} = installed, socket = new r.window.WebSocket(GAME_URL);
    const combatAction = '/actions/combat/fly', nextAction = '/actions/foraging/berry';
    const enhancingAction = '/actions/enhancing/enhance';
    const enhancedItem = '/items/gobo_stabber', enhancedHash = `123::${INV}::${enhancedItem}::0`;
    const initialCoins = 234001243024519;
    const rules = client();
    rules.actionDetailMap[combatAction] = {hrid: combatAction, function: '/action_functions/combat', type: '/action_types/combat', inputItems: []};
    rules.actionDetailMap[nextAction] = {hrid: nextAction, type: '/action_types/foraging', function: '/action_functions/gathering', inputItems: []};
    rules.itemDetailMap['/items/coin'] = {categoryHrid: CURRENCY, sellPrice: 0, isTradable: true};
    rules.actionDetailMap[enhancingAction] = {hrid: enhancingAction, function: '/action_functions/enhancing', inputItems: []};
    rules.itemDetailMap[enhancedItem] = {categoryHrid: EQUIPMENT, isTradable: true, sellPrice: 100, enhancementCosts: [{itemHrid: '/items/coin', count: 1000}]};
    message(r, socket, rules);
    const coinRow = count => ({hash: `123::${INV}::/items/coin::0`, itemHrid: '/items/coin', itemLocationHrid: INV, enhancementLevel: 0, count});
    const snapshot = full();
    const charmHash = '123::/item_locations/charm::/items/grandmaster_enhancing_charm::0';
    snapshot.characterItems = [coinRow(initialCoins), {hash: enhancedHash, characterID: 123, itemHrid: enhancedItem, itemLocationHrid: INV, enhancementLevel: 0, count: 1}, {hash: charmHash, characterID: 123, itemHrid: '/items/grandmaster_enhancing_charm', itemLocationHrid: '/item_locations/charm', enhancementLevel: 0, count: 1}];
    snapshot.characterLoadoutMap = {...snapshot.characterLoadoutMap, 17: {id: 17, characterID: 123, name: 'Enhancing', actionTypeHrid: '/action_types/enhancing',
        isDefault: true, suppressValidation: false, useExactEnhancement: false, wearableMap: {'/item_locations/charm': charmHash}, foodItemHrids: [], drinkItemHrids: [], abilityMap: {}}};
    snapshot.characterInfo = {...snapshot.characterInfo, unreadTaskCount: 0, isTutorialCompleted: true};
    const monster = {...snapshot.characterQuests[0], type: '/quest_type/monster', actionHrid: '', monsterHrid: '/monsters/fly', coinRerollCount: 0};
    snapshot.characterQuests = [monster];
    const backgroundEnhance = {id: 880, actionHrid: enhancingAction, primaryItemHash: enhancedHash, secondaryItemHash: '', currentCount: 0,
        hasMaxCount: false, maxCount: 0, characterLoadoutID: 17, enhancingMaxLevel: 20, ordinal: 0, isDone: false};
    snapshot.characterActions = [backgroundEnhance];
    message(r, socket, snapshot);
    const binding = enhancer.getEnhancingLoadoutBinding();
    const run = {...activeEnhancerRun(800), enhancingLoadoutId: binding.id, enhancingLoadoutFingerprint: binding.fingerprint,
        enhancingLoadoutReservedItemHrids: binding.reservedItemHrids, loadoutTargetReservations: []};
    enhancer.State.run = run; enhancer.State.blockedReason = '';
    const packets = () => socket.sent.map(raw => JSON.parse(raw));
    const flushAckTimer = () => {
        const index = r.timers.findIndex(fn => fn.name === 'awaitAck');
        assert.ok(index >= 0); r.timers.splice(index, 1)[0]();
    };
    task.controller.configureTasks({minTokens: 0, batchTarget: 1, quantityMultiple: 1});
    task.controller.resume(); await task.controller.tick();
    assert.equal(socket.sent.length, 1, 'sufficient actual coins permit reroll beside dynamic enhancement costs');
    assert.equal(packets()[0].type, 'reroll_random_task', `${order.join(' -> ')}: monster triggers coin reroll`);
    assert.deepEqual(packets()[0].rerollRandomTaskData, {characterQuestId: 77, useMooPass: false, useCowbells: false, currentRerollCount: 0});
    assert.equal(task.controller.state.pending.count, 10000);
    assert.ok(task.controller.state.actions['880'], 'background enhancement queue remains intact');
    assert.equal(task.shared.holder.owner, 'task-queue');
    message(r, socket, {type: 'action_completed', endCharacterAction: {...backgroundEnhance, currentCount: 1}, endCharacterItems: [coinRow(initialCoins - 1000)]});
    assert.equal(task.controller.state.pending.kind, 'reroll', 'ordinary enhancement coin consumption is not a reroll acknowledgement');
    assert.equal(task.controller.state.pending.naturalDelta, -1000);
    let competitorGranted = false;
    const competitor = task.shared.acquire('market-reroll-test').then(release => { competitorGranted = true; return release; });
    const stillCombat = {...monster, type: '/quest_type/action', actionHrid: combatAction, monsterHrid: '', coinRerollCount: 1};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [stillCombat]});
    assert.equal(task.controller.state.pending.kind, 'reroll', 'quest half of acknowledgement cannot release a paid reroll');
    clockMs += 1500; await task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 1); assert.equal(competitorGranted, false, 'shared lane held until both reroll responses');
    message(r, socket, {type: 'items_updated', endCharacterItems: [coinRow(initialCoins - 11000)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    const releaseCompetitor = await competitor;
    const waitingReroll = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 1, 'repeat reroll waits for competing script lock');
    releaseCompetitor(); await waitingReroll;
    assert.equal(packets()[1].type, 'reroll_random_task', 'action combat quest also rerolls');
    assert.deepEqual(packets()[1].rerollRandomTaskData, {characterQuestId: 77, useMooPass: false, useCowbells: false, currentRerollCount: 1});
    assert.equal(task.controller.state.pending.count, 20000);
    message(r, socket, {type: 'items_updated', endCharacterItems: [coinRow(initialCoins - 31000)]});
    assert.equal(task.controller.state.pending.kind, 'reroll', 'coin half of acknowledgement cannot release a paid reroll');
    const lifeTask = {...stillCombat, actionHrid: ACTION, coinRerollCount: 2};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [lifeTask]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    clockMs += 1500; await task.controller.tick();
    assert.equal(packets()[2].type, 'new_character_action', 'successful noncombat reroll automatically queues without selection');
    assert.equal(packets()[2].newCharacterActionData.actionHrid, ACTION);
    assert.equal(packets()[2].newCharacterActionData.isStartNow, false);
    assert.equal(packets()[2].newCharacterActionData.maxCount, 5);
    assert.equal(packets()[2].newCharacterActionData.characterLoadoutId, MILKING_LOADOUT_ID, 'Milking queue binds its own saved loadout');
    assert.equal(task.shared.holder.owner, 'task-queue', 'queue acknowledgement keeps the shared lane');
    const {characterLoadoutId: milkLoadoutId, ...milkAction} = packets()[2].newCharacterActionData;
    const queued = {...milkAction, characterLoadoutID: milkLoadoutId, id: 901, currentCount: 0, ordinal: 1, isDone: false};
    message(r, socket, {type: 'actions_updated', endCharacterActions: [queued]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    assert.equal(task.controller.state.owned['901'], ACTION, 'official uppercase-ID acknowledgement confirms the Milking action');
    assert.equal(Object.hasOwn(task.controller.state.actions['901'], 'characterLoadoutId'), false);
    const laterTask = {...lifeTask, id: 78, actionHrid: nextAction, goalCount: 4, coinRerollCount: 0};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [laterTask]});
    clockMs += 1500; await task.controller.tick();
    assert.equal(packets()[3].type, 'new_character_action');
    assert.equal(packets()[3].newCharacterActionData.actionHrid, nextAction, 'later task joins the continuous automatic batch');
    assert.equal(packets()[3].newCharacterActionData.characterLoadoutId, FORAGING_LOADOUT_ID, 'Foraging queue binds its own saved loadout');
    assert.notEqual(packets()[3].newCharacterActionData.characterLoadoutId, milkLoadoutId);
    assert.ok(task.controller.state.job.taskIds.includes('78'));
    const {characterLoadoutId: foragingLoadoutId, ...foragingAction} = packets()[3].newCharacterActionData;
    message(r, socket, {type: 'actions_updated', endCharacterActions: [{...foragingAction, characterLoadoutID: foragingLoadoutId, id: 902, currentCount: 0, ordinal: 2, isDone: false}]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    assert.equal(task.controller.state.owned['902'], nextAction, 'official uppercase-ID acknowledgement confirms the Foraging action');
    clockMs += 1500; await task.controller.tick();
    assert.equal(socket.sent.length, 4, 'covered automatic tasks do not duplicate their queues');
    assert.equal(run.allowedExternalTypes.has('reroll_random_task'), true);
    assert.equal(run.allowedExternalTypes.has('new_character_action'), true);
    assert.equal(packets().some(packet => packet.type === 'load_loadout'), false, 'queue bindings never switch the currently equipped loadout');
    assert.equal(task.controller.state.actions['880'].characterLoadoutID, 17, 'the preexisting enhancement action keeps its loadout');
    assert.equal(enhancer.State.run, run); assert.equal(run.active, true, 'enhancer remains active beside both skill-bound queues');
    assert.equal(run.stopRequested, false, `${order.join(' -> ')}: ${run.integrityFailure} / ${enhancer.State.blockedReason}`); assert.equal(run.interferenceDetected, false);
    assert.equal(enhancer.State.blockedReason, ''); enhancer.Network.assertHookIntegrity();
    assert.equal(task.shared.holder, null);

    // The owned Milking action finishes while disconnected. Its item delta was
    // never seen, so the full snapshot must recover only the newly available
    // product surplus and send it through the same lane as ordinary writes.
    task.controller.configureTasks({autoClaim: false, autoRead: false, autoQueue: false, rerollCombat: false});
    const milkRow = count => ({hash: `123::${INV}::${ITEM}::0`, characterID: 123,
        itemHrid: ITEM, itemLocationHrid: INV, enhancementLevel: 0, count});
    const reconnectSnapshot = {...snapshot,
        characterActions: Object.values(task.controller.state.actions).filter(action => action.id !== 901),
        characterQuests: [{...lifeTask, currentCount: 5, status: '/quest_status/completed'}, laterTask],
        characterItems: [...Object.values(task.controller.state.items), milkRow(8)]};
    message(r, socket, reconnectSnapshot);
    assert.equal(run.stopRequested, true, 'enhancer deliberately retires its old plan on a full resynchronization');
    const recoveredBinding = enhancer.getEnhancingLoadoutBinding();
    const recoveredRun = {...activeEnhancerRun(801), enhancingLoadoutId: recoveredBinding.id,
        enhancingLoadoutFingerprint: recoveredBinding.fingerprint,
        enhancingLoadoutReservedItemHrids: recoveredBinding.reservedItemHrids, loadoutTargetReservations: []};
    enhancer.State.run = recoveredRun; enhancer.State.blockedReason = '';
    assert.equal(task.controller.state.settledActionHrids[ACTION], true, 'missing owned action restores the product settlement boundary');
    assert.equal(task.controller.state.credits[`${ITEM}::0`] || 0, 0, 'unobserved offline production is not an online output credit');
    assert.equal(task.controller.previewSurplus().rows.find(row => row.itemHrid === ITEM)?.count, 8);
    const holdRecovery = await task.shared.acquire('market-before-recovery');
    clockMs += 1500;
    const waitingRecovery = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 4, 'recovery sale waits while the market script owns the shared lane');
    holdRecovery(); await waitingRecovery;
    assert.equal(packets()[4].type, 'sell_to_shop');
    assert.deepEqual(packets()[4].sellToShopData, {itemHash: milkRow(8).hash, count: 8});
    assert.equal(task.controller.state.pending.kind, 'sell');
    assert.equal(task.shared.holder.owner, 'task-queue');
    assert.equal(task.controller.previewSurplus().rows.length, 0, 'recovered credits cannot be counted a second time');
    let afterSaleGranted = false;
    const afterSale = task.shared.acquire('market-after-recovery').then(release => { afterSaleGranted = true; return release; });
    message(r, socket, {type: 'items_updated', endCharacterItems: [coinRow(initialCoins - 31000)]});
    clockMs += 1500; await task.controller.tick(); await Promise.resolve();
    assert.equal(task.controller.state.pending.kind, 'sell', 'unrelated inventory updates cannot acknowledge the recovery sale');
    assert.equal(socket.sent.length, 5); assert.equal(afterSaleGranted, false);
    message(r, socket, {type: 'items_updated', endCharacterItems: [milkRow(0)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    const releaseAfterSale = await afterSale; releaseAfterSale();
    assert.equal(task.controller.state.credits[`${ITEM}::0`], 0);
    assert.equal(task.controller.state.saleCredits[`${ITEM}::0`], 0);
    message(r, socket, {type: 'items_updated', endCharacterItems: [milkRow(3)]});
    clockMs += 1500; await task.controller.tick();
    assert.equal(socket.sent.length, 5, 'new same-product inventory waits for the next recovery boundary');
    assert.equal(recoveredRun.active, true);
    assert.equal(recoveredRun.stopRequested, false, `${order.join(' -> ')}: ${recoveredRun.integrityFailure} / ${enhancer.State.blockedReason}`);
    assert.equal(recoveredRun.interferenceDetected, false);
    assert.equal(enhancer.State.blockedReason, ''); enhancer.Network.assertHookIntegrity();
    assert.equal(task.shared.holder, null);

}
async function policyOrderTest(order) {
    const r = realm(); let clockMs = VERSION;
    r.context.Date = class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clockMs])); }
        static now() { return clockMs; }
    };
    const installed = {};
    for (const name of order) installed[name] = install(name, r);
    const {task, enhancer} = installed, socket = new r.window.WebSocket(GAME_URL);
    const nextAction = '/actions/foraging/berry', enhancingAction = '/actions/enhancing/enhance';
    const enhancedItem = '/items/gobo_stabber', enhancedHash = `123::${INV}::${enhancedItem}::0`;
    const charmHash = '123::/item_locations/charm::/items/grandmaster_enhancing_charm::0';
    const coinRow = count => ({hash: `123::${INV}::/items/coin::0`, characterID: 123,
        itemHrid: '/items/coin', itemLocationHrid: INV, enhancementLevel: 0, count});
    const reward = count => JSON.stringify([{itemHrid: '/items/coin', count: 50}, {itemHrid: '/items/task_token', count}]);
    const rules = client();
    rules.actionDetailMap[nextAction] = {hrid: nextAction, type: '/action_types/foraging', function: '/action_functions/gathering', inputItems: []};
    rules.actionDetailMap[enhancingAction] = {hrid: enhancingAction, type: '/action_types/enhancing', function: '/action_functions/enhancing', inputItems: []};
    rules.itemDetailMap['/items/coin'] = {categoryHrid: CURRENCY, sellPrice: 0, isTradable: true};
    rules.itemDetailMap[enhancedItem] = {categoryHrid: EQUIPMENT, isTradable: true, sellPrice: 100, enhancementCosts: [{itemHrid: '/items/coin', count: 1000}]};
    message(r, socket, rules);
    const snapshot = full();
    snapshot.characterInfo = {...snapshot.characterInfo, taskSlotCap: 8, unreadTaskCount: 0, isTutorialCompleted: true};
    snapshot.characterItems = [coinRow(1000000),
        {hash: enhancedHash, characterID: 123, itemHrid: enhancedItem, itemLocationHrid: INV, enhancementLevel: 0, count: 1},
        {hash: charmHash, characterID: 123, itemHrid: '/items/grandmaster_enhancing_charm', itemLocationHrid: '/item_locations/charm', enhancementLevel: 0, count: 1}];
    snapshot.characterLoadoutMap = {...snapshot.characterLoadoutMap, 17: {id: 17, characterID: 123, name: 'Enhancing',
        actionTypeHrid: '/action_types/enhancing', isDefault: true, suppressValidation: false, useExactEnhancement: false,
        wearableMap: {'/item_locations/charm': charmHash}, foodItemHrids: [], drinkItemHrids: [], abilityMap: {}}};
    snapshot.characterActions = [{id: 880, actionHrid: enhancingAction, primaryItemHash: enhancedHash,
        secondaryItemHash: '', currentCount: 0, hasMaxCount: false, maxCount: 0, characterLoadoutID: 17,
        enhancingMaxLevel: 20, ordinal: 0, isDone: false}];
    const lowRewardTask = {...snapshot.characterQuests[0], goalCount: 2, coinRerollCount: 0, itemRewardsJSON: reward(10)};
    snapshot.characterQuests = [lowRewardTask];
    message(r, socket, snapshot);
    const binding = enhancer.getEnhancingLoadoutBinding();
    const run = {...activeEnhancerRun(900), enhancingLoadoutId: binding.id, enhancingLoadoutFingerprint: binding.fingerprint,
        enhancingLoadoutReservedItemHrids: binding.reservedItemHrids, loadoutTargetReservations: []};
    enhancer.State.run = run; enhancer.State.blockedReason = '';
    const packets = () => socket.sent.map(raw => JSON.parse(raw));
    const flushAckTimer = () => {
        const index = r.timers.findIndex(fn => fn.name === 'awaitAck');
        assert.ok(index >= 0); r.timers.splice(index, 1)[0]();
    };
    task.controller.configureTasks({minTokens: 25, batchTarget: 2, quantityMultiple: 3});
    task.controller.resume(); await task.controller.tick();
    assert.equal(packets()[0]?.type, 'reroll_random_task', `${order.join(' -> ')}: low-token life task is rerolled`);
    assert.deepEqual(packets()[0].rerollRandomTaskData, {characterQuestId: 77, useMooPass: false, useCowbells: false, currentRerollCount: 0});
    assert.equal(task.shared.holder.owner, 'task-queue');
    let competitorGranted = false;
    const competitor = task.shared.acquire('market-policy-test').then(release => { competitorGranted = true; return release; });
    const qualifiedTask = {...lowRewardTask, coinRerollCount: 1, itemRewardsJSON: reward(25)};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [qualifiedTask]});
    assert.equal(task.controller.state.pending.kind, 'reroll');
    clockMs += 1500; await task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 1); assert.equal(competitorGranted, false);
    message(r, socket, {type: 'items_updated', endCharacterItems: [coinRow(990000)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    const releaseCompetitor = await competitor;
    const waitingBatch = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 1, 'one qualified task cannot start a target-two batch');
    releaseCompetitor(); await waitingBatch;
    assert.equal(socket.sent.length, 1, 'the collector waits after the reroll reaches its reward threshold');

    const secondTask = {...qualifiedTask, id: 78, actionHrid: nextAction, goalCount: 4, coinRerollCount: 0};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [secondTask]});
    clockMs += 1500; await task.controller.tick();
    assert.equal(packets()[1]?.type, 'new_character_action');
    assert.equal(packets()[1].newCharacterActionData.actionHrid, ACTION);
    assert.equal(packets()[1].newCharacterActionData.maxCount, 3, 'remaining two rounds upward to three');
    assert.equal(packets()[1].newCharacterActionData.characterLoadoutId, MILKING_LOADOUT_ID);
    assert.equal(packets()[1].newCharacterActionData.isStartNow, false);
    assert.deepEqual(Array.from(task.controller.state.job.taskIds).sort(), ['77', '78']);
    const lateTask = {...secondTask, id: 79, goalCount: 10};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [lateTask]});
    assert.deepEqual(Array.from(task.controller.state.job.taskIds).sort(), ['77', '78'], 'later tasks cannot expand the fixed batch');
    const pendingMilk = task.controller.state.pending;
    const spam = {type: 'error', message: 'errorNotification.requestSpamProtection'};
    message(r, socket, spam);
    assert.equal(task.controller.state.pending, pendingMilk, 'spam preserves the pending queue intent for a late acknowledgement');
    assert.equal(task.controller.state.enabled, true); assert.equal(task.controller.state.ready, true);
    assert.equal(task.socket, socket); assert.equal(socket.readyState, r.WebSocket.OPEN);
    assert.equal(task.controller.state.cooldownUntil, clockMs + 5000);
    let afterSpamGranted = false;
    const afterSpam = task.shared.acquire('market-after-task-spam').then(release => { afterSpamGranted = true; return release; });
    clockMs += 2000; flushAckTimer(); await task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 2, 'spam backoff does not send another queue request');
    assert.equal(task.shared.holder.owner, 'task-queue'); assert.equal(afterSpamGranted, false);
    const {characterLoadoutId: milkLoadoutId, ...milkAction} = packets()[1].newCharacterActionData;
    const milkQueued = {...milkAction, characterLoadoutID: milkLoadoutId, id: 951, currentCount: 0, ordinal: 1, isDone: false};
    message(r, socket, {type: 'actions_updated', endCharacterActions: [milkQueued]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    assert.equal(task.controller.state.owned['951'], ACTION, 'the exact queue acknowledgement is accepted during backoff');
    assert.equal(task.shared.holder.owner, 'task-queue', 'even a confirmed request retains the lane until backoff expires');
    clockMs += 2999; flushAckTimer(); await task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 2); assert.equal(afterSpamGranted, false, '4999 ms is still inside the spam cooldown');
    clockMs += 1; flushAckTimer();
    const releaseAfterSpam = await afterSpam;
    assert.equal(afterSpamGranted, true, 'the queued market waiter receives the lane after five seconds');
    const nextQueue = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 2, 'the next Task queue waits for the market holder instead of replaying the confirmed request');
    releaseAfterSpam(); await nextQueue;
    assert.equal(packets()[2]?.type, 'new_character_action');
    assert.equal(packets()[2].newCharacterActionData.actionHrid, nextAction);
    assert.equal(packets()[2].newCharacterActionData.maxCount, 6, 'remaining four rounds upward to six without adding the later task');
    assert.equal(packets()[2].newCharacterActionData.characterLoadoutId, FORAGING_LOADOUT_ID);
    assert.equal(task.shared.holder.owner, 'task-queue');
    const {characterLoadoutId: foragingLoadoutId, ...foragingAction} = packets()[2].newCharacterActionData;
    const forageQueued = {...foragingAction, characterLoadoutID: foragingLoadoutId, id: 952, currentCount: 0, ordinal: 2, isDone: false};
    message(r, socket, {type: 'actions_updated', endCharacterActions: [forageQueued]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    clockMs += 1500; await task.controller.tick();
    assert.equal(socket.sent.length, 3, 'fixed batch remains covered and does not queue later tasks early');
    assert.equal(packets().filter(packet => packet.type === 'new_character_action' && packet.newCharacterActionData.actionHrid === ACTION).length, 1,
        'a successful late acknowledgement prevents duplicate Milking queues');
    const releaseOtherScript = await task.shared.acquire('market:order_book:other');
    message(r, socket, spam);
    assert.equal(task.controller.state.pending, null, 'an idle Task cannot attribute another script\'s spam error to an operation');
    assert.equal(task.controller.state.enabled, true); assert.equal(task.controller.state.ready, true);
    assert.equal(task.socket, socket); assert.equal(socket.readyState, r.WebSocket.OPEN);
    assert.equal(task.shared.holder.owner, 'market:order_book:other');
    clockMs += 4999; await task.controller.tick();
    assert.equal(socket.sent.length, 3);
    releaseOtherScript(); clockMs += 1; await task.controller.tick();
    assert.equal(socket.sent.length, 3, 'unattributed spam does not manufacture an operation to retry');
    assert.equal(packets().some(packet => packet.type === 'load_loadout'), false);
    assert.equal(run.active, true); assert.equal(run.stopRequested, false, `${order.join(' -> ')}: ${run.integrityFailure} / ${enhancer.State.blockedReason}`);
    assert.equal(run.interferenceDetected, false); assert.equal(enhancer.State.blockedReason, '');
    assert.equal(task.shared.holder, null); enhancer.Network.assertHookIntegrity();
}
async function cowbellOrderTest(order) {
    const r = realm(); let clockMs = VERSION;
    r.context.Date = class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clockMs])); }
        static now() { return clockMs; }
    };
    const installed = {};
    for (const name of order) installed[name] = install(name, r);
    const {task, enhancer} = installed, socket = new r.window.WebSocket(GAME_URL);
    const coin = '/items/coin', cowbell = '/items/cowbell', bag = '/items/bag_of_10_cowbells';
    const itemRow = (itemHrid, count) => ({hash: `123::${INV}::${itemHrid}::0`, characterID: 123,
        itemHrid, itemLocationHrid: INV, enhancementLevel: 0, count});
    const enhancingAction = '/actions/enhancing/enhance', enhancedItem = '/items/gobo_stabber';
    const enhancedHash = itemRow(enhancedItem, 1).hash;
    const charmHash = '123::/item_locations/charm::/items/grandmaster_enhancing_charm::0';
    const rules = client();
    rules.actionDetailMap[enhancingAction] = {hrid: enhancingAction, type: '/action_types/enhancing',
        function: '/action_functions/enhancing', inputItems: []};
    for (const hrid of [coin, cowbell, bag]) rules.itemDetailMap[hrid] = {categoryHrid: hrid === bag ? '/item_categories/loot' : CURRENCY, sellPrice: 0, isTradable: hrid !== cowbell};
    rules.itemDetailMap[bag].isOpenable = true;
    rules.itemDetailMap[enhancedItem] = {categoryHrid: EQUIPMENT, isTradable: true, sellPrice: 100,
        enhancementCosts: [{itemHrid: coin, count: 1000}]};
    message(r, socket, rules);
    const snapshot = full();
    snapshot.characterInfo = {...snapshot.characterInfo, taskSlotCap: 8, unreadTaskCount: 0, isTutorialCompleted: true};
    snapshot.characterItems = [itemRow(coin, 1000000), itemRow(cowbell, 0), itemRow(bag, 1), itemRow(enhancedItem, 1),
        {hash: charmHash, characterID: 123, itemHrid: '/items/grandmaster_enhancing_charm', itemLocationHrid: '/item_locations/charm', enhancementLevel: 0, count: 1}];
    snapshot.characterLoadoutMap = {...snapshot.characterLoadoutMap, 17: {id: 17, characterID: 123, name: 'Enhancing',
        actionTypeHrid: '/action_types/enhancing', isDefault: true, suppressValidation: false, useExactEnhancement: false,
        wearableMap: {'/item_locations/charm': charmHash}, foodItemHrids: [], drinkItemHrids: [], abilityMap: {}}};
    snapshot.characterActions = [{id: 880, actionHrid: enhancingAction, primaryItemHash: enhancedHash,
        secondaryItemHash: '', currentCount: 0, hasMaxCount: false, maxCount: 0, characterLoadoutID: 17,
        enhancingMaxLevel: 20, ordinal: 0, isDone: false}];
    const monster = {...snapshot.characterQuests[0], type: '/quest_type/monster', actionHrid: '',
        monsterHrid: '/monsters/fly', coinRerollCount: 20, cowbellRerollCount: 0};
    snapshot.characterQuests = [monster];
    message(r, socket, snapshot);
    const binding = enhancer.getEnhancingLoadoutBinding();
    const run = {...activeEnhancerRun(1000), enhancingLoadoutId: binding.id, enhancingLoadoutFingerprint: binding.fingerprint,
        enhancingLoadoutReservedItemHrids: binding.reservedItemHrids, loadoutTargetReservations: []};
    enhancer.State.run = run; enhancer.State.blockedReason = '';
    const packets = () => socket.sent.map(raw => JSON.parse(raw));
    const flushAckTimer = () => {
        const index = r.timers.findIndex(fn => fn.name === 'awaitAck');
        assert.ok(index >= 0); r.timers.splice(index, 1)[0]();
    };
    task.controller.configureTasks({minTokens: 0, batchTarget: 1, quantityMultiple: 1});
    assert.equal(task.controller.state.cowbellFallback, true);
    task.controller.resume(); await task.controller.tick();
    assert.equal(packets()[0]?.type, 'reroll_random_task');
    assert.deepEqual(packets()[0].rerollRandomTaskData, {characterQuestId: 77,
        useMooPass: false, useCowbells: false, currentRerollCount: 20}, 'counter twenty still uses coins');
    const afterCoin = {...monster, coinRerollCount: 21};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [afterCoin]});
    assert.equal(task.controller.state.pending.kind, 'reroll');
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(coin, 680000)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    clockMs += 1500; await task.controller.tick();
    assert.equal(packets()[1]?.type, 'open_loot', 'after twenty-one coin rerolls, empty Cowbell balance opens a bag');
    assert.deepEqual(packets()[1].openLootData, {itemHash: itemRow(bag, 1).hash, count: 1});
    assert.equal(task.controller.state.pending.kind, 'open_bag');
    assert.equal(task.shared.holder.owner, 'task-queue');
    let competitorGranted = false;
    const competitor = task.shared.acquire('market-after-cowbell-bag').then(release => { competitorGranted = true; return release; });
    message(r, socket, {type: 'loot_opened', openedItem: {itemHrid: bag, enhancementLevel: 0, count: 1},
        gainedItems: [{itemHrid: cowbell, enhancementLevel: 0, count: 10}]});
    assert.equal(task.controller.state.pending.kind, 'open_bag', 'loot display data does not replace actual inventory confirmation');
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(bag, 0)]});
    clockMs += 1500; await task.controller.tick(); await Promise.resolve();
    assert.equal(task.controller.state.pending.kind, 'open_bag', 'bag consumption alone cannot authorize a paid reroll');
    assert.equal(socket.sent.length, 2); assert.equal(competitorGranted, false);
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(cowbell, 10)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    const releaseCompetitor = await competitor;
    const waitingCowbell = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 2, 'the Cowbell reroll waits for the competing market holder');
    releaseCompetitor(); await waitingCowbell;
    assert.equal(packets()[2]?.type, 'reroll_random_task');
    assert.deepEqual(packets()[2].rerollRandomTaskData, {characterQuestId: 77,
        useMooPass: false, useCowbells: true, currentRerollCount: 0});
    assert.equal(task.controller.state.pending.currency, 'cowbell');
    assert.equal(task.controller.state.pending.counterField, 'cowbellRerollCount');
    assert.equal(task.controller.state.pending.count, 1);
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(cowbell, 9)]});
    assert.equal(task.controller.state.pending.kind, 'reroll', 'Cowbell deduction alone cannot finish the reroll');
    const replacement = {...afterCoin, id: 79, coinRerollCount: 0, cowbellRerollCount: 1};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [
        {...afterCoin, status: '/quest_status/discarded'}, replacement]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    assert.equal(task.controller.state.cowbellTaskIds['77'], undefined);
    assert.equal(task.controller.state.cowbellTaskIds['79'], true, 'confirmed task replacement retains Cowbell mode across a coin counter reset');
    clockMs += 1500; await task.controller.tick();
    assert.deepEqual(packets()[3].rerollRandomTaskData, {characterQuestId: 79,
        useMooPass: false, useCowbells: true, currentRerollCount: 1});
    assert.equal(task.controller.state.pending.count, 2);
    const lifeTask = {...replacement, type: '/quest_type/action', actionHrid: ACTION, monsterHrid: '', cowbellRerollCount: 2};
    message(r, socket, {type: 'quests_updated', endCharacterQuests: [lifeTask]});
    assert.equal(task.controller.state.pending.kind, 'reroll', 'quest acknowledgement still waits for the Cowbell deduction');
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(cowbell, 7)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    clockMs += 1500; await task.controller.tick();
    assert.equal(packets()[4]?.type, 'new_character_action');
    assert.equal(packets()[4].newCharacterActionData.characterLoadoutId, MILKING_LOADOUT_ID);
    const {characterLoadoutId, ...action} = packets()[4].newCharacterActionData;
    const queued = {...action, characterLoadoutID: characterLoadoutId, id: 991, currentCount: 0, ordinal: 1, isDone: false};
    message(r, socket, {type: 'actions_updated', endCharacterActions: [queued]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    clockMs += 1500; await task.controller.tick();
    assert.equal(socket.sent.length, 5, 'the conversion opens exactly one bag and never duplicates confirmed rerolls');
    assert.equal(run.allowedExternalTypes.has('open_loot'), true);
    assert.equal(task.controller.state.enabled, true); assert.equal(task.controller.state.ready, true);
    assert.equal(run.active, true); assert.equal(run.stopRequested, false, `${order.join(' -> ')}: ${run.integrityFailure} / ${enhancer.State.blockedReason}`);
    assert.equal(run.interferenceDetected, false); assert.equal(enhancer.State.blockedReason, '');
    assert.equal(task.shared.holder, null); enhancer.Network.assertHookIntegrity();
}
async function tailOrderTest(order) {
    const r = realm(); let clockMs = VERSION;
    r.context.Date = class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clockMs])); }
        static now() { return clockMs; }
    };
    const installed = {};
    for (const name of order) installed[name] = install(name, r);
    const {task, enhancer} = installed, socket = new r.window.WebSocket(GAME_URL);
    const productionAction = '/actions/crafting/widget', product = '/items/widget';
    const enhancingAction = '/actions/enhancing/enhance', enhancedItem = '/items/gobo_stabber';
    const milkTesterKey = '/shop_items/test/milk_supply_offer';
    const itemRow = (itemHrid, count) => ({hash: `123::${INV}::${itemHrid}::0`, characterID: 123,
        itemHrid, itemLocationHrid: INV, enhancementLevel: 0, count});
    const charmHash = '123::/item_locations/charm::/items/grandmaster_enhancing_charm::0';
    const rules = client();
    rules.actionDetailMap[productionAction] = {hrid: productionAction, name: 'Widget', type: '/action_types/crafting',
        function: '/action_functions/production', inputItems: [{itemHrid: ITEM, count: 2}], outputItems: [{itemHrid: product, count: 1}]};
    rules.actionDetailMap[enhancingAction] = {hrid: enhancingAction, type: '/action_types/enhancing',
        function: '/action_functions/enhancing', inputItems: []};
    rules.itemDetailMap['/items/coin'] = {categoryHrid: CURRENCY, sellPrice: 0, isTradable: true};
    rules.itemDetailMap[product] = {categoryHrid: EQUIPMENT, sellPrice: 2, isTradable: true};
    rules.itemDetailMap[enhancedItem] = {categoryHrid: EQUIPMENT, isTradable: true, sellPrice: 100,
        enhancementCosts: [{itemHrid: ITEM, count: 1}, {itemHrid: '/items/coin', count: 1000}]};
    rules.shopItemDetailMap[milkTesterKey] = rules.shopItemDetailMap['/shop_items/test/milk'];
    delete rules.shopItemDetailMap['/shop_items/test/milk'];
    message(r, socket, rules);
    const snapshot = full();
    snapshot.characterInfo = {...snapshot.characterInfo, unreadTaskCount: 0, isTutorialCompleted: true};
    snapshot.characterItems = [itemRow('/items/coin', 1000000), itemRow(ITEM, 0), itemRow(enhancedItem, 1),
        {hash: charmHash, characterID: 123, itemHrid: '/items/grandmaster_enhancing_charm',
            itemLocationHrid: '/item_locations/charm', enhancementLevel: 0, count: 1}];
    snapshot.characterLoadoutMap = {...snapshot.characterLoadoutMap,
        17: {id: 17, characterID: 123, name: 'Enhancing', actionTypeHrid: '/action_types/enhancing',
            isDefault: true, suppressValidation: false, useExactEnhancement: false,
            wearableMap: {'/item_locations/charm': charmHash}, foodItemHrids: [], drinkItemHrids: [], abilityMap: {}},
        20: {...lifeLoadouts(123)[MILKING_LOADOUT_ID], id: 20, name: 'Crafting', actionTypeHrid: '/action_types/crafting'}};
    const background = {id: 880, actionHrid: enhancingAction, primaryItemHash: itemRow(enhancedItem, 1).hash,
        secondaryItemHash: '', currentCount: 0, hasMaxCount: false, maxCount: 0, characterLoadoutID: 17,
        enhancingMaxLevel: 20, ordinal: 0, isDone: false};
    snapshot.characterActions = [background];
    const firstQuest = {...snapshot.characterQuests[0], actionHrid: productionAction, goalCount: 2};
    snapshot.characterQuests = [firstQuest, {...snapshot.characterQuests[0], id: 78, goalCount: 2}];
    message(r, socket, snapshot);
    const binding = enhancer.getEnhancingLoadoutBinding();
    const run = {...activeEnhancerRun(1100), enhancingLoadoutId: binding.id, enhancingLoadoutFingerprint: binding.fingerprint,
        enhancingLoadoutReservedItemHrids: binding.reservedItemHrids, loadoutTargetReservations: []};
    enhancer.State.run = run; enhancer.State.blockedReason = '';
    const packets = () => socket.sent.map(raw => JSON.parse(raw));
    const flushAckTimer = () => {
        const index = r.timers.findIndex(fn => fn.name === 'awaitAck');
        assert.ok(index >= 0); r.timers.splice(index, 1)[0]();
    };
    task.controller.configureTasks({minTokens: 0, batchTarget: 2, quantityMultiple: 1, autoClaim: false, autoRead: false});
    task.controller.resume(); await task.controller.tick();
    assert.equal(packets()[0]?.type, 'buy_from_shop', `${order.join(' -> ')}: unknown enhancement costs do not block Task material purchases`);
    assert.deepEqual(packets()[0].buyFromShopData, {shopItemHrid: milkTesterKey, enhancementLevel: 0, count: 4},
        'Task ingredient purchases use the actual tester catalog key');
    assert.equal(task.shared.holder.owner, 'task-queue');
    let purchaseWaiterGranted = false;
    const purchaseWaiter = task.shared.acquire('market-after-task-purchase').then(release => { purchaseWaiterGranted = true; return release; });
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow('/items/coin', 999996)]});
    clockMs += 1500; await task.controller.tick(); await Promise.resolve();
    assert.equal(task.controller.state.pending.kind, 'buy', 'unrelated currency update cannot confirm ingredient delivery');
    assert.equal(socket.sent.length, 1); assert.equal(purchaseWaiterGranted, false);
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(ITEM, 4), itemRow('/items/coin', 999996)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    const releasePurchaseWaiter = await purchaseWaiter;
    const waitingFirstQueue = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 1, 'the first append waits for the competing market holder');
    releasePurchaseWaiter(); await waitingFirstQueue;
    assert.equal(packets()[1]?.type, 'new_character_action');
    assert.equal(packets()[1].newCharacterActionData.isStartNow, false, 'append never depends on the replace-queue user setting');
    assert.equal(packets()[1].newCharacterActionData.actionHrid, productionAction);
    assert.equal(packets()[1].newCharacterActionData.characterLoadoutId, 20);
    assert.equal(packets()[1].newCharacterActionData.maxCount, 2);
    const {characterLoadoutId, ...data} = packets()[1].newCharacterActionData;
    const queued = {...data, characterLoadoutID: characterLoadoutId, id: 1001, currentCount: 0, ordinal: 10, isDone: false};
    message(r, socket, {type: 'actions_updated', endCharacterActions: [background]});
    clockMs += 1500; await task.controller.tick();
    assert.equal(task.controller.state.pending.kind, 'queue', 'an unchanged background action cannot acknowledge the appended Task');
    assert.equal(socket.sent.length, 2, 'the second Task waits for the first Task queue acknowledgement');
    message(r, socket, {type: 'actions_updated', endCharacterActions: [queued]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    assert.equal(task.controller.state.owned['1001'], productionAction);
    const releaseMarket = await task.shared.acquire('market-before-second-append');
    const waitingSecondQueue = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 2, 'the second append also waits for the shared lane');
    releaseMarket(); await waitingSecondQueue;
    assert.equal(packets()[2]?.type, 'new_character_action', 'a second Task may append while the unlimited enhancer remains first');
    assert.equal(packets()[2].newCharacterActionData.actionHrid, ACTION);
    assert.equal(packets()[2].newCharacterActionData.maxCount, 2);
    assert.equal(packets()[2].newCharacterActionData.characterLoadoutId, MILKING_LOADOUT_ID);
    assert.equal(packets()[2].newCharacterActionData.isStartNow, false);
    assert.equal(task.controller.state.pending.kind, 'queue');
    let competitorGranted = false;
    const competitor = task.shared.acquire('market-after-second-append').then(release => { competitorGranted = true; return release; });
    message(r, socket, {type: 'actions_updated', endCharacterActions: [queued]});
    clockMs += 1500; await task.controller.tick(); await Promise.resolve();
    assert.equal(task.controller.state.pending.kind, 'queue', 'repeated first-Task acknowledgement cannot confirm the second append');
    assert.equal(competitorGranted, false); assert.equal(socket.sent.length, 3);
    const {characterLoadoutId: secondLoadoutId, ...secondData} = packets()[2].newCharacterActionData;
    const secondQueued = {...secondData, characterLoadoutID: secondLoadoutId, id: 1002, currentCount: 0, ordinal: 20, isDone: false};
    message(r, socket, {type: 'actions_updated', endCharacterActions: [secondQueued]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    const releaseCompetitor = await competitor; releaseCompetitor();
    assert.deepEqual(JSON.parse(JSON.stringify(task.controller.state.actions['880'])), background,
        'Task appends preserve every field of the original enhancement action');
    assert.equal(enhancer.State.actions.has('880'), true, 'enhancer retains its background action snapshot');
    assert.equal(enhancer.State.actions.get('880').ordinal, 0);
    assert.deepEqual(Object.values(task.controller.state.actions).sort((a, b) => a.ordinal - b.ordinal).map(a => a.id), [880, 1001, 1002]);
    for (let round = 0; round < 3; round++) { clockMs += 1500; await task.controller.tick(); }
    assert.equal(socket.sent.length, 3, 'fully covered Tasks do not produce duplicate queue requests');
    assert.equal(task.controller.state.pending, null); assert.equal(task.shared.holder, null);
    assert.equal(run.allowedExternalTypes.has('buy_from_shop'), true);
    assert.equal(run.allowedExternalTypes.has('new_character_action'), true);
    assert.equal(packets().some(packet => /^(?:move_|cancel_)/.test(packet.type) || packet.type === 'load_loadout'), false,
        'Task automation never moves, cancels or replaces the existing queue');
    assert.equal(packets().filter(packet => packet.type === 'new_character_action')
        .every(packet => packet.newCharacterActionData.isStartNow === false), true);
    assert.equal(task.controller.state.enabled, true); assert.equal(task.controller.state.ready, true);
    assert.equal(run.active, true); assert.equal(run.stopRequested, false, `${order.join(' -> ')}: ${run.integrityFailure} / ${enhancer.State.blockedReason}`);
    assert.equal(run.interferenceDetected, false); assert.equal(enhancer.State.blockedReason, '');
    enhancer.Network.assertHookIntegrity();
}
async function testerOutputSaleOrderTest(order, {basePreset = false} = {}) {
    const r = realm(); let clockMs = VERSION;
    r.context.Date = class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clockMs])); }
        static now() { return clockMs; }
    };
    const installed = {};
    for (const name of order) installed[name] = install(name, r);
    const {task, enhancer} = installed, socket = new r.window.WebSocket(GAME_URL);
    const product = '/items/gobo_stabber', productionAction = '/actions/cheesesmithing/gobo_stabber';
    const initialStock = basePreset ? 0 : 7, saleCount = initialStock + 3;
    const enhancingAction = '/actions/enhancing/enhance', enhancedItem = '/items/granite_bludgeon';
    const testerKey = '/shop_items/test/replacement_weapon_offer';
    const itemRow = (itemHrid, count, enhancementLevel = 0) => ({hash: `123::${INV}::${itemHrid}::${enhancementLevel}`,
        characterID: 123, itemHrid, itemLocationHrid: INV, enhancementLevel, count});
    const charmHash = '123::/item_locations/charm::/items/grandmaster_enhancing_charm::0';
    const charm = {hash: charmHash, characterID: 123, itemHrid: '/items/grandmaster_enhancing_charm',
        itemLocationHrid: '/item_locations/charm', enhancementLevel: 0, count: 1};
    const rules = client();
    rules.actionDetailMap[productionAction] = {hrid: productionAction, type: '/action_types/cheesesmithing',
        function: '/action_functions/production', inputItems: [], outputItems: [{itemHrid: product, count: 3}]};
    rules.actionDetailMap[enhancingAction] = {hrid: enhancingAction, type: '/action_types/enhancing',
        function: '/action_functions/enhancing', inputItems: []};
    rules.itemDetailMap[product] = {categoryHrid: EQUIPMENT, sellPrice: 100, isTradable: true,
        enhancementCosts: [{itemHrid: '/items/coin', count: 1000}]};
    rules.itemDetailMap[enhancedItem] = {categoryHrid: EQUIPMENT, sellPrice: 100, isTradable: true,
        enhancementCosts: [{itemHrid: '/items/coin', count: 1000}]};
    rules.itemDetailMap['/items/coin'] = {categoryHrid: CURRENCY, sellPrice: 0, isTradable: true};
    rules.shopItemDetailMap[testerKey] = {itemHrid: product, category: '/shop_categories/tester',
        costs: [{itemHrid: '/items/coin', count: 2}]};
    message(r, socket, rules);
    const snapshot = full();
    snapshot.characterInfo = {...snapshot.characterInfo, unreadTaskCount: 0, isTutorialCompleted: true};
    const enhancedProducts = [itemRow(product, 1, 9), itemRow(product, 2, 10), itemRow(product, 1, 20)];
    snapshot.characterItems = [itemRow('/items/coin', 1000000), itemRow(product, initialStock), ...enhancedProducts, itemRow(enhancedItem, 1), charm];
    snapshot.characterLoadoutMap = {...snapshot.characterLoadoutMap,
        17: {id: 17, characterID: 123, name: 'Enhancing', actionTypeHrid: '/action_types/enhancing',
            isDefault: true, suppressValidation: false, useExactEnhancement: false,
            wearableMap: {'/item_locations/charm': charmHash}, foodItemHrids: [], drinkItemHrids: [], abilityMap: {}},
        20: {...lifeLoadouts(123)[MILKING_LOADOUT_ID], id: 20, name: 'Cheesesmithing',
            actionTypeHrid: '/action_types/cheesesmithing', wearableMap: {'/item_locations/main_hand': itemRow(product, 1, basePreset ? 0 : 20).hash}}};
    const background = {id: 880, actionHrid: enhancingAction, primaryItemHash: itemRow(enhancedItem, 1).hash,
        secondaryItemHash: '', currentCount: 0, hasMaxCount: false, maxCount: 0, characterLoadoutID: 17,
        enhancingMaxLevel: 20, ordinal: 0, isDone: false};
    const production = {id: 990, actionHrid: productionAction, primaryItemHash: '', secondaryItemHash: '',
        currentCount: 0, hasMaxCount: true, maxCount: 1, characterLoadoutID: 20, ordinal: 1, isDone: false};
    const taskQuest = {...snapshot.characterQuests[0], actionHrid: productionAction, goalCount: 1};
    snapshot.characterActions = [background, production]; snapshot.characterQuests = [taskQuest];
    message(r, socket, snapshot);
    const activateEnhancer = id => {
        const binding = enhancer.getEnhancingLoadoutBinding();
        const run = {...activeEnhancerRun(id), mode: 'quick', itemIds: ['granite_bludgeon'], useExistingInventory: false,
            enhancingLoadoutId: binding.id, enhancingLoadoutFingerprint: binding.fingerprint,
            enhancingLoadoutReservedItemHrids: binding.reservedItemHrids, loadoutTargetReservations: [],
            recoveryJournal: {itemIds: ['granite_bludgeon'], itemPlans: [], acked: [], adoptedActions: [], inFlight: null}};
        enhancer.State.run = run; enhancer.State.blockedReason = '';
        return run;
    };
    const run = activateEnhancer(1200);
    const packets = () => socket.sent.map(raw => JSON.parse(raw));
    const flushAckTimer = () => {
        const index = r.timers.findIndex(fn => fn.name === 'awaitAck');
        assert.ok(index >= 0); r.timers.splice(index, 1)[0]();
    };
    task.controller.configureTasks({minTokens: 0, batchTarget: 1, quantityMultiple: 1,
        autoClaim: false, autoRead: false, recoverSurplus: false});
    task.controller.resume(); await task.controller.tick();
    assert.equal(socket.sent.length, 0, 'disabling category cleanup leaves original stock until explicitly enabled');
    assert.equal(task.controller.state.owned['990'], productionAction);
    const done = {...production, currentCount: 1, isDone: true};
    const completedQuest = {...taskQuest, currentCount: 1, status: '/quest_status/completed'};
    const completion = {type: 'action_completed', endCharacterAction: done,
        endCharacterItems: [itemRow(product, saleCount)], endCharacterQuests: [completedQuest]};
    message(r, socket, completion);
    assert.equal(task.controller.state.credits[`${product}::0`], 3, 'only the three observed outputs are production credits before recovery');
    task.controller.configureTasks({recoverSurplus: true});
    const holdSale = await task.shared.acquire('market-before-tester-output-sale');
    const waitingSale = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 0, 'the full-stock settlement sale waits for the shared lane');
    holdSale(); await waitingSale;
    assert.equal(packets()[0]?.type, 'sell_to_shop', `${order.join(' -> ')}: settled equipment is sold despite a saved +${basePreset ? 0 : 20} loadout`);
    assert.deepEqual(packets()[0].sellToShopData, {itemHash: itemRow(product, 0).hash, count: saleCount},
        basePreset ? 'an explicitly +0 preset does not retain one of the three +0 equipment outputs'
            : 'equipment classification authorizes original seven plus three produced, while enhanced stacks stay untouched');
    assert.equal(task.controller.state.pending.kind, 'sell');
    let saleWaiterGranted = false;
    const saleWaiter = task.shared.acquire('market-after-tester-output-sale').then(release => { saleWaiterGranted = true; return release; });
    for (const enhancedRow of enhancedProducts) {
        message(r, socket, {type: 'items_updated', endCharacterItems: [enhancedRow]});
        clockMs += 1500; await task.controller.tick(); await Promise.resolve();
        assert.equal(task.controller.state.pending.kind, 'sell', `+${enhancedRow.enhancementLevel} inventory cannot acknowledge the separate +0 sale`);
        assert.equal(saleWaiterGranted, false); assert.equal(socket.sent.length, 1);
    }
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(product, 0)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    const releaseSaleWaiter = await saleWaiter; releaseSaleWaiter();
    message(r, socket, completion);
    clockMs += 1500; await task.controller.tick();
    assert.equal(socket.sent.length, 1, 'duplicate completion cannot restore or resell the cleared stack');
    assert.equal(task.controller.state.credits[`${product}::0`], 0);
    assert.equal(task.controller.state.saleCredits[`${product}::0`], 0);
    for (const enhancedRow of enhancedProducts) assert.deepEqual(
        JSON.parse(JSON.stringify(task.controller.state.items[enhancedRow.hash])), enhancedRow,
        `the separate +${enhancedRow.enhancementLevel} stack remains intact after selling all +0 outputs`);
    assert.deepEqual(JSON.parse(JSON.stringify(task.controller.state.actions['880'])), background);
    assert.equal(run.stopRequested, false, `${order.join(' -> ')}: a saved life-skill loadout must not block +0 output sales or stop unrelated enhancement: ${run.integrityFailure}`);
    assert.equal(run.active, true); assert.equal(run.interferenceDetected, false);

    const reconnect = {...snapshot, characterActions: [background], characterQuests: [completedQuest],
        characterItems: [itemRow('/items/coin', 1001000), itemRow(product, 4), ...enhancedProducts, itemRow(enhancedItem, 1), charm]};
    message(r, socket, reconnect);
    assert.equal(run.stopRequested, true, 'a full resynchronization independently retires the old enhancer run');
    const recoveredRun = activateEnhancer(1201);
    assert.equal(task.controller.previewSurplus().rows.find(row => row.itemHrid === product)?.count, 4,
        'reconnect cleanup does not revive an original-stock floor or a preset reservation for +0 equipment');
    clockMs += 1500; await task.controller.tick();
    assert.deepEqual(packets()[1]?.sellToShopData, {itemHash: itemRow(product, 0).hash, count: 4});
    assert.equal(task.shared.holder.owner, 'task-queue');
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(product, 0)]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    clockMs += 1500; await task.controller.tick();
    assert.equal(socket.sent.length, 2); assert.equal(task.shared.holder, null);
    assert.equal(packets().filter(packet => packet.type === 'sell_to_shop')
        .every(packet => packet.sellToShopData.itemHash === itemRow(product, 0).hash), true,
        'every automatic sale addresses the exact +0 hash, never the same-item +9, +10 or +20 hashes');
    for (const enhancedRow of enhancedProducts) assert.deepEqual(
        JSON.parse(JSON.stringify(task.controller.state.items[enhancedRow.hash])), enhancedRow);
    assert.equal(recoveredRun.active, true); assert.equal(recoveredRun.stopRequested, false);
    assert.equal(recoveredRun.interferenceDetected, false); enhancer.Network.assertHookIntegrity();

    // The Task change does not relax enhancer protection for the item types
    // selected in its own run, whose future commands may still need +0 stock.
    recoveredRun.itemIds.push('gobo_stabber');
    message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(product, 2)]});
    socket.send(JSON.stringify({type: 'sell_to_shop', sellToShopData: {itemHash: itemRow(product, 2).hash, count: 1}}));
    assert.equal(socket.sent.length, 3, 'a user sale still reaches the socket');
    assert.equal(recoveredRun.stopRequested, true, 'selling a newly selected enhancer item type retains its existing stop protection');
    assert.equal(recoveredRun.interferenceDetected, true);
    enhancer.Network.assertHookIntegrity();
}
async function categoryCleanupOrderTest(order) {
    const r = realm(); let clockMs = VERSION;
    r.context.Date = class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clockMs])); }
        static now() { return clockMs; }
    };
    const installed = {};
    for (const name of order) installed[name] = install(name, r);
    const {task, enhancer} = installed, socket = new r.window.WebSocket(GAME_URL);
    const weapon = '/items/gobo_stabber', ore = '/items/copper_ore', hide = '/items/rough_hide';
    const food = '/items/apple', drink = '/items/black_tea', mirror = '/items/philosophers_mirror';
    const superTea = '/items/super_enhancing_tea', superCoffee = '/items/super_attack_coffee';
    const coffee = '/items/attack_coffee', ultraTea = '/items/ultra_enhancing_tea', ultraCoffee = '/items/ultra_attack_coffee';
    const locked = '/items/birch_log', unknown = '/items/unknown_fixture';
    const enhancedItem = '/items/granite_bludgeon', enhancingAction = '/actions/enhancing/enhance';
    const batchAction = '/actions/crafting/widget', finiteAction = '/actions/brewing/black_tea';
    const itemRow = (itemHrid, count, enhancementLevel = 0) => ({hash: `123::${INV}::${itemHrid}::${enhancementLevel}`,
        characterID: 123, itemHrid, itemLocationHrid: INV, enhancementLevel, count});
    const charmHash = '123::/item_locations/charm::/items/grandmaster_enhancing_charm::0';
    const charm = {hash: charmHash, characterID: 123, itemHrid: '/items/grandmaster_enhancing_charm',
        itemLocationHrid: '/item_locations/charm', enhancementLevel: 0, count: 1};
    const rules = client();
    // Neither old inventory nor its eligibility depends on a tester listing or
    // an action output table. Only this current batch and actual queues reserve it.
    // Keep the unrelated Milk entry so the snapshot is a complete client map.
    for (const hrid of [weapon, enhancedItem]) rules.itemDetailMap[hrid] = {categoryHrid: EQUIPMENT, sellPrice: 100, isTradable: true};
    for (const hrid of [ore, hide, mirror, locked]) rules.itemDetailMap[hrid] = {categoryHrid: RESOURCE, sellPrice: 1, isTradable: true};
    rules.itemDetailMap[food] = {categoryHrid: '/item_categories/food', sellPrice: 1, isTradable: true};
    for (const hrid of [drink, coffee, ultraTea, ultraCoffee, superTea, superCoffee]) {
        rules.itemDetailMap[hrid] = {categoryHrid: '/item_categories/drink', sellPrice: 1, isTradable: true};
    }
    rules.itemDetailMap[unknown] = {sellPrice: 1, isTradable: true};
    for (const hrid of ['/items/coin', '/items/cowbell', '/items/task_token']) {
        rules.itemDetailMap[hrid] = {categoryHrid: CURRENCY, sellPrice: 1, isTradable: true};
    }
    rules.itemDetailMap['/items/bag_of_10_cowbells'] = {categoryHrid: '/item_categories/loot', sellPrice: 1, isTradable: true};
    rules.actionDetailMap[enhancingAction] = {hrid: enhancingAction, type: '/action_types/enhancing',
        function: '/action_functions/enhancing', inputItems: []};
    rules.actionDetailMap[batchAction] = {hrid: batchAction, type: '/action_types/crafting',
        function: '/action_functions/production', inputItems: [{itemHrid: ore, count: 2}], outputItems: []};
    rules.actionDetailMap[finiteAction] = {hrid: finiteAction, type: '/action_types/brewing',
        function: '/action_functions/production', inputItems: [{itemHrid: ore, count: 3}], outputItems: [{itemHrid: drink, count: 1}]};
    message(r, socket, rules);
    const snapshot = full();
    snapshot.characterInfo = {...snapshot.characterInfo, unreadTaskCount: 0, isTutorialCompleted: true};
    const protectedRows = [itemRow(weapon, 1, 9), itemRow(weapon, 2, 10), itemRow(weapon, 1, 20),
        itemRow(food, 9), itemRow(drink, 9), itemRow(mirror, 7), {...itemRow(locked, 2), isLocked: true},
        itemRow(coffee, 9), itemRow(ultraTea, 9), itemRow(ultraCoffee, 9), itemRow(superTea, 1, 10), itemRow(superCoffee, 1, 9),
        itemRow(unknown, 1), itemRow('/items/coin', 1000000), itemRow('/items/cowbell', 10),
        itemRow('/items/task_token', 25), itemRow('/items/bag_of_10_cowbells', 1), itemRow(enhancedItem, 1), charm];
    snapshot.characterItems = [itemRow(weapon, 3), itemRow(ore, 15), itemRow(hide, 4), itemRow(superTea, 5), itemRow(superCoffee, 6), ...protectedRows];
    snapshot.characterLoadoutMap = {...snapshot.characterLoadoutMap,
        17: {id: 17, characterID: 123, name: 'Enhancing', actionTypeHrid: '/action_types/enhancing',
            isDefault: true, suppressValidation: false, useExactEnhancement: false,
            wearableMap: {'/item_locations/charm': charmHash}, foodItemHrids: [], drinkItemHrids: [], abilityMap: {}},
        20: {...lifeLoadouts(123)[MILKING_LOADOUT_ID], id: 20, name: 'Crafting', actionTypeHrid: '/action_types/crafting',
            wearableMap: {'/item_locations/main_hand': itemRow(weapon, 1, 20).hash}}};
    const background = {id: 880, actionHrid: enhancingAction, primaryItemHash: itemRow(enhancedItem, 1).hash,
        secondaryItemHash: '', currentCount: 0, hasMaxCount: false, maxCount: 0, characterLoadoutID: 17,
        enhancingMaxLevel: 20, ordinal: 0, isDone: false};
    const finiteQueue = {id: 881, actionHrid: finiteAction, primaryItemHash: '', secondaryItemHash: '',
        currentCount: 1, hasMaxCount: true, maxCount: 3, characterLoadoutID: 21, ordinal: 1, isDone: false};
    snapshot.characterActions = [background, finiteQueue];
    snapshot.characterQuests = [{...snapshot.characterQuests[0], actionHrid: batchAction, goalCount: 2}];
    message(r, socket, snapshot);
    const binding = enhancer.getEnhancingLoadoutBinding();
    const run = {...activeEnhancerRun(1300), mode: 'quick', itemIds: ['granite_bludgeon'], useExistingInventory: false,
        enhancingLoadoutId: binding.id, enhancingLoadoutFingerprint: binding.fingerprint,
        enhancingLoadoutReservedItemHrids: binding.reservedItemHrids, loadoutTargetReservations: [],
        recoveryJournal: {itemIds: ['granite_bludgeon'], itemPlans: [], acked: [], adoptedActions: [], inFlight: null}};
    enhancer.State.run = run; enhancer.State.blockedReason = '';
    const packets = () => socket.sent.map(raw => JSON.parse(raw));
    const flushAckTimer = () => {
        const index = r.timers.findIndex(fn => fn.name === 'awaitAck');
        assert.ok(index >= 0); r.timers.splice(index, 1)[0]();
    };
    task.controller.configureTasks({minTokens: 0, batchTarget: 1, quantityMultiple: 1, autoClaim: false, autoRead: false});
    assert.equal(task.controller.previewSurplus().rows.length, 0, 'fresh installations wait for an explicit session start');
    task.controller.resume();
    assert.deepEqual(Object.keys(task.controller.state.settledActionHrids), []);
    assert.deepEqual(Object.keys(task.controller.state.observedOutputs), []);
    const expected = {[weapon]: 3, [ore]: 5, [hide]: 4, [superTea]: 5, [superCoffee]: 6};
    const saleTotal = Object.keys(expected).length;
    assert.deepEqual(Object.fromEntries(task.controller.previewSurplus().rows.map(row => [row.itemHrid, row.count])), expected,
        'cleanup includes +0 Super tea/coffee, retains other drinks, and keeps six queued plus four batch ingredients');
    const releaseMarket = await task.shared.acquire('market-before-category-cleanup');
    const firstSale = task.controller.tick(); await Promise.resolve();
    assert.equal(socket.sent.length, 0, 'category cleanup waits behind the market lane');
    releaseMarket(); await firstSale;
    const sold = {};
    for (let index = 0; index < saleTotal; index++) {
        const packet = packets()[index];
        assert.equal(packet?.type, 'sell_to_shop', `${order.join(' -> ')}: category cleanup transaction ${index + 1}`);
        const {itemHash, count} = packet.sellToShopData, hrid = itemHash.split('::')[2];
        assert.equal(itemHash, itemRow(hrid, 0).hash); assert.equal(count, expected[hrid]);
        assert.equal(sold[hrid], undefined, 'each category stack is authorized once');
        sold[hrid] = count;
        assert.equal(task.shared.holder.owner, 'task-queue');
        let waiterGranted = false;
        const waiter = task.shared.acquire(`market-after-category-sale-${index}`).then(release => { waiterGranted = true; return release; });
        message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(drink, 9)]});
        if (hrid === superTea || hrid === superCoffee) {
            const enhancedRow = protectedRows.find(row => row.itemHrid === hrid);
            message(r, socket, {type: 'items_updated', endCharacterItems: [enhancedRow]});
            assert.equal(task.controller.state.pending.kind, 'sell', 'a same-drink enhanced hash cannot acknowledge its +0 sale');
        }
        clockMs += 1500; await task.controller.tick(); await Promise.resolve();
        assert.equal(task.controller.state.pending.kind, 'sell', 'a retained drink update cannot acknowledge a different sold stack');
        assert.equal(waiterGranted, false); assert.equal(socket.sent.length, index + 1);
        const remaining = task.controller.state.items[itemHash].count - count;
        message(r, socket, {type: 'items_updated', endCharacterItems: [itemRow(hrid, remaining)]});
        assert.equal(task.controller.state.pending, null); flushAckTimer();
        const releaseWaiter = await waiter;
        const next = task.controller.tick(); await Promise.resolve();
        assert.equal(socket.sent.length, index + 1, 'the next sale or Task queue honors the competing shared holder');
        releaseWaiter(); await next;
    }
    assert.deepEqual(sold, expected);
    assert.equal(packets()[saleTotal]?.type, 'new_character_action', 'cleanup leaves enough materials to append the current Task');
    assert.equal(packets()[saleTotal].newCharacterActionData.actionHrid, batchAction);
    assert.equal(packets()[saleTotal].newCharacterActionData.maxCount, 2);
    assert.equal(packets()[saleTotal].newCharacterActionData.characterLoadoutId, 20);
    assert.equal(packets()[saleTotal].newCharacterActionData.isStartNow, false);
    assert.equal(task.controller.state.items[itemRow(ore, 0).hash].count, 10);
    const {characterLoadoutId, ...data} = packets()[saleTotal].newCharacterActionData;
    message(r, socket, {type: 'actions_updated', endCharacterActions: [
        {...data, characterLoadoutID: characterLoadoutId, id: 1003, currentCount: 0, ordinal: 2, isDone: false}]});
    assert.equal(task.controller.state.pending, null); flushAckTimer();
    clockMs += 1500; await task.controller.tick();
    assert.equal(socket.sent.length, saleTotal + 1, 'reserved stock is neither sold nor followed by duplicate requests');
    assert.equal(task.controller.previewSurplus().rows.length, 0);
    for (const row of protectedRows) assert.deepEqual(JSON.parse(JSON.stringify(task.controller.state.items[row.hash])), row,
        `category cleanup preserves ${row.itemHrid} +${row.enhancementLevel}`);
    for (const action of [background, finiteQueue]) assert.deepEqual(JSON.parse(JSON.stringify(task.controller.state.actions[action.id])), action);
    assert.equal(task.shared.holder, null); assert.equal(run.active, true);
    assert.equal(run.stopRequested, false, `${order.join(' -> ')}: ${run.integrityFailure} / ${enhancer.State.blockedReason}`);
    assert.equal(run.interferenceDetected, false); enhancer.Network.assertHookIntegrity();
}
async function main() {
    for (const order of [['task', 'enhancer', 'market'], ['task', 'market', 'enhancer'], ['enhancer', 'task', 'market'],
        ['enhancer', 'market', 'task'], ['market', 'task', 'enhancer'], ['market', 'enhancer', 'task']]) {
        await orderTest(order); await maintenanceOrderTest(order); await rerollOrderTest(order); await policyOrderTest(order); await cowbellOrderTest(order); await tailOrderTest(order);
        await testerOutputSaleOrderTest(order); await testerOutputSaleOrderTest(order, {basePreset: true});
        await categoryCleanupOrderTest(order);
    }
    captureTest(); lateEnhancerTest(); cacheTest(); manualWriteTest(); enhancerFirstLimitationTest();
    console.log('mwi Task queue coexistence: PASS (6 orders, claim/Read/reward reroll/Cowbell bag fallback/fixed rounded batches/skill loadouts/reconnect category cleanup/+0 equipment beside +9/+10/+20 and +0 presets/no-history non-tester cleanup/Super tea and coffee +0 sales with exact hash ACK/Food ordinary and Ultra drinks mirror locked and unknown categories retained/finite queue and batch inputs retained/real tester purchase keys/spam cooldown with late ACK/tail-only queues behind unlimited enhancement, active enhancer and shared acknowledgement lock, late sockets, cache, isolation, manual writes)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
