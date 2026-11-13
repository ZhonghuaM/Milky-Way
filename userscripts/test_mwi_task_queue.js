#!/usr/bin/env node
'use strict';

// Deterministic protocol tests. No browser, network, or real timers are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.join(__dirname, 'mwi_task_queue.user.js');
const {buildPlan, requirements, createController, actionRemaining, taskTokens} = require(scriptPath);
const cases = [];

function test(name, run) {
    cases.push({name, run});
}

function memoryStorage() {
    const entries = new Map();
    return {
        getItem(key) { return entries.get(String(key)) ?? null; },
        setItem(key, value) { entries.set(String(key), String(value)); },
        removeItem(key) { entries.delete(String(key)); },
    };
}

const HRID = {
    gather: '/actions/foraging/apple',
    produce: '/actions/cooking/apple_sauce',
    second: '/actions/cooking/apple_pie',
    // The recipes below are synthetic protocol fixtures. Their inputs and
    // outputs use real resource/equipment items so sales do not mislabel food.
    apple: '/items/log',
    sauce: '/items/lumber',
    pie: '/items/wooden_bow',
    coin: '/items/coin',
};
const COWBELL = '/items/cowbell';
const COWBELL_BAG = '/items/bag_of_10_cowbells';
const CATEGORY = {
    resource: '/item_categories/resource', equipment: '/item_categories/equipment',
    food: '/item_categories/food', drink: '/item_categories/drink', currency: '/item_categories/currency',
};

const LOADOUT_IDS = {
    foraging: 51,
    cooking: 52,
    brewing: 53,
    milking: 54,
    woodcutting: 55,
    cheesesmithing: 56,
    crafting: 57,
    tailoring: 58,
    enhancing: 59,
};

function loadout(skill, overrides = {}) {
    return {
        id: LOADOUT_IDS[skill],
        characterID: 123,
        name: skill[0].toUpperCase() + skill.slice(1),
        actionTypeHrid: `/action_types/${skill}`,
        wearableMap: {},
        foodItemHrids: [],
        drinkItemHrids: [],
        abilityMap: {},
        isDefault: false,
        suppressValidation: false,
        useExactEnhancement: false,
        ...overrides,
    };
}

function defaultLoadouts() {
    return Object.fromEntries(Object.keys(LOADOUT_IDS).map(skill => [LOADOUT_IDS[skill], loadout(skill)]));
}

function item(itemHrid, count, enhancementLevel = 0) {
    return {
        id: `${itemHrid}:${enhancementLevel}`,
        characterID: 123,
        itemHrid,
        enhancementLevel,
        itemLocationHrid: '/item_locations/inventory',
        count,
        hash: `123::/item_locations/inventory::${itemHrid}::${enhancementLevel}`,
    };
}

function quest(id, actionHrid, goalCount, currentCount = 0) {
    return {
        id,
        category: '/quest_category/random_task',
        type: '/quest_type/action',
        status: '/quest_status/in_progress',
        itemRewardsJSON: JSON.stringify([{itemHrid: '/items/task_token', count: 25}]),
        actionHrid,
        goalCount,
        currentCount,
    };
}

function completedQuest(id, overrides = {}) {
    return {
        ...quest(id, HRID.gather, 1, 1),
        status: '/quest_status/completed',
        ...overrides,
    };
}

function claimedQuest(id, overrides = {}) {
    return {...completedQuest(id), ...overrides, status: '/quest_status/claimed'};
}

function combatQuest(id, coinRerollCount = 0, overrides = {}) {
    return {
        ...quest(id, '', 5),
        type: '/quest_type/monster',
        monsterHrid: '/monsters/chicken',
        coinRerollCount,
        ...overrides,
    };
}

function action(id, actionHrid, maxCount, currentCount = 0, overrides = {}) {
    return {
        id,
        actionHrid,
        ordinal: Number(id),
        hasMaxCount: true,
        maxCount,
        currentCount,
        isDone: false,
        primaryItemHash: '',
        secondaryItemHash: '',
        difficultyTier: 0,
        characterLoadoutID: LOADOUT_IDS[String(actionHrid).split('/')[2]] || 0,
        ...overrides,
    };
}

function clientData() {
    return {
        type: 'init_client_data',
        versionTimestamp: 12345,
        actionDetailMap: {
            [HRID.gather]: {
                name: 'Apple',
                function: '/action_functions/gathering',
                inputItems: [],
                outputItems: [{itemHrid: HRID.apple, count: 1}],
            },
            [HRID.produce]: {
                name: 'Apple Sauce',
                function: '/action_functions/production',
                inputItems: [{itemHrid: HRID.apple, count: 3}],
                // A task counts action executions, even for multi-output recipes.
                outputItems: [{itemHrid: HRID.sauce, count: 5}],
            },
            [HRID.second]: {
                name: 'Apple Pie',
                function: '/action_functions/production',
                inputItems: [{itemHrid: HRID.apple, count: 2}],
                outputItems: [{itemHrid: HRID.pie, count: 1}],
            },
        },
        itemDetailMap: Object.fromEntries(
            Object.values(HRID).filter(hrid => hrid.startsWith('/items/')).map(
                hrid => [hrid, {name: hrid.split('/').at(-1), sellPrice: 1,
                    categoryHrid: hrid === HRID.coin ? CATEGORY.currency
                        : hrid === HRID.pie ? CATEGORY.equipment : CATEGORY.resource}]
            )
        ),
        shopItemDetailMap: {
            '/shop_items/test/apple': {
                itemHrid: HRID.apple,
                category: '/shop_categories/tester',
                costs: [{itemHrid: HRID.coin, count: 2}],
            },
        },
    };
}

function nonTesterClientData() {
    const client = clientData();
    client.shopItemDetailMap = {};
    return client;
}

function addTesterItem(client, itemHrid, key = `/shop_items/test/${itemHrid.split('/').at(-1)}`) {
    client.shopItemDetailMap[key] = {
        itemHrid,
        category: '/shop_categories/tester',
        costs: [{itemHrid: HRID.coin, count: 2}],
    };
}

function harness({
    tasks = [quest(1, HRID.produce, 10)],
    actions = [],
    items = [item(HRID.coin, 100000)],
    capacity = 100,
    taskSlotCap,
    initialTime = 100000,
    storage = memoryStorage(),
    client = clientData(),
    maintenance = false,
    automation = false,
    recoverSurplus = false,
    taskPolicy = {minTokens: 0, batchTarget: 1, quantityMultiple: 1},
    unreadTaskCount = 0,
    isTutorialCompleted = true,
    loadouts = defaultLoadouts(),
} = {}) {
    const sent = [];
    const timers = new Map();
    let clock = initialTime;
    let timerId = 0;
    let held = 0;
    const coordinator = {
        async acquire() {
            held += 1;
            let released = false;
            return () => {
                if (!released) held -= 1;
                released = true;
            };
        },
    };
    const controller = createController({
        storage,
        coordinator,
        now: () => clock,
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, {callback, at: clock + delay});
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        send(message) {
            sent.push(typeof message === 'string' ? JSON.parse(message) : message);
            return true;
        },
        onChange() {},
    });
    const init = {
        type: 'init_character_data',
        character: {id: 123, gameMode: 'standard'},
        characterInfo: {actionQueueCap: capacity, unreadTaskCount, isTutorialCompleted,
            ...(taskSlotCap == null ? {} : {taskSlotCap})},
        characterQuests: tasks,
        characterActions: actions,
        characterItems: items,
        characterLoadoutMap: loadouts,
    };
    controller.receive(client);
    controller.receive(init);
    const config = {};
    if (taskPolicy) Object.assign(config, taskPolicy);
    if (recoverSurplus !== null) config.recoverSurplus = recoverSurplus;
    if (!automation) Object.assign(config, {autoQueue: false, rerollCombat: false});
    if (maintenance === false && !automation) Object.assign(config, {autoClaim: false, autoRead: false});
    else if (maintenance !== true && maintenance !== false) Object.assign(config, maintenance);
    if (Object.keys(config).length) controller.configureTasks(config);
    function advanceClock(milliseconds) {
        clock += milliseconds;
        for (const [id, timer] of [...timers]) {
            if (timer.at > clock) continue;
            timers.delete(id);
            timer.callback();
        }
    }
    return {
        c: controller,
        sent,
        storage,
        init,
        get now() { return clock; },
        get held() { return held; },
        receive(message) { controller.receive(message); },
        async start(ids = tasks.map(task => task.id), options = {sellOutputs: true}) {
            await controller.start(ids, options);
            await controller.tick();
            await flush();
        },
        async tick() {
            advanceClock(1100);
            await controller.tick();
            await flush();
        },
        async resume() {
            controller.resume();
            advanceClock(1100);
            await controller.tick();
            await flush();
        },
        async advance(milliseconds) {
            advanceClock(milliseconds);
            await flush();
        },
    };
}

async function flush() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function sentOf(h, type) {
    return h.sent.filter(message => message.type === type);
}

function enqueue(h, index = 0) {
    return sentOf(h, 'new_character_action')[index]?.newCharacterActionData;
}

test('userscript exposes deterministic planning and controller entry points', () => {
    assert.equal(typeof buildPlan, 'function');
    assert.equal(typeof requirements, 'function');
    assert.equal(typeof createController, 'function');
    assert.equal(typeof actionRemaining, 'function');
});

test('userscript contains no marketplace mutation commands', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.doesNotMatch(source, /type\s*:\s*['"](?:create_market_listing|edit_market_listing|cancel_market_listing|buy_from_market)['"]/);
});

test('gathering appends the remaining task count without a purchase', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 12, 5)]});
    await h.start();
    assert.equal(sentOf(h, 'buy_from_shop').length, 0);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    assert.equal(enqueue(h).actionHrid, HRID.gather);
    assert.equal(enqueue(h).maxCount, 7);
    assert.equal(enqueue(h).hasMaxCount, true);
    assert.equal(enqueue(h).isStartNow, false);
});

test('production buys recipe inputs per action, regardless of output stack size', async () => {
    const h = harness({tasks: [quest(1, HRID.produce, 10, 2)]});
    await h.start();
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
    assert.deepEqual(sentOf(h, 'buy_from_shop')[0].buyFromShopData, {
        shopItemHrid: '/shop_items/test/apple',
        enhancementLevel: 0,
        count: 24,
    });
    assert.equal(sentOf(h, 'new_character_action').length, 0,
        'the action must wait for server-confirmed ingredients');
});

test('same-action tasks get separate queue entries while sharing old coverage and reserved materials', async () => {
    const h = harness({
        tasks: [quest(1, HRID.produce, 10, 2), quest(2, HRID.produce, 7, 1)],
        actions: [action(10, HRID.produce, 8, 3)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 17)],
    });
    await h.start();
    // The first task needs 8 - 5 = 3 new actions; the second still needs 6.
    // The old queue reserves 15 of 17 apples. Buy 7 for the first task now,
    // then 18 for the second task after the first enqueue is acknowledged.
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 7);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 24)]});
    await h.tick();
    assert.equal(enqueue(h).maxCount, 3);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.produce, 3)]});
    await h.tick();
    assert.equal(sentOf(h, 'buy_from_shop')[1]?.buyFromShopData.count, 18);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 42)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'new_character_action').map(message => message.newCharacterActionData.maxCount), [3, 6]);
    assert.equal(sentOf(h, 'buy_from_shop').reduce((sum, message) => sum + message.buyFromShopData.count, 0), 25);
});

test('materials reserved by another queued recipe are unavailable to new tasks', async () => {
    const h = harness({
        tasks: [quest(1, HRID.produce, 2)],
        actions: [action(10, HRID.second, 5, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 9)],
    });
    await h.start();
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 3);
});

test('an existing queue that already covers the task creates no new action or purchase', async () => {
    const h = harness({
        tasks: [quest(1, HRID.produce, 10, 6)],
        actions: [action(10, HRID.produce, 10, 5)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 15)],
    });
    await h.start();
    assert.equal(h.sent.length, 0);
});

test('only a matching shop inventory acknowledgement releases the queued action', async () => {
    const h = harness({tasks: [quest(1, HRID.produce, 2)]});
    await h.start();
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.sauce, 10)]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 6)]});
    await h.tick();
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    assert.equal(enqueue(h).maxCount, 2);
});

test('natural gathering output cannot acknowledge an outstanding shop purchase', async () => {
    const h = harness({
        tasks: [quest(1, HRID.produce, 2)],
        actions: [action(10, HRID.gather, 100)],
    });
    await h.start();
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(10, HRID.gather, 100, 1),
        endCharacterItems: [item(HRID.apple, 6)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 6)]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 0,
        'repeating the naturally reached balance does not confirm a purchase');
});

test('a full queue waits for authoritative removal before buying or appending', async () => {
    const old = action(10, HRID.gather, 1);
    const h = harness({
        tasks: [quest(1, HRID.produce, 2)],
        actions: [old],
        capacity: 1,
    });
    await h.start();
    assert.equal(h.sent.length, 0);
    h.receive({
        type: 'action_completed',
        endCharacterAction: {...old, currentCount: 1, isDone: true},
        endCharacterItems: [],
    });
    await h.tick();
    assert.equal(h.sent.length, 0, 'action_completed alone must not free a slot');
    h.receive({type: 'actions_updated', endCharacterActions: [{...old, isDone: true}]});
    await h.tick();
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
});

test('pending and acknowledged appends are not repeated on later ticks', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 8)]});
    await h.start();
    await h.tick();
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 8)]});
    await h.tick();
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 1);
});

test('with surplus recovery disabled only completed owned output is sold and enhanced items remain', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 8)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100), item(HRID.apple, 1, 7)],
    });
    await h.start();
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 8)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 8, 8),
        endCharacterItems: [item(HRID.apple, 110), item(HRID.apple, 2, 7)],
        endCharacterQuests: [quest(1, HRID.gather, 8, 8)],
    });
    await h.tick();
    const sale = sentOf(h, 'sell_to_shop');
    assert.equal(sale.length, 1);
    assert.deepEqual(sale[0].sellToShopData, {
        itemHash: item(HRID.apple, 0).hash,
        count: 10,
    });
    assert.equal(h.sent.some(message => /market/.test(message.type)), false);
});

test('unowned action completions and inventory updates do not authorize any sale', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 8)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 8)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(900, HRID.gather, 8, 1),
        endCharacterItems: [item(HRID.apple, 110)],
    });
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 120)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
});

test('duplicate completion messages cannot sell an output twice', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 8)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 8)]});
    const completion = {
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 8, 8),
        endCharacterItems: [item(HRID.apple, 110)],
        endCharacterQuests: [quest(1, HRID.gather, 8, 8)],
    };
    h.receive(completion);
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 100)]});
    await h.tick();
    h.receive(completion);
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
});

test('a final completion still credits output when queue removal arrives first', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 1)]});
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 1, 1, {isDone: true})]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1, {isDone: true}),
        endCharacterItems: [item(HRID.apple, 101)],
        endCharacterQuests: [quest(1, HRID.gather, 1, 1)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 1);
});

test('disabling output sales still appends gathering actions', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 1)]});
    await h.start([1], {sellOutputs: false});
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 1)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 1)],
        endCharacterQuests: [quest(1, HRID.gather, 1, 1)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
});

test('remaining action count handles partial, finished and unlimited queue entries', () => {
    assert.equal(actionRemaining(action(1, HRID.produce, 12, 5)), 7);
    assert.equal(actionRemaining(action(1, HRID.produce, 5, 5)), 0);
    assert.equal(actionRemaining(action(1, HRID.produce, 5, 2, {isDone: true})), 0);
    assert.equal(actionRemaining(action(1, HRID.produce, 0, 2, {hasMaxCount: false})), Infinity);
});

test('an upgrade recipe counts its base item once in addition to ordinary inputs', () => {
    assert.deepEqual(requirements({
        inputItems: [{itemHrid: HRID.apple, count: 2}],
        upgradeItemHrid: HRID.apple,
        outputItems: [{itemHrid: HRID.sauce, count: 5}],
    }, 4), {[`${HRID.apple}::0`]: 12});
});

test('an upgrade task sets the purchased base inventory stack as primary item', async () => {
    const client = clientData();
    client.actionDetailMap[HRID.produce].upgradeItemHrid = HRID.apple;
    const h = harness({client, tasks: [quest(1, HRID.produce, 2)]});
    await h.start();
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 8);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 8)]});
    await h.tick();
    assert.equal(enqueue(h)?.primaryItemHash, item(HRID.apple, 0).hash);
});

test('a matching item in an ordinary shop cannot substitute for shop-tester', () => {
    const client = clientData();
    client.shopItemDetailMap['/shop_items/test/apple'].category = '/shop_categories/general';
    const h = harness({client});
    assert.throws(() => h.c.plan([1]), /商店|tester|测试/);
    assert.equal(h.sent.length, 0);
});

test('a missing tester item blocks production instead of falling back to market', () => {
    const client = clientData();
    delete client.shopItemDetailMap['/shop_items/test/apple'];
    const h = harness({client});
    assert.throws(() => h.c.plan([1]), /商店|tester|测试/);
    assert.equal(h.sent.length, 0);
});

test('insufficient shop currency blocks the proposed purchases', () => {
    const h = harness({items: [item(HRID.coin, 1)]});
    assert.throws(() => h.c.plan([1]), /不足|金币|货币|余额/);
    assert.equal(h.sent.length, 0);
});

test('a refreshed controller recognizes an accepted queue request and does not append again', async () => {
    const first = harness({tasks: [quest(1, HRID.gather, 8)]});
    await first.start();
    assert.equal(sentOf(first, 'new_character_action').length, 1);
    const fresh = harness({
        storage: first.storage,
        tasks: [quest(1, HRID.gather, 8)],
        actions: [action(42, HRID.gather, 8)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'new_character_action').length, 0);
    assert.equal(fresh.c.state.pending, null);
    assert.equal(fresh.c.state.owned['42'], HRID.gather);
});

test('a refresh after a completed purchase uses the authoritative inventory without buying twice', async () => {
    const first = harness({tasks: [quest(1, HRID.produce, 2)]});
    await first.start();
    assert.equal(sentOf(first, 'buy_from_shop').length, 1);
    const fresh = harness({
        storage: first.storage,
        tasks: [quest(1, HRID.produce, 2)],
        items: [item(HRID.coin, 99988), item(HRID.apple, 6)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'buy_from_shop').length, 0);
    assert.equal(sentOf(fresh, 'new_character_action').length, 1);
    assert.equal(enqueue(fresh).maxCount, 2);
});

test('a disconnected controller waits for a full snapshot and recognizes its accepted action', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 8)]});
    await h.start();
    h.receive({type: 'socket_closed'});
    await h.tick();
    assert.equal(h.c.state.ready, false);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    h.receive({...h.init, characterActions: [action(42, HRID.gather, 8)]});
    await h.tick();
    assert.equal(h.c.state.ready, true);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
});

test('unknown purchase results time out without replaying the request', async () => {
    const h = harness({tasks: [quest(1, HRID.produce, 2)]});
    await h.start();
    await h.advance(21000);
    await h.tick();
    assert.equal(h.c.state.enabled, false);
    assert.equal(h.c.state.pending.kind, 'buy');
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    assert.equal(h.held, 0);
});

test('pausing while a purchase is pending prevents subsequent queue writes', async () => {
    const h = harness({tasks: [quest(1, HRID.produce, 2)]});
    await h.start();
    assert.equal(h.held, 1, 'the shared write lane stays held until acknowledgement');
    h.c.stop();
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 6)]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    assert.equal(h.c.state.enabled, false);
    assert.equal(h.held, 0);
});

test('switching characters does not reuse another character task batch', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 8)]});
    await h.start();
    h.receive({...h.init, character: {id: 456, gameMode: 'standard'}});
    await h.tick();
    assert.equal(h.c.state.characterId, '456');
    assert.equal(h.c.state.enabled, false);
    assert.equal(h.c.state.job, null);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
});

test('the batch remains active after enqueue acknowledgement until the selected tasks finish', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 8)]});
    await h.start();
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 8)]});
    await h.tick();
    assert.deepEqual(h.c.state.job?.taskIds, ['1']);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    // A removed action with incomplete task progress needs replacing.
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 8, 0, {isDone: true})]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 2);
    assert.equal(enqueue(h, 1).maxCount, 8);
});

test('a new batch preserves the original stock floor and previously settled unsold output', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start([1], {sellOutputs: false});
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 1)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 101)],
        endCharacterQuests: [quest(1, HRID.gather, 1, 1)],
    });
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 1, 1, {isDone: true})]});
    await h.tick();
    assert.equal(h.c.state.job, null);
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(2, HRID.gather, 1)]});
    await h.start([2]);
    assert.equal(h.c.state.floors[`${HRID.apple}::0`], 100);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 1);
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 1);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 100)]});
    await h.tick();
    h.receive({type: 'actions_updated', endCharacterActions: [action(43, HRID.gather, 1)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 103)],
        endCharacterQuests: [quest(2, HRID.gather, 1, 1)],
    });
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop').map(m => m.sellToShopData.count), [1, 3]);
});

test('duplicate item hashes in one completion are applied sequentially before crediting output', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 2)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 2),
        endCharacterItems: [item(HRID.apple, 105), item(HRID.apple, 107)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 2)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 7);
});

test('natural output during a pending buy is accounted for separately from shop delivery', async () => {
    const h = harness({
        tasks: [quest(1, HRID.produce, 2)],
        actions: [action(10, HRID.gather, 100)],
    });
    await h.start();
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(10, HRID.gather, 100, 1),
        endCharacterItems: [item(HRID.apple, 4)],
    });
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 10)]});
    await h.tick();
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
});

test('two gathering tasks for the same action each append one queue entry of their own size', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 2), quest(2, HRID.gather, 3)]});
    await h.start();
    assert.equal(enqueue(h)?.maxCount, 2);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 2)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'new_character_action').map(message => message.newCharacterActionData.maxCount), [2, 3]);
    h.receive({type: 'actions_updated', endCharacterActions: [action(43, HRID.gather, 3)]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 2);
    assert.equal(sentOf(h, 'buy_from_shop').length, 0);
});

test('same-action task tracking preserves earlier tasks when a later task is no longer active', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 2), quest(2, HRID.gather, 3)]});
    await h.start();
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 2)]});
    await h.tick();
    h.receive({type: 'actions_updated', endCharacterActions: [action(43, HRID.gather, 3)]});
    h.receive({type: 'quests_updated', endCharacterQuests: [{...quest(2, HRID.gather, 3, 3), status: '/quest_status/claimed'}]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 2),
        endCharacterItems: [item(HRID.apple, 1)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 2)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 1);
});

