#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ACTIVE = '/market_listing_status/active';
const FILLED = '/market_listing_status/filled';
const INVENTORY = '/item_locations/inventory';
const EQUIPPED_CHARM = '/item_locations/charm';
const ITEM_ID = 'grandmaster_attack_charm';
const ITEM_HRID = `/items/${ITEM_ID}`;
const COWBELL_BAG_ID = 'bag_of_10_cowbells';
const COWBELL_BAG_HRID = `/items/${COWBELL_BAG_ID}`;
const COIN_ID = 'coin';
const COIN_HRID = `/items/${COIN_ID}`;

let now = 1_800_000_000_000;
let nextTimerId = 1;
const scheduledTimers = new Map();

class FakeDate extends Date {
    constructor(...args) {
        super(...(args.length > 0 ? args : [now]));
    }

    static now() {
        return now;
    }
}

function fakeSetTimeout(callback, delay = 0) {
    const id = nextTimerId++;
    scheduledTimers.set(id, {
        callback,
        delay: Number(delay) || 0,
        scheduledAt: now,
    });
    return id;
}

function fakeClearTimeout(id) {
    scheduledTimers.delete(id);
}

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url = (
        'wss://api-test.milkywayidle.com/ws?characterId=123'
    )) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        this.listeners = new Map();
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    send(data) {
        if (this.readyState !== FakeWebSocket.OPEN) {
            throw new Error('FakeWebSocket is not open');
        }
        this.sent.push(String(data));
    }

    emit(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) {
            listener.call(this, event);
        }
    }
}

const storage = new Map();

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

const location = {
    hostname: 'test.milkywayidle.com',
    origin: 'https://test.milkywayidle.com',
    href: 'https://test.milkywayidle.com/?characterId=123',
    search: '?characterId=123',
};
const fakeWindow = {
    location,
    WebSocket: FakeWebSocket,
    localStorage: {
        getItem: (key) => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
    },
    addEventListener() {},
    requestAnimationFrame(callback) {
        callback();
        return 1;
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    confirm: () => true,
    prompt: () => null,
    alert() {},
};
const fakeDocument = {
    body: {},
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
};
const context = {
    console: {log() {}, warn() {}, error() {}},
    window: fakeWindow,
    document: fakeDocument,
    WebSocket: FakeWebSocket,
    URL,
    URLSearchParams,
    Intl,
    Date: FakeDate,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    __MWI_MARKET_KEEPER_RUNTIME_TEST_MODE__: true,
};
vm.createContext(context);

const userscriptPath = path.join(__dirname, 'mwi_market_keeper.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');
vm.runInContext(source, context, {filename: userscriptPath});

const exportsObject =
    context.__MWI_MARKET_KEEPER_RUNTIME_TEST_EXPORTS__;
assert.ok(exportsObject, 'market keeper runtime exports are required');

const {
    COWBELL_BAG_ITEM_ID,
    COWBELL_LEVEL,
    COIN_ITEM_ID,
    CONFIG,
    State,
    Network,
    MarketTransactions,
    MarketKeeper,
    UI,
    analyzeCowbellBuyBook,
    analyzeOrderBook,
    claimListing,
    createCowbellBuyPayload,
    createPostPayload,
    getEquippedItemCount,
    getInventoryReserveNeeded,
    getOfficialBinnedMarketPrice,
    isItemMarketLocked,
    getOwnActiveBuyListings,
    getTradablePriceRange,
    getPreviousOfficialMarketPrice,
    initializationIssue,
    matchPostResult,
    maintainCowbellBuy,
    pendingWriteStatusText,
    planCowbellBuyDecision,
    planMarketDecision,
    postCowbellBuy,
    postInventory,
    reconcilePersistedPendingWrite,
    replaceClientData,
    replaceInventory,
    replaceItemMarks,
    replaceMyListings,
    restoreClientDataFromCache,
    updateCharacterItemSlot,
    updateInventoryItem,
} = exportsObject;

function fakeClassList() {
    const values = new Set();
    return {
        contains: (value) => values.has(value),
        toggle(value, force) {
            if (force === true) values.add(value);
            else if (force === false) values.delete(value);
            else if (values.has(value)) values.delete(value);
            else values.add(value);
        },
    };
}

function inventoryItem(
    count,
    itemId = ITEM_ID,
    enhancementLevel = 20
) {
    return {
        itemHrid: `/items/${itemId}`,
        itemLocationHrid: INVENTORY,
        enhancementLevel,
        count,
    };
}

function equippedItem(
    count,
    itemId = ITEM_ID,
    enhancementLevel = 20,
    itemLocationHrid = EQUIPPED_CHARM
) {
    return {
        itemHrid: `/items/${itemId}`,
        itemLocationHrid,
        enhancementLevel,
        count,
    };
}

function itemMark({
    itemId = ITEM_ID,
    kind = 'lock',
    minEnhancementLevel = 20,
    maxEnhancementLevel = 20,
} = {}) {
    return {
        itemHrid: `/items/${itemId}`,
        kind,
        minEnhancementLevel,
        maxEnhancementLevel,
    };
}

function listing({
    id,
    price,
    orderQuantity = 1,
    filledQuantity = 0,
    status = ACTIVE,
    itemId = ITEM_ID,
    unclaimedItemCount = 0,
    unclaimedCoinCount = 0,
    workingPrice,
    isSell = true,
    enhancementLevel = 20,
} = {}) {
    const result = {
        id,
        status,
        isSell,
        itemHrid: `/items/${itemId}`,
        enhancementLevel,
        price,
        orderQuantity,
        filledQuantity,
        unclaimedItemCount,
        unclaimedCoinCount,
    };
    if (workingPrice !== undefined) result.workingPrice = workingPrice;
    return result;
}

function ask(listingId, price, quantity = 1) {
    return {listingId, price, quantity};
}

function orderBook(
    asks,
    itemId = ITEM_ID,
    priceBand = null,
    bids = [],
    enhancementLevel = 20
) {
    const snapshot = {
        itemHrid: `/items/${itemId}`,
        orderBooks: {
            [enhancementLevel]: {asks, bids},
        },
    };
    if (priceBand) {
        snapshot.marketValues = [];
        snapshot.priceBandMins = [];
        snapshot.priceBandMaxs = [];
        snapshot.marketValues[enhancementLevel] =
            priceBand.marketValue ?? 1000;
        snapshot.priceBandMins[enhancementLevel] = priceBand.min;
        snapshot.priceBandMaxs[enhancementLevel] = priceBand.max;
    }
    return snapshot;
}

function cowbellBuyListing(options = {}) {
    return listing({
        itemId: COWBELL_BAG_ID,
        enhancementLevel: 0,
        isSell: false,
        ...options,
    });
}

function cowbellBook({
    asks = [],
    bids = [],
    min = 900,
    max = 1100,
    marketValue = 1000,
} = {}) {
    return orderBook(
        asks,
        COWBELL_BAG_ID,
        {min, max, marketValue},
        bids,
        0
    );
}

function clientData() {
    return {
        type: 'init_client_data',
        itemDetailMap: {
            [ITEM_HRID]: {
                isTradable: true,
                sellPrice: 2,
                name: 'Grandmaster Attack Charm',
            },
            [COWBELL_BAG_HRID]: {
                isTradable: true,
                sellPrice: 0,
                name: 'Bag of 10 Cowbells',
            },
            [COIN_HRID]: {
                isTradable: true,
                sellPrice: 0,
                name: 'Coin',
            },
        },
        gameModeDetailMap: {
            standard: {marketRestricted: false},
        },
    };
}

function sentMessages(socket) {
    return socket.sent.map((raw) => JSON.parse(raw));
}

async function flushUntil(predicate, label) {
    for (let attempt = 0; attempt < 40; attempt++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail(`timed out waiting for ${label}`);
}

async function releaseTimerWithDelay(delay, label) {
    await flushUntil(
        () => [...scheduledTimers.values()].some((timer) => (
            timer.delay === delay
        )),
        label
    );
    const entry = [...scheduledTimers.entries()].find(([, timer]) => (
        timer.delay === delay
    ));
    assert.ok(entry);
    const [timerId, timer] = entry;
    scheduledTimers.delete(timerId);
    now += timer.delay;
    timer.callback();
}

function stopAndResetTimers() {
    MarketKeeper.stop();
    scheduledTimers.clear();
    State.timer = null;
}

function resetRuntime({
    inventory = 1,
    equipped = 0,
    cowbellInventory = 0,
    coinInventory = 1_000_000,
    listings = [],
    enabled = true,
    watchlist = [ITEM_ID],
    cowbellEnabled = false,
} = {}) {
    if (State.op) MarketTransactions.abort('test reset');
    stopAndResetTimers();
    storage.clear();
    now += 100_000;

    const socket = new FakeWebSocket();
    State.socket = socket;
    State.connectionEpoch++;
    State.syncEpoch++;
    State.characterId = '123';
    State.profileLoaded = true;
    State.enabled = enabled;
    State.cowbellEnabled = cowbellEnabled;
    State.watchlist.clear();
    for (const itemId of watchlist) State.watchlist.add(itemId);
    State.pausedItems.clear();
    State.pendingWrite = null;
    State.op = null;
    State.busy = false;
    State.roundRobinIndex = 0;
    State.idleScanStreak = 0;
    State.currentItemId = '';
    State.lastPolledItemId = '';
    State.lastPollAt = 0;
    State.lastCowbellPollAt = 0;
    State.itemStatus.clear();
    State.candidateItemIds.clear();
    State.lastRequestAt = 0;
    State.backoffUntil = 0;
    State.logs.length = 0;

    replaceClientData(clientData());
    replaceItemMarks([]);
    replaceInventory([
        inventoryItem(inventory),
        ...(equipped > 0 ? [equippedItem(equipped)] : []),
        inventoryItem(cowbellInventory, COWBELL_BAG_ID, 0),
        inventoryItem(coinInventory, COIN_ID, 0),
    ]);
    replaceMyListings(listings);
    State.listingCap = 20;
    State.characterGameMode = 'standard';
    State.tradingRulesKnown = true;
    State.acceptedTradingRules = true;
    State.accessReady = true;
    assert.equal(initializationIssue(), '');
    return socket;
}

async function respondToOrderBook(
    socket,
    sentIndex,
    asks,
    priceBand = null,
    {
        itemId = ITEM_ID,
        bids = [],
        enhancementLevel = 20,
    } = {}
) {
    await flushUntil(
        () => sentMessages(socket).length > sentIndex,
        `outgoing message ${sentIndex}`
    );
    const sent = sentMessages(socket)[sentIndex];
    assert.equal(sent.type, 'get_market_item_order_books');
    assert.equal(
        sent.getMarketItemOrderBooksData?.itemHrid,
        `/items/${itemId}`
    );
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: orderBook(
            asks,
            itemId,
            priceBand,
            bids,
            enhancementLevel
        ),
    });
}

async function confirmPost({
    socket,
    sentIndex,
    resultingListing,
    resultingInventory = 1,
    itemId = ITEM_ID,
}) {
    await flushUntil(
        () => sentMessages(socket).length > sentIndex,
        `post message ${sentIndex}`
    );
    const post = sentMessages(socket)[sentIndex];
    assert.equal(post.type, 'post_market_order');
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [resultingListing],
    });
    Network.handleIncoming({
        type: 'items_updated',
        updatedCharacterItems: [inventoryItem(resultingInventory, itemId)],
    });
    return post;
}

async function confirmCowbellPost({
    socket,
    sentIndex,
    resultingListing,
}) {
    await flushUntil(
        () => sentMessages(socket).length > sentIndex,
        `cowbell post message ${sentIndex}`
    );
    const post = sentMessages(socket)[sentIndex];
    assert.equal(post.type, 'post_market_order');
    assert.equal(post.postMarketOrderData?.isSell, false);
    assert.equal(
        post.postMarketOrderData?.itemHrid,
        COWBELL_BAG_HRID
    );
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [resultingListing],
    });
    return post;
}