test('new output during a pending sale waits for the next queue boundary before a subsequent sale', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 3)],
        actions: [action(42, HRID.gather, 1), action(43, HRID.gather, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 110)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 1)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 10);
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 2, 1),
        endCharacterItems: [item(HRID.apple, 113)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 2)],
    });
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 103)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop').map(message => message.sellToShopData.count), [10]);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 3);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 2, 2),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 3)],
    });
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop').map(message => message.sellToShopData.count), [10, 5]);
});

test('terminal queue removal cannot trigger duplicate work before the final task progress arrives', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 2, 1)],
        actions: [action(42, HRID.gather, 2, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({
        type: 'actions_updated',
        endCharacterActions: [action(42, HRID.gather, 2, 2, {isDone: true})],
    });
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 0,
        'the last execution is awaiting task settlement, not missing work');
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 2, {isDone: true}),
        endCharacterItems: [item(HRID.apple, 101)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 2)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 1);
});

test('an existing action stopped for missing inputs is replenished and requeued for the unfinished task', async () => {
    const h = harness({
        tasks: [quest(1, HRID.produce, 8, 6)],
        actions: [action(42, HRID.produce, 5, 3)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 1)],
        capacity: 1,
    });
    await h.start();
    assert.equal(h.sent.length, 0, 'the existing action currently covers all remaining task work');
    assert.deepEqual(h.c.state.job?.taskIds, ['1']);
    h.receive({
        type: 'actions_updated',
        endCharacterActions: [action(42, HRID.produce, 5, 3, {isDone: true})],
    });
    await h.tick();
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 5,
        'two remaining executions require six apples; one is already in stock');
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 6)]});
    await h.tick();
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    assert.equal(enqueue(h).maxCount, 2);
});

test('an existing unlimited action stops authorizing output sales after its watched task completes', async () => {
    const unlimited = count => action(42, HRID.gather, 0, count, {hasMaxCount: false});
    const h = harness({
        tasks: [quest(1, HRID.gather, 1)],
        actions: [unlimited(0)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({
        type: 'action_completed',
        endCharacterAction: unlimited(1),
        endCharacterItems: [item(HRID.apple, 101)],
        endCharacterQuests: [{...quest(1, HRID.gather, 1, 1), status: '/quest_status/completed'}],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0, 'task completion alone is not a settlement for an unlimited queue');
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 1);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 100)]});
    await h.tick();
    h.receive({
        type: 'action_completed',
        endCharacterAction: unlimited(2),
        endCharacterItems: [item(HRID.apple, 101)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`] || 0, 0);
});

test('task maintenance defaults on and can claim combat tasks without a queue batch', async () => {
    const combat = completedQuest(2, {
        type: '/quest_type/monster',
        actionHrid: '',
        monsterHrid: '/monsters/chicken',
    });
    const h = harness({
        maintenance: true,
        tasks: [completedQuest(1, {category: '/quest_category/tutorial'}), combat, quest(3, HRID.gather, 2)],
    });
    assert.equal(h.c.state.autoClaim, true);
    assert.equal(h.c.state.autoRead, true);
    assert.equal(h.c.state.enabled, false);
    await h.tick();
    assert.equal(h.sent.length, 0, 'maintenance requires the controller to be enabled');
    await h.resume();
    assert.equal(h.c.state.job, null);
    assert.deepEqual(sentOf(h, 'claim_character_quest')[0]?.claimCharacterQuestData, {characterQuestId: 2});
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(2, combat)]});
    await h.tick();
    assert.equal(sentOf(h, 'claim_character_quest').length, 1,
        'tutorial and unfinished quests are not automatically claimed');
});

test('completed tasks are claimed individually before unread tasks are read', async () => {
    const h = harness({maintenance: true, tasks: [completedQuest(1), completedQuest(2)], unreadTaskCount: 3});
    await h.resume();
    assert.deepEqual(h.sent.map(message => message.type), ['claim_character_quest']);
    assert.equal(h.held, 1);
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'claim_character_quest').map(message => message.claimCharacterQuestData.characterQuestId), [1, 2]);
    assert.equal(sentOf(h, 'read_random_tasks').length, 0);
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(2)]});
    await h.tick();
    const read = sentOf(h, 'read_random_tasks');
    assert.equal(read.length, 1);
    assert.deepEqual(Object.keys(read[0]).sort(), ['ts', 'type']);
    assert.equal(typeof read[0].ts, 'number');
});

test('claim acknowledgement requires the exact task id with claimed status', async () => {
    const h = harness({maintenance: true, tasks: [completedQuest(1)]});
    await h.resume();
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(99)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    h.receive({type: 'quests_updated', endCharacterQuests: [completedQuest(1)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    assert.equal(sentOf(h, 'claim_character_quest').length, 1);
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    await h.tick();
    assert.equal(h.c.state.pending, null);
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    await h.tick();
    assert.equal(sentOf(h, 'claim_character_quest').length, 1);
    assert.equal(h.held, 0);
});

test('reading waits for a lower unread count in character_info_updated', async () => {
    const h = harness({maintenance: true, tasks: [], unreadTaskCount: 2});
    await h.resume();
    assert.equal(sentOf(h, 'read_random_tasks').length, 1);
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(1, HRID.gather, 10)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 2}});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    h.receive({type: 'character_info_updated', characterInfo: {actionQueueCap: 100}});
    await h.tick();
    assert.notEqual(h.c.state.pending, null, 'a partial info update must not imply unread count zero');
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}});
    await h.tick();
    assert.equal(h.c.state.pending, null);
    assert.equal(sentOf(h, 'read_random_tasks').length, 1);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

test('reading continues when its acknowledgement still leaves unread tasks', async () => {
    const h = harness({maintenance: true, tasks: [], unreadTaskCount: 3});
    await h.resume();
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 1}});
    await h.tick();
    assert.equal(sentOf(h, 'read_random_tasks').length, 2);
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 1}});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    assert.equal(sentOf(h, 'read_random_tasks').length, 2,
        'a duplicate first acknowledgement cannot confirm the second read');
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}});
    await h.tick();
    assert.equal(h.c.state.pending, null);
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 2}});
    await h.tick();
    assert.equal(sentOf(h, 'read_random_tasks').length, 3);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

test('reading requires explicit tutorial completion and respects a later info update', async () => {
    for (const tutorial of [false, undefined]) {
        const h = harness({maintenance: true, tasks: [], unreadTaskCount: 1, isTutorialCompleted: false});
        if (tutorial === undefined) {
            const initial = {...h.init, characterInfo: {actionQueueCap: 100, unreadTaskCount: 1}};
            h.receive(initial);
        }
        await h.resume();
        assert.equal(sentOf(h, 'read_random_tasks').length, 0);
        h.receive({type: 'character_info_updated', characterInfo: {isTutorialCompleted: true, unreadTaskCount: 1}});
        await h.tick();
        assert.equal(sentOf(h, 'read_random_tasks').length, 1);
    }
});

test('claim and read settings are independent and persist across refresh', async () => {
    const h = harness({maintenance: {autoClaim: false, autoRead: true}, tasks: [completedQuest(1)], unreadTaskCount: 1});
    await h.resume();
    assert.equal(sentOf(h, 'claim_character_quest').length, 0);
    assert.equal(sentOf(h, 'read_random_tasks').length, 1);
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}});
    await h.tick();
    h.c.configureTasks({autoClaim: true, autoRead: false});
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 1}});
    await h.tick();
    assert.equal(sentOf(h, 'claim_character_quest').length, 1);
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    await h.tick();
    assert.equal(sentOf(h, 'read_random_tasks').length, 1);
    const fresh = harness({maintenance: true, storage: h.storage, tasks: [], unreadTaskCount: 1});
    assert.equal(fresh.c.state.autoClaim, true);
    assert.equal(fresh.c.state.autoRead, false);
    await fresh.tick();
    assert.equal(fresh.sent.length, 0);
});

test('newly read tasks with the same action are excluded from an existing batch', async () => {
    const h = harness({maintenance: true, tasks: [quest(1, HRID.gather, 2)], unreadTaskCount: 1});
    await h.start([1]);
    assert.deepEqual(h.sent.map(message => message.type), ['read_random_tasks']);
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(2, HRID.gather, 3)]});
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}});
    await h.tick();
    assert.equal(enqueue(h).maxCount, 2);
    assert.deepEqual(h.c.state.job.taskIds, ['1']);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 2)]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    assert.deepEqual(h.c.state.job.taskIds, ['1']);
});

test('claim rewards do not become sale credits while maintenance and a queue batch run together', async () => {
    const h = harness({
        maintenance: true,
        tasks: [quest(1, HRID.gather, 1), completedQuest(9, {actionHrid: HRID.produce})],
        unreadTaskCount: 1,
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start([1]);
    assert.equal(sentOf(h, 'claim_character_quest')[0]?.claimCharacterQuestData.characterQuestId, 9);
    h.receive({
        type: 'quests_updated',
        endCharacterQuests: [claimedQuest(9, {actionHrid: HRID.produce})],
        endCharacterItems: [item(HRID.apple, 150)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'read_random_tasks').length, 1);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`] || 0, 0);
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}});
    await h.tick();
    assert.equal(enqueue(h).maxCount, 1);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 1)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 151)],
        endCharacterQuests: [completedQuest(1)],
    });
    await h.tick();
    assert.deepEqual(sentOf(h, 'claim_character_quest').map(message => message.claimCharacterQuestData.characterQuestId), [9, 1]);
    assert.equal(sentOf(h, 'sell_to_shop').length, 0, 'claiming completed tasks has priority over selling output');
    h.receive({
        type: 'quests_updated',
        endCharacterQuests: [claimedQuest(1)],
        endCharacterItems: [item(HRID.apple, 161)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 1);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
});

const maintenanceOperations = [
    {
        name: 'claim',
        type: 'claim_character_quest',
        initial: {tasks: [completedQuest(1)], unreadTaskCount: 0},
        completed: {tasks: [claimedQuest(1)], unreadTaskCount: 0},
        ack: {type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]},
        next: {type: 'quests_updated', endCharacterQuests: [completedQuest(2)]},
    },
    {
        name: 'read',
        type: 'read_random_tasks',
        initial: {tasks: [], unreadTaskCount: 1},
        completed: {tasks: [quest(1, HRID.gather, 4)], unreadTaskCount: 0},
        ack: {type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}},
        next: {type: 'character_info_updated', characterInfo: {unreadTaskCount: 1}},
    },
];

for (const operation of maintenanceOperations) {
    test(`pausing a pending ${operation.name} stops future work until explicitly resumed`, async () => {
        const h = harness({maintenance: true, ...operation.initial});
        await h.resume();
        assert.equal(sentOf(h, operation.type).length, 1);
        assert.equal(h.held, 1);
        h.c.stop();
        h.receive(operation.ack);
        await h.tick();
        assert.equal(h.c.state.pending, null);
        assert.equal(h.c.state.enabled, false);
        assert.equal(h.held, 0);
        h.receive(operation.next);
        await h.tick();
        assert.equal(sentOf(h, operation.type).length, 1);
        await h.resume();
        assert.equal(sentOf(h, operation.type).length, 2);
    });

    test(`an unacknowledged ${operation.name} times out without replaying its packet`, async () => {
        const h = harness({maintenance: true, ...operation.initial});
        await h.resume();
        const saved = JSON.parse(h.storage.getItem('MWI_TASK_QUEUE_V1:123'));
        assert.equal(saved.pending?.kind, operation.name);
        await h.advance(21000);
        await h.tick();
        assert.equal(h.c.state.enabled, false);
        assert.notEqual(h.c.state.pending, null);
        assert.equal(sentOf(h, operation.type).length, 1);
        assert.equal(h.held, 0);
    });

    test(`a server error for ${operation.name} remains paused even if its acknowledgement later arrives`, async () => {
        const h = harness({maintenance: true, ...operation.initial});
        await h.resume();
        h.receive({type: 'error', message: 'task request rejected'});
        await h.tick();
        assert.equal(h.c.state.enabled, false);
        assert.equal(sentOf(h, operation.type).length, 1);
        h.receive(operation.ack);
        h.receive(operation.next);
        await h.tick();
        assert.equal(h.c.state.pending, null);
        assert.equal(h.c.state.enabled, false);
        assert.equal(sentOf(h, operation.type).length, 1);
    });

    test(`a refresh after an accepted ${operation.name} does not repeat it`, async () => {
        const first = harness({maintenance: true, ...operation.initial});
        await first.resume();
        assert.equal(sentOf(first, operation.type).length, 1);
        const fresh = harness({maintenance: true, storage: first.storage, ...operation.completed});
        await fresh.tick();
        assert.equal(fresh.c.state.pending, null);
        assert.equal(fresh.c.state.enabled, true);
        assert.equal(fresh.sent.length, 0);
    });

    test(`disconnecting during ${operation.name} waits for authoritative resynchronization`, async () => {
        const h = harness({maintenance: true, ...operation.initial});
        await h.resume();
        h.receive({type: 'socket_closed'});
        await h.tick();
        assert.equal(h.c.state.ready, false);
        assert.equal(sentOf(h, operation.type).length, 1);
        const full = {
            ...h.init,
            characterQuests: operation.completed.tasks,
            characterInfo: {...h.init.characterInfo, unreadTaskCount: operation.completed.unreadTaskCount},
        };
        h.receive(full);
        await h.tick();
        assert.equal(h.c.state.ready, true);
        assert.equal(h.c.state.pending, null);
        assert.equal(sentOf(h, operation.type).length, 1);
        assert.equal(sentOf(h, 'new_character_action').length, 0);
    });
}

test('maintenance uses the same one-second write throttle even after an immediate acknowledgement', async () => {
    const h = harness({maintenance: true, tasks: [completedQuest(1), completedQuest(2)]});
    await h.resume();
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    await h.advance(100);
    await h.c.tick();
    await flush();
    assert.equal(h.held, 0);
    assert.equal(sentOf(h, 'claim_character_quest').length, 1);
    await h.advance(899);
    await h.c.tick();
    await flush();
    assert.equal(sentOf(h, 'claim_character_quest').length, 1);
    await h.advance(1);
    await h.c.tick();
    await flush();
    assert.equal(sentOf(h, 'claim_character_quest').length, 2);
});

test('an old version 1.0 saved batch gains enabled maintenance defaults without losing its queue plan', async () => {
    const storage = memoryStorage();
    storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify({
        schema: 1,
        job: {taskIds: ['1']},
        owned: {'42': HRID.gather},
        credits: {},
        floors: {[`${HRID.apple}::0`]: 100},
        progress: {'42': 0},
        watched: {[HRID.gather]: ['1']},
        pending: null,
        enabled: true,
        sellOutputs: true,
    }));
    const h = harness({
        maintenance: true,
        storage,
        tasks: [quest(1, HRID.gather, 2), completedQuest(9)],
        actions: [action(42, HRID.gather, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
        unreadTaskCount: 1,
    });
    assert.equal(h.c.state.autoClaim, true);
    assert.equal(h.c.state.autoRead, true);
    assert.equal(h.c.state.enabled, true);
    assert.deepEqual(h.c.state.job.taskIds, ['1']);
    assert.equal(h.c.state.owned['42'], HRID.gather);
    assert.equal(h.c.state.floors[`${HRID.apple}::0`], 100);
    await h.tick();
    assert.equal(sentOf(h, 'claim_character_quest')[0]?.claimCharacterQuestData.characterQuestId, 9);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

test('replayed completed updates cannot reopen a claimed or discarded task for another claim', async () => {
    const h = harness({
        maintenance: true,
        tasks: [completedQuest(1), {...completedQuest(2), status: '/quest_status/discarded'}],
    });
    await h.resume();
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    await h.tick();
    h.receive({type: 'quests_updated', endCharacterQuests: [completedQuest(1), completedQuest(2)]});
    await h.tick();
    assert.equal(h.c.state.quests['1'].status, '/quest_status/claimed');
    assert.equal(h.c.state.quests['2'].status, '/quest_status/discarded');
    assert.equal(sentOf(h, 'claim_character_quest').length, 1);
    assert.equal(h.c.state.pending, null);
});

test('full automation defaults on and resume queues current life tasks without manual selection', async () => {
    const h = harness({automation: true, tasks: [quest(1, HRID.gather, 2), quest(2, HRID.gather, 3)]});
    assert.equal(h.c.state.autoQueue, true);
    assert.equal(h.c.state.rerollCombat, true);
    assert.equal(h.c.state.autoClaim, true);
    assert.equal(h.c.state.autoRead, true);
    await h.resume();
    assert.equal(enqueue(h)?.maxCount, 2);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 2)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'new_character_action').map(message => message.newCharacterActionData.maxCount), [2, 3]);
    assert.deepEqual([...h.c.state.job.taskIds].sort(), ['1', '2']);
});

test('automatically adopting a new task preserves the existing batch floor and earned output credits', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 2)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 1),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 1)],
    });
    h.c.configureTasks({autoQueue: true, rerollCombat: true});
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(2, HRID.gather, 3)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 5);
    assert.equal(h.c.state.floors[`${HRID.apple}::0`], 100);
    assert.deepEqual([...h.c.state.job.taskIds].sort(), ['1', '2']);
    assert.deepEqual(sentOf(h, 'new_character_action').map(message => message.newCharacterActionData.maxCount), [2, 3]);
    h.receive({type: 'actions_updated', endCharacterActions: [action(43, HRID.gather, 3)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 2),
        endCharacterItems: [item(HRID.apple, 107)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 2)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 7);
    assert.equal(h.c.state.floors[`${HRID.apple}::0`], 100);
});

test('automatically discovered tasks wait for a queue slot before appending one complete entry', async () => {
    const old = action(10, HRID.second, 5);
    const h = harness({automation: true, tasks: [quest(1, HRID.gather, 7)], actions: [old], capacity: 1});
    await h.resume();
    assert.equal(h.sent.length, 0);
    h.receive({type: 'actions_updated', endCharacterActions: [{...old, isDone: true}]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 1);
    assert.equal(enqueue(h).maxCount, 7);
});

test('combat rerolls use the exact coin-only payload and capped coin price', async () => {
    for (const count of [0, 1, 5, 6]) {
        const price = 10000 * 2 ** Math.min(count, 5);
        const short = harness({automation: true, tasks: [combatQuest(1, count)], items: [item(HRID.coin, price - 1)]});
        await short.resume();
        assert.equal(short.sent.length, 0, `${price - 1} coins cannot cover reroll ${count}`);
        assert.equal(short.c.state.enabled, true);
        const h = harness({automation: true, tasks: [combatQuest(1, count)], items: [item(HRID.coin, price)]});
        await h.resume();
        const reroll = sentOf(h, 'reroll_random_task');
        assert.equal(reroll.length, 1, `exactly ${price} coins covers reroll ${count}`);
        assert.deepEqual(reroll[0].rerollRandomTaskData, {
            characterQuestId: 1,
            useMooPass: false,
            useCowbells: false,
            currentRerollCount: count,
        });
        assert.equal(sentOf(h, 'new_character_action').length, 0);
        assert.equal(h.c.state.pending?.kind, 'reroll');
        assert.equal(h.held, 1);
    }
});

test('insufficient reroll coins wait for balance updates without spending cowbells or passes', async () => {
    const h = harness({
        automation: true,
        tasks: [combatQuest(1, 5)],
        items: [item(HRID.coin, 319999), item('/items/cowbell', 999)],
    });
    await h.resume();
    assert.equal(h.sent.length, 0);
    assert.equal(h.c.state.enabled, true, 'a coin shortage waits instead of disabling automatic work');
    assert.equal(h.c.state.pending, null);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 320000)]});
    await h.tick();
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    assert.equal(sentOf(h, 'reroll_random_task')[0].rerollRandomTaskData.useMooPass, false);
    assert.equal(sentOf(h, 'reroll_random_task')[0].rerollRandomTaskData.useCowbells, false);
});

test('a reroll requires both the exact task counter and its coin deduction before the next reroll', async () => {
    const h = harness({automation: true, tasks: [combatQuest(1)], items: [item(HRID.coin, 100000)]});
    await h.resume();
    h.receive({type: 'quests_updated', endCharacterQuests: [combatQuest(99, 1)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    h.receive({type: 'quests_updated', endCharacterQuests: [combatQuest(1, 0)]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 10)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    h.receive({type: 'quests_updated', endCharacterQuests: [combatQuest(1, 1)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null, 'task reroll count alone is not a complete transaction');
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90001)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null, 'a different coin deduction cannot acknowledge this reroll');
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.equal(sentOf(h, 'reroll_random_task').length, 2);
    assert.equal(sentOf(h, 'reroll_random_task')[1].rerollRandomTaskData.currentRerollCount, 1);
    h.receive({type: 'quests_updated', endCharacterQuests: [combatQuest(1, 1)]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null, 'replays of the first acknowledgement do not complete the second');
    assert.equal(sentOf(h, 'reroll_random_task').length, 2);
});

test('coin-first reroll acknowledgement waits for the matching life-task result before queueing', async () => {
    const h = harness({automation: true, tasks: [combatQuest(1)], items: [item(HRID.coin, 100000)]});
    await h.resume();
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'quests_updated', endCharacterQuests: [{...quest(1, HRID.gather, 4), coinRerollCount: 1}]});
    await h.tick();
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    assert.equal(enqueue(h)?.maxCount, 4);
});

test('a wrong next reroll count cannot release the pending transaction', async () => {
    const h = harness({automation: true, tasks: [combatQuest(1)], items: [item(HRID.coin, 100000)]});
    await h.resume();
    h.receive({type: 'quests_updated', endCharacterQuests: [combatQuest(1, 2)]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

test('full automation reads, rerolls combat until life, buys, queues, claims, sells and handles the next task', async () => {
    const h = harness({automation: true, tasks: [], unreadTaskCount: 1});
    await h.resume();
    assert.deepEqual(h.sent.map(message => message.type), ['read_random_tasks']);
    h.receive({type: 'quests_updated', endCharacterQuests: [combatQuest(1)]});
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}});
    await h.tick();
    assert.equal(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData.currentRerollCount, 0);
    h.receive({type: 'quests_updated', endCharacterQuests: [combatQuest(1, 1)]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.equal(sentOf(h, 'reroll_random_task')[1]?.rerollRandomTaskData.currentRerollCount, 1);
    const production = {...quest(1, HRID.produce, 3), coinRerollCount: 2};
    h.receive({type: 'quests_updated', endCharacterQuests: [production]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 70000)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData, {
        shopItemHrid: '/shop_items/test/apple', enhancementLevel: 0, count: 9,
    });
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 9), item(HRID.coin, 69982)]});
    await h.tick();
    assert.equal(enqueue(h)?.maxCount, 3);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.produce, 3)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.produce, 3, 3),
        endCharacterItems: [item(HRID.apple, 0), item(HRID.sauce, 15)],
        endCharacterQuests: [{...production, currentCount: 3, status: '/quest_status/completed'}],
    });
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.produce, 3, 3, {isDone: true})]});
    await h.tick();
    assert.equal(sentOf(h, 'claim_character_quest')[0]?.claimCharacterQuestData.characterQuestId, 1);
    h.receive({
        type: 'quests_updated',
        endCharacterQuests: [claimedQuest(1, {...production, currentCount: 3})],
        endCharacterItems: [item(HRID.apple, 7)],
    });
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData, {itemHash: item(HRID.sauce, 0).hash, count: 15});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.sauce, 0)]});
    await h.tick();
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 1}});
    await h.tick();
    assert.equal(sentOf(h, 'read_random_tasks').length, 2);
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(2, HRID.gather, 4)]});
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}});
    await h.tick();
    assert.deepEqual(sentOf(h, 'new_character_action').map(message => message.newCharacterActionData.maxCount), [3, 4]);
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
    assert.equal(sentOf(h, 'sell_to_shop').length, 1, 'claim rewards are not sold as production output');
    assert.deepEqual(h.sent.map(message => message.type), [
        'read_random_tasks', 'reroll_random_task', 'reroll_random_task',
        'buy_from_shop', 'new_character_action', 'claim_character_quest',
        'sell_to_shop', 'read_random_tasks', 'new_character_action',
    ]);
});

test('a reroll may replace a discarded task with one new id without matching pre-existing tasks', async () => {
    const h = harness({automation: true, tasks: [combatQuest(1), combatQuest(99, 1)]});
    await h.resume();
    assert.equal(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData.characterQuestId, 1);
    h.receive({
        type: 'quests_updated',
        endCharacterQuests: [
            combatQuest(1, 0, {status: '/quest_status/discarded'}),
            {...quest(2, HRID.gather, 4), coinRerollCount: 1},
        ],
    });
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    assert.equal(enqueue(h)?.maxCount, 4);
    assert.ok(h.c.state.job.taskIds.includes('2'));
});

test('a partially acknowledged reroll times out and never retries its coin spend', async () => {
    const h = harness({automation: true, tasks: [combatQuest(1)]});
    await h.resume();
    h.receive({type: 'quests_updated', endCharacterQuests: [combatQuest(1, 1)]});
    await h.advance(21000);
    await h.tick();
    assert.equal(h.c.state.enabled, false);
    assert.equal(h.c.state.pending?.kind, 'reroll');
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    assert.equal(h.held, 0);
    assert.equal(JSON.parse(h.storage.getItem('MWI_TASK_QUEUE_V1:123')).pending?.kind, 'reroll');
});

test('a refresh after a completed combat reroll continues from the new counter without repeating the old one', async () => {
    const first = harness({automation: true, tasks: [combatQuest(1)]});
    await first.resume();
    const fresh = harness({
        automation: true,
        storage: first.storage,
        tasks: [combatQuest(1, 1)],
        items: [item(HRID.coin, 90000)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'reroll_random_task').length, 1);
    assert.equal(sentOf(fresh, 'reroll_random_task')[0].rerollRandomTaskData.currentRerollCount, 1);
});

test('a refresh after rerolling into a life task queues that task without another reroll', async () => {
    const first = harness({automation: true, tasks: [combatQuest(1)]});
    await first.resume();
    const fresh = harness({
        automation: true,
        storage: first.storage,
        tasks: [{...quest(1, HRID.gather, 4), coinRerollCount: 1}],
        items: [item(HRID.coin, 90000)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'reroll_random_task').length, 0);
    assert.equal(enqueue(fresh)?.maxCount, 4);
});

test('pausing a reroll prevents its life result from being queued until resume', async () => {
    const h = harness({automation: true, tasks: [combatQuest(1)]});
    await h.resume();
    h.c.stop();
    h.receive({type: 'quests_updated', endCharacterQuests: [{...quest(1, HRID.gather, 4), coinRerollCount: 1}]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.equal(h.c.state.pending, null);
    assert.equal(h.c.state.enabled, false);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    await h.resume();
    assert.equal(enqueue(h)?.maxCount, 4);
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
});

test('version 1.1 settings migrate with both new automation options enabled', async () => {
    const previous = harness({maintenance: true, tasks: []});
    await previous.resume();
    const saved = JSON.parse(previous.storage.getItem('MWI_TASK_QUEUE_V1:123'));
    delete saved.autoQueue;
    delete saved.rerollCombat;
    previous.storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
    const h = harness({automation: true, storage: previous.storage, tasks: [quest(1, HRID.gather, 2)]});
    assert.equal(h.c.state.autoQueue, true);
    assert.equal(h.c.state.rerollCombat, true);
    await h.tick();
    assert.equal(enqueue(h)?.maxCount, 2);
});

test('resume immediately owns existing task actions so output before the first tick is credited', async () => {
    const h = harness({
        automation: true,
        tasks: [quest(1, HRID.gather, 3)],
        actions: [action(42, HRID.gather, 3)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    h.c.resume();
    assert.equal(h.sent.length, 0, 'no scheduler tick has run yet');
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 3, 1),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 1)],
    });
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 5);
    assert.equal(h.c.state.floors[`${HRID.apple}::0`], 100);
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0, 'the queue is still running and has not reached a sale boundary');
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

test('a life task discovered during a pending claim owns its running action and preserves its output', async () => {
    const h = harness({
        automation: true,
        tasks: [completedQuest(9, {actionHrid: HRID.produce})],
        actions: [action(42, HRID.gather, 3)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.resume();
    assert.equal(h.c.state.pending?.kind, 'claim');
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(1, HRID.gather, 3)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 3, 1),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 1)],
    });
    assert.equal(h.c.state.pending?.kind, 'claim');
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 5);
    assert.equal(h.c.state.floors[`${HRID.apple}::0`], 100);
    h.receive({
        type: 'quests_updated',
        endCharacterQuests: [claimedQuest(9, {actionHrid: HRID.produce})],
        endCharacterItems: [item(HRID.apple, 115)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0, 'claiming an unrelated task does not settle this running queue');
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 5);
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 3, 3),
        endCharacterItems: [item(HRID.apple, 117)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 3)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 7);
    assert.equal(h.c.state.floors[`${HRID.apple}::0`], 100);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

function unlimitedEnhancingFixture() {
    const client = clientData();
    const enhanceHrid = '/actions/enhancing/enhance';
    const primary = item('/items/gobo_stabber', 1, 7);
    client.actionDetailMap[enhanceHrid] = {
        name: 'Enhance',
        function: '/action_functions/enhancing',
        inputItems: [],
        outputItems: [],
    };
    client.itemDetailMap[primary.itemHrid] = {
        name: 'Gobo Stabber',
        sellPrice: 1,
        categoryHrid: CATEGORY.equipment,
        enhancementCosts: [
            {itemHrid: HRID.coin, count: 1000},
            {itemHrid: HRID.apple, count: 2},
        ],
    };
    return {
        client,
        primary,
        enhancing: action(90, enhanceHrid, 0, 0, {
            hasMaxCount: false,
            primaryItemHash: primary.hash,
        }),
    };
}

test('an unlimited enhancing action does not freeze a large coin balance needed for combat rerolls', async () => {
    const {client, primary, enhancing} = unlimitedEnhancingFixture();
    const h = harness({
        automation: true,
        client,
        tasks: [quest(1, HRID.gather, 5, 2), combatQuest(2)],
        actions: [action(42, HRID.gather, 5, 2), enhancing],
        items: [item(HRID.coin, 234001243024519), primary],
    });
    await h.resume();
    assert.equal(sentOf(h, 'reroll_random_task').length, 1,
        'unbounded future enhancing costs must not freeze every currently held coin');
    assert.deepEqual(sentOf(h, 'reroll_random_task')[0].rerollRandomTaskData, {
        characterQuestId: 2,
        useMooPass: false,
        useCowbells: false,
        currentRerollCount: 0,
    });
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

test('rerolls still subtract fixed finite queue coin costs while unlimited enhancing is present', async () => {
    const {client, primary, enhancing} = unlimitedEnhancingFixture();
    client.actionDetailMap[HRID.second].inputItems = [{itemHrid: HRID.coin, count: 2500}];
    const h = harness({
        automation: true,
        client,
        tasks: [quest(1, HRID.gather, 5, 2), combatQuest(2)],
        actions: [action(42, HRID.gather, 5, 2), action(43, HRID.second, 6, 2), enhancing],
        items: [item(HRID.coin, 19999), primary],
    });
    await h.resume();
    assert.equal(sentOf(h, 'reroll_random_task').length, 0,
        'four remaining fixed-cost actions reserve 10000 coins, leaving only 9999');
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.pending, null);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 20000)]});
    await h.tick();
    assert.equal(sentOf(h, 'reroll_random_task').length, 1,
        'a remaining available balance of exactly 10000 allows one reroll');
});

test('an unchanged coin shortage keeps one wait status without alternating covered-queue log messages', async () => {
    const {client, primary, enhancing} = unlimitedEnhancingFixture();
    const h = harness({
        automation: true,
        client,
        tasks: [quest(1, HRID.gather, 5, 2), combatQuest(2)],
        actions: [action(42, HRID.gather, 5, 2), enhancing],
        items: [item(HRID.coin, 9999), primary],
    });
    await h.resume();
    assert.equal(h.sent.length, 0);
    assert.match(h.c.state.message, /金币/);
    const message = h.c.state.message;
    const logs = [...h.c.state.logs];
    for (let i = 0; i < 10; i += 1) {
        await h.advance(500);
        await h.c.tick();
        await flush();
        assert.equal(h.c.state.message, message);
    }
    assert.deepEqual(h.c.state.logs, logs,
        'unchanged queue coverage and coin shortage should not add alternating logs every 500 ms');
    assert.equal(h.sent.length, 0);
    assert.equal(h.c.state.enabled, true);
});

test('running output accumulates without sales and a finished queue sells each item in one combined batch', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 3)],
        actions: [action(42, HRID.gather, 3)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100), item(HRID.sauce, 20)],
    });
    await h.start();
    for (const [count, apples, sauce] of [[1, 102, 21], [2, 105, 22]]) {
        h.receive({
            type: 'action_completed',
            endCharacterAction: action(42, HRID.gather, 3, count),
            endCharacterItems: [item(HRID.apple, apples), item(HRID.sauce, sauce)],
            endCharacterQuests: [quest(1, HRID.gather, 3, count)],
        });
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    }
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 5);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 3, 3, {isDone: false}),
        endCharacterItems: [item(HRID.apple, 109), item(HRID.sauce, 23)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 3)],
    });
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData, {itemHash: item(HRID.apple, 0).hash, count: 9});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 100)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[1]?.sellToShopData, {itemHash: item(HRID.sauce, 0).hash, count: 3});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.sauce, 20)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 2);
});

test('a nonterminal queue update reporting maxCount waits for the actual completion before selling', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 4)],
        actions: [action(42, HRID.gather, 2), action(43, HRID.gather, 3)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 1),
        endCharacterItems: [item(HRID.apple, 102)],
        endCharacterQuests: [quest(1, HRID.gather, 4, 1)],
    });
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 2, 2, {isDone: false})]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 2),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [quest(1, HRID.gather, 4, 2)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 5);
});

test('queue removal before the final completion does not sell an incomplete output batch', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 2)],
        actions: [action(42, HRID.gather, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 1),
        endCharacterItems: [item(HRID.apple, 103)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 1)],
    });
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 2, 2, {isDone: true})]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 2, {isDone: true}),
        endCharacterItems: [item(HRID.apple, 107)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 2)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 7);
});

test('duplicate queue and claim boundaries do not release output earned after the original settlement', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 1), quest(2, HRID.gather, 3)],
        actions: [action(42, HRID.gather, 1), action(43, HRID.gather, 3)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    const firstCompletion = {
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 110)],
        endCharacterQuests: [completedQuest(1)],
    };
    h.receive(firstCompletion);
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    await h.tick();
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 100)]});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 3, 1),
        endCharacterItems: [item(HRID.apple, 103)],
        endCharacterQuests: [quest(2, HRID.gather, 3, 1)],
    });
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 1, 1, {isDone: true})]});
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]});
    h.receive(firstCompletion);
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop').map(message => message.sellToShopData.count), [10]);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 3);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
});

test('refresh preserves the existing settlement budget without selling later or inferred offline output', async () => {
    const first = harness({
        tasks: [quest(1, HRID.gather, 1), quest(2, HRID.gather, 3)],
        actions: [action(42, HRID.gather, 1), action(43, HRID.gather, 3)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await first.start();
    first.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 110)],
        endCharacterQuests: [completedQuest(1)],
    });
    first.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 3, 1),
        endCharacterItems: [item(HRID.apple, 113)],
        endCharacterQuests: [quest(2, HRID.gather, 3, 1)],
    });
    const fresh = harness({
        storage: first.storage,
        tasks: [completedQuest(1), quest(2, HRID.gather, 3, 1)],
        actions: [action(42, HRID.gather, 1, 1), action(43, HRID.gather, 3, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 130)],
    });
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`], 13);
    assert.equal(fresh.c.state.saleCredits[`${HRID.apple}::0`], 10);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 10);
    fresh.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 120)]});
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 1);
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`], 3);
});

test('a boundary found after reconnect releases only output already observed before disconnect', async () => {
    const first = harness({
        tasks: [quest(1, HRID.gather, 2)],
        actions: [action(42, HRID.gather, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await first.start();
    first.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 2, 1),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 1)],
    });
    const fresh = harness({
        storage: first.storage,
        tasks: [completedQuest(1, {goalCount: 2, currentCount: 2})],
        actions: [],
        items: [item(HRID.coin, 100000), item(HRID.apple, 120)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 5,
        'the additional fifteen unobserved items are not inferred as sale credits');
});

test('legacy credits wait for a new boundary and historical claims do not trigger migration sales', async () => {
    const storage = memoryStorage();
    storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify({
        schema: 1,
        job: {taskIds: ['1', '2']},
        owned: {'42': HRID.gather, '43': HRID.gather},
        credits: {[`${HRID.apple}::0`]: 5},
        floors: {[`${HRID.apple}::0`]: 100},
        progress: {'42': 1, '43': 1},
        watched: {[HRID.gather]: ['1', '2']},
        pending: null,
        enabled: true,
        sellOutputs: true,
        autoClaim: false,
        autoRead: false,
        autoQueue: false,
        rerollCombat: false,
    }));
    const h = harness({
        storage,
        tasks: [claimedQuest(1), quest(2, HRID.gather, 3, 1)],
        actions: [action(43, HRID.gather, 3, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 120)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 3, 3),
        endCharacterItems: [item(HRID.apple, 125)],
        endCharacterQuests: [quest(2, HRID.gather, 3, 3)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 10,
        'only five saved credits plus five newly observed items become sellable');
});

test('inventory consumption reduces both accrued output and its pending settlement budget', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 1)],
        actions: [action(42, HRID.gather, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await h.start();
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 110)],
        endCharacterQuests: [quest(1, HRID.gather, 1, 1)],
    });
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 106)]});
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 6);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`], 6);
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 6);
});

test('an uncertain sale is not retried or re-released by its old boundary after refresh', async () => {
    const first = harness({
        tasks: [quest(1, HRID.gather, 1)],
        actions: [action(42, HRID.gather, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await first.start();
    first.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 110)],
        endCharacterQuests: [completedQuest(1)],
    });
    await first.tick();
    assert.equal(first.c.state.pending?.kind, 'sell');
    const fresh = harness({
        storage: first.storage,
        tasks: [completedQuest(1)],
        actions: [],
        items: [item(HRID.coin, 100000), item(HRID.apple, 110)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 0);
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`] || 0, 0);
    assert.equal(fresh.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
});

test('a persisted claim omitted from the full snapshot settles known output from an unlimited action', async () => {
    const unlimited = count => action(42, HRID.gather, 0, count, {hasMaxCount: false});
    const first = harness({
        maintenance: true,
        tasks: [quest(1, HRID.gather, 1)],
        actions: [unlimited(0)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await first.start();
    first.receive({
        type: 'action_completed',
        endCharacterAction: unlimited(1),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [completedQuest(1)],
    });
    await first.tick();
    assert.equal(first.c.state.pending?.kind, 'claim');
    assert.equal(first.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
    const fresh = harness({
        maintenance: true,
        storage: first.storage,
        tasks: [],
        actions: [unlimited(5)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 150)],
    });
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`], 5);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'claim_character_quest').length, 0);
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 5,
        'claim rewards and offline production do not enlarge the five observed output credits');
    assert.equal(sentOf(fresh, 'new_character_action').length, 0);
});

test('a claim still completed after refresh is retried before releasing unlimited-action output', async () => {
    const unlimited = count => action(42, HRID.gather, 0, count, {hasMaxCount: false});
    const first = harness({
        maintenance: true,
        tasks: [quest(1, HRID.gather, 1)],
        actions: [unlimited(0)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await first.start();
    first.receive({
        type: 'action_completed',
        endCharacterAction: unlimited(1),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [completedQuest(1)],
    });
    await first.tick();
    assert.equal(first.c.state.pending?.kind, 'claim');
    const fresh = harness({
        maintenance: true,
        storage: first.storage,
        tasks: [completedQuest(1)],
        actions: [unlimited(1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 105)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'claim_character_quest')[0]?.claimCharacterQuestData.characterQuestId, 1);
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 0);
    assert.equal(fresh.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
    fresh.receive({
        type: 'quests_updated',
        endCharacterQuests: [claimedQuest(1)],
        endCharacterItems: [item(HRID.apple, 150)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 5);
});

test('each life skill queues its English same-name loadout instead of loadout zero', async () => {
    for (const skill of ['milking', 'foraging', 'woodcutting', 'cheesesmithing', 'crafting', 'tailoring', 'cooking', 'brewing']) {
        const client = clientData();
        const actionHrid = `/actions/${skill}/test_recipe`;
        client.actionDetailMap[actionHrid] = {
            name: `Test ${skill}`,
            function: '/action_functions/production',
            inputItems: [],
            outputItems: [{itemHrid: HRID.apple, count: 1}],
        };
        const h = harness({automation: true, client, tasks: [quest(1, actionHrid, 7, 2)]});
        await h.resume();
        assert.equal(enqueue(h)?.characterLoadoutId, LOADOUT_IDS[skill], skill);
        assert.equal(enqueue(h)?.maxCount, 5);
        assert.equal(enqueue(h)?.isStartNow, false);
    }
});

test('loadout names ignore case and surrounding whitespace and accept the all-skills type', async () => {
    const loadouts = defaultLoadouts();
    loadouts[51] = loadout('foraging', {name: '  fOrAgInG \t', actionTypeHrid: ''});
    const h = harness({automation: true, loadouts, tasks: [quest(1, HRID.gather, 5)]});
    await h.resume();
    assert.equal(enqueue(h)?.characterLoadoutId, 51);
});

test('loadout records accept the characterId alias for the current character', async () => {
    const loadouts = defaultLoadouts();
    loadouts[51] = loadout('foraging', {characterID: undefined, characterId: 123});
    const h = harness({automation: true, loadouts, tasks: [quest(1, HRID.gather, 5)]});
    await h.resume();
    assert.equal(enqueue(h)?.characterLoadoutId, 51);
});

test('missing, ambiguous, wrong-skill and foreign-character loadouts pause before material purchases', async () => {
    const cases = [
        {name: 'missing', rows: {}},
        {name: 'wrong name', rows: {52: loadout('cooking', {name: 'Food Gear'})}},
        {name: 'ambiguous', rows: {52: loadout('cooking'), 152: loadout('cooking', {id: 152, name: ' COOKING '})}},
        {name: 'wrong skill', rows: {52: loadout('cooking', {actionTypeHrid: '/action_types/foraging'})}},
        {name: 'foreign character', rows: {52: loadout('cooking', {characterID: 456})}},
        {name: 'conflicting owner aliases', rows: {52: loadout('cooking', {characterID: 123, characterId: 456})}},
    ];
    for (const scenario of cases) {
        const h = harness({automation: true, loadouts: scenario.rows, tasks: [quest(1, HRID.produce, 2)]});
        await h.resume();
        assert.equal(h.sent.length, 0, `${scenario.name}: do not buy ingredients or enqueue with loadout zero`);
        assert.equal(h.c.state.enabled, false, scenario.name);
    }
});

test('loadouts_updated replaces the old map and a corrected map can be used after resume', async () => {
    const h = harness({automation: true, tasks: [quest(1, HRID.gather, 5)]});
    h.receive({type: 'loadouts_updated', characterLoadoutMap: {52: loadout('cooking')}});
    await h.resume();
    assert.equal(h.sent.length, 0, 'the removed Foraging loadout must not survive a full map replacement');
    assert.equal(h.c.state.enabled, false);
    h.receive({type: 'loadouts_updated', characterLoadoutMap: {151: loadout('foraging', {id: 151})}});
    await h.resume();
    assert.equal(enqueue(h)?.characterLoadoutId, 151);
});

test('a loadout changed while materials are being purchased is resolved again before enqueueing', async () => {
    const h = harness({tasks: [quest(1, HRID.produce, 2)]});
    await h.start();
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
    h.receive({type: 'loadouts_updated', characterLoadoutMap: {152: loadout('cooking', {id: 152})}});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 6)]});
    await h.tick();
    assert.equal(enqueue(h)?.characterLoadoutId, 152);
});

test('queue acknowledgements accept either loadout ID spelling when both agree', async () => {
    for (const ids of [{characterLoadoutID: 51}, {characterLoadoutId: 51}, {characterLoadoutID: 51, characterLoadoutId: 51}]) {
        const h = harness({tasks: [quest(1, HRID.gather, 5)]});
        await h.start();
        const acknowledged = action(42, HRID.gather, 5);
        delete acknowledged.characterLoadoutID;
        h.receive({type: 'actions_updated', endCharacterActions: [{...acknowledged, ...ids}]});
        await h.tick();
        assert.equal(h.c.state.pending, null);
        assert.equal(h.c.state.owned['42'], HRID.gather);
        assert.equal(sentOf(h, 'new_character_action').length, 1);
    }
});

test('wrong, missing or conflicting loadout IDs cannot acknowledge the queued request', async () => {
    for (const ids of [{characterLoadoutID: 0}, {characterLoadoutID: 151}, {}, {characterLoadoutID: 51, characterLoadoutId: 151}]) {
        const h = harness({tasks: [quest(1, HRID.gather, 5)]});
        await h.start();
        const acknowledged = action(42, HRID.gather, 5);
        delete acknowledged.characterLoadoutID;
        h.receive({type: 'actions_updated', endCharacterActions: [{...acknowledged, ...ids}]});
        await h.tick();
        assert.notEqual(h.c.state.pending, null);
        assert.equal(h.c.state.owned['42'], undefined);
        assert.equal(sentOf(h, 'new_character_action').length, 1);
    }
});

test('a pending enqueue keeps its original expected loadout after a loadout map update', async () => {
    const h = harness({tasks: [quest(1, HRID.gather, 5)]});
    await h.start();
    assert.equal(enqueue(h)?.characterLoadoutId, 51);
    h.receive({type: 'loadouts_updated', characterLoadoutMap: {151: loadout('foraging', {id: 151})}});
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 5, 0, {characterLoadoutID: 151})]});
    await h.tick();
    assert.notEqual(h.c.state.pending, null);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 5, 0, {characterLoadoutID: 51})]});
    await h.tick();
    assert.equal(h.c.state.pending, null);
    assert.equal(sentOf(h, 'new_character_action').length, 1);
});

test('refresh resolves an accepted pending enqueue against its saved loadout instead of the new same-name loadout', async () => {
    const first = harness({tasks: [quest(1, HRID.gather, 5)]});
    await first.start();
    assert.equal(enqueue(first)?.characterLoadoutId, 51);
    const fresh = harness({
        storage: first.storage,
        tasks: [quest(1, HRID.gather, 5)],
        actions: [action(42, HRID.gather, 5, 0, {characterLoadoutID: 51})],
        loadouts: {151: loadout('foraging', {id: 151})},
    });
    await fresh.tick();
    assert.equal(fresh.c.state.pending, null);
    assert.equal(fresh.c.state.owned['42'], HRID.gather);
    assert.equal(sentOf(fresh, 'new_character_action').length, 0);
});

test('an older covered queue keeps its original loadout without cancelling, rebuilding or loading gear immediately', async () => {
    for (const id of [0, 151]) {
        const h = harness({
            automation: true,
            tasks: [quest(1, HRID.gather, 7, 3)],
            actions: [action(42, HRID.gather, 7, 3, {characterLoadoutID: id})],
        });
        await h.resume();
        await h.tick();
        assert.deepEqual(h.sent, []);
        assert.equal(h.c.state.actions['42'].characterLoadoutID, id);
        assert.equal(h.c.state.enabled, true);
    }
});

test('a legacy pending queue without a saved loadout ID can recognize the accepted loadout-zero action', async () => {
    const storage = memoryStorage();
    storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify({
        schema: 1,
        job: {taskIds: ['1']},
        owned: {},
        credits: {},
        saleCredits: {},
        saleCheckpoints: {},
        floors: {[`${HRID.coin}::0`]: 100000},
        progress: {},
        watched: {[HRID.gather]: ['1']},
        pending: {kind: 'queue', actionHrid: HRID.gather, count: 5, beforeIds: [], primaryItemHash: '', inventoryRevision: 0, sentAt: 100000},
        enabled: true,
        sellOutputs: true,
        autoClaim: false,
        autoRead: false,
        autoQueue: false,
        rerollCombat: false,
        autoSessionInitialized: true,
    }));
    const h = harness({
        storage,
        tasks: [quest(1, HRID.gather, 5)],
        actions: [action(42, HRID.gather, 5, 0, {characterLoadoutID: 0})],
    });
    await h.tick();
    assert.equal(h.c.state.pending, null);
    assert.equal(h.c.state.owned['42'], HRID.gather);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

test('refresh preserves output outside an uncertain sale and waits for its later settlement', async () => {
    const first = harness({
        tasks: [quest(1, HRID.gather, 3)],
        actions: [action(42, HRID.gather, 1), action(43, HRID.gather, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await first.start();
    first.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 110)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 1)],
    });
    await first.tick();
    first.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 2, 1),
        endCharacterItems: [item(HRID.apple, 113)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 2)],
    });
    assert.equal(first.c.state.pending?.count, 10);
    assert.equal(first.c.state.credits[`${HRID.apple}::0`], 13);
    assert.equal(first.c.state.saleCredits[`${HRID.apple}::0`], 10);
    const fresh = harness({
        storage: first.storage,
        tasks: [quest(1, HRID.gather, 3, 2)],
        actions: [action(43, HRID.gather, 2, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 103)],
    });
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`], 3);
    assert.equal(fresh.c.state.saleCredits[`${HRID.apple}::0`] || 0, 0);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 0);
    fresh.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 2, 2),
        endCharacterItems: [item(HRID.apple, 105)],
        endCharacterQuests: [quest(1, HRID.gather, 3, 3)],
    });
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 5,
        'three earlier confirmed outputs survive the uncertain sale and join two new outputs');
});