function runPureDecisionTests() {
    const level20BinCases = [
        // [raw value, round down, round up, effective gap]
        [101, 100, 102, 2],
        [201, 200, 205, 5],
        [401, 400, 410, 10],
        [801, 800, 820, 20],
        [1001, 1000, 1020, 20],
        [1201, 1200, 1225, 25],
        [1501, 1500, 1530, 30],
        [50001, 50000, 51000, 1000],
    ];
    for (const [raw, down, up, gap] of level20BinCases) {
        assert.equal(
            getOfficialBinnedMarketPrice(raw, false, 0, 20),
            down,
            `level-20 official bin rounds ${raw} down with gap ${gap}`
        );
        assert.equal(
            getOfficialBinnedMarketPrice(raw, true, 0, 20),
            up,
            `level-20 official bin rounds ${raw} up with gap ${gap}`
        );
        assert.equal(up - down, gap);
    }

    assert.equal(
        getOfficialBinnedMarketPrice(1201, true, 0),
        1225,
        'the market helper defaults to the +20 bin table'
    );
    assert.equal(
        getOfficialBinnedMarketPrice(1201, true, 0, 0),
        1205,
        'unenhanced items use the tighter level-zero bin gap'
    );
    assert.equal(
        getOfficialBinnedMarketPrice(50001, true, 0, 0),
        50200,
        'the level-zero five-digit gap remains distinct from +20'
    );

    const officialPreviousSteps = new Map([
        [100, 99],
        [200, 198],
        [400, 395],
        [800, 790],
        [1000, 980],
        [1200, 1180],
        [1500, 1475],
        [50000, 49000],
    ]);
    for (const [leftOne, expected] of officialPreviousSteps) {
        assert.equal(
            getPreviousOfficialMarketPrice(leftOne, 0, 20),
            expected,
            `official previous +20 price step for ${leftOne}`
        );
    }

    for (const [inventoryCount, expectedKind, expectedExcess] of [
        [0, 'reserve_only', 0],
        [1, 'reserve_only', 0],
        [2, 'post_new', 1],
        [50, 'post_new', 49],
    ]) {
        const baseArguments = {
            itemId: ITEM_ID,
            inventoryCount,
            ownListings: [],
            orderBookSnapshot: orderBook([ask(901, 1000)]),
            vendorPrice: 2,
            listingSlotAvailable: true,
        };
        const decision = planMarketDecision(baseArguments);
        assert.equal(decision.kind, expectedKind);
        assert.equal(
            decision.excessQuantity,
            expectedExcess,
            `inventory ${inventoryCount} must reserve exactly one item`
        );
    }

    const own = listing({
        id: 101,
        price: 1000,
        orderQuantity: 10,
    });
    const equippedReserveStable = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 0,
        equippedCount: 1,
        ownListings: [own],
        orderBookSnapshot: orderBook([ask(101, 1000, 10)]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(
        equippedReserveStable.kind,
        'already_lowest',
        'an equipped +20 satisfies the self-use reserve without reclaiming the listing'
    );

    const equippedAndInventoryArguments = {
        itemId: ITEM_ID,
        inventoryCount: 1,
        equippedCount: 1,
        ownListings: [],
        orderBookSnapshot: orderBook([ask(902, 1000)]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    };
    const equippedAndInventoryPost = planMarketDecision(
        equippedAndInventoryArguments
    );
    assert.equal(equippedAndInventoryPost.kind, 'post_new');
    assert.equal(
        equippedAndInventoryPost.excessQuantity,
        1,
        'when the reserve is equipped, the warehouse copy is sellable'
    );
    const tiedLowest = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 6,
        ownListings: [own],
        orderBookSnapshot: orderBook([
            ask(201, 1000),
            ask(101, 1000, 10),
        ]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(tiedLowest.kind, 'consolidate');
    assert.equal(tiedLowest.newPrice, 1000);
    assert.equal(tiedLowest.excessQuantity, 5);

    const competitorBelow = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 1,
        ownListings: [own],
        orderBookSnapshot: orderBook([
            ask(201, 950),
            ask(101, 1000, 10),
        ]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(competitorBelow.kind, 'reprice');
    assert.equal(competitorBelow.newPrice, 940);

    const reclaimReserve = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 0,
        ownListings: [own],
        orderBookSnapshot: orderBook([ask(101, 1000, 10)]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(reclaimReserve.kind, 'reserve_reclaim');

    const legacyOffGridOwn = listing({
        id: 106,
        price: 998,
        orderQuantity: 2,
    });
    const legacyOffGridReclaim = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 0,
        ownListings: [legacyOffGridOwn],
        orderBookSnapshot: orderBook([ask(106, 998, 2)]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(legacyOffGridReclaim.kind, 'reserve_reclaim');
    assert.equal(
        legacyOffGridReclaim.newPrice,
        1000,
        'a pre-update off-grid own order is rounded upward before reserve reclaim reposting'
    );

    const offGridBand = {min: 901, max: 1101, marketValue: 1000};
    const peggedOffGridOwn = listing({
        id: 107,
        price: 900,
        workingPrice: 901,
        orderQuantity: 2,
    });
    for (const inventoryCount of [0, 2]) {
        const peggedReplacement = planMarketDecision({
            itemId: ITEM_ID,
            inventoryCount,
            ownListings: [peggedOffGridOwn],
            orderBookSnapshot: orderBook(
                [ask(107, 901, 2)],
                ITEM_ID,
                offGridBand
            ),
            vendorPrice: 2,
            listingSlotAvailable: true,
        });
        assert.equal(
            peggedReplacement.kind,
            inventoryCount === 0 ? 'reserve_reclaim' : 'consolidate'
        );
        assert.equal(
            peggedReplacement.newPrice,
            900,
            'a legal limit below an off-grid band Min keeps the same pegged working price'
        );
    }

    const deepUndercut = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 1,
        ownListings: [own],
        orderBookSnapshot: orderBook([
            ask(201, 850),
            ask(101, 1000, 10),
        ]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(deepUndercut.kind, 'reprice');
    assert.equal(
        deepUndercut.newPrice,
        840,
        'a much lower competitor is followed without any historical price floor'
    );

    const deepUndercutWithNewInventory = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 2,
        ownListings: [own],
        orderBookSnapshot: orderBook([
            ask(201, 850),
            ask(101, 1000, 10),
        ]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(deepUndercutWithNewInventory.kind, 'reprice');
    assert.equal(
        deepUndercutWithNewInventory.newPrice,
        840,
        'new inventory is merged while repricing directly to the latest left-one step'
    );

    const secondOwn = listing({
        id: 102,
        price: 1050,
        orderQuantity: 5,
    });
    const multipleOwn = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 4,
        ownListings: [own, secondOwn],
        orderBookSnapshot: orderBook([
            ask(101, 1000, 10),
            ask(102, 1050, 5),
            ask(201, 1100, 20),
        ]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(multipleOwn.kind, 'consolidate');
    assert.equal(multipleOwn.ownListings.length, 2);
    assert.equal(multipleOwn.newPrice, 1000);

    const priceBand = {min: 900, max: 1100, marketValue: 1000};
    const rangedBook = orderBook([
        ask(301, 800),
        ask(302, 950),
        ask(303, 1200),
    ], ITEM_ID, priceBand);
    const rangedAnalysis = analyzeOrderBook(rangedBook, []);
    assert.equal(rangedAnalysis.rawLeftOne.price, 800);
    assert.equal(rangedAnalysis.leftOne.price, 950);
    assert.deepEqual(
        JSON.parse(JSON.stringify(getTradablePriceRange(rangedBook))),
        {min: 900, max: 1100, marketValue: 1000}
    );
    const rangedPost = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 2,
        ownListings: [],
        orderBookSnapshot: rangedBook,
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(rangedPost.kind, 'post_new');
    assert.equal(rangedPost.newPrice, 940);
    const atBandMinBook = orderBook(
        [ask(306, 900)],
        ITEM_ID,
        priceBand
    );
    const atBandMinPost = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 2,
        ownListings: [],
        orderBookSnapshot: atBandMinBook,
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(atBandMinPost.kind, 'post_new');
    assert.equal(
        atBandMinPost.newPrice,
        880,
        'an in-band left one at Min still uses the next official price step, even below Min'
    );
    const changedBandDecision = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 2,
        ownListings: [],
        orderBookSnapshot: orderBook([
            ask(301, 800),
            ask(302, 950),
            ask(303, 1200),
        ], ITEM_ID, {min: 901, max: 1101, marketValue: 1001}),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(
        changedBandDecision.kind,
        'post_new',
        'the current authoritative price band is used immediately'
    );
    assert.equal(changedBandDecision.newPrice, 940);

    const peggedOwn = listing({
        id: 103,
        price: 850,
        workingPrice: 900,
        orderQuantity: 2,
    });
    const peggedDecision = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 1,
        ownListings: [peggedOwn],
        orderBookSnapshot: orderBook([
            ask(304, 950, 10),
        ], ITEM_ID, priceBand),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(peggedDecision.kind, 'already_lowest');
    assert.equal(peggedDecision.oldPrice, 900);
    assert.equal(peggedDecision.oldLimitPrice, 850);
    assert.equal(
        peggedDecision.ownCurrentPrice,
        900,
        'workingPrice fallback, not the submitted limit, determines whether own is left one'
    );
    const peggedConsolidation = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 2,
        ownListings: [peggedOwn],
        orderBookSnapshot: orderBook([
            ask(304, 950, 10),
        ], ITEM_ID, priceBand),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(peggedConsolidation.kind, 'consolidate');
    assert.equal(
        peggedConsolidation.newPrice,
        900,
        'consolidation preserves the effective working price, not a stale lower limit'
    );

    const ownLowest = listing({id: 104, price: 850});
    const ownLowestConsolidation = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 2,
        ownListings: [ownLowest],
        orderBookSnapshot: orderBook([
            ask(104, 850),
            ask(305, 1100),
        ]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(ownLowestConsolidation.kind, 'consolidate');
    assert.equal(
        ownLowestConsolidation.newPrice,
        860,
        'a legacy off-grid own price rounds upward during consolidation so it is not self-undercut'
    );

    for (const asks of [[], [ask(401, 800), ask(402, 1200)]]) {
        const emptyBandBook = orderBook(
            asks,
            ITEM_ID,
            priceBand
        );
        const emptyBandPost = planMarketDecision({
            itemId: ITEM_ID,
            inventoryCount: 2,
            ownListings: [],
            orderBookSnapshot: emptyBandBook,
            vendorPrice: 2,
            listingSlotAvailable: true,
        });
        assert.equal(emptyBandPost.kind, 'post_new');
        assert.equal(
            emptyBandPost.newPrice,
            900,
            'no ask inside the authoritative band uses exact Min'
        );
    }

    const freeEmpty = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 2,
        ownListings: [],
        orderBookSnapshot: orderBook([]),
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(freeEmpty.kind, 'no_quote');

    const disabledBandBook = orderBook(
        [ask(501, 1000)],
        ITEM_ID,
        {min: 900, max: 0, marketValue: 1000}
    );
    assert.equal(getTradablePriceRange(disabledBandBook), null);
    const disabledBandPost = planMarketDecision({
        itemId: ITEM_ID,
        inventoryCount: 2,
        ownListings: [],
        orderBookSnapshot: disabledBandBook,
        vendorPrice: 2,
        listingSlotAvailable: true,
    });
    assert.equal(disabledBandPost.kind, 'post_new');
    assert.equal(
        disabledBandPost.newPrice,
        980,
        'band max 0 means legacy/free pricing rather than an active range'
    );

    const missingBandMin = orderBook([]);
    missingBandMin.priceBandMaxs = [];
    missingBandMin.priceBandMaxs[20] = 1100;
    assert.equal(
        planMarketDecision({
            itemId: ITEM_ID,
            inventoryCount: 2,
            ownListings: [],
            orderBookSnapshot: missingBandMin,
            vendorPrice: 2,
            listingSlotAvailable: true,
        }).kind,
        'invalid_book',
        'a positive band max without a valid min fails closed'
    );

    const invalidBand = orderBook([], ITEM_ID, {
        min: 1100,
        max: 1000,
    });
    assert.equal(
        planMarketDecision({
            itemId: ITEM_ID,
            inventoryCount: 2,
            ownListings: [],
            orderBookSnapshot: invalidBand,
            vendorPrice: 2,
            listingSlotAvailable: true,
        }).kind,
        'invalid_book'
    );

    const payload = createPostPayload(ITEM_ID, 49, 1225);
    assert.equal(payload.postMarketOrderData.quantity, 49);
    assert.equal(payload.postMarketOrderData.price, 1225);
    assert.equal(typeof payload.postMarketOrderData.price, 'number');
    assert.equal(
        Object.hasOwn(payload.postMarketOrderData, 'confirmedMisprice'),
        false,
        'the current test-server sender no longer includes the legacy field'
    );
    assert.throws(
        () => createPostPayload(ITEM_ID, 1, 1234),
        /合法档位/,
        'an in-range but off-grid +20 price is rejected before a pending write is persisted'
    );
    assert.equal(
        createPostPayload(ITEM_ID, 1, 1_000_000_000_000)
            .postMarketOrderData.price,
        1_000_000_000_000
    );
    assert.throws(
        () => createPostPayload(ITEM_ID, 1, 1_000_000_000_001),
        /超出允许范围/
    );

    replaceClientData({
        ...clientData(),
        marketplaceLimits: {
            maxQuantity: 2,
            maxPrice: 1200,
            maxNotional: 2000,
        },
    });
    assert.equal(
        createPostPayload(ITEM_ID, 2, 1000).postMarketOrderData.price,
        1000
    );
    assert.throws(
        () => createPostPayload(ITEM_ID, 3, 500),
        /超出允许范围/
    );
    assert.throws(
        () => createPostPayload(ITEM_ID, 1, 1201),
        /超出允许范围/
    );
    assert.throws(
        () => createPostPayload(ITEM_ID, 2, 1100),
        /超出允许范围/
    );
    replaceClientData(clientData());
}

function runCowbellPureDecisionTests() {
    resetRuntime({
        enabled: false,
        watchlist: [],
        cowbellEnabled: true,
    });
    assert.equal(COWBELL_BAG_ITEM_ID, COWBELL_BAG_ID);
    assert.equal(COWBELL_LEVEL, 0);
    assert.equal(COIN_ITEM_ID, COIN_ID);

    const payload = createCowbellBuyPayload(1100);
    assert.deepEqual(
        JSON.parse(JSON.stringify(payload)),
        {
            type: 'post_market_order',
            postMarketOrderData: {
                isSell: false,
                itemHrid: COWBELL_BAG_HRID,
                enhancementLevel: 0,
                quantity: 1,
                price: 1100,
                isInstantOrder: false,
            },
        },
        'the anchor is one resting buy order for the tradable bag, not premium cowbells'
    );

    const ranged = analyzeCowbellBuyBook(cowbellBook({
        asks: [ask(1, 800), ask(2, 1100)],
        bids: [ask(3, 1090), ask(4, 1000)],
    }));
    assert.equal(ranged.valid, true);
    assert.equal(ranged.rawLeftOne.price, 800);
    assert.equal(ranged.leftOne.price, 1100);
    assert.equal(ranged.targetPrice, 1100);
    assert.equal(ranged.atCeiling, true);

    const baseArguments = {
        ownBuyListings: [],
        coinCount: 10_000,
        listingSlotAvailable: true,
    };
    for (const snapshot of [
        cowbellBook(),
        cowbellBook({asks: [ask(10, 800), ask(11, 950)]}),
        cowbellBook({asks: [ask(12, 800), ask(13, 1200)]}),
        cowbellBook({bids: [ask(14, 1100)]}),
    ]) {
        const decision = planCowbellBuyDecision({
            ...baseArguments,
            orderBookSnapshot: snapshot,
        });
        assert.equal(decision.kind, 'cowbell_post_buy');
        assert.equal(decision.quantity, 1);
        assert.equal(decision.price, 1100);
    }

    const offGridCeiling = planCowbellBuyDecision({
        ...baseArguments,
        orderBookSnapshot: cowbellBook({max: 1101}),
    });
    assert.equal(offGridCeiling.kind, 'cowbell_post_buy');
    assert.equal(offGridCeiling.targetPrice, 1101);
    assert.equal(
        offGridCeiling.price,
        1104,
        'an off-grid Max uses the next legal level-zero limit and pegs its working price back to Max'
    );
    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            coinCount: 1101,
            orderBookSnapshot: cowbellBook({max: 1101}),
        }).kind,
        'cowbell_insufficient_coins',
        'coin preflight covers the submitted legal limit, not only its pegged working price'
    );

    const atCeiling = planCowbellBuyDecision({
        ...baseArguments,
        orderBookSnapshot: cowbellBook({
            asks: [ask(20, 800), ask(21, 1100)],
        }),
    });
    assert.equal(atCeiling.kind, 'cowbell_at_ceiling');

    const correct = cowbellBuyListing({
        id: 30,
        price: 1200,
        workingPrice: 1100,
    });
    const stable = planCowbellBuyDecision({
        ...baseArguments,
        ownBuyListings: [correct],
        orderBookSnapshot: cowbellBook({
            bids: [ask(30, 1100)],
        }),
    });
    assert.equal(
        stable.kind,
        'cowbell_buy_stable',
        'a higher submitted limit pegged to the current Max is already a correct anchor'
    );

    const staleLimit = cowbellBuyListing({
        id: 31,
        price: 1000,
        workingPrice: 1000,
    });
    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            ownBuyListings: [staleLimit],
            orderBookSnapshot: cowbellBook({
                bids: [ask(31, 1000)],
            }),
        }).kind,
        'cowbell_replace_buy',
        'an effective bid below the current Max must be replaced'
    );

    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            ownBuyListings: [correct, cowbellBuyListing({
                id: 32,
                price: 1100,
            })],
            orderBookSnapshot: cowbellBook(),
        }).kind,
        'cowbell_replace_buy'
    );
    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            ownBuyListings: [cowbellBuyListing({
                id: 33,
                price: 1100,
                orderQuantity: 2,
            })],
            orderBookSnapshot: cowbellBook(),
        }).kind,
        'cowbell_replace_buy'
    );
    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            ownBuyListings: [correct],
            orderBookSnapshot: cowbellBook({asks: [ask(34, 1100)]}),
        }).kind,
        'cowbell_remove_at_ceiling'
    );
    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            listingSlotAvailable: false,
            orderBookSnapshot: cowbellBook(),
        }).kind,
        'cowbell_listing_cap'
    );
    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            coinCount: 1099,
            orderBookSnapshot: cowbellBook(),
        }).kind,
        'cowbell_insufficient_coins'
    );
    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            orderBookSnapshot: orderBook(
                [],
                COWBELL_BAG_ID,
                null,
                [],
                0
            ),
        }).kind,
        'cowbell_invalid_book'
    );
    assert.equal(
        planCowbellBuyDecision({
            ...baseArguments,
            orderBookSnapshot: orderBook(
                [],
                COWBELL_BAG_ID,
                {min: 900, max: 1100},
                [],
                20
            ),
        }).kind,
        'cowbell_invalid_book',
        'the +20 range must never be reused for an unenhanced cowbell bag'
    );

    replaceMyListings([
        correct,
        cowbellBuyListing({id: 40, itemId: ITEM_ID}),
        listing({id: 41, itemId: COWBELL_BAG_ID, enhancementLevel: 0}),
        cowbellBuyListing({id: 42, enhancementLevel: 1}),
        cowbellBuyListing({id: 43, status: FILLED}),
    ]);
    assert.deepEqual(
        Array.from(
            getOwnActiveBuyListings(COWBELL_BAG_ID, 0),
            (entry) => Number(entry.id)
        ),
        [30],
        'only active level-zero buy listings for the cowbell bag are adopted'
    );

    const expectedBuy = payload.postMarketOrderData;
    const activeBuyMatch = matchPostResult({
        baselineListings: [],
        currentListings: [[
            '50',
            cowbellBuyListing({id: 50, price: 1100}),
        ]],
        expectedPost: expectedBuy,
    });
    assert.equal(activeBuyMatch.status, 'confirmed');
    const filledBuyMatch = matchPostResult({
        baselineListings: [],
        currentListings: [[
            '51',
            cowbellBuyListing({
                id: 51,
                price: 1100,
                status: FILLED,
                filledQuantity: 1,
                unclaimedItemCount: 1,
                unclaimedCoinCount: 37,
            }),
        ]],
        expectedPost: expectedBuy,
    });
    assert.equal(
        filledBuyMatch.status,
        'confirmed',
        'an immediately filled buy may hold both the bag and price-improvement refund'
    );
    for (const malformed of [
        cowbellBuyListing({
            id: 53,
            price: 1100,
            status: FILLED,
            filledQuantity: 0,
            unclaimedItemCount: 1,
        }),
        cowbellBuyListing({
            id: 54,
            price: 1100,
            status: FILLED,
            filledQuantity: 1,
            unclaimedItemCount: 0,
        }),
        cowbellBuyListing({
            id: 55,
            price: 1100,
            status: ACTIVE,
            filledQuantity: 1,
            unclaimedItemCount: 1,
        }),
    ]) {
        const invalid = matchPostResult({
            baselineListings: [],
            currentListings: [[String(malformed.id), malformed]],
            expectedPost: expectedBuy,
        });
        assert.equal(
            invalid.status,
            'unknown',
            'a contradictory buy listing first-state must fail closed'
        );
    }
    const wrongSide = matchPostResult({
        baselineListings: [],
        currentListings: [[
            '52',
            listing({
                id: 52,
                itemId: COWBELL_BAG_ID,
                enhancementLevel: 0,
                price: 1100,
            }),
        ]],
        expectedPost: expectedBuy,
    });
    assert.equal(wrongSide.status, 'pending');
}