test('refresh preserves a later settled budget while removing only the uncertain sale quantity', async () => {
    const first = harness({
        tasks: [quest(1, HRID.gather, 2)],
        actions: [action(42, HRID.gather, 1), action(43, HRID.gather, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
    });
    await first.start();
    first.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 110)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 1)],
    });
    await first.tick();
    first.receive({
        type: 'action_completed',
        endCharacterAction: action(43, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 113)],
        endCharacterQuests: [quest(1, HRID.gather, 2, 2)],
    });
    assert.equal(first.c.state.pending?.count, 10);
    assert.equal(first.c.state.credits[`${HRID.apple}::0`], 13);
    assert.equal(first.c.state.saleCredits[`${HRID.apple}::0`], 13);
    const fresh = harness({
        storage: first.storage,
        tasks: [completedQuest(1, {goalCount: 2, currentCount: 2})],
        actions: [],
        items: [item(HRID.coin, 100000), item(HRID.apple, 103)],
    });
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`], 3);
    assert.equal(fresh.c.state.saleCredits[`${HRID.apple}::0`], 3);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 3);
});

test('locked output keeps its confirmed credits and settlement until the stack is unlocked', async () => {
    const h = harness({
        tasks: [quest(1, HRID.gather, 1)],
        actions: [action(42, HRID.gather, 1)],
        items: [item(HRID.coin, 100000), {...item(HRID.apple, 100), isLocked: true}],
    });
    await h.start();
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [{...item(HRID.apple, 110), isLocked: true}],
        endCharacterQuests: [quest(1, HRID.gather, 1, 1)],
    });
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 10);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`], 10);
    h.receive({type: 'items_updated', endCharacterItems: [{...item(HRID.apple, 110), isLocked: false}]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 10);
});

// Finish an owned queue without inventing an inventory delta. Subsequent stock
// changes deliberately have an unknown source (offline output, purchases or
// rewards), which the user has authorized recovery to sell above protections.
async function settledSurplusHarness({completionItems = [], ...options} = {}) {
    const h = harness({
        recoverSurplus: true,
        tasks: [quest(1, HRID.gather, 1)],
        actions: [action(42, HRID.gather, 1)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100)],
        ...options,
    });
    // Seed the requested settlement without startup inventory cleanup racing
    // this helper's synthetic completion. Startup cleanup has its own test.
    const recoveryEnabled = h.c.state.recoverSurplus;
    h.c.configureTasks({recoverSurplus: false});
    await h.start([1]);
    h.c.configureTasks({recoverSurplus: recoveryEnabled});
    h.receive({
        type: 'action_completed',
        endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: completionItems,
        endCharacterQuests: [quest(1, HRID.gather, 1, 1)],
    });
    return h;
}

test('surplus recovery defaults on, preserves an explicit opt-out and migrates older saves', () => {
    const initial = harness({recoverSurplus: null});
    assert.equal(initial.c.state.recoverSurplus, true);
    initial.c.configureTasks({recoverSurplus: false});
    const optedOut = harness({storage: initial.storage, recoverSurplus: null});
    assert.equal(optedOut.c.state.recoverSurplus, false);
    const saved = JSON.parse(initial.storage.getItem('MWI_TASK_QUEUE_V1:123'));
    delete saved.recoverSurplus;
    initial.storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
    const migrated = harness({storage: initial.storage, recoverSurplus: null});
    assert.equal(migrated.c.state.recoverSurplus, true);
});

test('surplus recovery counts only uncredited stock, is idempotent and never starts or sends by itself', async () => {
    const h = await settledSurplusHarness({completionItems: [item(HRID.apple, 105)]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 135)]});
    assert.deepEqual(h.c.previewSurplus(), {
        characterId: '123',
        rows: [{itemKey: `${HRID.apple}::0`, itemHrid: HRID.apple, hash: item(HRID.apple, 0).hash,
            count: 130, stock: 135, floor: 0, reserved: 0, known: 5}],
    });
    h.c.stop();
    assert.equal(h.c.recoverSurplus()[0]?.count, 130);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 135);
    assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`], 135);
    assert.deepEqual(h.c.recoverSurplus(), []);
    await h.tick();
    assert.equal(h.c.state.enabled, false);
    assert.deepEqual(h.sent, []);
    h.c.configureTasks({recoverSurplus: false, sellOutputs: false});
    await h.resume();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0, 'the sale switch suppresses previously credited cleanup');
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 135, 'disabling inventory cleanup preserves existing credits');
    h.c.configureTasks({sellOutputs: true});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 135);
    assert.throws(() => h.c.recoverSurplus(), /尚未确认/);
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 135);
});

test('reconnect recovers all settled tester product stock including the saved original inventory without duplicate sales', async () => {
    const first = await settledSurplusHarness();
    const fresh = harness({
        storage: first.storage,
        recoverSurplus: true,
        tasks: [completedQuest(1)],
        actions: [],
        items: [item(HRID.coin, 100000), item(HRID.apple, 160)],
    });
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`] || 0, 0);
    assert.equal(fresh.c.state.recoveryNeeded, true);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 160);
    assert.equal(fresh.c.state.floors[`${HRID.apple}::0`], 100);
    fresh.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 0)]});
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 1);
});

test('inventory recovery includes allowed items beyond all four product tables without retaining original stock', async () => {
    const essence = '/items/test_essence';
    const rare = '/items/test_rare';
    const unsellable = '/items/test_unsellable';
    const client = clientData();
    Object.assign(client.actionDetailMap[HRID.gather], {
        outputItems: [{itemHrid: HRID.sauce, count: 1}],
        dropTable: [{itemHrid: HRID.pie, dropRate: 0.1}],
        rareDropTable: [{itemHrid: rare, dropRate: 0.01}],
        essenceDropTable: [{itemHrid: essence, dropRate: 0.01},
            {itemHrid: HRID.coin}, {itemHrid: unsellable}],
    });
    client.itemDetailMap[essence] = {sellPrice: 1, categoryHrid: CATEGORY.resource};
    client.itemDetailMap[rare] = {sellPrice: 1, categoryHrid: CATEGORY.resource};
    client.itemDetailMap[unsellable] = {sellPrice: 0, categoryHrid: CATEGORY.resource};
    const h = await settledSurplusHarness({client, items: [
        item(HRID.coin, 100000), item(HRID.apple, 100), item(HRID.sauce, 10),
        item(HRID.pie, 20), item(rare, 30), item(essence, 40),
    ]});
    h.receive({type: 'items_updated', endCharacterItems: [
        item(HRID.apple, 999), item(HRID.sauce, 12), item(HRID.pie, 23),
        item(rare, 34), item(essence, 45), item(rare, 99, 7),
        item(HRID.coin, 200000), item(unsellable, 99),
    ]});
    assert.deepEqual(Object.fromEntries(h.c.previewSurplus().rows.map(r => [r.itemHrid, r.count])), {
        [HRID.apple]: 999, [HRID.sauce]: 12, [HRID.pie]: 23, [rare]: 34, [essence]: 45,
    });
});

test('an observed owned output supplements product metadata and survives refresh for recovery', async () => {
    const special = '/items/test_observed_drop';
    const client = nonTesterClientData();
    client.itemDetailMap[special] = {sellPrice: 1, categoryHrid: CATEGORY.resource};
    const first = await settledSurplusHarness({client, items: [item(HRID.coin, 100000)], completionItems: [item(special, 2)]});
    assert.equal(first.c.state.observedOutputs[HRID.gather]?.[`${special}::0`], true);
    const fresh = harness({
        storage: first.storage, client, recoverSurplus: true,
        tasks: [completedQuest(1)], actions: [],
        items: [item(HRID.coin, 100000), item(special, 7)],
    });
    assert.equal(fresh.c.previewSurplus().rows.find(r => r.itemHrid === special)?.count, 5);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 7);
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.itemHash, item(special, 0).hash);
});

test('resource and base equipment recovery ignores tester availability and saved food drink or wearable references', async () => {
    const client = nonTesterClientData();
    client.actionDetailMap[HRID.gather].dropTable = [{itemHrid: HRID.sauce}, {itemHrid: HRID.pie}];
    const loadouts = defaultLoadouts();
    loadouts[51].foodItemHrids = [HRID.apple];
    loadouts[53].drinkItemHrids = [HRID.sauce];
    loadouts[52].wearableMap = {'/equipment_types/body': item(HRID.pie, 1, 10).hash};
    const h = await settledSurplusHarness({client, loadouts});
    h.receive({type: 'items_updated', endCharacterItems: [
        item(HRID.apple, 105), item(HRID.sauce, 8), item(HRID.pie, 9), item(HRID.pie, 1, 10),
    ]});
    assert.deepEqual(h.c.previewSurplus().rows.map(r => [r.itemHrid, r.count]),
        [[HRID.apple, 105], [HRID.sauce, 8], [HRID.pie, 9]]);
    loadouts[52] = {...loadouts[52], useExactEnhancement: true};
    h.receive({type: 'loadouts_updated', characterLoadoutMap: loadouts});
    assert.deepEqual(h.c.previewSurplus().rows.map(r => [r.itemHrid, r.count]),
        [[HRID.apple, 105], [HRID.sauce, 8], [HRID.pie, 9]], 'preset enhancement matching never controls the cleanup whitelist');
});

test('settled allowed output bypasses saved presets while enhanced and unknown-category items remain protected', async () => {
    for (const recoverSurplus of [false, true]) {
        const client = clientData();
        const unrelated = '/items/tester_unrelated';
        client.actionDetailMap[HRID.gather].outputItems = [{itemHrid: HRID.pie}];
        client.actionDetailMap[HRID.gather].dropTable = [{itemHrid: HRID.apple}, {itemHrid: HRID.sauce}];
        client.itemDetailMap[unrelated] = {sellPrice: 1};
        addTesterItem(client, HRID.pie, '/shop_items/unusual_equipment_offer');
        addTesterItem(client, HRID.sauce);
        addTesterItem(client, unrelated);
        const loadouts = defaultLoadouts();
        loadouts[52].wearableMap = {'/equipment_types/body': item(HRID.pie, 1, 20).hash};
        loadouts[51].foodItemHrids = [HRID.apple];
        loadouts[53].drinkItemHrids = [HRID.sauce];
        const h = harness({client, loadouts, recoverSurplus: false,
            tasks: [quest(1, HRID.gather, 2)], actions: [action(42, HRID.gather, 2)],
            items: [item(HRID.coin, 100000), item(HRID.pie, 3), item(HRID.apple, 10),
                item(HRID.sauce, 5), item(HRID.pie, 1, 20), item(unrelated, 50)]});
        await h.start();
        h.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 2, 1),
            endCharacterItems: [item(HRID.pie, 6), item(HRID.apple, 12), item(HRID.sauce, 7)],
            endCharacterQuests: [quest(1, HRID.gather, 2, 1)]});
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop').length, 0, 'production still waits for a settlement boundary');
        h.c.configureTasks({recoverSurplus});
        h.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 2, 2),
            endCharacterItems: [item(HRID.pie, 8), item(HRID.apple, 14), item(HRID.sauce, 9)],
            endCharacterQuests: [quest(1, HRID.gather, 2, 2)]});
        const totals = [[HRID.pie, 8, 5], [HRID.apple, 14, 4], [HRID.sauce, 9, 4]];
        for (const [index, [hrid, stock, known]] of totals.entries()) {
            await h.tick();
            const count = recoverSurplus ? stock : known;
            assert.deepEqual(sentOf(h, 'sell_to_shop')[index]?.sellToShopData,
                {itemHash: item(hrid, 0).hash, count});
            h.receive({type: 'items_updated', endCharacterItems: [item(hrid, stock - count)]});
        }
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop').length, 3);
        assert.equal(h.c.state.items[item(HRID.pie, 1, 20).hash].count, 1);
        assert.equal(h.c.state.items[item(unrelated, 50).hash].count, 50);
    }
});

test('allowed category cleanup is independent of tester shop keys availability and prices', async () => {
    const variants = [
        {name: 'noncanonical key', patch: {}, eligible: true},
        {name: 'wrong item', patch: {itemHrid: HRID.sauce}, eligible: false},
        {name: 'regular shop', patch: {category: '/shop_categories/general'}, eligible: false},
        {name: 'missing cost data', patch: {costs: undefined}, eligible: false},
        {name: 'invalid cost count', patch: {costs: [{itemHrid: HRID.coin, count: -1}]}, eligible: false},
    ];
    for (const {name, patch, eligible} of variants) {
        const client = nonTesterClientData();
        addTesterItem(client, HRID.apple, '/shop_items/a_completely_different_name');
        Object.assign(client.shopItemDetailMap['/shop_items/a_completely_different_name'], patch);
        const h = await settledSurplusHarness({client});
        h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 105)]});
        const row = h.c.previewSurplus().rows[0];
        assert.equal(row?.floor, 0, name);
        assert.equal(row?.count, 105, name);
    }
});

test('resume cleans untracked resource and base equipment inventory without tasks or tester listings and retains all other categories', async () => {
    const client = nonTesterClientData();
    const food = '/items/apple', drink = '/items/production_tea', mirror = '/items/philosophers_mirror';
    const lockedGear = '/items/wooden_shield', unknown = '/items/unclassified_test_item';
    const loot = '/items/test_loot', wrongCategory = '/items/test_plural_resource';
    Object.assign(client.itemDetailMap, {
        [food]: {sellPrice: 1, categoryHrid: CATEGORY.food},
        [drink]: {sellPrice: 1, categoryHrid: CATEGORY.drink},
        [mirror]: {sellPrice: 1, categoryHrid: CATEGORY.resource},
        [lockedGear]: {sellPrice: 1, categoryHrid: CATEGORY.equipment},
        [unknown]: {sellPrice: 1},
        [loot]: {sellPrice: 1, categoryHrid: '/item_categories/loot'},
        [wrongCategory]: {sellPrice: 1, categoryHrid: '/item_categories/resources'},
    });
    const h = harness({client, recoverSurplus: true, tasks: [],
        actions: [action(90, HRID.second, 1)],
        items: [item(HRID.coin, 100000), item(food, 4), item(drink, 5), item(HRID.pie, 3),
            item(HRID.apple, 7), ...[1, 9, 10, 20].map(level => item(HRID.pie, 1, level)),
            item(mirror, 6), {...item(lockedGear, 2), isLocked: true}, item(unknown, 8),
            item(loot, 9), item(wrongCategory, 10)]});
    await h.resume();
    assert.deepEqual(h.c.state.owned, {});
    assert.deepEqual(h.c.state.settledActionHrids, {});
    assert.deepEqual(h.c.state.observedOutputs, {});
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.pie, 0).hash, count: 3});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.pie, 0)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[1]?.sellToShopData,
        {itemHash: item(HRID.apple, 0).hash, count: 5}, 'the finite queued recipe keeps its two material units');
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 2)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 2);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    assert.deepEqual(h.c.previewSurplus().rows, []);
    for (const [hrid, count] of [[food, 4], [drink, 5], [mirror, 6], [lockedGear, 2], [unknown, 8], [loot, 9], [wrongCategory, 10]]) {
        assert.equal(h.c.state.items[item(hrid, 0).hash].count, count, hrid);
    }
    for (const level of [1, 9, 10, 20]) assert.equal(h.c.state.items[item(HRID.pie, 1, level).hash].count, 1);
});

test('food and ordinary drink categories reject online output and stale sale credits even with tester listings and historical product records', async () => {
    const client = clientData();
    const protectedItems = [['/items/apple', CATEGORY.food], ['/items/production_tea', CATEGORY.drink]];
    client.actionDetailMap[HRID.gather].outputItems = protectedItems.map(([itemHrid]) => ({itemHrid, count: 1}));
    for (const [hrid, categoryHrid] of protectedItems) {
        client.itemDetailMap[hrid] = {sellPrice: 1, categoryHrid};
        addTesterItem(client, hrid);
    }
    const first = await settledSurplusHarness({client, items: [item(HRID.coin, 100000)],
        completionItems: protectedItems.map(([hrid]) => item(hrid, 4))});
    for (const [hrid] of protectedItems) assert.equal(first.c.state.credits[`${hrid}::0`] || 0, 0);
    assert.deepEqual(first.c.previewSurplus().rows, []);
    await first.tick();
    assert.equal(sentOf(first, 'sell_to_shop').length, 0);
    const saved = JSON.parse(first.storage.getItem('MWI_TASK_QUEUE_V1:123'));
    saved.credits = Object.fromEntries(protectedItems.map(([hrid]) => [`${hrid}::0`, 4]));
    saved.saleCredits = {...saved.credits};
    saved.observedOutputs = {[HRID.gather]: Object.fromEntries(protectedItems.map(([hrid]) => [`${hrid}::0`, true]))};
    first.storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
    const fresh = harness({storage: first.storage, client, recoverSurplus: true, tasks: [], actions: [],
        items: [item(HRID.coin, 100000), ...protectedItems.map(([hrid]) => item(hrid, 7))]});
    assert.deepEqual(fresh.c.previewSurplus().rows, []);
    assert.equal(fresh.c.nextSale(), null);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 0);
    for (const [hrid] of protectedItems) assert.equal(fresh.c.state.items[item(hrid, 0).hash].count, 7);
});

test('an automatic claim acknowledgement triggers inventory cleanup without any owned or historical task products', async () => {
    const h = harness({maintenance: true, recoverSurplus: true, tasks: [], actions: []});
    await h.resume();
    assert.equal(h.c.state.recoveryNeeded, false);
    assert.deepEqual(h.sent, []);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.pie, 3)]});
    h.receive({type: 'quests_updated', endCharacterQuests: [completedQuest(99)]});
    await h.tick();
    assert.equal(sentOf(h, 'claim_character_quest')[0]?.claimCharacterQuestData.characterQuestId, 99);
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    assert.deepEqual(h.c.state.owned, {});
    assert.deepEqual(h.c.state.settledActionHrids, {});
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(99)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.pie, 0).hash, count: 3});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.pie, 0)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
});

test('resuming after a pause scans eligible inventory acquired while automatic selling was stopped', async () => {
    const h = harness({recoverSurplus: true, tasks: [], actions: []});
    await h.resume();
    assert.equal(h.c.state.recoveryNeeded, false);
    h.c.stop();
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.pie, 3)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    assert.equal(h.c.state.enabled, false);
    await h.resume();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.pie, 0).hash, count: 3});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.pie, 0)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
});