function runPanelCloseAndStackingTest() {
    const panelClassList = fakeClassList();
    const fabClassList = fakeClassList();
    const attributes = new Map();
    UI.refs = {
        panel: {classList: panelClassList},
        fab: {
            classList: fabClassList,
            setAttribute: (name, value) => attributes.set(name, value),
        },
    };
    UI.setOpen(true);
    assert.equal(panelClassList.contains('open'), true);
    assert.equal(fabClassList.contains('panel-open'), true);
    assert.equal(attributes.get('aria-expanded'), 'true');
    UI.setOpen(false);
    assert.equal(panelClassList.contains('open'), false);
    assert.equal(fabClassList.contains('panel-open'), false);
    assert.equal(attributes.get('aria-expanded'), 'false');

    const marketPanelZ = Number(
        source.match(/#panel\{[^}]*z-index:(\d+)/)?.[1]
    );
    const enhancerSource = fs.readFileSync(
        path.join(__dirname, 'mwi_safe_enhancer.user.js'),
        'utf8'
    );
    const enhancerZIndexes = [...enhancerSource.matchAll(
        /z-index:\s*(\d+)/g
    )].map((match) => Number(match[1]));
    assert.ok(Number.isSafeInteger(marketPanelZ));
    assert.ok(enhancerZIndexes.length > 0);
    assert.ok(
        marketPanelZ > Math.max(...enhancerZIndexes),
        'the market panel and close button must sit above the enhancer UI'
    );
}

function runPostMatchingTests() {
    const expectedPost = {
        isSell: true,
        itemHrid: ITEM_HRID,
        enhancementLevel: 20,
        quantity: 4,
        price: 980,
        isInstantOrder: false,
    };

    const newListing = listing({
        id: 301,
        price: 980,
        orderQuantity: 4,
    });
    const created = matchPostResult({
        baselineListings: [],
        currentListings: [['301', newListing]],
        expectedPost,
    });
    assert.equal(created.status, 'confirmed');
    assert.equal(String(created.listingId), '301');

    const baseline = listing({
        id: 305,
        price: 980,
        orderQuantity: 6,
        filledQuantity: 1,
    });
    const mergedListing = listing({
        id: 305,
        price: 980,
        orderQuantity: 10,
        filledQuantity: 1,
    });
    const merged = matchPostResult({
        baselineListings: [['305', baseline]],
        currentListings: [['305', mergedListing]],
        expectedPost,
    });
    assert.equal(merged.status, 'confirmed');
    assert.equal(String(merged.listingId), '305');

    const ambiguous = matchPostResult({
        baselineListings: [],
        currentListings: [
            ['401', listing({
                id: 401,
                price: 980,
                orderQuantity: 4,
            })],
            ['402', listing({
                id: 402,
                price: 980,
                orderQuantity: 4,
            })],
        ],
        expectedPost,
    });
    assert.equal(ambiguous.status, 'unknown');
    assert.match(ambiguous.reason, /多条精确候选/);

    const immediatelyFilled = matchPostResult({
        baselineListings: [],
        currentListings: [['501', listing({
            id: 501,
            price: 980,
            orderQuantity: 4,
            filledQuantity: 4,
            status: FILLED,
            unclaimedCoinCount: 123,
        })]],
        expectedPost,
    });
    assert.equal(immediatelyFilled.status, 'confirmed');
    assert.equal(immediatelyFilled.filled, true);
}

function runInitializationIsolationTest() {
    const socket = resetRuntime({enabled: false, watchlist: []});
    State.profileLoaded = false;
    State.inventoryReady = false;
    State.listingsReady = false;
    State.accessReady = false;
    replaceClientData(clientData());
    Network.handleIncoming({
        type: 'init_character_data',
        character: {id: 123, gameMode: 'standard'},
        characterInfo: {marketListingCap: 20},
        characterSetting: {hasAcceptedTradingRules: true},
        characterItemMarks: [],
        characterItems: [inventoryItem(1), equippedItem(1)],
        myMarketListings: [],
        // Deliberately no queue, loadout or mirror fields.
    });
    assert.equal(State.socket, socket);
    assert.equal(initializationIssue(), '');
    assert.equal(getEquippedItemCount(ITEM_ID), 1);
    assert.equal(Object.hasOwn(State, 'loadoutsReady'), false);
    assert.equal(Object.hasOwn(State, 'mirrorCount'), false);
    assert.equal(Object.hasOwn(State, 'enhancementRun'), false);
}

function runIncompleteInitializationDiagnosticTest() {
    resetRuntime({enabled: false, watchlist: []});
    State.logs.length = 0;
    Network.handleIncoming({
        type: 'init_character_data',
        character: {id: 123, gameMode: 'standard'},
        characterInfo: {marketListingCap: 20},
        characterSetting: {hasAcceptedTradingRules: true},
        characterItemMarks: [],
        characterItems: [inventoryItem(1)],
        // Deliberately missing myMarketListings.
    });
    assert.equal(State.inventoryReady, true);
    assert.equal(State.listingsReady, false);
    assert.match(initializationIssue(), /本人挂单全量未同步/);
    assert.equal(State.logs.at(-1)?.type, 'warn');
    assert.match(State.logs.at(-1)?.message || '', /本人挂单全量.*缺失/);
    assert.doesNotMatch(State.logs.at(-1)?.message || '', /市场全量已同步/);
}

function runItemMarkInitializationAndUpdateTest() {
    resetRuntime({enabled: false, watchlist: []});
    State.profileLoaded = false;
    completeCharacterInit({
        characterItemMarks: [itemMark()],
    });
    assert.equal(
        isItemMarketLocked(ITEM_ID, 20),
        true,
        'the complete character snapshot imports an exact +20 lock'
    );
    assert.equal(isItemMarketLocked(ITEM_ID, 19), false);

    Network.handleIncoming({
        type: 'item_marks_updated',
        characterItemMarks: [
            itemMark({kind: 'favorite'}),
            itemMark({
                minEnhancementLevel: 0,
                maxEnhancementLevel: 19,
            }),
        ],
    });
    assert.equal(
        isItemMarketLocked(ITEM_ID, 20),
        false,
        'item_marks_updated is a full replacement, not an additive delta'
    );

    Network.handleIncoming({
        type: 'item_marks_updated',
        characterItemMarks: [itemMark({
            minEnhancementLevel: 0,
            maxEnhancementLevel: 1000,
        })],
    });
    assert.equal(
        isItemMarketLocked(ITEM_ID, 20),
        true,
        'an all-level lock also protects the +20 item'
    );

    resetRuntime({enabled: false, watchlist: []});
    State.profileLoaded = false;
    completeCharacterInit({omitCharacterItemMarks: true});
    assert.equal(
        initializationIssue(),
        '',
        'the official client treats an omitted mark array as an empty authoritative snapshot'
    );
    assert.equal(State.itemMarksReady, true);
    assert.equal(isItemMarketLocked(ITEM_ID, 20), false);
}

function runSameVersionClientCacheTest() {
    const version = Date.parse('2026-08-03T12:00:00.000Z');
    const cached = {
        ...clientData(),
        versionTimestamp: new Date(version).toISOString(),
    };
    storage.set(
        'initClientData',
        compressLzStringUtf16(JSON.stringify(cached))
    );
    State.clientReady = false;
    State.itemRules.clear();
    State.gameModeRestrictions.clear();
    const matchingSocket = new FakeWebSocket(
        'wss://api-test.milkywayidle.com/ws?characterId=123'
            + `&versionTimestamp=${version}`
    );
    assert.equal(restoreClientDataFromCache(matchingSocket), true);
    assert.equal(State.clientReady, true);
    assert.equal(State.itemRules.get(ITEM_ID)?.isTradable, true);
    assert.equal(State.gameModeRestrictions.get('standard'), false);

    storage.set(
        'initClientData',
        compressLzStringUtf16(JSON.stringify({
            ...cached,
            versionTimestamp: String(version),
        }))
    );
    State.clientReady = false;
    State.itemRules.clear();
    State.gameModeRestrictions.clear();
    assert.equal(
        restoreClientDataFromCache(matchingSocket),
        true,
        'a numeric-string cache version must match the socket epoch'
    );

    State.clientReady = false;
    State.itemRules.clear();
    State.gameModeRestrictions.clear();
    const mismatchedSocket = new FakeWebSocket(
        'wss://api-test.milkywayidle.com/ws?characterId=123'
            + `&versionTimestamp=${version + 1}`
    );
    assert.equal(restoreClientDataFromCache(mismatchedSocket), false);
    assert.equal(
        State.clientReady,
        false,
        'a stale game cache must not unlock market writes'
    );
    replaceClientData(clientData());
    assert.equal(State.clientReady, true);
    Network.resetConnection('test version switch');
    assert.equal(State.clientReady, false);
    assert.equal(State.itemRules.size, 0);
    assert.equal(State.gameModeRestrictions.size, 0);
    storage.delete('initClientData');
}

async function runColdWatchlistFastScanTest() {
    const socket = resetRuntime({
        inventory: 1,
        listings: [],
        watchlist: [ITEM_ID, 'another_cold_watch'],
    });
    await MarketKeeper.tick();
    assert.equal(
        sentMessages(socket).length,
        0,
        'a reserved-only item must not request an unnecessary order book'
    );
    assert.equal(State.itemStatus.get(ITEM_ID)?.kind, 'reserve_only');
    assert.equal(scheduledTimers.size, 1);
    assert.equal(
        [...scheduledTimers.values()][0].delay,
        CONFIG.IDLE_SCAN_MS,
        'cold watchlist entries must be skipped quickly'
    );
    await MarketKeeper.tick();
    assert.equal(sentMessages(socket).length, 0);
    assert.equal(scheduledTimers.size, 1);
    assert.equal(
        [...scheduledTimers.values()][0].delay,
        CONFIG.POLL_MS,
        'a full cold-only pass must back off instead of busy-looping'
    );
}

async function runFirstQuoteAndReserveIntegrationTest() {
    const coldItemIds = Array.from(
        {length: 26},
        (_, index) => `cold_watch_${index}`
    );
    const socket = resetRuntime({
        inventory: 5,
        listings: [],
        watchlist: [...coldItemIds, ITEM_ID],
    });
    State.roundRobinIndex = coldItemIds.length;

    const tick = MarketKeeper.tick();
    await respondToOrderBook(socket, 0, [ask(201, 1000, 20)]);
    const post = await confirmPost({
        socket,
        sentIndex: 1,
        resultingListing: listing({
            id: 301,
            price: 980,
            orderQuantity: 4,
        }),
        // Two more +20 items finished while the market write was waiting.
        // The exact listing proves the post, and the higher inventory must
        // remain available for the next keeper cycle instead of pausing.
        resultingInventory: 3,
    });
    await tick;

    assert.equal(post.postMarketOrderData.quantity, 4);
    assert.equal(post.postMarketOrderData.price, 980);
    assert.equal(
        Object.hasOwn(post.postMarketOrderData, 'confirmedMisprice'),
        false
    );
    assert.equal(State.itemStatus.get(ITEM_ID)?.kind, 'listed');
    assert.equal(State.pendingWrite, null);
    assert.equal(State.inventory.get(ITEM_ID)?.[20], 3);
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        ['get_market_item_order_books', 'post_market_order'],
        'one current order book is enough to post immediately'
    );
}

async function runPriceBandMinIntegrationTest() {
    const priceBand = {min: 900, max: 1100, marketValue: 1000};
    const outsideBandAsks = [
        ask(811, 800, 20),
        ask(812, 1200, 20),
    ];
    const socket = resetRuntime({inventory: 2, listings: []});

    const tick = MarketKeeper.tick();
    await respondToOrderBook(
        socket,
        0,
        outsideBandAsks,
        priceBand
    );
    const post = await confirmPost({
        socket,
        sentIndex: 1,
        resultingListing: listing({
            id: 813,
            price: 900,
            workingPrice: 900,
            orderQuantity: 1,
        }),
        resultingInventory: 1,
    });
    await tick;

    assert.equal(post.postMarketOrderData.price, 900);
    assert.equal(typeof post.postMarketOrderData.price, 'number');
    assert.equal(post.postMarketOrderData.quantity, 1);
    assert.equal(
        Object.hasOwn(post.postMarketOrderData, 'confirmedMisprice'),
        false
    );
}

async function runInBandLeftOneIntegrationTest() {
    const priceBand = {min: 900, max: 1100, marketValue: 1000};
    const asks = [
        ask(821, 800, 20),
        ask(822, 950, 20),
        ask(823, 1200, 20),
    ];
    const socket = resetRuntime({inventory: 2, listings: []});

    const tick = MarketKeeper.tick();
    await respondToOrderBook(socket, 0, asks, priceBand);
    const post = await confirmPost({
        socket,
        sentIndex: 1,
        resultingListing: listing({
            id: 824,
            price: 940,
            workingPrice: 940,
            orderQuantity: 1,
        }),
        resultingInventory: 1,
    });
    await tick;

    assert.equal(post.postMarketOrderData.price, 940);
    assert.equal(post.postMarketOrderData.quantity, 1);
}