test('a completed queue retains all purchased inputs for the current batch before and after the production queue is appended', async () => {
    const h = harness({recoverSurplus: false,
        tasks: [quest(1, HRID.gather, 1), quest(2, HRID.produce, 2)],
        actions: [action(42, HRID.gather, 1)]});
    await h.start([1, 2]);
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 6);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 6)]});
    h.c.configureTasks({recoverSurplus: true});
    h.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 1, 1),
        endCharacterItems: [item(HRID.apple, 7)], endCharacterQuests: [completedQuest(1)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.apple, 0).hash, count: 1});
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 6)]});
    await h.tick();
    assert.equal(enqueue(h)?.actionHrid, HRID.produce);
    assert.equal(enqueue(h)?.maxCount, 2);
    h.receive({type: 'actions_updated', endCharacterActions: [action(43, HRID.produce, 2)]});
    await h.tick();
    assert.deepEqual(h.c.previewSurplus().rows, []);
    assert.equal(h.c.nextSale(), null);
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
    assert.equal(h.c.state.items[item(HRID.apple, 0).hash].count, 6);
});

test('tester recovery ignores saved base wearables while retaining active primary and secondary physical targets', async () => {
    const {client, enhancing} = unlimitedEnhancingFixture();
    client.actionDetailMap[HRID.gather].dropTable = [{itemHrid: HRID.sauce}, {itemHrid: HRID.pie}];
    client.itemDetailMap[HRID.apple].enhancementCosts = [
        {itemHrid: HRID.apple, count: 2}, {itemHrid: HRID.sauce, count: 3}, {itemHrid: HRID.pie, count: 1},
    ];
    addTesterItem(client, HRID.sauce);
    addTesterItem(client, HRID.pie);
    const loadouts = defaultLoadouts();
    for (const id of [51, 52, 53]) loadouts[id].wearableMap = {'/equipment_types/body': item(HRID.pie, 1).hash};
    const background = {...enhancing, primaryItemHash: item(HRID.apple, 1).hash,
        secondaryItemHash: item(HRID.sauce, 1).hash};
    const h = await settledSurplusHarness({client, loadouts,
        actions: [action(42, HRID.gather, 1), background],
        items: [item(HRID.coin, 100000), item(HRID.apple, 10), item(HRID.sauce, 10), item(HRID.pie, 10)]});
    assert.deepEqual(Object.fromEntries(h.c.previewSurplus().rows.map(r => [r.itemHrid, [r.count, r.reserved]])), {
        [HRID.apple]: [9, 1], [HRID.sauce]: [9, 1], [HRID.pie]: [10, 0],
    });
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.apple, 0).hash, count: 9});
});

test('all three base pants are sold despite base presets while the separate enhanced pants and their active hashes stay intact', async () => {
    for (const zeroLevel of [0, '0']) {
        const pants = '/items/test_pants';
        const {client, enhancing} = unlimitedEnhancingFixture();
        client.actionDetailMap[HRID.gather].outputItems = [{itemHrid: pants}];
        client.itemDetailMap[pants] = {sellPrice: 1, categoryHrid: CATEGORY.equipment};
        addTesterItem(client, pants);
        const loadouts = defaultLoadouts();
        loadouts[51].wearableMap = {'/equipment_types/legs': item(pants, 1).hash};
        loadouts[52].wearableMap = {'/equipment_types/legs': item(pants, 1, 20).hash};
        const h = await settledSurplusHarness({client, loadouts,
            actions: [action(42, HRID.gather, 1), {...enhancing,
                primaryItemHash: item(pants, 1, 9).hash, secondaryItemHash: item(pants, 1, 10).hash}],
            items: [item(HRID.coin, 100000), {...item(pants, 3), enhancementLevel: zeroLevel},
                ...[9, 10, 20].map(level => item(pants, 1, level))]});
        assert.deepEqual(h.c.previewSurplus().rows.map(row => [row.itemHrid, row.count, row.reserved]), [[pants, 3, 0]]);
        await h.tick();
        assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
            {itemHash: item(pants, 0).hash, count: 3});
        h.receive({type: 'items_updated', endCharacterItems: [item(pants, 0)]});
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop').length, 1);
        for (const level of [9, 10, 20]) assert.equal(h.c.state.items[item(pants, 1, level).hash].count, 1);
    }
});

test('new talisman belts use equipment cleanup while enhanced inventory and the worn belt remain intact', async () => {
    const belts = ['small_talisman_belt', 'medium_talisman_belt', 'large_talisman_belt'].map(id => `/items/${id}`);
    const client = clientData();
    for (const hrid of belts) client.itemDetailMap[hrid] = {sellPrice: 1, categoryHrid: CATEGORY.equipment};
    const worn = {...item(belts[2], 1, 20), itemLocationHrid: '/item_locations/belt',
        hash: `123::/item_locations/belt::${belts[2]}::20`};
    const h = await settledSurplusHarness({client, items: [item(HRID.coin, 100000), worn,
        ...belts.flatMap(hrid => [item(hrid, 3), ...[9, 10, 20].map(level => item(hrid, 1, level))])]});
    assert.deepEqual(h.c.previewSurplus().rows.map(row => [row.itemHrid, row.count]), belts.map(hrid => [hrid, 3]));
    for (const hrid of belts) {
        await h.tick();
        assert.deepEqual(sentOf(h, 'sell_to_shop').at(-1).sellToShopData,
            {itemHash: item(hrid, 0).hash, count: 3});
        h.receive({type: 'items_updated', endCharacterItems: [item(hrid, 0)]});
    }
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, belts.length);
    for (const hrid of belts) for (const level of [9, 10, 20]) {
        assert.equal(h.c.state.items[item(hrid, 1, level).hash].count, 1);
    }
    assert.equal(h.c.state.items[worn.hash].count, 1);
});

test('ambiguous or inconsistent item rows cannot create output sales online or through saved credits after reconnect', async () => {
    const base = item(HRID.pie, 3);
    const variants = [
        {name: 'field zero hash nine', row: {...base, hash: item(HRID.pie, 3, 9).hash}},
        {name: 'field zero hash ten', row: {...base, hash: item(HRID.pie, 3, 10).hash}},
        {name: 'missing level hash nine', row: {...base, enhancementLevel: undefined, hash: item(HRID.pie, 3, 9).hash}},
        {name: 'missing level hash zero', row: {...base, enhancementLevel: undefined}},
        {name: 'null level', row: {...base, enhancementLevel: null}},
        {name: 'empty level', row: {...base, enhancementLevel: ''}},
        {name: 'boolean level', row: {...base, enhancementLevel: false}},
        {name: 'field nine hash zero', row: {...base, enhancementLevel: 9}},
        {name: 'field owner mismatch', row: {...base, characterID: 456}},
        {name: 'owner aliases conflict', row: {...base, characterId: 456}},
        {name: 'hash owner mismatch', row: {...base, hash: base.hash.replace('123::', '456::')}},
        {name: 'field location mismatch', row: {...base, itemLocationHrid: '/item_locations/equipment'}},
        {name: 'hash location mismatch', row: {...base, hash: base.hash.replace('/item_locations/inventory', '/item_locations/equipment')}},
        {name: 'field item mismatch', row: {...base, itemHrid: HRID.sauce}},
        {name: 'incomplete hash', row: {...base, hash: `123::${HRID.pie}::0`}},
    ];
    for (const {name, row} of variants) {
        const client = clientData();
        client.actionDetailMap[HRID.gather].outputItems = [{itemHrid: HRID.pie}];
        addTesterItem(client, HRID.pie);
        addTesterItem(client, HRID.sauce);
        const h = await settledSurplusHarness({client,
            items: [item(HRID.coin, 100000)], completionItems: [row]});
        assert.deepEqual(h.c.previewSurplus().rows, [], `${name}: no recovery candidate`);
        assert.equal(h.c.state.credits[`${row.itemHrid}::0`] || 0, 0, `${name}: no online zero-level credit`);
        assert.equal(h.c.nextSale(), null, name);
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop').length, 0, `${name}: no online packet`);

        const saved = JSON.parse(h.storage.getItem('MWI_TASK_QUEUE_V1:123'));
        saved.credits = {[`${HRID.pie}::0`]: 3, [`${HRID.sauce}::0`]: 3};
        saved.saleCredits = {...saved.credits};
        saved.floors = {};
        h.storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
        const fresh = harness({storage: h.storage, client, recoverSurplus: true,
            tasks: [completedQuest(1)], actions: [], items: [item(HRID.coin, 100000), row]});
        assert.deepEqual(fresh.c.previewSurplus().rows, [], `${name}: no recovered candidate`);
        assert.equal(fresh.c.nextSale(), null, `${name}: saved credits cannot authorize the hash`);
        await fresh.tick();
        assert.equal(sentOf(fresh, 'sell_to_shop').length, 0, `${name}: no reconnect packet`);
    }
});

test('legacy enhanced credits never turn into base-item sale credits after reconnect', async () => {
    const client = clientData();
    client.actionDetailMap[HRID.gather].outputItems = [{itemHrid: HRID.pie}];
    addTesterItem(client, HRID.pie);
    const first = await settledSurplusHarness({client, recoverSurplus: false,
        items: [item(HRID.coin, 100000)]});
    const saved = JSON.parse(first.storage.getItem('MWI_TASK_QUEUE_V1:123'));
    saved.credits = {[`${HRID.pie}::9`]: 1, [`${HRID.pie}::10`]: 1};
    saved.saleCredits = {...saved.credits};
    saved.observedOutputs = {[HRID.gather]: {[`${HRID.pie}::9`]: true, [`${HRID.pie}::10`]: true}};
    first.storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
    const fresh = harness({storage: first.storage, client, recoverSurplus: false,
        tasks: [completedQuest(1)], actions: [],
        items: [item(HRID.coin, 100000), item(HRID.pie, 3), item(HRID.pie, 1, 9), item(HRID.pie, 1, 10)]});
    assert.equal(fresh.c.state.credits[`${HRID.pie}::0`] || 0, 0);
    assert.equal(fresh.c.state.saleCredits[`${HRID.pie}::0`] || 0, 0);
    assert.equal(fresh.c.nextSale(), null);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 0);
});

test('a sale remains pending when only an enhanced or contradictory item row reports the expected decrement', async () => {
    const h = await settledSurplusHarness({completionItems: [item(HRID.apple, 103)]});
    await h.tick();
    assert.equal(h.c.state.pending?.kind, 'sell');
    for (const row of [item(HRID.apple, 0, 9),
        {...item(HRID.apple, 0), enhancementLevel: 10},
        {...item(HRID.apple, 0), enhancementLevel: undefined}]) {
        h.receive({type: 'items_updated', endCharacterItems: [row]});
        assert.equal(h.c.state.pending?.kind, 'sell');
        assert.notEqual(h.c.state.pending?.responseObserved, true,
            'an enhanced or ambiguous row is not evidence that the pending base-item sale was processed');
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop').length, 1);
    }
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 0)]});
    assert.equal(h.c.state.pending, null);
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
});