async function runOwnListingsConsolidationNoLoopTest() {
    const firstOwn = listing({
        id: 101,
        price: 1000,
        orderQuantity: 3,
        filledQuantity: 1,
    });
    const secondOwn = listing({
        id: 102,
        price: 1000,
        orderQuantity: 2,
        filledQuantity: 1,
    });
    const socket = resetRuntime({
        inventory: 2,
        listings: [firstOwn, secondOwn],
    });
    const consolidationBand = {
        min: 900,
        max: 1100,
        marketValue: 1000,
    };

    const tick = MarketKeeper.tick();
    await respondToOrderBook(socket, 0, [
        ask(900, 1000, 20),
        ask(101, 1000, 2),
        ask(102, 1000, 1),
    ], consolidationBand);

    const cancelledFirst = listing({
        id: 101,
        price: 1000,
        orderQuantity: 3,
        filledQuantity: 1,
        status: '/market_listing_status/cancelled',
        unclaimedItemCount: 2,
    });
    await flushUntil(
        () => sentMessages(socket).length > 1,
        'first consolidation cancel'
    );
    assert.equal(sentMessages(socket)[1].type, 'cancel_market_listing');
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [cancelledFirst],
    });
    await flushUntil(
        () => sentMessages(socket).length > 2,
        'first consolidation claim'
    );
    assert.equal(sentMessages(socket)[2].type, 'claim_market_listing');
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...cancelledFirst,
            unclaimedItemCount: 0,
        }],
    });
    Network.handleIncoming({
        type: 'items_updated',
        // Two reclaimed items plus one newly enhanced +20 arrived.
        updatedCharacterItems: [inventoryItem(5)],
    });

    const cancelledSecond = listing({
        id: 102,
        price: 1000,
        orderQuantity: 2,
        filledQuantity: 1,
        status: '/market_listing_status/cancelled',
        unclaimedItemCount: 1,
    });
    await flushUntil(
        () => sentMessages(socket).length > 3,
        'second consolidation cancel'
    );
    assert.equal(sentMessages(socket)[3].type, 'cancel_market_listing');
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [cancelledSecond],
    });
    await flushUntil(
        () => sentMessages(socket).length > 4,
        'second consolidation claim'
    );
    assert.equal(sentMessages(socket)[4].type, 'claim_market_listing');
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...cancelledSecond,
            unclaimedItemCount: 0,
        }],
    });
    Network.handleIncoming({
        type: 'items_updated',
        // 2 initial + 2 reclaimed + 1 reclaimed + 1 new output = 6.
        updatedCharacterItems: [inventoryItem(6)],
    });

    const post = await confirmPost({
        socket,
        sentIndex: 5,
        resultingListing: listing({
            id: 301,
            price: 1000,
            orderQuantity: 5,
        }),
        resultingInventory: 1,
    });
    await tick;

    assert.equal(post.postMarketOrderData.price, 1000);
    assert.equal(post.postMarketOrderData.quantity, 5);
    assert.equal(
        2 + (3 - 1) + (2 - 1) + 1,
        1 + post.postMarketOrderData.quantity,
        'partial fills, reclaimed stock and new output conserve one reserve plus one combined listing'
    );
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        [
            'get_market_item_order_books',
            'cancel_market_listing',
            'claim_market_listing',
            'cancel_market_listing',
            'claim_market_listing',
            'post_market_order',
        ],
        'all own listings are withdrawn and claimed before one combined post'
    );

    for (let pass = 0; pass < 2; pass++) {
        now += CONFIG.MIN_REQUEST_GAP_MS + 1;
        const stableTick = MarketKeeper.tick();
        await respondToOrderBook(socket, 6 + pass, [
            ask(900, 1000, 20),
            ask(301, 1000, 5),
        ], consolidationBand);
        await stableTick;
        assert.equal(
            State.itemStatus.get(ITEM_ID)?.kind,
            'already_lowest'
        );
        assert.equal(State.pausedItems.has(ITEM_ID), false);
        assert.equal(State.pendingWrite, null);
    }
    const messagesAfterStablePolls = sentMessages(socket);
    assert.equal(
        messagesAfterStablePolls.filter((message) => (
            message.type === 'cancel_market_listing'
        )).length,
        2
    );
    assert.equal(
        messagesAfterStablePolls.filter((message) => (
            message.type === 'claim_market_listing'
        )).length,
        2
    );
    assert.equal(
        messagesAfterStablePolls.filter((message) => (
            message.type === 'post_market_order'
        )).length,
        1,
        'the combined listing remains stable instead of entering a reprice loop'
    );
    assert.equal(
        [...State.myListings.values()].filter((entry) => (
            entry.status === ACTIVE &&
            entry.itemHrid === ITEM_HRID
        )).length,
        1
    );
}

async function runLegacyOffGridReserveReclaimIntegrationTest() {
    const oldListing = listing({
        id: 611,
        price: 998,
        orderQuantity: 2,
    });
    const socket = resetRuntime({
        inventory: 0,
        listings: [oldListing],
    });

    const tick = MarketKeeper.tick();
    await respondToOrderBook(socket, 0, [ask(611, 998, 2)]);
    await flushUntil(
        () => sentMessages(socket).length > 1,
        'legacy off-grid reserve cancel'
    );
    assert.equal(sentMessages(socket)[1].type, 'cancel_market_listing');

    const cancelled = listing({
        id: 611,
        price: 998,
        orderQuantity: 2,
        status: '/market_listing_status/cancelled',
        unclaimedItemCount: 2,
    });
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [cancelled],
    });
    await flushUntil(
        () => sentMessages(socket).length > 2,
        'legacy off-grid reserve claim'
    );
    assert.equal(sentMessages(socket)[2].type, 'claim_market_listing');

    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...cancelled,
            unclaimedItemCount: 0,
        }],
    });
    Network.handleIncoming({
        type: 'items_updated',
        endCharacterItems: [inventoryItem(2)],
    });

    const post = await confirmPost({
        socket,
        sentIndex: 3,
        resultingListing: listing({
            id: 612,
            price: 1000,
            orderQuantity: 1,
        }),
        resultingInventory: 1,
    });
    await tick;

    assert.equal(post.postMarketOrderData.price, 1000);
    assert.equal(post.postMarketOrderData.quantity, 1);
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        [
            'get_market_item_order_books',
            'cancel_market_listing',
            'claim_market_listing',
            'post_market_order',
        ],
        'the legacy order is reclaimed and reposted once at a new legal bin without an unknown-write loop'
    );
}

async function runEquippedReserveDoesNotChurnListingTest() {
    const own = listing({
        id: 701,
        price: 1000,
        orderQuantity: 1,
    });
    const socket = resetRuntime({
        inventory: 1,
        equipped: 0,
        listings: [own],
    });
    const locationStates = [
        {inventory: 0, equipped: 1},
        {inventory: 1, equipped: 0},
        {inventory: 0, equipped: 1},
        {inventory: 1, equipped: 0},
    ];

    for (let index = 0; index < locationStates.length; index++) {
        const state = locationStates[index];
        Network.handleIncoming({
            type: 'items_updated',
            endCharacterItems: [
                inventoryItem(state.inventory),
                equippedItem(state.equipped),
            ],
        });
        assert.equal(getEquippedItemCount(ITEM_ID), state.equipped);
        now += CONFIG.MIN_REQUEST_GAP_MS + 1;
        const tick = MarketKeeper.tick();
        await respondToOrderBook(socket, index, [
            ask(701, 1000, 1),
        ]);
        await tick;
        assert.equal(
            State.itemStatus.get(ITEM_ID)?.kind,
            'already_lowest'
        );
        assert.equal(State.pausedItems.has(ITEM_ID), false);
        assert.equal(State.pendingWrite, null);
    }

    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        new Array(locationStates.length).fill(
            'get_market_item_order_books'
        ),
        'moving the reserved +20 between inventory and equipment never cancels or reposts the stable listing'
    );
    assert.equal(
        [...State.myListings.values()].filter((entry) => (
            entry.status === ACTIVE && entry.itemHrid === ITEM_HRID
        )).length,
        1
    );
}

function runEquippedLevelAndRemovalTest() {
    resetRuntime({inventory: 0, listings: []});
    replaceInventory([
        inventoryItem(0),
        equippedItem(1, ITEM_ID, 19),
    ]);
    assert.equal(getEquippedItemCount(ITEM_ID), 0);
    assert.equal(
        getInventoryReserveNeeded(ITEM_ID),
        1,
        'an equipped +19 cannot satisfy the +20 reserve'
    );

    updateCharacterItemSlot(equippedItem(1));
    assert.equal(getEquippedItemCount(ITEM_ID), 1);
    updateCharacterItemSlot(equippedItem(0));
    assert.equal(
        getEquippedItemCount(ITEM_ID),
        0,
        'a zero-count equipment delta removes the equipped reserve'
    );
}

async function runBeltEquippedReserveTest() {
    const belts = ['small_talisman_belt', 'medium_talisman_belt', 'large_talisman_belt'];
    for (const itemId of belts) {
        const socket = resetRuntime({inventory: 0, watchlist: [itemId]});
        const data = clientData();
        data.itemDetailMap[`/items/${itemId}`] = {
            isTradable: true, sellPrice: 2, name: itemId.replaceAll('_', ' '),
        };
        replaceClientData(data);
        replaceInventory([
            inventoryItem(2, itemId),
            equippedItem(1, itemId, 20, '/item_locations/belt'),
        ]);
        assert.equal(State.candidateItemIds.has(itemId), true);
        assert.equal(getEquippedItemCount(itemId), 1);
        assert.equal(getInventoryReserveNeeded(itemId), 0);

        const tick = MarketKeeper.tick();
        await respondToOrderBook(socket, 0, [ask(902, 1000)], null, {itemId});
        const ownListing = listing({id: 903, itemId, price: 980, orderQuantity: 2});
        const post = await confirmPost({socket, sentIndex: 1, itemId,
            resultingListing: ownListing, resultingInventory: 0});
        await tick;
        assert.equal(post.postMarketOrderData.itemHrid, `/items/${itemId}`);
        assert.equal(post.postMarketOrderData.quantity, 2,
            'the worn +20 belt preserves the reserve while both inventory copies can be listed');
        assert.equal(getEquippedItemCount(itemId), 1);
        assert.equal(State.pendingWrite, null);
        const stable = planMarketDecision({itemId, inventoryCount: 0,
            equippedCount: getEquippedItemCount(itemId), ownListings: [ownListing],
            orderBookSnapshot: orderBook([ask(903, 980, 2)], itemId),
            vendorPrice: 2, listingSlotAvailable: true});
        assert.equal(stable.kind, 'already_lowest', 'the worn belt does not trigger reclaiming a listed copy');

        updateCharacterItemSlot(equippedItem(0, itemId, 20, '/item_locations/belt'));
        updateCharacterItemSlot(equippedItem(1, itemId, 19, '/item_locations/belt'));
        assert.equal(getEquippedItemCount(itemId), 0);
        assert.equal(getInventoryReserveNeeded(itemId), 1, 'a +19 belt cannot replace the +20 reserve');
    }
}

async function runRepriceCancelClaimPostIntegrationTest() {
    const own = listing({
        id: 101,
        price: 1000,
        orderQuantity: 10,
    });
    const socket = resetRuntime({inventory: 1, listings: [own]});
    const tick = MarketKeeper.tick();

    await respondToOrderBook(socket, 0, [
        ask(201, 850, 20),
        ask(101, 1000, 10),
    ]);
    await flushUntil(
        () => sentMessages(socket).length > 1,
        'cancel request'
    );
    assert.equal(sentMessages(socket)[1].type, 'cancel_market_listing');
    const cancelled = listing({
        id: 101,
        price: 1000,
        orderQuantity: 10,
        status: '/market_listing_status/cancelled',
        unclaimedItemCount: 10,
    });
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [cancelled],
    });

    await flushUntil(
        () => sentMessages(socket).length > 2,
        'claim request'
    );
    assert.equal(sentMessages(socket)[2].type, 'claim_market_listing');
    const claimed = {
        ...cancelled,
        unclaimedItemCount: 0,
        unclaimedCoinCount: 0,
    };
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [claimed],
    });
    Network.handleIncoming({
        type: 'items_updated',
        // Two freshly enhanced +20s landed while the ten cancelled items
        // were claimed. The claim must still confirm deterministically.
        updatedCharacterItems: [inventoryItem(13)],
    });

    await respondToOrderBook(socket, 3, [ask(201, 950, 20)]);
    const post = await confirmPost({
        socket,
        sentIndex: 4,
        resultingListing: listing({
            id: 301,
            price: 940,
            orderQuantity: 12,
        }),
        resultingInventory: 1,
    });
    await tick;

    assert.equal(post.postMarketOrderData.price, 940);
    assert.equal(post.postMarketOrderData.quantity, 12);
    assert.equal(
        State.itemStatus.get(ITEM_ID)?.ownPrice,
        940,
        'reposting uses the latest fresh left-one even when it moved up after cancellation'
    );
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        [
            'get_market_item_order_books',
            'cancel_market_listing',
            'claim_market_listing',
            'get_market_item_order_books',
            'post_market_order',
        ]
    );
    assert.equal(State.pendingWrite, null);
    assert.equal(State.itemStatus.get(ITEM_ID)?.kind, 'listed');
}

async function runConcurrentTickTest() {
    const socket = resetRuntime({inventory: 2, listings: []});
    const first = MarketKeeper.tick();
    const second = MarketKeeper.tick();

    await flushUntil(
        () => sentMessages(socket).length === 1,
        'one serialized order-book request'
    );
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        ['get_market_item_order_books'],
        'two concurrent ticks must not duplicate the order-book request'
    );
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: orderBook([ask(701, 1000)]),
    });
    await confirmPost({
        socket,
        sentIndex: 1,
        resultingListing: listing({
            id: 702,
            price: 980,
            orderQuantity: 1,
        }),
        resultingInventory: 1,
    });
    await Promise.all([first, second]);
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        ['get_market_item_order_books', 'post_market_order'],
        'two concurrent ticks produce one read and one post, never duplicates'
    );
}

async function runSpamBackoffTest() {
    const socket = resetRuntime({inventory: 2, listings: []});
    const startedAt = now;
    const outcomePromise = MarketTransactions.begin({
        kind: 'order_book',
        itemId: ITEM_ID,
        timeoutMs: CONFIG.READ_TIMEOUT_MS,
        timeoutMessage: 'spam test timeout',
        payload: {
            type: 'get_market_item_order_books',
            getMarketItemOrderBooksData: {itemHrid: ITEM_HRID},
        },
    });
    MarketTransactions.handleIncoming({
        type: 'error',
        message: 'errorNotification.requestSpamProtection',
    });
    assert.ok(
        State.op,
        'an error without request id must not settle the market request '
            + 'before an exact result or timeout'
    );
    assert.equal(
        sentMessages(socket).length,
        1,
        'an unattributed spam error must never trigger an immediate resend'
    );
    const timeout = scheduledTimers.get(State.op.timer);
    assert.ok(timeout, 'the original bounded observation timer must remain');
    timeout.callback();
    const outcome = await outcomePromise;
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason, /requestSpamProtection/);
    assert.equal(
        State.backoffUntil,
        startedAt + CONFIG.SPAM_BACKOFF_MS
    );

    scheduledTimers.clear();
    State.timer = null;
    MarketKeeper.schedule(0);
    assert.equal(scheduledTimers.size, 1);
    const [{delay}] = scheduledTimers.values();
    assert.equal(delay, CONFIG.SPAM_BACKOFF_MS);
    assert.equal(
        sentMessages(socket).length,
        1,
        'spam protection must schedule a backoff without resending'
    );
}

async function runPendingWriteBarrierAndRecoveryTest() {
    const socket = resetRuntime({inventory: 2, listings: []});
    State.pendingWrite = {
        kind: 'post',
        itemId: ITEM_ID,
        characterId: State.characterId,
    };
    State.pausedItems.set(ITEM_ID, '等待完整快照');

    await MarketKeeper.tick();
    assert.equal(
        sentMessages(socket).length,
        0,
        'one unknown market write globally blocks later market writes from overwriting its recovery record'
    );

    State.inventoryReady = false;
    reconcilePersistedPendingWrite();
    assert.ok(
        State.pendingWrite,
        'an incomplete inventory snapshot cannot release a pending write'
    );

    State.inventoryReady = true;
    State.listingsReady = true;
    reconcilePersistedPendingWrite();
    assert.equal(State.pendingWrite, null);
    assert.equal(State.pausedItems.has(ITEM_ID), false);
}

function runPendingWriteStatusTextTest() {
    resetRuntime({enabled: false, watchlist: []});
    State.pendingWrite = {
        kind: 'post',
        itemId: ITEM_ID,
        characterId: State.characterId,
    };
    State.inventoryReady = false;
    assert.match(pendingWriteStatusText(), /完整库存/);
    State.inventoryReady = true;
    State.listingsReady = false;
    assert.match(pendingWriteStatusText(), /本人挂单/);
    State.listingsReady = true;
    assert.match(pendingWriteStatusText(), /完整刷新接管/);
    State.pendingWrite = null;
    assert.equal(pendingWriteStatusText(), '');
}

async function runCurrentSessionPendingSnapshotSafetyTest() {
    resetRuntime({inventory: 2, listings: [], enabled: false});
    const outcomePromise = MarketTransactions.begin({
        kind: 'cancel',
        itemId: ITEM_ID,
        listingId: '777',
        timeoutMs: CONFIG.WRITE_TIMEOUT_MS,
        payload: {
            type: 'cancel_market_listing',
            cancelMarketListingData: {marketListingId: 777},
        },
    });
    const currentSessionId = State.pendingWrite?.pageSessionId;
    assert.ok(currentSessionId, 'new unknown writes carry a page-session nonce');

    completeCharacterInit();
    const outcome = await outcomePromise;
    assert.equal(outcome.status, 'unknown');
    assert.equal(
        State.pendingWrite?.pageSessionId,
        currentSessionId,
        'a resync in the same page cannot clear an in-flight write whose late server commit may follow the snapshot'
    );
}

function storedProfileWithPending(pendingWrite) {
    return JSON.stringify({
        'test.milkywayidle.com:123': {
            enabled: false,
            cowbellEnabled: false,
            watchlist: [ITEM_ID],
            pausedItems: {[ITEM_ID]: '等待完整快照'},
            pendingWrite,
            backoffUntil: 0,
        },
    });
}

function completeCharacterInit({
    characterItems = [inventoryItem(2)],
    myMarketListings = [],
    characterItemMarks = [],
    omitCharacterItems = false,
    omitMyMarketListings = false,
    omitCharacterItemMarks = false,
} = {}) {
    const message = {
        type: 'init_character_data',
        character: {id: 123, gameMode: 'standard'},
        characterInfo: {marketListingCap: 20},
        characterSetting: {hasAcceptedTradingRules: true},
    };
    if (!omitCharacterItems) {
        message.characterItems = characterItems;
    }
    if (!omitMyMarketListings) {
        message.myMarketListings = myMarketListings;
    }
    if (!omitCharacterItemMarks) {
        message.characterItemMarks = characterItemMarks;
    }
    Network.handleIncoming(message);
}

function runPersistedPendingMigrationRecoveryTests() {
    resetRuntime({enabled: false, watchlist: []});
    storage.set(
        'MWI_MARKET_KEEPER_V1',
        storedProfileWithPending({
            kind: 'post',
            itemId: ITEM_ID,
            // Legacy builds could serialize the id as a JSON number.
            characterId: 123,
        })
    );
    State.profileLoaded = false;
    completeCharacterInit();
    assert.equal(
        State.pendingWrite,
        null,
        'a numeric legacy character id is normalized before snapshot takeover'
    );
    assert.equal(State.pausedItems.has(ITEM_ID), false);
    assert.equal(
        JSON.parse(storage.get('MWI_MARKET_KEEPER_V1'))
            ['test.milkywayidle.com:123'].pendingWrite,
        null,
        'successful takeover removes the persisted barrier as well as the in-memory copy'
    );

    for (const [label, pendingWrite] of [
        ['primitive legacy record', 'legacy-pending-write'],
        ['missing target item', {
            kind: 'post',
            characterId: '123',
        }],
        ['foreign character record', {
            kind: 'claim',
            itemId: ITEM_ID,
            characterId: '999',
        }],
    ]) {
        resetRuntime({enabled: false, watchlist: []});
        storage.set(
            'MWI_MARKET_KEEPER_V1',
            storedProfileWithPending(pendingWrite)
        );
        State.profileLoaded = false;
        completeCharacterInit();
        assert.equal(
            State.pendingWrite,
            null,
            `${label} must be quarantined after a complete current-character snapshot instead of globally blocking every refresh`
        );
        assert.equal(
            sentMessages(State.socket).length,
            0,
            `${label} recovery must never replay an old market request`
        );
    }

    for (const [label, missingFields] of [
        ['inventory', {omitCharacterItems: true}],
        ['own listings', {omitMyMarketListings: true}],
    ]) {
        resetRuntime({enabled: false, watchlist: []});
        storage.set(
            'MWI_MARKET_KEEPER_V1',
            storedProfileWithPending({
                kind: 'post',
                itemId: ITEM_ID,
                characterId: '123',
            })
        );
        State.profileLoaded = false;
        completeCharacterInit(missingFields);
        assert.ok(
            State.pendingWrite,
            `a snapshot missing ${label} must retain the unknown-write barrier`
        );
        assert.equal(sentMessages(State.socket).length, 0);

        completeCharacterInit();
        assert.equal(
            State.pendingWrite,
            null,
            `the next complete snapshot takes over after ${label} arrives`
        );
    }
}

async function runPendingPostSnapshotConvergenceTest() {
    {
        const recoveredListing = listing({
            id: 541,
            price: 1000,
            orderQuantity: 1,
        });
        const socket = resetRuntime({inventory: 2, listings: []});
        State.pendingWrite = {
            kind: 'post',
            itemId: ITEM_ID,
            characterId: State.characterId,
        };
        State.pausedItems.set(ITEM_ID, '旧挂单结果未知');
        Network.handleIncoming({
            type: 'init_character_data',
            character: {id: 123, gameMode: 'standard'},
            characterInfo: {marketListingCap: 20},
            characterSetting: {hasAcceptedTradingRules: true},
            characterItemMarks: [],
            characterItems: [inventoryItem(1)],
            myMarketListings: [recoveredListing],
        });
        assert.equal(State.pendingWrite, null);
        assert.equal(State.pausedItems.has(ITEM_ID), false);

        const tick = MarketKeeper.tick();
        await respondToOrderBook(socket, 0, [ask(541, 1000)]);
        await tick;
        assert.equal(State.itemStatus.get(ITEM_ID)?.kind, 'already_lowest');
        assert.equal(
            sentMessages(socket).filter((message) => (
                message.type === 'post_market_order'
            )).length,
            0,
            'a recovered post visible in the full snapshot is never posted again'
        );
    }

    {
        const socket = resetRuntime({inventory: 2, listings: []});
        State.pendingWrite = {
            kind: 'post',
            itemId: ITEM_ID,
            characterId: State.characterId,
        };
        State.pausedItems.set(ITEM_ID, '旧挂单结果未知');
        Network.handleIncoming({
            type: 'init_character_data',
            character: {id: 123, gameMode: 'standard'},
            characterInfo: {marketListingCap: 20},
            characterSetting: {hasAcceptedTradingRules: true},
            characterItemMarks: [],
            characterItems: [inventoryItem(2)],
            myMarketListings: [],
        });
        assert.equal(State.pendingWrite, null);

        const tick = MarketKeeper.tick();
        await respondToOrderBook(socket, 0, [ask(542, 1000)]);
        await confirmPost({
            socket,
            sentIndex: 1,
            resultingListing: listing({
                id: 543,
                price: 980,
                orderQuantity: 1,
            }),
            resultingInventory: 1,
        });
        await tick;
        assert.equal(
            sentMessages(socket).filter((message) => (
                message.type === 'post_market_order'
            )).length,
            1,
            'a failed recovered post is replanned from full state and sent once'
        );
    }
}

async function runSendBoundaryInventoryPreflightTest() {
    const socket = resetRuntime({inventory: 2, listings: []});
    State.lastRequestAt = now;
    const posting = postInventory(ITEM_ID, 1, 1000);
    await flushUntil(() => scheduledTimers.size > 0, 'post request gap');
    updateInventoryItem(inventoryItem(1));
    await releaseTimerWithDelay(
        CONFIG.MIN_REQUEST_GAP_MS,
        'request-gap timer before post'
    );

    await assert.rejects(
        posting,
        /发送前仓库或当前装备已变化/
    );
    assert.equal(sentMessages(socket).length, 0);
    assert.equal(State.pendingWrite, null);
}