test('reload clamps confirmed tester credits against current stock without subtracting the obsolete original floor', async () => {
    const loadouts = defaultLoadouts();
    loadouts[52].wearableMap = {'/equipment_types/body': item(HRID.apple, 1, 20).hash};
    const first = await settledSurplusHarness({loadouts, recoverSurplus: false,
        completionItems: [item(HRID.apple, 103)]});
    const fresh = harness({storage: first.storage, loadouts, recoverSurplus: false,
        tasks: [completedQuest(1)], actions: [],
        items: [item(HRID.coin, 100000), item(HRID.apple, 3), item(HRID.apple, 1, 20)]});
    assert.equal(fresh.c.state.floors[`${HRID.apple}::0`], 100);
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`], 3);
    assert.equal(fresh.c.state.saleCredits[`${HRID.apple}::0`], 3);
    await fresh.tick();
    assert.deepEqual(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.apple, 0).hash, count: 3});
});

test('insufficient funds for another task do not prevent selling unrelated settled products', async () => {
    const client = nonTesterClientData();
    client.actionDetailMap[HRID.gather].outputItems = [{itemHrid: HRID.sauce}];
    addTesterItem(client, HRID.sauce);
    addTesterItem(client, HRID.apple);
    const h = await settledSurplusHarness({client,
        items: [item(HRID.coin, 0), item(HRID.sauce, 5)]});
    h.c.configureTasks({autoQueue: true});
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(2, HRID.produce, 100)]});
    assert.throws(() => h.c.plan([2]), /金币|余额|不足/);
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.sauce, 0).hash, count: 5});
});

test('finishing an unowned finite queue rechecks settled tester stock after its material reservation is released', async () => {
    const h = await settledSurplusHarness({
        actions: [action(42, HRID.gather, 1), action(90, HRID.second, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 10)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 6);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 4)]});
    await h.tick();
    h.receive({type: 'action_completed', endCharacterAction: action(90, HRID.second, 2, 1)});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1, 'ordinary action progress does not release reserved leftovers');
    h.receive({type: 'action_completed', endCharacterAction: action(90, HRID.second, 2, 2)});
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop').map(m => m.sellToShopData.count), [6, 4]);
});

test('unknown background consumption does not block allowed resource cleanup with or without tester listings', async () => {
    const client = clientData();
    client.actionDetailMap[HRID.gather].dropTable = [{itemHrid: HRID.sauce}];
    const maze = action(90, '/actions/labyrinth/explore', 0, 0, {hasMaxCount: false});
    const h = await settledSurplusHarness({client,
        actions: [action(42, HRID.gather, 1), maze],
        items: [item(HRID.coin, 100000), item(HRID.apple, 100), item(HRID.sauce, 10)],
        completionItems: [item(HRID.apple, 105), item(HRID.sauce, 12)]});
    const preview = h.c.previewSurplus();
    assert.notEqual(preview.deferred, true);
    assert.deepEqual(preview.rows.map(r => [r.itemHrid, r.count]), [[HRID.apple, 100], [HRID.sauce, 10]]);
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.apple, 0).hash, count: 105});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 0)]});
    await h.tick();
    assert.equal(h.c.state.recoveryNeeded, false);
    assert.deepEqual(sentOf(h, 'sell_to_shop')[1]?.sellToShopData,
        {itemHash: item(HRID.sauce, 0).hash, count: 12});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.sauce, 0)]});
    client.actionDetailMap[maze.actionHrid] = {function: '/action_functions/combat', inputItems: [], outputItems: []};
    h.receive(client);
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 2);
});

test('recovery recomputes current queue and automatic task materials and checks fresh inventory locks', async () => {
    const h = await settledSurplusHarness();
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 140)]});
    assert.equal(h.c.previewSurplus().rows[0]?.count, 140);
    h.c.configureTasks({autoQueue: true});
    h.receive({type: 'actions_updated', endCharacterActions: [action(43, HRID.second, 2)]});
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(2, HRID.produce, 3)]});
    assert.equal(h.c.previewSurplus().rows[0]?.reserved, 13);
    assert.equal(h.c.previewSurplus().rows[0]?.count, 127);
    h.receive({type: 'items_updated', endCharacterItems: [{...item(HRID.apple, 125), isLocked: true}]});
    assert.deepEqual(h.c.recoverSurplus(), []);
    h.receive({type: 'items_updated', endCharacterItems: [{...item(HRID.apple, 125), isLocked: false}]});
    assert.equal(h.c.recoverSurplus()[0]?.count, 112,
        'tester recovery recalculates from 125 stock less 13 current material reserve');
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 112);
});

test('unknown surplus is recovered at settlement boundaries rather than on every action or tick', async () => {
    const h = await settledSurplusHarness({automation: true, maintenance: {autoClaim: false, autoRead: false}});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 110)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 110);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 0)]});
    await h.tick();
    h.receive({type: 'actions_updated', endCharacterActions: [action(43, HRID.gather, 2)]});
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(2, HRID.gather, 2)]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 7)]});
    h.receive({type: 'action_completed', endCharacterAction: action(43, HRID.gather, 2, 1),
        endCharacterItems: [item(HRID.apple, 8)], endCharacterQuests: [quest(2, HRID.gather, 2, 1)]});
    for (let i = 0; i < 4; i += 1) await h.tick();
    assert.equal(h.c.state.credits[`${HRID.apple}::0`], 1);
    assert.equal(h.c.state.recoveryNeeded, false);
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
    h.receive({type: 'action_completed', endCharacterAction: action(43, HRID.gather, 2, 2),
        endCharacterItems: [item(HRID.apple, 10)], endCharacterQuests: [quest(2, HRID.gather, 2, 2)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[1]?.sellToShopData.count, 10);
});

test('enabling recovery or output selling requests a fresh recovery while either disabled flag prevents automatic recovery', async () => {
    const h = await settledSurplusHarness({recoverSurplus: false});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 130)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 0);
    h.c.configureTasks({sellOutputs: false, recoverSurplus: true});
    await h.tick();
    assert.equal(h.c.state.credits[`${HRID.apple}::0`] || 0, 0);
    h.c.configureTasks({sellOutputs: true});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 130);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 0)]});
    await h.tick();
    h.c.configureTasks({recoverSurplus: false});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 9)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
    h.c.configureTasks({recoverSurplus: true});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[1]?.sellToShopData.count, 9);
});

test('older quest and action checkpoints restore the settled product scope before checkpoint deduplication', async () => {
    for (const kind of ['quest', 'action']) {
        const storage = memoryStorage();
        storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify({
            schema: 1, job: null, owned: kind === 'action' ? {'42': HRID.gather} : {},
            credits: {}, saleCredits: {}, saleCheckpoints: {[`${kind}:${kind === 'quest' ? '1' : '42'}`]: true},
            floors: {[`${HRID.apple}::0`]: 100}, progress: {}, watched: {[HRID.gather]: ['1']},
            pending: null, enabled: true, sellOutputs: true, autoClaim: false, autoRead: false,
            autoQueue: false, rerollCombat: false, autoSessionInitialized: true,
        }));
        const h = harness({storage, recoverSurplus: null, tasks: [], actions: [],
            items: [item(HRID.coin, 100000), item(HRID.apple, 130)]});
        assert.equal(h.c.state.settledActionHrids[HRID.gather], true, `${kind} checkpoint restores its action`);
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 130);
    }
});

function tokenQuest(id, actionHrid, goalCount, tokens, currentCount = 0, overrides = {}) {
    return {...quest(id, actionHrid, goalCount, currentCount),
        itemRewardsJSON: JSON.stringify([{itemHrid: '/items/task_token', count: tokens}]),
        ...overrides};
}

test('task token rewards sum valid JSON entries and distinguish unknown data from zero rewards', () => {
    assert.equal(taskTokens(quest(1, HRID.gather, 1)), 25);
    assert.equal(taskTokens({...quest(1, HRID.gather, 1), itemRewardsJSON: JSON.stringify([
        {itemHrid: '/items/task_token', count: 12}, {itemHrid: HRID.coin, count: 1000},
        {itemHrid: '/items/task_token', count: 13},
    ])}), 25);
    assert.equal(taskTokens({...quest(1, HRID.gather, 1), itemRewardsJSON: '[]'}), 0);
    for (const value of [undefined, '{broken', 'null', JSON.stringify({count: 25}),
        JSON.stringify([{itemHrid: '/items/task_token', count: -1}]),
        JSON.stringify([{itemHrid: '/items/task_token', count: 2.5}]),
        JSON.stringify([{itemHrid: '/items/task_token', count: 'unknown'}])]) {
        assert.equal(taskTokens({...quest(1, HRID.gather, 1), itemRewardsJSON: value}), null);
    }
});

test('batch policy defaults to 25 tokens, 48 tasks and multiples of 3 and persists edited settings', () => {
    const h = harness({taskPolicy: null});
    assert.equal(h.c.state.minTokens, 25);
    assert.equal(h.c.state.batchTarget, 48);
    assert.equal(h.c.state.quantityMultiple, 3);
    h.c.configureTasks({minTokens: 30, batchTarget: 12, quantityMultiple: 6});
    const fresh = harness({storage: h.storage, taskPolicy: null});
    assert.equal(fresh.c.state.minTokens, 30);
    assert.equal(fresh.c.state.batchTarget, 12);
    assert.equal(fresh.c.state.quantityMultiple, 6);
});

test('47 qualifying tasks wait without purchasing or queueing and the 48th opens a fixed batch', async () => {
    const tasks = Array.from({length: 47}, (_, i) => quest(i + 1, HRID.gather, 4));
    const h = harness({automation: true, taskPolicy: null, tasks});
    await h.resume();
    assert.equal(h.c.state.job, null);
    assert.equal(h.c.batchStatus().eligibleCount, 47);
    assert.equal(h.c.batchStatus().target, 48);
    assert.deepEqual(h.sent, []);
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(48, HRID.gather, 4)]});
    await h.tick();
    assert.equal(h.c.state.job.fixedBatch, true);
    assert.equal(h.c.state.job.quantityMultiple, 3);
    assert.deepEqual(h.c.state.job.taskIds, Array.from({length: 48}, (_, i) => String(i + 1)));
    assert.equal(enqueue(h)?.maxCount, 6);
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(49, HRID.gather, 4)]});
    assert.equal(h.c.state.job.taskIds.includes('49'), false);
});

test('waiting for a full batch still reads tasks and rerolls a low-token life task using only coins', async () => {
    const h = harness({automation: true, taskPolicy: null, tasks: [], unreadTaskCount: 1});
    await h.resume();
    assert.deepEqual(h.sent.map(m => m.type), ['read_random_tasks']);
    h.receive({type: 'quests_updated', endCharacterQuests: [tokenQuest(1, HRID.produce, 4, 24, 0, {coinRerollCount: 0})]});
    h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}});
    await h.tick();
    assert.deepEqual(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData, {
        characterQuestId: 1, useMooPass: false, useCowbells: false, currentRerollCount: 0,
    });
    h.receive({type: 'quests_updated', endCharacterQuests: [tokenQuest(1, HRID.produce, 4, 25, 0, {coinRerollCount: 1})]});
    await h.tick();
    assert.equal(h.c.state.pending?.kind, 'reroll', 'qualifying task data alone does not confirm the coin spend');
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.equal(h.c.state.pending, null);
    assert.equal(h.c.state.job, null);
    assert.equal(h.c.batchStatus().eligibleCount, 1);
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    assert.equal(sentOf(h, 'buy_from_shop').length, 0);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
});

test('unknown rewards and low-token life tasks already started or covered are never rerolled', async () => {
    const scenarios = [
        {tasks: [{...quest(1, HRID.gather, 4), itemRewardsJSON: '{broken'}]},
        {tasks: [tokenQuest(1, HRID.gather, 4, 10, 1)]},
        {tasks: [tokenQuest(1, HRID.gather, 4, 10)], actions: [action(42, HRID.gather, 1)]},
    ];
    for (const scenario of scenarios) {
        const h = harness({automation: true, taskPolicy: null, ...scenario});
        await h.resume();
        await h.tick();
        assert.equal(sentOf(h, 'reroll_random_task').length, 0);
        assert.equal(sentOf(h, 'new_character_action').length, 0);
        assert.equal(h.c.state.enabled, true);
    }
});

test('the effective batch target respects the server task-slot cap without changing the saved target', async () => {
    const h = harness({automation: true, taskPolicy: null, taskSlotCap: 3,
        tasks: [quest(1, HRID.gather, 4), quest(2, HRID.gather, 4), quest(3, HRID.gather, 4)]});
    assert.equal(h.c.batchStatus().configuredTarget, 48);
    assert.equal(h.c.batchStatus().target, 3);
    await h.resume();
    assert.equal(h.c.state.job.fixedBatch, true);
    assert.deepEqual(h.c.state.job.taskIds, ['1', '2', '3']);
    assert.equal(enqueue(h)?.maxCount, 6);
    assert.equal(h.c.state.batchTarget, 48);
});

test('starting early uses only currently qualifying life tasks and freezes them while later tasks wait', async () => {
    const h = harness({automation: true, taskPolicy: null,
        tasks: [quest(1, HRID.gather, 4), quest(2, HRID.produce, 2),
            tokenQuest(3, HRID.second, 4, 24), combatQuest(4)]});
    h.c.startEarly();
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.job.fixedBatch, true);
    assert.deepEqual(h.c.state.job.taskIds, ['1', '2']);
    assert.equal(enqueue(h)?.maxCount, 6);
    h.receive({type: 'quests_updated', endCharacterQuests: [quest(5, HRID.second, 4)]});
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 6)]});
    await h.tick();
    assert.deepEqual(h.c.state.job.taskIds, ['1', '2']);
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 9);
});

test('rounding applies after existing coverage and shares planned excess across same-action tasks', () => {
    const single = harness({tasks: [quest(1, HRID.produce, 4)], actions: [action(42, HRID.produce, 2)],
        items: [item(HRID.coin, 100000), item(HRID.apple, 2)]});
    const p = buildPlan(single.c.state, [1], {quantityMultiple: 3});
    assert.equal(p.entries[0].covered, 2);
    assert.equal(p.entries[0].count, 3);
    assert.equal(p.entries[0].inputs[`${HRID.apple}::0`], 9);
    assert.equal(p.purchases[0]?.count, 13, 'six old reserved apples plus nine new apples less two in stock');
    const shared = harness({tasks: [quest(1, HRID.produce, 4), quest(2, HRID.produce, 5)]});
    const together = buildPlan(shared.c.state, [1, 2], {quantityMultiple: 3});
    assert.deepEqual(together.entries.map(e => e.count), [6, 3]);
    assert.equal(together.purchases[0]?.count, 27, 'two excess actions for the first task cover the second task');
});

test('a rounded production queue buys its complete material quantity once and waits for the exact inventory acknowledgement', async () => {
    const h = harness({automation: true, taskPolicy: null, tasks: [quest(1, HRID.produce, 4)]});
    h.c.startEarly();
    await h.tick();
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 18);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 12)]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 18)]});
    await h.tick();
    assert.equal(enqueue(h)?.maxCount, 6);
    assert.equal(sentOf(h, 'buy_from_shop').length, 1);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.produce, 6)]});
    await h.tick();
    assert.equal(sentOf(h, 'new_character_action').length, 1);
});

test('claimed tasks retain ownership of rounded finite queue tails, including after a refresh', async () => {
    const h = harness({automation: true, taskPolicy: null, tasks: [quest(1, HRID.gather, 2)]});
    h.c.startEarly();
    await h.tick();
    assert.equal(enqueue(h)?.maxCount, 3);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 3)]});
    h.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 3, 2),
        endCharacterItems: [item(HRID.apple, 2)], endCharacterQuests: [completedQuest(1, {goalCount: 2, currentCount: 2})]});
    await h.tick();
    assert.equal(sentOf(h, 'claim_character_quest')[0]?.claimCharacterQuestData.characterQuestId, 1);
    h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1, {goalCount: 2, currentCount: 2})]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 2);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 0)]});
    await h.tick();
    const fresh = harness({storage: h.storage, automation: true, taskPolicy: null,
        tasks: [claimedQuest(1, {goalCount: 2, currentCount: 2})],
        actions: [action(42, HRID.gather, 3, 2)], items: [item(HRID.coin, 100000), item(HRID.apple, 0)]});
    await fresh.tick();
    assert.equal(sentOf(fresh, 'new_character_action').length, 0);
    fresh.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 3, 3),
        endCharacterItems: [item(HRID.apple, 1)], endCharacterQuests: [claimedQuest(1, {goalCount: 2, currentCount: 2})]});
    assert.equal(fresh.c.state.credits[`${HRID.apple}::0`], 1);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop')[0]?.sellToShopData.count, 1);
});

test('refresh keeps fixed batch IDs and its rounding snapshot despite newer global settings and tasks', async () => {
    const h = harness({automation: true, taskPolicy: null, tasks: [quest(1, HRID.gather, 4)]});
    h.c.startEarly();
    await h.tick();
    assert.equal(enqueue(h)?.maxCount, 6);
    h.c.configureTasks({minTokens: 30, batchTarget: 12, quantityMultiple: 9});
    const fresh = harness({storage: h.storage, automation: true, taskPolicy: null,
        tasks: [quest(1, HRID.gather, 4), tokenQuest(2, HRID.produce, 4, 30)],
        actions: [action(42, HRID.gather, 6)]});
    await fresh.tick();
    assert.deepEqual(fresh.c.state.job.taskIds, ['1']);
    assert.equal(fresh.c.state.job.fixedBatch, true);
    assert.equal(fresh.c.state.job.quantityMultiple, 3);
    assert.equal(fresh.c.state.quantityMultiple, 9);
    assert.equal(fresh.c.state.pending, null);
    assert.equal(sentOf(fresh, 'new_character_action').length, 0);
    assert.equal(sentOf(fresh, 'buy_from_shop').length, 0);
});

test('an older in-progress job migrates to a fixed batch without waiting for 48 or adding newly read tasks', async () => {
    const storage = memoryStorage();
    storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify({
        schema: 1, job: {taskIds: ['1']}, owned: {'42': HRID.gather}, credits: {}, saleCredits: {},
        saleCheckpoints: {}, floors: {[`${HRID.coin}::0`]: 100000}, progress: {'42': 0},
        watched: {[HRID.gather]: ['1']}, pending: null, enabled: true, sellOutputs: true,
        autoClaim: true, autoRead: true, autoQueue: true, rerollCombat: true, autoSessionInitialized: true,
    }));
    const h = harness({storage, automation: true, taskPolicy: null,
        tasks: [quest(1, HRID.gather, 4), quest(2, HRID.produce, 4)], actions: [action(42, HRID.gather, 4)]});
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.job.fixedBatch, true);
    assert.deepEqual(h.c.state.job.taskIds, ['1']);
    assert.deepEqual(h.sent, []);
});

test('a full task slot cap skips Read and keeps rerolling low rewards before starting the qualified batch', async () => {
    const h = harness({automation: true, taskPolicy: null, taskSlotCap: 2, unreadTaskCount: 3,
        tasks: [quest(1, HRID.gather, 4), tokenQuest(2, HRID.produce, 4, 24, 0, {coinRerollCount: 0})]});
    await h.resume();
    assert.equal(sentOf(h, 'read_random_tasks').length, 0);
    assert.equal(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData.characterQuestId, 2);
    h.receive({type: 'quests_updated', endCharacterQuests: [tokenQuest(2, HRID.produce, 4, 25, 0, {coinRerollCount: 1})]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.equal(sentOf(h, 'read_random_tasks').length, 0);
    assert.equal(h.c.state.unreadTaskCount, 3);
    assert.deepEqual(h.c.state.job.taskIds, ['1', '2']);
    assert.equal(enqueue(h)?.maxCount, 6);
});

test('empty or boolean reward counts stay unknown and never authorize spending coins on a reroll', async () => {
    for (const count of ['', false, true]) {
        const q = tokenQuest(1, HRID.gather, 4, count);
        assert.equal(taskTokens(q), null);
        const h = harness({automation: true, taskPolicy: null, tasks: [q]});
        await h.resume();
        await h.tick();
        assert.equal(h.c.state.enabled, true);
        assert.equal(h.c.state.job, null);
        assert.deepEqual(h.sent, []);
    }
});

test('sale reservations keep the fixed active batch and exclude future batches regardless of tester availability', async () => {
    for (const tester of [true, false]) {
        const h = await settledSurplusHarness({recoverSurplus: false, client: tester ? clientData() : nonTesterClientData(),
            taskPolicy: {minTokens: 25, batchTarget: 48, quantityMultiple: 3}});
        await h.tick();
        assert.equal(h.c.state.job, null);
        h.receive({type: 'quests_updated', endCharacterQuests: [quest(2, HRID.produce, 4)]});
        h.c.startEarly();
        assert.equal(h.c.state.job.quantityMultiple, 3);
        h.c.configureTasks({autoQueue: true, quantityMultiple: 9});
        h.receive({type: 'quests_updated', endCharacterQuests: [quest(3, HRID.second, 4)]});
        h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 200)]});
        assert.deepEqual(h.c.state.job.taskIds, ['2']);
        assert.equal(h.c.state.job.quantityMultiple, 3);
        const apple = h.c.previewSurplus().rows.find(r => r.itemHrid === HRID.apple);
        assert.equal(apple?.reserved, 18, 'only the active batch needs 6 × 3 material units');
        assert.equal(apple?.count, 182);
        assert.equal(h.c.recoverSurplus()[0]?.count, 182);
        assert.equal(h.c.nextSale()?.count, 182);
    }
});

test('an earlier low-token outside task is rerolled before its action can be queued for the fixed batch', async () => {
    const h = harness({automation: true, taskPolicy: null,
        tasks: [combatQuest(10), tokenQuest(11, HRID.produce, 4, 24, 0, {coinRerollCount: 0}),
            quest(12, HRID.produce, 4)]});
    h.c.startEarly();
    await h.tick();
    assert.deepEqual(h.c.state.job.taskIds, ['12']);
    assert.equal(sentOf(h, 'buy_from_shop').length, 0);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    assert.equal(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData.characterQuestId, 11,
        'the actual same-action blocker takes priority over unrelated combat tasks');
    h.receive({type: 'quests_updated', endCharacterQuests: [tokenQuest(11, HRID.gather, 4, 25, 0, {coinRerollCount: 1})]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 18);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 18)]});
    await h.tick();
    assert.equal(enqueue(h)?.actionHrid, HRID.produce);
    assert.equal(enqueue(h)?.maxCount, 6);
    assert.deepEqual(h.c.state.job.taskIds, ['12']);
});

test('started or unknown-reward predecessors preserve their action while another batch action can proceed', async () => {
    const blockers = [tokenQuest(1, HRID.produce, 4, 24, 1),
        {...quest(1, HRID.produce, 4), itemRewardsJSON: '{broken'}];
    for (const blocker of blockers) {
        const h = harness({automation: true, taskPolicy: null,
            tasks: [blocker, quest(2, HRID.produce, 4), quest(3, HRID.gather, 4)]});
        h.c.startEarly();
        await h.tick();
        assert.deepEqual(h.c.state.job.taskIds, ['2', '3']);
        assert.equal(enqueue(h)?.actionHrid, HRID.gather);
        assert.equal(enqueue(h)?.maxCount, 6);
        h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 6)]});
        for (let i = 0; i < 3; i += 1) await h.tick();
        assert.equal(h.c.state.enabled, true);
        assert.equal(sentOf(h, 'buy_from_shop').length, 0);
        assert.equal(sentOf(h, 'reroll_random_task').length, 0);
        assert.equal(sentOf(h, 'new_character_action').length, 1);
        assert.deepEqual(h.c.state.quests['1'], blocker);
    }
});

async function tickAfter(h, milliseconds) {
    await h.advance(milliseconds);
    await h.c.tick();
    await flush();
}

const spamOperations = [
    {
        name: 'open_bag', type: 'open_loot',
        async begin() {
            const h = harness({automation: true, tasks: [combatQuest(1, 21, {cowbellRerollCount: 0})],
                items: [item(HRID.coin, 1000000), item(COWBELL, 0), item(COWBELL_BAG, 2)]});
            await h.resume();
            return h;
        },
        ack(h) { h.receive({type: 'items_updated', endCharacterItems: [item(COWBELL_BAG, 1), item(COWBELL, 10)]}); },
        partial(h) { h.receive({type: 'items_updated', endCharacterItems: [item(COWBELL_BAG, 1)]}); },
    },
    {
        name: 'buy', type: 'buy_from_shop',
        async begin() {
            const h = harness({tasks: [quest(1, HRID.produce, 2)]});
            await h.start();
            return h;
        },
        ack(h) { h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 6)]}); },
        partial(h) { h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 1)]}); },
    },
    {
        name: 'queue', type: 'new_character_action',
        async begin() {
            const h = harness({tasks: [quest(1, HRID.gather, 3)]});
            await h.start();
            return h;
        },
        ack(h) { h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 3)]}); },
        partial(h) { h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.gather, 4)]}); },
    },
    {
        name: 'claim', type: 'claim_character_quest',
        async begin() {
            const h = harness({maintenance: true, tasks: [completedQuest(1)]});
            await h.resume();
            return h;
        },
        ack(h) { h.receive({type: 'quests_updated', endCharacterQuests: [claimedQuest(1)]}); },
    },
    {
        name: 'read', type: 'read_random_tasks',
        async begin() {
            const h = harness({maintenance: true, tasks: [], unreadTaskCount: 1});
            await h.resume();
            return h;
        },
        ack(h) { h.receive({type: 'character_info_updated', characterInfo: {unreadTaskCount: 0}}); },
        partial(h) { h.receive({type: 'quests_updated', endCharacterQuests: [quest(1, HRID.gather, 3)]}); },
    },
    {
        name: 'sell', type: 'sell_to_shop',
        async begin() {
            const h = harness({tasks: [quest(1, HRID.gather, 1)], actions: [action(42, HRID.gather, 1)],
                items: [item(HRID.coin, 100000), item(HRID.apple, 100)]});
            await h.start();
            h.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 1, 1),
                endCharacterItems: [item(HRID.apple, 110)], endCharacterQuests: [quest(1, HRID.gather, 1, 1)]});
            await h.tick();
            return h;
        },
        ack(h) { h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 100)]}); },
        partial(h) { h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 109)]}); },
    },
    {
        name: 'reroll', type: 'reroll_random_task',
        async begin() {
            const h = harness({automation: true, tasks: [combatQuest(1)]});
            await h.resume();
            return h;
        },
        ack(h) {
            h.receive({type: 'quests_updated', endCharacterQuests: [{...quest(1, HRID.gather, 3), coinRerollCount: 1}]});
            h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
        },
    },
];

for (const operation of spamOperations) {
    test(`spam-rejected ${operation.name} waits at least five seconds and a late exact acknowledgement prevents a duplicate`, async () => {
        for (const lateAck of [false, true]) {
            const h = await operation.begin();
            assert.equal(sentOf(h, operation.type).length, 1);
            assert.equal(h.c.state.pending?.kind, operation.name);
            const rejectedAt = h.now;
            h.receive({type: 'error', message: 'requestSpamProtection'});
            assert.equal(h.c.state.enabled, true);
            assert.equal(h.c.state.ready, true);
            assert.equal(h.c.state.pending?.kind, operation.name, 'keep the request available for a delayed exact acknowledgement');
            assert.equal(h.c.state.pending?.spamRejectedAt, rejectedAt);
            assert.ok(h.c.state.cooldownUntil >= rejectedAt + 5000);
            await tickAfter(h, 4000);
            if (lateAck) {
                operation.ack(h);
                assert.equal(h.c.state.pending, null);
            }
            await tickAfter(h, 999);
            assert.equal(sentOf(h, operation.type).length, 1);
            assert.equal(h.held, 1, 'hold the shared write lane throughout the cooldown, including after a late ACK');
            const beforeExpiryWrites = h.sent.length;
            await tickAfter(h, 101);
            assert.equal(sentOf(h, operation.type).length, lateAck ? 1 : 2);
            if (!lateAck) assert.equal(h.sent.length, beforeExpiryWrites + 1, 'only one freshly planned retry may be sent');
            await tickAfter(h, 1100);
            assert.equal(sentOf(h, operation.type).length, lateAck ? 1 : 2);
        }
    });
}

test('each repeated spam rejection extends the cooldown from its own arrival without disabling automation', async () => {
    const h = await spamOperations.find(o => o.name === 'claim').begin();
    h.receive({type: 'error', errorCode: 'errorNotification.requestSpamProtection'});
    const firstDeadline = h.c.state.cooldownUntil;
    await tickAfter(h, 3000);
    h.receive({type: 'error', error: 'requestSpamProtection'});
    assert.ok(h.c.state.cooldownUntil >= firstDeadline + 3000);
    await tickAfter(h, 2100);
    assert.equal(sentOf(h, 'claim_character_quest').length, 1);
    assert.equal(h.c.state.enabled, true);
    await tickAfter(h, 3000);
    assert.equal(sentOf(h, 'claim_character_quest').length, 2);
});

test('manually pausing during spam cooldown cannot be undone by expiry, repeated errors or a late acknowledgement', async () => {
    const operation = spamOperations.find(o => o.name === 'claim');
    const h = await operation.begin();
    h.receive({type: 'error', message: 'requestSpamProtection'});
    h.c.stop();
    await tickAfter(h, 1000);
    h.receive({type: 'error', message: 'requestSpamProtection'});
    operation.ack(h);
    await tickAfter(h, 6000);
    assert.equal(h.c.state.enabled, false);
    assert.equal(sentOf(h, operation.type).length, 1);
    assert.equal(h.held, 0);
});

test('a saved spam cooldown survives disconnect and a full reload before retrying from fresh task state', async () => {
    const h = await spamOperations.find(o => o.name === 'claim').begin();
    h.receive({type: 'error', message: 'requestSpamProtection'});
    const deadline = h.c.state.cooldownUntil;
    await h.advance(1500);
    h.receive({type: 'socket_closed'});
    const fresh = harness({storage: h.storage, initialTime: h.now, maintenance: true, tasks: [completedQuest(1)]});
    assert.equal(fresh.c.state.enabled, true);
    assert.ok(fresh.c.state.cooldownUntil >= deadline);
    await tickAfter(fresh, 3499);
    assert.equal(fresh.sent.length, 0);
    await tickAfter(fresh, 101);
    assert.equal(sentOf(fresh, 'claim_character_quest').length, 1);
    await tickAfter(fresh, 1100);
    assert.equal(sentOf(fresh, 'claim_character_quest').length, 1);
});

test('non-spam errors and text merely containing the spam code still halt rather than retrying', async () => {
    for (const message of ['task request rejected', 'requestSpamProtection: unrelated failure']) {
        const h = await spamOperations.find(o => o.name === 'claim').begin();
        h.receive({type: 'error', message});
        await tickAfter(h, 6000);
        assert.equal(h.c.state.enabled, false);
        assert.equal(sentOf(h, 'claim_character_quest').length, 1);
        assert.notEqual(h.c.state.pending, null);
    }
});

test('spam cooldown cannot retry a reroll after only one side of its transaction was acknowledged', async () => {
    for (const coinsFirst of [false, true]) {
        const h = await spamOperations.find(o => o.name === 'reroll').begin();
        h.receive({type: 'error', message: 'requestSpamProtection'});
        const coins = {type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]};
        const task = {type: 'quests_updated', endCharacterQuests: [combatQuest(1, 1)]};
        h.receive(coinsFirst ? coins : task);
        await tickAfter(h, 5100);
        assert.equal(h.c.state.enabled, true);
        assert.equal(h.c.state.pending?.kind, 'reroll');
        assert.equal(sentOf(h, 'reroll_random_task').length, 1);
        h.receive(coinsFirst ? task : coins);
        await tickAfter(h, 1100);
        assert.deepEqual(sentOf(h, 'reroll_random_task').map(m => m.rerollRandomTaskData.currentRerollCount), [0, 1]);
    }
});

test('incomplete buy, sale, read or mismatched queue evidence keeps a spam-rejected request pending', async () => {
    for (const operation of spamOperations.filter(o => o.partial)) {
        const h = await operation.begin();
        h.receive({type: 'error', message: 'requestSpamProtection'});
        operation.partial(h);
        await tickAfter(h, 5100);
        assert.equal(h.c.state.enabled, true);
        assert.equal(h.c.state.pending?.kind, operation.name);
        assert.equal(sentOf(h, operation.type).length, 1);
    }
});

test('overlapping external requests prevent attributing a spam error to the pending transaction for retry', async () => {
    const operation = spamOperations.find(o => o.name === 'claim');
    const h = await operation.begin();
    h.c.observeExternalRequest();
    h.receive({type: 'error', message: 'requestSpamProtection'});
    await tickAfter(h, 5100);
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.pending?.kind, 'claim');
    assert.equal(h.c.state.pending?.externalOverlap, true);
    assert.equal(sentOf(h, operation.type).length, 1);
    operation.ack(h);
    await tickAfter(h, 1100);
    assert.equal(h.c.state.pending, null);
    assert.equal(sentOf(h, operation.type).length, 1);
    assert.equal(h.held, 0);
});

test('cowbell fallback is enabled by default, configurable and persistent across reload', () => {
    const h = harness();
    assert.equal(h.c.state.cowbellFallback, true);
    h.c.configureTasks({cowbellFallback: false});
    const fresh = harness({storage: h.storage});
    assert.equal(fresh.c.state.cowbellFallback, false);
    const saved = JSON.parse(h.storage.getItem('MWI_TASK_QUEUE_V1:123'));
    delete saved.cowbellFallback;
    h.storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
    assert.equal(harness({storage: h.storage}).c.state.cowbellFallback, true);
});

test('only coin reroll counts strictly above 20 switch to the cowbell counter and capped cowbell price', async () => {
    for (const coinCount of [20, 21]) {
        const h = harness({automation: true, tasks: [combatQuest(1, coinCount, {cowbellRerollCount: 2})],
            items: [item(HRID.coin, 1000000), item(COWBELL, 64), item(COWBELL_BAG, 5)]});
        await h.resume();
        assert.deepEqual(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData, {
            characterQuestId: 1, useMooPass: false, useCowbells: coinCount > 20,
            currentRerollCount: coinCount > 20 ? 2 : 20,
        });
        assert.equal(h.c.state.pending?.count, coinCount > 20 ? 4 : 320000);
        assert.equal(h.c.state.pending?.itemKey, `${coinCount > 20 ? COWBELL : HRID.coin}::0`);
        assert.equal(sentOf(h, 'open_loot').length, 0);
    }
    for (const cowbellCount of [5, 6]) {
        const h = harness({automation: true, tasks: [combatQuest(1, 21, {cowbellRerollCount: cowbellCount})],
            items: [item(HRID.coin, 1000000), item(COWBELL, 32)]});
        await h.resume();
        assert.equal(h.c.state.pending?.count, 32);
        assert.equal(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData.currentRerollCount, cowbellCount);
    }
    const short = harness({automation: true, tasks: [combatQuest(1, 20, {cowbellRerollCount: 0})],
        items: [item(HRID.coin, 319999), item(COWBELL, 64), item(COWBELL_BAG, 5)]});
    await short.resume();
    assert.deepEqual(short.sent, [], 'having bells does not bypass the strict >20 threshold');
    const disabled = harness({automation: true, tasks: [combatQuest(1, 21, {cowbellRerollCount: 2})],
        items: [item(HRID.coin, 320000), item(COWBELL, 64)]});
    disabled.c.configureTasks({cowbellFallback: false});
    await disabled.resume();
    assert.equal(sentOf(disabled, 'reroll_random_task')[0]?.rerollRandomTaskData.useCowbells, false);
    assert.equal(sentOf(disabled, 'reroll_random_task')[0]?.rerollRandomTaskData.currentRerollCount, 21);
});

test('opening one cowbell bag waits for the exact bag decrement and ten-bell increment in either order', async () => {
    for (const bellsFirst of [false, true]) {
        const h = await spamOperations.find(o => o.name === 'open_bag').begin();
        assert.deepEqual(sentOf(h, 'open_loot')[0]?.openLootData, {itemHash: item(COWBELL_BAG, 0).hash, count: 1});
        h.receive({type: 'loot_opened'});
        await h.tick();
        assert.equal(h.c.state.pending?.kind, 'open_bag');
        assert.equal(sentOf(h, 'reroll_random_task').length, 0);
        const bagAck = {type: 'items_updated', endCharacterItems: [item(COWBELL_BAG, 1)]};
        const bellsAck = {type: 'items_updated', endCharacterItems: [item(COWBELL, 10)]};
        h.receive(bellsFirst ? bellsAck : bagAck);
        await h.tick();
        assert.equal(h.c.state.pending?.kind, 'open_bag');
        assert.equal(sentOf(h, 'open_loot').length, 1);
        assert.equal(sentOf(h, 'reroll_random_task').length, 0);
        if (!bellsFirst) {
            h.receive({type: 'items_updated', endCharacterItems: [item(COWBELL, 9)]});
            await h.tick();
            assert.equal(h.c.state.pending?.kind, 'open_bag', 'nine bells do not confirm a bag of ten');
        }
        h.receive(bellsFirst ? bagAck : bellsAck);
        await h.tick();
        assert.equal(sentOf(h, 'open_loot').length, 1);
        assert.deepEqual(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData, {
            characterQuestId: 1, useMooPass: false, useCowbells: true, currentRerollCount: 0,
        });
    }
});

test('a 32-bell reroll opens four bags sequentially and never opens more than the current shortage needs', async () => {
    const h = harness({automation: true, tasks: [combatQuest(1, 21, {cowbellRerollCount: 5})],
        items: [item(HRID.coin, 1000000), item(COWBELL, 0), item(COWBELL_BAG, 8)]});
    await h.resume();
    for (let i = 1; i <= 4; i += 1) {
        assert.equal(sentOf(h, 'open_loot').length, i);
        assert.equal(sentOf(h, 'reroll_random_task').length, 0);
        assert.equal(sentOf(h, 'open_loot').at(-1)?.openLootData.count, 1);
        h.receive({type: 'items_updated', endCharacterItems: [item(COWBELL_BAG, 8 - i), item(COWBELL, i * 10)]});
        await h.tick();
    }
    assert.equal(sentOf(h, 'open_loot').length, 4);
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    assert.equal(h.c.state.pending?.count, 32);
    assert.equal(sentOf(h, 'buy_from_shop').length, 0);
});

test('insufficient bells with no unlocked unenhanced bag wait without spending coins or buying bags', async () => {
    for (const bags of [[], [{...item(COWBELL_BAG, 5), isLocked: true}], [item(COWBELL_BAG, 5, 1)]]) {
        const h = harness({automation: true, tasks: [combatQuest(1, 21, {cowbellRerollCount: 2})],
            items: [item(HRID.coin, 1000000), item(COWBELL, 3), ...bags]});
        await h.resume();
        for (let i = 0; i < 3; i += 1) await h.tick();
        assert.equal(h.c.state.enabled, true);
        assert.equal(h.c.state.pending, null);
        assert.deepEqual(h.sent, []);
        h.receive({type: 'items_updated', endCharacterItems: [item(COWBELL, 4)]});
        await h.tick();
        assert.equal(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData.useCowbells, true);
        assert.equal(sentOf(h, 'open_loot').length, 0);
    }
});

test('cowbell rerolls need both deduction and the correct counter and retain cowbell mode when coin counts reset', async () => {
    for (const newId of [1, 2]) for (const bellsFirst of [false, true]) {
        const h = harness({automation: true, tasks: [combatQuest(1, 21, {cowbellRerollCount: 0})],
            items: [item(HRID.coin, 1000000), item(COWBELL, 10)]});
        await h.resume();
        const replacement = combatQuest(newId, 0, {cowbellRerollCount: 1});
        const taskAck = {type: 'quests_updated', endCharacterQuests: newId === 1 ? [replacement]
            : [combatQuest(1, 21, {cowbellRerollCount: 0, status: '/quest_status/discarded'}), replacement]};
        const bellsAck = {type: 'items_updated', endCharacterItems: [item(COWBELL, 9)]};
        h.receive(bellsFirst ? bellsAck : taskAck);
        await h.tick();
        assert.equal(h.c.state.pending?.kind, 'reroll');
        assert.equal(sentOf(h, 'reroll_random_task').length, 1);
        h.receive(bellsFirst ? taskAck : bellsAck);
        await h.tick();
        assert.deepEqual(sentOf(h, 'reroll_random_task')[1]?.rerollRandomTaskData, {
            characterQuestId: newId, useMooPass: false, useCowbells: true, currentRerollCount: 1,
        });
        assert.equal(h.c.state.pending?.count, 2);
        assert.equal(h.c.state.cowbellTaskIds[String(newId)], true);
        assert.equal(h.c.state.items[item(HRID.coin, 0).hash].count, 1000000);
    }
});

test('refresh after an accepted bag open uses the new bell balance without opening the same bag again', async () => {
    const first = await spamOperations.find(o => o.name === 'open_bag').begin();
    first.receive({type: 'socket_closed'});
    const fresh = harness({storage: first.storage, automation: true,
        tasks: [combatQuest(1, 21, {cowbellRerollCount: 0})],
        items: [item(HRID.coin, 1000000), item(COWBELL, 10), item(COWBELL_BAG, 1)]});
    await fresh.tick();
    assert.equal(sentOf(fresh, 'open_loot').length, 0);
    assert.equal(sentOf(fresh, 'reroll_random_task').length, 1);
    assert.equal(sentOf(fresh, 'reroll_random_task')[0]?.rerollRandomTaskData.useCowbells, true);
});

test('a full reconnect after an accepted cowbell reroll retains the replacement task currency and advances its counter once', async () => {
    for (const newId of [1, 2]) {
        const first = harness({automation: true, tasks: [combatQuest(1, 21, {cowbellRerollCount: 0})],
            items: [item(HRID.coin, 1000000), item(COWBELL, 10)]});
        await first.resume();
        first.receive({type: 'socket_closed'});
        const replacement = combatQuest(newId, 0, {cowbellRerollCount: 1});
        const fresh = harness({storage: first.storage, automation: true,
            tasks: newId === 1 ? [replacement]
                : [combatQuest(1, 21, {cowbellRerollCount: 0, status: '/quest_status/discarded'}), replacement],
            items: [item(HRID.coin, 1000000), item(COWBELL, 9)]});
        await fresh.tick();
        assert.deepEqual(sentOf(fresh, 'reroll_random_task')[0]?.rerollRandomTaskData, {
            characterQuestId: newId, useMooPass: false, useCowbells: true, currentRerollCount: 1,
        });
        assert.equal(sentOf(fresh, 'reroll_random_task').length, 1);
        assert.equal(sentOf(fresh, 'open_loot').length, 0);
    }
});

test('currencies and cowbell bags are never sold even when metadata labels them as resources and old credits survive', async () => {
    const client = clientData();
    const protectedItems = [[HRID.coin, 100000], [COWBELL, 5], [COWBELL_BAG, 2], ['/items/task_token', 7]];
    for (const [hrid] of protectedItems) {
        client.itemDetailMap[hrid] = {sellPrice: 1, categoryHrid: CATEGORY.resource};
        addTesterItem(client, hrid);
    }
    client.actionDetailMap[HRID.gather].dropTable = protectedItems.map(([itemHrid]) => ({itemHrid}));
    client.actionDetailMap[HRID.gather].outputItems = [];
    const first = await settledSurplusHarness({client, items: [item(HRID.coin, 100000)]});
    first.receive({type: 'items_updated', endCharacterItems: protectedItems.map(([hrid, count]) => item(hrid, count))});
    assert.deepEqual(first.c.previewSurplus().rows, []);
    const saved = JSON.parse(first.storage.getItem('MWI_TASK_QUEUE_V1:123'));
    saved.credits = Object.fromEntries(protectedItems.map(([hrid, count]) => [`${hrid}::0`, count]));
    saved.saleCredits = {...saved.credits};
    first.storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
    const fresh = harness({storage: first.storage, client, recoverSurplus: true,
        tasks: [completedQuest(1)], actions: [],
        items: protectedItems.map(([hrid, count]) => item(hrid, count))});
    assert.equal(fresh.c.state.credits[`${COWBELL}::0`], 5);
    assert.equal(fresh.c.state.saleCredits[`${COWBELL_BAG}::0`], 2);
    assert.deepEqual(fresh.c.previewSurplus().rows, []);
    assert.equal(fresh.c.nextSale(), null);
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 0);
});

function protectedTeaFixture() {
    const protectedHrids = [
        ...['alchemy', 'brewing', 'cheesesmithing', 'cooking', 'crafting', 'enhancing',
            'foraging', 'milking', 'tailoring', 'woodcutting'].map(skill => `/items/ultra_${skill}_tea`),
        '/items/ultra_tea', '/items/philosophers_mirror',
    ];
    const ordinaryTea = '/items/production_tea';
    const client = clientData();
    const products = [...protectedHrids, ordinaryTea, HRID.apple];
    client.actionDetailMap[HRID.gather].outputItems = products.map(itemHrid => ({itemHrid, count: 1}));
    for (const hrid of products) {
        client.itemDetailMap[hrid] = {sellPrice: 1,
            categoryHrid: hrid.includes('tea') ? CATEGORY.drink : CATEGORY.resource};
        addTesterItem(client, hrid);
    }
    return {client, protectedHrids, ordinaryTea};
}

test('Ultra and ordinary teas and Philosopher mirror never gain online sale credits while allowed resource output still sells at settlement', async () => {
    const {client, protectedHrids, ordinaryTea} = protectedTeaFixture();
    const h = harness({client, recoverSurplus: true,
        tasks: [quest(1, HRID.gather, 2)], actions: [action(42, HRID.gather, 2)],
        items: [item(HRID.coin, 100000)]});
    await h.start();
    for (const current of [1, 2]) {
        h.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 2, current),
            endCharacterItems: [...protectedHrids.map(hrid => item(hrid, current + 1)),
                item(ordinaryTea, current + 1), item(HRID.apple, current * 2)],
            endCharacterQuests: [quest(1, HRID.gather, 2, current)]});
        for (const hrid of [...protectedHrids, ordinaryTea]) {
            assert.equal(h.c.state.credits[`${hrid}::0`] || 0, 0, hrid);
            assert.notEqual(h.c.state.observedOutputs[HRID.gather]?.[`${hrid}::0`], true, hrid);
        }
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop').length, current === 1 ? 0 : 1);
    }
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.apple, 0).hash, count: 4});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 0)]});
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
    assert.deepEqual(h.c.previewSurplus().rows, []);
    for (const hrid of [...protectedHrids, ordinaryTea]) assert.equal(h.c.state.items[item(hrid, 0).hash].count, 3, hrid);
});

test('Ultra and ordinary teas and Philosopher mirror remain unsellable after reconnect with old credits and tester recovery metadata', async () => {
    const {client, protectedHrids, ordinaryTea} = protectedTeaFixture();
    const first = await settledSurplusHarness({client, items: [item(HRID.coin, 100000)]});
    const saved = JSON.parse(first.storage.getItem('MWI_TASK_QUEUE_V1:123'));
    saved.credits = Object.fromEntries([...protectedHrids, ordinaryTea].map(hrid => [`${hrid}::0`, 3]));
    saved.saleCredits = {...saved.credits};
    saved.observedOutputs = {[HRID.gather]: Object.fromEntries(protectedHrids.map(hrid => [`${hrid}::0`, true]))};
    first.storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
    const fresh = harness({storage: first.storage, client, recoverSurplus: true,
        tasks: [completedQuest(1)], actions: [],
        items: [item(HRID.coin, 100000), ...protectedHrids.map(hrid => item(hrid, 5)),
            item(ordinaryTea, 3), item(HRID.apple, 4)]});
    assert.deepEqual(fresh.c.previewSurplus().rows.map(row => [row.itemHrid, row.count]),
        [[HRID.apple, 4]]);
    assert.equal(fresh.c.nextSale(), null, 'persisted protected credits cannot authorize a sale');
    for (const [index, [hrid, count]] of [[HRID.apple, 4]].entries()) {
        await fresh.tick();
        assert.deepEqual(sentOf(fresh, 'sell_to_shop')[index]?.sellToShopData,
            {itemHash: item(hrid, 0).hash, count});
        fresh.receive({type: 'items_updated', endCharacterItems: [item(hrid, 0)]});
    }
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, 1);
    assert.equal(fresh.c.nextSale(), null);
    assert.deepEqual(fresh.c.previewSurplus().rows, []);
    for (const hrid of protectedHrids) assert.equal(fresh.c.state.items[item(hrid, 0).hash].count, 5, hrid);
    assert.equal(fresh.c.state.items[item(ordinaryTea, 0).hash].count, 3);
});

function superDrinkFixture() {
    const client = nonTesterClientData();
    const allowed = ['/items/super_tea', '/items/super_coffee', '/items/super_foraging_tea',
        '/items/super_enhancing_tea', '/items/super_dark_roast_coffee'];
    const protectedItems = [
        ['/items/ultra_foraging_tea', CATEGORY.drink], ['/items/ultra_tea', CATEGORY.drink],
        ['/items/ultra_coffee', CATEGORY.drink], ['/items/tea', CATEGORY.drink],
        ['/items/coffee', CATEGORY.drink], ['/items/production_tea', CATEGORY.drink],
        ['/items/espresso_coffee', CATEGORY.drink], ['/items/superior_tea', CATEGORY.drink],
        ['/items/superior_coffee', CATEGORY.drink], ['/items/super_fruit_drink', CATEGORY.drink],
        ['/items/super_tea_leaf', CATEGORY.drink], ['/items/super_apple_pie', CATEGORY.food],
        ['/items/super_food_tea', CATEGORY.food], ['/items/super_unknown_tea', undefined],
        ['/items/super_loot_coffee', '/item_categories/loot'],
    ];
    for (const [hrid, categoryHrid] of [...allowed.map(hrid => [hrid, CATEGORY.drink]), ...protectedItems]) {
        client.itemDetailMap[hrid] = {sellPrice: 1, ...(categoryHrid ? {categoryHrid} : {})};
    }
    client.actionDetailMap[HRID.gather].outputItems = [...allowed, ...protectedItems.map(([hrid]) => hrid)]
        .map(itemHrid => ({itemHrid, count: 1}));
    return {client, allowed, protectedItems};
}

test('only Drink-category Super tea and coffee output earns sale credits and sells after completion', async () => {
    const {client, allowed, protectedItems} = superDrinkFixture();
    const products = [...allowed, ...protectedItems.map(([hrid]) => hrid)];
    const h = harness({client, tasks: [quest(1, HRID.gather, 2)], actions: [action(42, HRID.gather, 2)]});
    await h.start();
    for (const current of [1, 2]) {
        h.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 2, current),
            endCharacterItems: products.map(hrid => item(hrid, current + 1)),
            endCharacterQuests: [quest(1, HRID.gather, 2, current)]});
        for (const hrid of allowed) assert.equal(h.c.state.credits[`${hrid}::0`], current + 1, hrid);
        for (const [hrid] of protectedItems) assert.equal(h.c.state.credits[`${hrid}::0`] || 0, 0, hrid);
        if (current === 1) {
            await h.tick();
            assert.equal(sentOf(h, 'sell_to_shop').length, 0);
        }
    }
    for (const [index, hrid] of allowed.entries()) {
        await h.tick();
        assert.deepEqual(sentOf(h, 'sell_to_shop')[index]?.sellToShopData,
            {itemHash: item(hrid, 0).hash, count: 3});
        h.receive({type: 'items_updated', endCharacterItems: [item(hrid, 0)]});
    }
    await h.tick();
    assert.equal(sentOf(h, 'sell_to_shop').length, allowed.length);
    assert.deepEqual(h.c.previewSurplus().rows, []);
    for (const [hrid] of protectedItems) assert.equal(h.c.state.items[item(hrid, 0).hash].count, 3, hrid);
});

test('reconnect cleans untracked Super tea and coffee stock despite saved floors and leaves protected drink or food stock intact', async () => {
    const {client, allowed, protectedItems} = superDrinkFixture();
    const items = [item(HRID.coin, 100000), ...allowed.map(hrid => item(hrid, 7)),
        ...protectedItems.map(([hrid]) => item(hrid, 5))];
    const first = harness({client, tasks: [], actions: [], items, recoverSurplus: false});
    await first.resume();
    assert.deepEqual(first.sent, []);
    const fresh = harness({storage: first.storage, client, tasks: [], actions: [], items, recoverSurplus: true});
    assert.deepEqual(fresh.c.state.owned, {});
    assert.deepEqual(fresh.c.state.settledActionHrids, {});
    assert.deepEqual(fresh.c.state.observedOutputs, {});
    for (const hrid of allowed) assert.equal(fresh.c.state.floors[`${hrid}::0`], 7);
    assert.deepEqual(fresh.c.previewSurplus().rows.map(row => [row.itemHrid, row.count, row.floor]),
        allowed.map(hrid => [hrid, 7, 0]));
    for (const [index, hrid] of allowed.entries()) {
        await fresh.tick();
        assert.deepEqual(sentOf(fresh, 'sell_to_shop')[index]?.sellToShopData,
            {itemHash: item(hrid, 0).hash, count: 7});
        fresh.receive({type: 'items_updated', endCharacterItems: [item(hrid, 0)]});
    }
    await fresh.tick();
    assert.equal(sentOf(fresh, 'sell_to_shop').length, allowed.length);
    for (const [hrid] of protectedItems) assert.equal(fresh.c.state.items[item(hrid, 0).hash].count, 5, hrid);
});

test('Super drink cleanup preserves locked or enhanced stacks and all active batch and finite queue ingredients', async () => {
    const {client, allowed} = superDrinkFixture();
    const [tea, coffee, lockedTea] = allowed;
    client.actionDetailMap[HRID.produce].inputItems = [{itemHrid: tea, count: 3}];
    client.actionDetailMap[HRID.second].inputItems = [{itemHrid: tea, count: 2}, {itemHrid: coffee, count: 1}];
    const h = harness({client, recoverSurplus: true,
        tasks: [quest(1, HRID.produce, 2)], actions: [action(90, HRID.second, 2)],
        items: [item(HRID.coin, 100000), item(tea, 20), item(coffee, 7),
            {...item(lockedTea, 5), isLocked: true}, item(tea, 1, 9), item(coffee, 1, 10)]});
    await h.start();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(tea, 0).hash, count: 10}, 'six active batch inputs plus four finite queued inputs stay reserved');
    h.receive({type: 'items_updated', endCharacterItems: [item(tea, 10)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'sell_to_shop')[1]?.sellToShopData,
        {itemHash: item(coffee, 0).hash, count: 5});
    h.receive({type: 'items_updated', endCharacterItems: [item(coffee, 2)]});
    await h.tick();
    assert.equal(enqueue(h)?.maxCount, 2);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.produce, 2)]});
    await h.tick();
    assert.deepEqual(h.c.previewSurplus().rows, []);
    assert.equal(sentOf(h, 'sell_to_shop').length, 2);
    assert.equal(h.c.state.items[item(tea, 0).hash].count, 10);
    assert.equal(h.c.state.items[item(coffee, 0).hash].count, 2);
    assert.equal(h.c.state.items[item(lockedTea, 0).hash].count, 5);
    assert.equal(h.c.state.items[item(tea, 1, 9).hash].count, 1);
    assert.equal(h.c.state.items[item(coffee, 1, 10).hash].count, 1);
});

test('a matching loot-opened notice prevents another bag after spam cooldown while inventory acknowledgements are missing', async () => {
    const operation = spamOperations.find(o => o.name === 'open_bag');
    const h = await operation.begin();
    h.receive({type: 'loot_opened', openedItem: {itemHrid: COWBELL_BAG, enhancementLevel: 0, count: 1}});
    assert.equal(h.c.state.pending?.kind, 'open_bag');
    assert.equal(h.c.state.pending?.responseObserved, true);
    h.receive({type: 'error', message: 'requestSpamProtection'});
    await tickAfter(h, 5100);
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.pending?.kind, 'open_bag');
    assert.equal(sentOf(h, 'open_loot').length, 1);
    assert.equal(sentOf(h, 'reroll_random_task').length, 0);
    operation.ack(h);
    await h.tick();
    assert.equal(sentOf(h, 'open_loot').length, 1);
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    assert.equal(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData.useCowbells, true);
});

test('qualifying life tasks and terminal tasks leave cowbell mode and a later higher reward threshold starts again with coins', async () => {
    for (const result of ['qualified', 'completed', 'claimed', 'discarded']) {
        const h = harness({tasks: [combatQuest(1, 21, {cowbellRerollCount: 0})],
            items: [item(HRID.coin, 1000000), item(COWBELL, 10)]});
        h.c.configureTasks({rerollCombat: true, minTokens: 25});
        await h.resume();
        assert.equal(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData.useCowbells, true);
        const replacement = result === 'qualified'
            ? tokenQuest(1, HRID.gather, 4, 25, 0, {coinRerollCount: 0, cowbellRerollCount: 1})
            : combatQuest(1, 0, {cowbellRerollCount: 1});
        h.receive({type: 'quests_updated', endCharacterQuests: [replacement]});
        h.receive({type: 'items_updated', endCharacterItems: [item(COWBELL, 9)]});
        assert.equal(h.c.state.pending, null);
        if (result !== 'qualified') {
            assert.equal(h.c.state.cowbellTaskIds['1'], true);
            h.receive({type: 'quests_updated', endCharacterQuests: [{...replacement, status: `/quest_status/${result}`}]});
        }
        assert.notEqual(h.c.state.cowbellTaskIds['1'], true);
        if (result === 'qualified') {
            h.c.configureTasks({minTokens: 30});
            await h.tick();
            assert.deepEqual(sentOf(h, 'reroll_random_task')[1]?.rerollRandomTaskData, {
                characterQuestId: 1, useMooPass: false, useCowbells: false, currentRerollCount: 0,
            });
            assert.equal(h.c.state.pending?.count, 10000);
        }
    }
});

test('a historical same-id cowbell task update cannot acknowledge a paid reroll despite matching the next counter', async () => {
    const original = combatQuest(1, 21, {cowbellRerollCount: 0, updatedAt: '2026-09-24T10:00:00.000Z'});
    const h = harness({automation: true, tasks: [original], items: [item(HRID.coin, 1000000), item(COWBELL, 10)]});
    await h.resume();
    const stale = combatQuest(1, 0, {cowbellRerollCount: 1, updatedAt: '2026-09-24T09:00:00.000Z'});
    h.receive({type: 'quests_updated', endCharacterQuests: [stale]});
    h.receive({type: 'items_updated', endCharacterItems: [item(COWBELL, 9)]});
    await h.tick();
    assert.equal(h.c.state.quests['1'], original);
    assert.equal(h.c.state.pending?.kind, 'reroll');
    assert.deepEqual(h.c.state.pending?.candidateIds, {});
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
    const fresh = combatQuest(1, 0, {cowbellRerollCount: 1, updatedAt: '2026-09-24T11:00:00.000Z'});
    h.receive({type: 'quests_updated', endCharacterQuests: [fresh]});
    assert.equal(h.c.state.pending, null);
    await h.tick();
    assert.equal(h.c.state.quests['1'], fresh);
    assert.equal(sentOf(h, 'reroll_random_task')[1]?.rerollRandomTaskData.currentRerollCount, 1);
    assert.equal(sentOf(h, 'reroll_random_task')[1]?.rerollRandomTaskData.useCowbells, true);
});

test('a late discard for the old same-id task cannot erase the already observed replacement while payment is pending', async () => {
    const original = combatQuest(1, 21, {cowbellRerollCount: 0});
    const h = harness({automation: true, tasks: [original], items: [item(HRID.coin, 1000000), item(COWBELL, 10)]});
    await h.resume();
    const replacement = combatQuest(1, 0, {cowbellRerollCount: 1});
    h.receive({type: 'quests_updated', endCharacterQuests: [replacement]});
    h.receive({type: 'quests_updated', endCharacterQuests: [{...original, status: '/quest_status/discarded'}]});
    assert.equal(h.c.state.quests['1'], replacement);
    assert.equal(h.c.state.pending?.kind, 'reroll');
    assert.equal(h.c.state.pending?.oldDiscarded, false);
    h.receive({type: 'items_updated', endCharacterItems: [item(COWBELL, 9)]});
    assert.equal(h.c.state.pending, null);
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.deepEqual(sentOf(h, 'reroll_random_task').map(m => m.rerollRandomTaskData.currentRerollCount), [0, 1]);
    assert.equal(sentOf(h, 'reroll_random_task')[1]?.rerollRandomTaskData.useCowbells, true);
});

test('an infinite background consumer does not block tester purchases or tail appends while finite ingredients stay reserved', async () => {
    const unlimited = action(90, HRID.second, 0, 0, {hasMaxCount: false, ordinal: 0});
    const finite = action(91, HRID.second, 4, 1, {ordinal: 1});
    const h = harness({tasks: [quest(1, HRID.produce, 2)], actions: [unlimited, finite],
        items: [item(HRID.coin, 100000), item(HRID.apple, 4)]});
    const p = h.c.plan([1]);
    assert.equal(p.entries[0]?.count, 2);
    assert.equal(p.reserved[`${HRID.apple}::0`], 6);
    assert.equal(p.purchases[0]?.count, 8, 'six for this Task plus six for finite work less four in stock');
    await h.start();
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.job.frontMode, undefined);
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 8);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 12)]});
    await h.tick();
    assert.equal(enqueue(h)?.maxCount, 2);
    assert.equal(enqueue(h)?.isStartNow, false);
    assert.deepEqual(h.sent.map(m => m.type), ['buy_from_shop', 'new_character_action']);
});

test('dynamic enhancing permits planning while retaining one primary and secondary protected item', () => {
    const {client, enhancing, primary: enhanced} = unlimitedEnhancingFixture();
    const primary = item(enhanced.itemHrid, 1);
    client.actionDetailMap[HRID.produce].inputItems = [{itemHrid: primary.itemHrid, count: 1}, {itemHrid: HRID.apple, count: 3}];
    client.shopItemDetailMap['/shop_items/test/gobo_stabber'] = {
        itemHrid: primary.itemHrid, category: '/shop_categories/tester', costs: [{itemHrid: HRID.coin, count: 2}],
    };
    const h = harness({client, tasks: [quest(1, HRID.produce, 1)],
        actions: [{...enhancing, ordinal: 0, primaryItemHash: primary.hash, secondaryItemHash: item(HRID.apple, 1).hash}],
        items: [item(HRID.coin, 100000), primary, item(HRID.apple, 1)]});
    const p = h.c.plan([1]);
    assert.equal(p.reserved[`${primary.itemHrid}::0`], 1);
    assert.equal(p.reserved[`${HRID.apple}::0`], 1);
    assert.deepEqual(Object.fromEntries(p.purchases.map(row => [row.itemHrid, row.count])), {
        [primary.itemHrid]: 1, [HRID.apple]: 3,
    });
});

test('each Task can append at the tail after the previous append is acknowledged without waiting for its execution', async () => {
    const unlimited = action(90, HRID.second, 0, 0, {hasMaxCount: false, ordinal: 0});
    const h = harness({tasks: [quest(1, HRID.produce, 2), quest(2, HRID.gather, 3)], actions: [unlimited],
        items: [item(HRID.coin, 100000), item(HRID.apple, 6)]});
    await h.start([1, 2], {sellOutputs: false});
    assert.equal(enqueue(h)?.actionHrid, HRID.produce);
    assert.equal(enqueue(h)?.isStartNow, false);
    assert.equal(sentOf(h, 'move_character_action_to_front').length, 0);
    h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.produce, 2, 0, {ordinal: 1})]});
    await h.tick();
    assert.equal(enqueue(h, 1)?.actionHrid, HRID.gather);
    assert.equal(enqueue(h, 1)?.isStartNow, false);
    assert.equal(h.c.state.actions['42'].currentCount, 0, 'the preceding Task has not executed yet');
    h.receive({type: 'actions_updated', endCharacterActions: [action(43, HRID.gather, 3, 0, {ordinal: 2})]});
    for (let i = 0; i < 3; i += 1) await h.tick();
    assert.equal(h.c.state.pending, null);
    assert.deepEqual(h.sent.map(m => m.type), ['new_character_action', 'new_character_action']);
    assert.equal(h.c.state.actions['90'].ordinal, 0);
    assert.equal(h.c.state.actions['42'].ordinal, 1);
});

test('a finite queue that already covers a Task is left intact beside infinite background work', async () => {
    const {client, primary, enhancing} = unlimitedEnhancingFixture();
    const h = harness({client, tasks: [quest(1, HRID.produce, 4, 2)],
        actions: [action(42, HRID.produce, 4, 2, {ordinal: -1}), {...enhancing, ordinal: 0}],
        items: [item(HRID.coin, 100000), primary, item(HRID.apple, 1)]});
    assert.equal(h.c.plan([1]).entries[0]?.count, 0);
    await h.start();
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.deepEqual(h.sent, []);
    assert.equal(h.c.state.actions['42'].ordinal, -1);
});

test('a full queue with infinite background work waits for a free slot and never reorders existing actions', async () => {
    const unlimited = action(90, HRID.second, 0, 0, {hasMaxCount: false, ordinal: 0});
    const queued = action(42, HRID.produce, 2, 0, {ordinal: 1});
    const h = harness({tasks: [quest(1, HRID.produce, 4)], actions: [unlimited, queued], capacity: 2,
        items: [item(HRID.coin, 100000), item(HRID.apple, 12)]});
    await h.start();
    for (let i = 0; i < 3; i += 1) await h.tick();
    assert.deepEqual(h.sent, []);
    h.receive({type: 'action_completed', endCharacterAction: {...queued, currentCount: 2},
        endCharacterItems: [item(HRID.apple, 6)], endCharacterQuests: [quest(1, HRID.produce, 4, 2)]});
    h.receive({type: 'actions_updated', endCharacterActions: [{...queued, currentCount: 2, isDone: true}]});
    await h.tick();
    assert.equal(enqueue(h)?.maxCount, 2);
    assert.equal(enqueue(h)?.isStartNow, false);
    assert.deepEqual(h.sent.map(m => m.type), ['new_character_action']);
    assert.equal(h.c.state.actions['90'].ordinal, 0);
});

test('refresh recognizes an accepted tail append without duplicating it beside an infinite background action', async () => {
    const unlimited = action(90, HRID.second, 0, 0, {hasMaxCount: false, ordinal: 0});
    const tasks = [quest(1, HRID.produce, 2)];
    const items = [item(HRID.coin, 100000), item(HRID.apple, 6)];
    const first = harness({tasks, actions: [unlimited], items});
    await first.start();
    assert.equal(sentOf(first, 'new_character_action').length, 1);
    const fresh = harness({storage: first.storage, tasks, actions: [unlimited, action(42, HRID.produce, 2, 0, {ordinal: 1})], items});
    await fresh.tick();
    assert.equal(fresh.c.state.pending, null);
    assert.equal(fresh.c.state.owned['42'], HRID.produce);
    assert.deepEqual(fresh.sent, []);
});

test('full synchronization removes legacy front mode and never replays a pending move before continuing tail appends', async () => {
    const unlimited = action(90, HRID.second, 0, 0, {hasMaxCount: false, ordinal: 0});
    const tasks = [quest(1, HRID.produce, 2), quest(2, HRID.gather, 3)];
    const items = [item(HRID.coin, 100000), item(HRID.apple, 6)];
    const first = harness({tasks, actions: [unlimited], items});
    await first.start();
    const saved = JSON.parse(first.storage.getItem('MWI_TASK_QUEUE_V1:123'));
    saved.job.frontMode = true;
    saved.job.queuedActionIds = ['42'];
    saved.owned['42'] = HRID.produce;
    saved.ownedLimits['42'] = {actionHrid: HRID.produce, maxCount: 2};
    saved.pending = {kind: 'move_front', actionId: '42', beforeHeadId: '90', beforeProgress: 0,
        beforeOrdinals: {'90': 0, '42': 1}, sentAt: 100000, inventoryRevision: 0};
    for (const ordinal of [1, -1]) {
        const storage = memoryStorage();
        storage.setItem('MWI_TASK_QUEUE_V1:123', JSON.stringify(saved));
        const fresh = harness({storage, tasks, actions: [unlimited, action(42, HRID.produce, 2, 0, {ordinal})], items});
        assert.equal(fresh.c.state.pending, null);
        assert.equal(fresh.c.state.job.frontMode, undefined);
        await fresh.tick();
        assert.equal(enqueue(fresh)?.actionHrid, HRID.gather);
        assert.equal(enqueue(fresh)?.maxCount, 3);
        assert.equal(enqueue(fresh)?.isStartNow, false);
        assert.deepEqual(fresh.sent.map(m => m.type), ['new_character_action']);
        assert.equal(fresh.c.state.actions['42'].ordinal, ordinal);
        const migrated = JSON.parse(storage.getItem('MWI_TASK_QUEUE_V1:123'));
        assert.equal(migrated.job.frontMode, undefined);
    }
});

test('an infinite same-action queue covers the Task at either position without duplicate purchases or appends', async () => {
    const blocker = action(90, HRID.second, 0, 0, {hasMaxCount: false, ordinal: 0});
    for (const ordinal of [1, -1]) {
        const covered = action(91, HRID.produce, 0, 0, {hasMaxCount: false, ordinal});
        const h = harness({tasks: [quest(1, HRID.produce, 2)], actions: [blocker, covered]});
        const p = h.c.plan([1]);
        assert.equal(p.entries[0]?.covered, 2);
        assert.equal(p.entries[0]?.count, 0);
        assert.deepEqual(p.purchases, []);
        await h.start();
        await h.tick();
        assert.deepEqual(h.sent, []);
    }
});

test('infinite background consumption does not freeze resource sales when tester listings are absent', async () => {
    const dynamic = unlimitedEnhancingFixture();
    const variants = [
        {client: clientData(), blocker: action(90, HRID.second, 0, 0, {hasMaxCount: false, ordinal: 0}), extras: []},
        {client: dynamic.client, blocker: {...dynamic.enhancing, ordinal: 0}, extras: [dynamic.primary]},
    ];
    for (const {client, blocker, extras} of variants) {
        client.shopItemDetailMap = {};
        const h = harness({client, recoverSurplus: false, tasks: [quest(1, HRID.gather, 1)],
            actions: [action(42, HRID.gather, 1, 0, {ordinal: -1}), blocker],
            items: [item(HRID.coin, 100000), item(HRID.apple, 100), ...extras]});
        await h.start();
        h.c.configureTasks({recoverSurplus: true});
        h.receive({type: 'action_completed', endCharacterAction: action(42, HRID.gather, 1, 1, {ordinal: -1, isDone: true}),
            endCharacterItems: [item(HRID.apple, 110)], endCharacterQuests: [quest(1, HRID.gather, 1, 1)]});
        assert.equal(h.c.state.credits[`${HRID.apple}::0`], 10);
        assert.equal(h.c.state.saleCredits[`${HRID.apple}::0`], 10);
        assert.equal(h.c.previewSurplus().rows.find(row => row.itemHrid === HRID.apple)?.count, 100);
        assert.equal(h.c.nextSale()?.count, 10, 'known output remains sellable before surplus recovery');
        await h.tick();
        assert.equal(sentOf(h, 'sell_to_shop')[0]?.sellToShopData.count, 110);
    }
});

test('tail-append purchases retain finite inputs and a protected primary and recompute shortages after background consumption', async () => {
    const {client, enhancing} = unlimitedEnhancingFixture();
    client.itemDetailMap[HRID.apple].enhancementCosts = [{itemHrid: HRID.coin, count: 1000}, {itemHrid: HRID.apple, count: 2}];
    const background = {...enhancing, ordinal: 0, primaryItemHash: item(HRID.apple, 4).hash};
    const h = harness({client, tasks: [quest(1, HRID.produce, 2)],
        actions: [background,
            action(91, HRID.second, 4, 1, {ordinal: 1})],
        items: [item(HRID.coin, 100000), item(HRID.apple, 4)]});
    await h.start();
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 9,
        'six Task ingredients plus six for finite work plus one protected primary less four in stock');
    h.receive({type: 'action_completed', endCharacterAction: {...background, currentCount: 1},
        endCharacterItems: [item(HRID.apple, 3)]});
    assert.equal(h.c.state.pending?.kind, 'buy');
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 12)]});
    assert.equal(h.c.state.pending, null);
    await h.tick();
    assert.deepEqual(sentOf(h, 'buy_from_shop').map(m => m.buyFromShopData.count), [9, 1]);
    assert.equal(sentOf(h, 'new_character_action').length, 0);
    assert.equal(sentOf(h, 'move_character_action_to_front').length, 0);
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 13)]});
    await h.tick();
    assert.deepEqual(sentOf(h, 'buy_from_shop').map(m => m.buyFromShopData.count), [9, 1]);
    assert.equal(enqueue(h)?.maxCount, 2);
    assert.equal(enqueue(h)?.isStartNow, false);
    assert.deepEqual(h.sent.map(m => m.type), ['buy_from_shop', 'buy_from_shop', 'new_character_action']);
});

test('unknown enhancing consumption does not block Task purchases or tail appends while finite ingredients and physical targets remain protected', async () => {
    for (const missingActionDetail of [false, true]) {
        const {client, primary, enhancing} = unlimitedEnhancingFixture();
        delete client.itemDetailMap[primary.itemHrid].enhancementCosts;
        if (missingActionDetail) {
            delete client.actionDetailMap[enhancing.actionHrid];
            delete client.itemDetailMap[primary.itemHrid];
        }
        const h = harness({client, tasks: [quest(1, HRID.produce, 2)],
            actions: [{...enhancing, ordinal: 0, secondaryItemHash: item(HRID.apple, 1).hash},
                action(91, HRID.second, 4, 1, {ordinal: 1})],
            items: [item(HRID.coin, 100000), primary, item(HRID.apple, 1)]});
        const p = h.c.plan([1]);
        assert.equal(p.reserved[`${primary.itemHrid}::7`], 1);
        assert.equal(p.reserved[`${HRID.apple}::0`], 7);
        assert.equal(p.purchases[0]?.count, 12,
            'six Task inputs plus six finite inputs plus one secondary target less one in stock');
        await h.start();
        assert.equal(h.c.state.enabled, true);
        assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 12);
        h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 13)]});
        await h.tick();
        assert.equal(enqueue(h)?.maxCount, 2);
        assert.equal(enqueue(h)?.isStartNow, false);
        h.receive({type: 'actions_updated', endCharacterActions: [action(42, HRID.produce, 2, 0, {ordinal: 2})]});
        await h.tick();
        assert.deepEqual(h.sent.map(m => m.type), ['buy_from_shop', 'new_character_action']);
        assert.equal(h.c.state.items[primary.hash].count, 1);
    }
});

test('unknown labyrinth exploration consumption does not block planning or tester purchases for a known Task', async () => {
    const maze = action(90, '/actions/labyrinth/explore', 0, 0, {hasMaxCount: false, ordinal: 0});
    const h = harness({tasks: [quest(1, HRID.produce, 2)],
        actions: [maze, action(91, HRID.second, 4, 1, {ordinal: 1})],
        items: [item(HRID.coin, 100000), item(HRID.apple, 4)]});
    const p = h.c.plan([1]);
    assert.equal(p.reserved[`${HRID.apple}::0`], 6);
    assert.equal(p.purchases[0]?.count, 8);
    await h.start();
    assert.equal(h.c.state.enabled, true);
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.count, 8);
    assert.equal(sentOf(h, 'buy_from_shop')[0]?.buyFromShopData.shopItemHrid, '/shop_items/test/apple');
});

test('a missing ordinary finite life recipe still blocks planning instead of guessing its reserved materials', () => {
    const client = clientData();
    delete client.actionDetailMap[HRID.second];
    const h = harness({client, tasks: [quest(1, HRID.gather, 2)],
        actions: [action(91, HRID.second, 4, 1)], items: [item(HRID.coin, 100000), item(HRID.apple, 20)]});
    assert.throws(() => h.c.plan([1]), /配方/);
    assert.deepEqual(h.sent, []);
});

test('batching with unknown maze costs cleans allowed inventory before continuing task rerolls', async () => {
    const first = await settledSurplusHarness({client: nonTesterClientData(), completionItems: [item(HRID.apple, 105)]});
    first.c.configureTasks({autoQueue: true, autoClaim: true, autoRead: true, rerollCombat: true,
        minTokens: 25, batchTarget: 48, quantityMultiple: 3, recoverSurplus: true});
    first.c.clear();
    first.c.resume();
    const mazeHrid = '/actions/labyrinth/explore';
    const h = harness({storage: first.storage, client: nonTesterClientData(), automation: true, taskPolicy: null, recoverSurplus: null,
        tasks: [combatQuest(2), quest(3, HRID.gather, 4)],
        actions: [action(90, mazeHrid, 0, 0, {hasMaxCount: false, ordinal: 0})],
        items: [item(HRID.coin, 100000), item(HRID.apple, 115)]});
    assert.equal(h.c.state.job, null);
    assert.equal(h.c.batchStatus().target, 48);
    assert.equal(h.c.batchStatus().eligibleCount, 1);
    assert.equal(h.c.state.sellOutputs, true);
    assert.equal(h.c.state.recoverSurplus, true);
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.job, null);
    assert.deepEqual(sentOf(h, 'sell_to_shop')[0]?.sellToShopData,
        {itemHash: item(HRID.apple, 0).hash, count: 115});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.apple, 0)]});
    await h.tick();
    assert.equal(h.c.state.recoveryNeeded, false);
    assert.deepEqual(sentOf(h, 'reroll_random_task')[0]?.rerollRandomTaskData, {
        characterQuestId: 2, useMooPass: false, useCowbells: false, currentRerollCount: 0,
    });
    h.receive({type: 'quests_updated', endCharacterQuests: [{...quest(2, HRID.gather, 4), coinRerollCount: 1}]});
    h.receive({type: 'items_updated', endCharacterItems: [item(HRID.coin, 90000)]});
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.pending, null);
    assert.equal(h.c.state.job, null);
    assert.equal(sentOf(h, 'sell_to_shop').length, 1);
    const synchronizedClient = nonTesterClientData();
    synchronizedClient.actionDetailMap[mazeHrid] = {
        name: 'Labyrinth', function: '/action_functions/combat', inputItems: [], outputItems: [],
    };
    h.receive(synchronizedClient);
    await h.tick();
    assert.equal(h.c.state.enabled, true);
    assert.equal(h.c.state.job, null);
    assert.equal(sentOf(h, 'sell_to_shop').length, 1, 'synchronizing background metadata does not sell again');
    assert.equal(sentOf(h, 'reroll_random_task').length, 1);
});

async function runTests() {
    let failed = 0;
    for (const {name, run} of cases) {
        try {
            await run();
            process.stdout.write(`ok - ${name}\n`);
        } catch (error) {
            failed += 1;
            process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
        }
    }
    process.stdout.write(`\n${cases.length - failed}/${cases.length} task queue tests passed\n`);
    process.exitCode = failed ? 1 : 0;
}

runTests();