async function runItemMarkPostPreflightTest() {
    {
        const socket = resetRuntime({inventory: 2, listings: []});
        replaceItemMarks([itemMark()]);
        await assert.rejects(
            postInventory(ITEM_ID, 1, 1000),
            /锁定/,
            'a known +20 lock blocks a direct sell before persistence or send'
        );
        assert.equal(sentMessages(socket).length, 0);
        assert.equal(State.pendingWrite, null);
    }

    {
        const socket = resetRuntime({inventory: 2, listings: []});
        State.lastRequestAt = now;
        const posting = postInventory(ITEM_ID, 1, 1000);
        await flushUntil(
            () => scheduledTimers.size > 0,
            'request gap before item-lock preflight'
        );
        Network.handleIncoming({
            type: 'item_marks_updated',
            characterItemMarks: [itemMark()],
        });
        await releaseTimerWithDelay(
            CONFIG.MIN_REQUEST_GAP_MS,
            'request-gap timer before locked post'
        );
        await assert.rejects(
            posting,
            /锁定/,
            'a lock added while waiting for the shared send lane is rechecked at the send boundary'
        );
        assert.equal(sentMessages(socket).length, 0);
        assert.equal(State.pendingWrite, null);
    }
}

async function runLockedItemStillClaimsTerminalAssetsTest() {
    const terminal = listing({
        id: 618,
        price: 1000,
        orderQuantity: 1,
        filledQuantity: 1,
        status: FILLED,
        unclaimedCoinCount: 1000,
    });
    const socket = resetRuntime({
        inventory: 1,
        listings: [terminal],
    });
    replaceItemMarks([itemMark()]);

    const tick = MarketKeeper.tick();
    await flushUntil(
        () => sentMessages(socket).length === 1,
        'claim for a settled locked-item listing'
    );
    assert.equal(sentMessages(socket)[0].type, 'claim_market_listing');
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...terminal,
            unclaimedCoinCount: 0,
        }],
    });
    await tick;

    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        ['claim_market_listing'],
        'locking blocks new reads/posts/reprices but does not strand already-settled assets'
    );
    assert.equal(State.itemStatus.get(ITEM_ID)?.kind, 'locked');
}

async function runPostEquipSwitchDuringRequestGapTest() {
    const socket = resetRuntime({
        inventory: 2,
        equipped: 0,
        listings: [],
    });
    State.lastRequestAt = now;
    const posting = postInventory(ITEM_ID, 1, 1000);

    Network.handleIncoming({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem(1),
            equippedItem(1),
        ],
    });
    await releaseTimerWithDelay(
        CONFIG.MIN_REQUEST_GAP_MS,
        'request-gap timer before equipment-aware post'
    );
    await flushUntil(
        () => sentMessages(socket).length === 1,
        'post send after equipment switch'
    );
    assert.equal(State.op?.baselineInventory, 1);
    assert.equal(State.op?.expectedInventory, 0);
    assert.equal(State.op?.baselineHeldCount, 2);
    assert.equal(State.op?.expectedHeldCount, 1);

    const post = await confirmPost({
        socket,
        sentIndex: 0,
        resultingListing: listing({
            id: 552,
            price: 1000,
            orderQuantity: 1,
        }),
        resultingInventory: 0,
    });
    await posting;
    assert.equal(post.postMarketOrderData.quantity, 1);
    assert.equal(getEquippedItemCount(ITEM_ID), 1);
    assert.equal(State.pendingWrite, null);

    const inFlightSocket = resetRuntime({
        inventory: 2,
        equipped: 0,
        listings: [],
    });
    const inFlightPosting = postInventory(ITEM_ID, 1, 1000);
    await flushUntil(
        () => sentMessages(inFlightSocket).length === 1,
        'post send before in-flight equipment switch'
    );
    assert.equal(State.op?.expectedInventory, 1);
    assert.equal(State.op?.expectedHeldCount, 1);
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [listing({
            id: 553,
            price: 1000,
            orderQuantity: 1,
        })],
    });
    Network.handleIncoming({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem(0),
            equippedItem(1),
        ],
    });
    await inFlightPosting;
    assert.equal(
        State.inventory.get(ITEM_ID)?.[20],
        0,
        'inventory alone is below the old expected value after equipping'
    );
    assert.equal(getEquippedItemCount(ITEM_ID), 1);
    assert.equal(State.pendingWrite, null);
}

async function runRawOwnListingFailClosedTest() {
    const staleActive = listing({
        id: 551,
        price: 1000,
        orderQuantity: 1,
        filledQuantity: 1,
        status: ACTIVE,
    });
    const socket = resetRuntime({
        inventory: 2,
        listings: [staleActive],
    });
    await assert.rejects(
        postInventory(ITEM_ID, 1, 1000),
        /仍有本人卖单或待领取/
    );
    assert.equal(
        sentMessages(socket).length,
        0,
        'an active raw own record blocks a new order even when its remaining quantity is zero'
    );
}

async function runSendBoundaryEpochAndLimitPreflightTest() {
    {
        const socket = resetRuntime({inventory: 2, listings: []});
        State.lastRequestAt = now;
        const posting = postInventory(ITEM_ID, 1, 1000);
        State.syncEpoch++;
        await releaseTimerWithDelay(
            CONFIG.MIN_REQUEST_GAP_MS,
            'request-gap timer before changed sync epoch'
        );
        await assert.rejects(posting, /全量状态已经变化/);
        assert.equal(sentMessages(socket).length, 0);
        assert.equal(State.pendingWrite, null);
    }

    {
        const socket = resetRuntime({inventory: 2, listings: []});
        State.lastRequestAt = now;
        const posting = postInventory(ITEM_ID, 1, 1000);
        replaceClientData({
            ...clientData(),
            marketplaceLimits: {
                maxQuantity: 2,
                maxPrice: 900,
                maxNotional: 1800,
            },
        });
        await releaseTimerWithDelay(
            CONFIG.MIN_REQUEST_GAP_MS,
            'request-gap timer before tightened market limits'
        );
        await assert.rejects(posting, /超出允许范围/);
        assert.equal(sentMessages(socket).length, 0);
        assert.equal(State.pendingWrite, null);
    }
}

async function runClaimSendBoundaryInventoryRebaseTest() {
    const terminal = listing({
        id: 601,
        price: 1000,
        orderQuantity: 2,
        status: '/market_listing_status/cancelled',
        unclaimedItemCount: 2,
    });
    const socket = resetRuntime({inventory: 10, listings: [terminal]});
    State.lastRequestAt = now;
    const claiming = claimListing(ITEM_ID, terminal);

    updateInventoryItem(inventoryItem(9));
    await releaseTimerWithDelay(
        CONFIG.MIN_REQUEST_GAP_MS,
        'request-gap timer before claim'
    );
    await flushUntil(
        () => sentMessages(socket).length === 1,
        'claim send after inventory rebasing'
    );
    assert.equal(sentMessages(socket)[0].type, 'claim_market_listing');
    assert.equal(State.op?.baselineInventory, 9);
    assert.equal(State.op?.expectedInventory, 11);
    assert.equal(State.op?.baselineHeldCount, 9);
    assert.equal(State.op?.expectedHeldCount, 11);

    Network.handleIncoming({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem(8),
            equippedItem(1),
        ],
    });

    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...terminal,
            unclaimedItemCount: 0,
        }],
    });
    Network.handleIncoming({
        type: 'items_updated',
        updatedCharacterItems: [inventoryItem(10)],
    });
    await claiming;
    assert.equal(getEquippedItemCount(ITEM_ID), 1);
    assert.equal(State.inventory.get(ITEM_ID)?.[20], 10);
    assert.equal(State.pendingWrite, null);
    assert.equal(State.pausedItems.has(ITEM_ID), false);
}

async function runCowbellFilledBuyPostReceiptTest() {
    const socket = resetRuntime({
        watchlist: [],
        cowbellEnabled: true,
        coinInventory: 10_000,
    });
    const posting = postCowbellBuy(1100);
    await flushUntil(
        () => sentMessages(socket).length === 1,
        'cowbell buy post'
    );
    const outbound = sentMessages(socket)[0];
    assert.equal(outbound.type, 'post_market_order');
    assert.deepEqual(
        JSON.parse(JSON.stringify(outbound.postMarketOrderData)),
        {
            isSell: false,
            itemHrid: COWBELL_BAG_HRID,
            enhancementLevel: 0,
            quantity: 1,
            price: 1100,
            isInstantOrder: false,
        }
    );
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [cowbellBuyListing({
            id: 801,
            price: 1100,
            status: FILLED,
            filledQuantity: 1,
            unclaimedItemCount: 1,
            unclaimedCoinCount: 37,
        })],
    });
    await posting;
    assert.equal(
        sentMessages(socket).length,
        1,
        'an exact filled-buy listing confirms without a fake cowbell inventory deduction'
    );
    assert.equal(State.pendingWrite, null);
    assert.equal(State.pausedItems.has(COWBELL_BAG_ID), false);
}

async function runCowbellLevelZeroAndCoinClaimReceiptTest() {
    const terminal = cowbellBuyListing({
        id: 811,
        price: 1100,
        status: FILLED,
        filledQuantity: 1,
        unclaimedItemCount: 1,
        unclaimedCoinCount: 37,
    });
    const socket = resetRuntime({
        watchlist: [],
        cowbellEnabled: true,
        cowbellInventory: 2,
        coinInventory: 100,
        listings: [terminal],
    });
    const claiming = claimListing(COWBELL_BAG_ID, terminal);
    await flushUntil(
        () => sentMessages(socket).length === 1,
        'cowbell filled buy claim'
    );
    assert.equal(sentMessages(socket)[0].type, 'claim_market_listing');

    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...terminal,
            unclaimedItemCount: 0,
            unclaimedCoinCount: 0,
        }],
    });
    assert.ok(
        State.op,
        'clearing the listing alone cannot prove receipt of its item and refund'
    );
    Network.handleIncoming({
        type: 'items_updated',
        updatedCharacterItems: [
            inventoryItem(99, COWBELL_BAG_ID, 20),
        ],
    });
    assert.ok(
        State.op,
        'a +20 delta for the same item id cannot satisfy a level-zero claim'
    );
    Network.handleIncoming({
        type: 'items_updated',
        updatedCharacterItems: [
            inventoryItem(3, COWBELL_BAG_ID, 0),
        ],
    });
    assert.ok(
        State.op,
        'the claimed bag alone cannot hide a missing coin refund'
    );
    Network.handleIncoming({
        type: 'items_updated',
        updatedCharacterItems: [
            inventoryItem(137, COIN_ID, 0),
        ],
    });
    await claiming;
    assert.equal(State.pendingWrite, null);
    assert.equal(State.inventory.get(COWBELL_BAG_ID)?.[0], 3);
    assert.equal(State.inventory.get(COIN_ID)?.[0], 137);
}

async function runCowbellCeilingRemovesBuyWithoutRepostTest() {
    const ownBuy = cowbellBuyListing({
        id: 821,
        price: 1100,
    });
    const socket = resetRuntime({
        watchlist: [],
        cowbellEnabled: true,
        coinInventory: 10_000,
        listings: [ownBuy],
    });
    const maintaining = maintainCowbellBuy();
    await respondToOrderBook(
        socket,
        0,
        [ask(901, 1100)],
        {min: 900, max: 1100, marketValue: 1000},
        {
            itemId: COWBELL_BAG_ID,
            bids: [ask(821, 1100)],
            enhancementLevel: 0,
        }
    );
    await flushUntil(
        () => sentMessages(socket).length > 1,
        'cowbell ceiling cancel'
    );
    assert.equal(sentMessages(socket)[1].type, 'cancel_market_listing');
    const cancelled = cowbellBuyListing({
        id: 821,
        price: 1100,
        status: '/market_listing_status/cancelled',
        unclaimedCoinCount: 1100,
    });
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [cancelled],
    });
    await flushUntil(
        () => sentMessages(socket).length > 2,
        'cowbell ceiling refund claim'
    );
    assert.equal(sentMessages(socket)[2].type, 'claim_market_listing');
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...cancelled,
            unclaimedCoinCount: 0,
        }],
    });
    Network.handleIncoming({
        type: 'items_updated',
        updatedCharacterItems: [
            inventoryItem(11_100, COIN_ID, 0),
        ],
    });
    await maintaining;
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        [
            'get_market_item_order_books',
            'cancel_market_listing',
            'claim_market_listing',
        ],
        'a sell ask at Max removes the anchor and never reposts it'
    );
    assert.equal(getOwnActiveBuyListings(COWBELL_BAG_ID, 0).length, 0);
}

async function runCowbellStaleBuyRefreshesPriceBeforeRepostTest() {
    const stale = cowbellBuyListing({
        id: 831,
        price: 1000,
    });
    const socket = resetRuntime({
        watchlist: [],
        cowbellEnabled: true,
        coinInventory: 10_000,
        listings: [stale],
    });
    const maintaining = maintainCowbellBuy();
    await respondToOrderBook(
        socket,
        0,
        [ask(910, 950)],
        {min: 900, max: 1100, marketValue: 1000},
        {
            itemId: COWBELL_BAG_ID,
            bids: [ask(831, 1000)],
            enhancementLevel: 0,
        }
    );
    await flushUntil(
        () => sentMessages(socket).length > 1,
        'stale cowbell buy cancel'
    );
    assert.equal(sentMessages(socket)[1].type, 'cancel_market_listing');
    const cancelled = cowbellBuyListing({
        id: 831,
        price: 1000,
        status: '/market_listing_status/cancelled',
        unclaimedCoinCount: 1000,
    });
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [cancelled],
    });
    await flushUntil(
        () => sentMessages(socket).length > 2,
        'stale cowbell buy refund claim'
    );
    assert.equal(sentMessages(socket)[2].type, 'claim_market_listing');
    now += CONFIG.MIN_REQUEST_GAP_MS + 1;
    Network.handleIncoming({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...cancelled,
            unclaimedCoinCount: 0,
        }],
    });
    Network.handleIncoming({
        type: 'items_updated',
        updatedCharacterItems: [
            inventoryItem(11_000, COIN_ID, 0),
        ],
    });

    await respondToOrderBook(
        socket,
        3,
        [ask(911, 1000)],
        {min: 950, max: 1200, marketValue: 1075},
        {
            itemId: COWBELL_BAG_ID,
            bids: [],
            enhancementLevel: 0,
        }
    );
    const post = await confirmCowbellPost({
        socket,
        sentIndex: 4,
        resultingListing: cowbellBuyListing({
            id: 832,
            price: 1200,
        }),
    });
    await maintaining;
    assert.equal(post.postMarketOrderData.price, 1200);
    assert.equal(post.postMarketOrderData.quantity, 1);
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        [
            'get_market_item_order_books',
            'cancel_market_listing',
            'claim_market_listing',
            'get_market_item_order_books',
            'post_market_order',
        ],
        'reanchoring must read the current range again after withdrawing the stale order'
    );
}

async function runCowbellOnlySchedulerTest() {
    const socket = resetRuntime({
        watchlist: [],
        cowbellEnabled: true,
        coinInventory: 10_000,
    });
    assert.equal(
        MarketKeeper.isRunning(),
        true,
        'the built-in cowbell target runs without a +20 watchlist'
    );
    const tick = MarketKeeper.tick();
    await respondToOrderBook(
        socket,
        0,
        [],
        {min: 900, max: 1100, marketValue: 1000},
        {
            itemId: COWBELL_BAG_ID,
            bids: [],
            enhancementLevel: 0,
        }
    );
    const post = await confirmCowbellPost({
        socket,
        sentIndex: 1,
        resultingListing: cowbellBuyListing({
            id: 841,
            price: 1100,
        }),
    });
    await tick;
    assert.equal(post.postMarketOrderData.quantity, 1);
    assert.equal(post.postMarketOrderData.price, 1100);
    assert.equal(State.lastPolledItemId, COWBELL_BAG_ID);
    assert.ok(State.lastCowbellPollAt > 0);
}

async function runCowbellDisabledIsolationTest() {
    const existingAnchor = cowbellBuyListing({
        id: 845,
        price: 1100,
    });
    const cowbellOnlySocket = resetRuntime({
        watchlist: [],
        cowbellEnabled: false,
        coinInventory: 10_000,
        listings: [existingAnchor],
    });
    assert.equal(
        MarketKeeper.isRunning(),
        false,
        'the master switch alone cannot start a disabled cowbell-only target'
    );
    await MarketKeeper.tick();
    assert.equal(
        sentMessages(cowbellOnlySocket).length,
        0,
        'disabling cowbell maintenance sends no read, cancel, claim or post'
    );
    assert.equal(
        getOwnActiveBuyListings(COWBELL_BAG_ID, 0).length,
        1,
        'turning the feature off leaves an existing anchor untouched'
    );

    const sellSocket = resetRuntime({
        inventory: 2,
        watchlist: [ITEM_ID],
        cowbellEnabled: false,
        coinInventory: 10_000,
        listings: [existingAnchor],
    });
    assert.equal(
        MarketKeeper.isRunning(),
        true,
        '+20 maintenance remains runnable when only cowbell is disabled'
    );
    const sellTick = MarketKeeper.tick();
    await respondToOrderBook(sellSocket, 0, [ask(846, 1000)]);
    const sellPost = await confirmPost({
        socket: sellSocket,
        sentIndex: 1,
        resultingListing: listing({
            id: 847,
            price: 980,
            orderQuantity: 1,
        }),
        resultingInventory: 1,
    });
    await sellTick;
    assert.equal(sellPost.postMarketOrderData.isSell, true);
    assert.equal(sellPost.postMarketOrderData.itemHrid, ITEM_HRID);
    assert.equal(
        getOwnActiveBuyListings(COWBELL_BAG_ID, 0).length,
        1,
        'normal +20 work cannot withdraw the disabled cowbell anchor'
    );
    assert.deepEqual(
        sentMessages(sellSocket).map((message) => (
            message.type === 'get_market_item_order_books'
                ? message.getMarketItemOrderBooksData.itemHrid
                : message.type
        )),
        [ITEM_HRID, 'post_market_order']
    );
}

function runCowbellProfilePersistenceTest() {
    const profileId = 'test.milkywayidle.com:123';
    resetRuntime({
        enabled: false,
        watchlist: [],
        cowbellEnabled: false,
    });
    storage.set('MWI_MARKET_KEEPER_V1', JSON.stringify({
        [profileId]: {
            enabled: false,
            cowbellEnabled: true,
            watchlist: [],
            pausedItems: {},
        },
    }));
    State.profileLoaded = false;
    Network.handleIncoming({
        type: 'init_character_data',
        character: {id: 123, gameMode: 'standard'},
        characterInfo: {marketListingCap: 20},
        characterSetting: {hasAcceptedTradingRules: true},
        characterItemMarks: [],
        characterItems: [
            inventoryItem(1),
            inventoryItem(0, COWBELL_BAG_ID, 0),
            inventoryItem(10_000, COIN_ID, 0),
        ],
        myMarketListings: [],
    });
    assert.equal(
        State.cowbellEnabled,
        true,
        'the independent cowbell toggle is restored from the character profile'
    );

    resetRuntime({
        enabled: false,
        watchlist: [],
        cowbellEnabled: true,
    });
    storage.set('MWI_MARKET_KEEPER_V1', JSON.stringify({
        [profileId]: {
            enabled: false,
            watchlist: [],
            pausedItems: {},
        },
    }));
    State.profileLoaded = false;
    Network.handleIncoming({
        type: 'init_character_data',
        character: {id: 123, gameMode: 'standard'},
        characterInfo: {marketListingCap: 20},
        characterSetting: {hasAcceptedTradingRules: true},
        characterItemMarks: [],
        characterItems: [
            inventoryItem(1),
            inventoryItem(0, COWBELL_BAG_ID, 0),
            inventoryItem(10_000, COIN_ID, 0),
        ],
        myMarketListings: [],
    });
    assert.equal(
        State.cowbellEnabled,
        false,
        'an older profile without the toggle defaults to disabled'
    );
}

async function runCowbellSchedulerDoesNotStarveEnhancementSalesTest() {
    const anchor = cowbellBuyListing({
        id: 851,
        price: 1200,
        workingPrice: 1100,
    });
    const socket = resetRuntime({
        inventory: 2,
        watchlist: [ITEM_ID],
        cowbellEnabled: true,
        coinInventory: 10_000,
        listings: [anchor],
    });

    const cowbellTick = MarketKeeper.tick();
    await respondToOrderBook(
        socket,
        0,
        [],
        {min: 900, max: 1100, marketValue: 1000},
        {
            itemId: COWBELL_BAG_ID,
            bids: [ask(851, 1100)],
            enhancementLevel: 0,
        }
    );
    await cowbellTick;
    assert.equal(
        State.itemStatus.get(COWBELL_BAG_ID)?.kind,
        'cowbell_buy_stable'
    );

    const sellTick = MarketKeeper.tick();
    await respondToOrderBook(socket, 1, [ask(852, 1000)]);
    const sellPost = await confirmPost({
        socket,
        sentIndex: 2,
        resultingListing: listing({
            id: 853,
            price: 980,
            orderQuantity: 1,
        }),
        resultingInventory: 1,
    });
    await sellTick;
    assert.equal(sellPost.postMarketOrderData.isSell, true);
    assert.equal(sellPost.postMarketOrderData.itemHrid, ITEM_HRID);
    assert.deepEqual(
        sentMessages(socket).map((message) => message.type),
        [
            'get_market_item_order_books',
            'get_market_item_order_books',
            'post_market_order',
        ],
        'after one due cowbell poll, the next scheduler turn services +20 sales'
    );
}

function runSingleAttachListenerTest() {
    stopAndResetTimers();
    State.socket = null;
    State.attachedSockets = new WeakSet();
    Network.install();
    const socket = new fakeWindow.WebSocket(
        'wss://api-test.milkywayidle.com/ws?characterId=123'
    );
    for (const type of ['open', 'message', 'close', 'error']) {
        assert.equal(
            socket.listeners.get(type)?.length,
            1,
            `shared socket publication must install ${type} listener once`
        );
    }
}

async function main() {
    runPanelCloseAndStackingTest();
    runPureDecisionTests();
    runCowbellPureDecisionTests();
    runPostMatchingTests();
    runInitializationIsolationTest();
    runIncompleteInitializationDiagnosticTest();
    runItemMarkInitializationAndUpdateTest();
    runSameVersionClientCacheTest();
    await runColdWatchlistFastScanTest();
    await runFirstQuoteAndReserveIntegrationTest();
    await runPriceBandMinIntegrationTest();
    await runInBandLeftOneIntegrationTest();
    await runOwnListingsConsolidationNoLoopTest();
    await runLegacyOffGridReserveReclaimIntegrationTest();
    await runEquippedReserveDoesNotChurnListingTest();
    runEquippedLevelAndRemovalTest();
    await runBeltEquippedReserveTest();
    await runRepriceCancelClaimPostIntegrationTest();
    await runConcurrentTickTest();
    await runSpamBackoffTest();
    await runPendingWriteBarrierAndRecoveryTest();
    runPendingWriteStatusTextTest();
    await runCurrentSessionPendingSnapshotSafetyTest();
    runPersistedPendingMigrationRecoveryTests();
    await runPendingPostSnapshotConvergenceTest();
    await runSendBoundaryInventoryPreflightTest();
    await runItemMarkPostPreflightTest();
    await runLockedItemStillClaimsTerminalAssetsTest();
    await runPostEquipSwitchDuringRequestGapTest();
    await runRawOwnListingFailClosedTest();
    await runSendBoundaryEpochAndLimitPreflightTest();
    await runClaimSendBoundaryInventoryRebaseTest();
    await runCowbellFilledBuyPostReceiptTest();
    await runCowbellLevelZeroAndCoinClaimReceiptTest();
    await runCowbellCeilingRemovesBuyWithoutRepostTest();
    await runCowbellStaleBuyRefreshesPriceBeforeRepostTest();
    await runCowbellOnlySchedulerTest();
    await runCowbellDisabledIsolationTest();
    runCowbellProfilePersistenceTest();
    await runCowbellSchedulerDoesNotStarveEnhancementSalesTest();
    runSingleAttachListenerTest();
    stopAndResetTimers();
    console.log('mwi_market_keeper runtime tests: PASS');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
