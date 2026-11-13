#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BELT_IDS = [
    'small_talisman_belt',
    'medium_talisman_belt',
    'large_talisman_belt',
];
// Synthetic client metadata exercises the official field shapes; it does not
// assert the current server's numeric enhancement costs or shop keys.
const BELT_ITEM_DETAILS = Object.fromEntries(BELT_IDS.map((itemId) => [
    `/items/${itemId}`,
    {
        isTradable: true,
        sellPrice: 2,
        categoryHrid: '/item_categories/equipment',
        enhancementCosts: [{itemHrid: '/items/coin', count: 10}],
        baseItemHrids: [],
    },
]));
const BELT_SHOP_DETAILS = Object.fromEntries(BELT_IDS.map((itemId) => [
    `/shop_items/test/synthetic_${itemId}_offer`,
    {
        itemHrid: `/items/${itemId}`,
        category: '/shop_categories/tester',
        costs: [{itemHrid: '/items/coin', count: 1}],
    },
]));

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
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
        this.sent.push(data);
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open');
    }

    emit(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) {
            listener.call(this, event);
        }
    }

    emitMessage(message) {
        this.emit('message', {data: JSON.stringify(message)});
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
    setTimeout,
    clearTimeout,
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
    console: {
        log() {},
        warn() {},
        error() {},
    },
    window: fakeWindow,
    document: fakeDocument,
    WebSocket: FakeWebSocket,
    URL,
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    __MWI_SAFE_ENHANCER_RUNTIME_TEST_MODE__: true,
};
vm.createContext(context);

const userscriptPath = path.join(__dirname, 'mwi_safe_enhancer.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');

const pageRealm = vm.createContext({
    console: {log() {}, warn() {}, error() {}},
});
vm.runInContext(`
    globalThis.window = globalThis;
    window.location = {hostname: 'example.invalid'};
    globalThis.__MWI_SAFE_ENHANCER_TEST_MODE__ = true;
    globalThis.__MWI_SAFE_ENHANCER_RUNTIME_TEST_MODE__ = true;
`, pageRealm);
vm.runInContext(source, pageRealm, {filename: userscriptPath});
assert.equal(
    pageRealm.__MWI_SAFE_ENHANCER_TEST_EXPORTS__,
    undefined,
    'page scripts must not be able to activate planner test mode'
);
assert.equal(
    pageRealm.__MWI_SAFE_ENHANCER_RUNTIME_TEST_EXPORTS__,
    undefined,
    'page scripts must not be able to activate runtime test mode'
);

vm.runInContext(source, context, {filename: userscriptPath});

const {
    CONFIG,
    State,
    WorkSignals,
    sleepFor,
    waitForStateQuiescence,
    waitForOwnedQueueIntegrity,
    waitForEnhancingLoadoutSave,
    Transactions,
    MarketTransactions,
    Network,
    MarketMaintenance,
    Controller,
    UI,
    READ_ONLY_OUTGOING_TYPES,
    actionCompletionMatches,
    actionFingerprintMatches,
    actionProgressMatches,
    buildBatchPlan,
    buildConfirmationText,
    classifyExternalOutgoing,
    createRecoveryJournal,
    createEnhancePayload,
    decompressLzStringUtf16,
    enumeratePlanCommands,
    finalizeCompletelyAcknowledgedQueueRun,
    getEnhancingLoadoutBinding,
    getLoadoutTargetReservations,
    getRecoveryPurchaseRequirements,
    isCompletelyAcknowledgedQueueJournal,
    reconcileRecoveryJournal,
    isSafeExternalQueueMutation,
    assertLoadoutTargetReservationsAvailable,
    assertPlansPreserveLoadoutTargetReservations,
    parsePositiveInteger,
    purchaseAndConfirm,
    runOperationSafely,
    sendEnhanceAndConfirm,
    progressSingleEnhanceActionMatches,
    registerOwnedAction,
    strictSingleEnhanceActionMatches,
    waitForQuickQueueSlot,
} = context.__MWI_SAFE_ENHANCER_RUNTIME_TEST_EXPORTS__;

Network.install();
location.search = '';
assert.equal(
    Network.isGameSocket(new FakeWebSocket(
        'wss://api-test.milkywayidle.com/ws'
    )),
    false
);
location.search = '?characterId=123';
for (const url of [
    'wss://api-test.milkywayidle.com/ws',
    'wss://api-test.milkywayidle.com/ws?characterId=invalid',
    'ws://api-test.milkywayidle.com/ws?characterId=123',
    'wss://api-test.milkywayidle.com:444/ws?characterId=123',
    'wss://api-test.milkywayidle.com/ws-other?characterId=123',
    'wss://example.com/ws?characterId=123',
]) {
    assert.equal(Network.isGameSocket(new FakeWebSocket(url)), false, url);
}
location.hostname = 'test.milkywayidlecn.com';
assert.equal(
    Network.isGameSocket(new FakeWebSocket(
        'wss://api-test.milkywayidlecn.com/ws?characterId=123'
    )),
    true
);
location.hostname = 'test.milkywayidle.com';

const unrelatedSocket = new FakeWebSocket(
    'wss://api-test.milkywayidle.com/ws?characterId=999'
);
unrelatedSocket.open();
unrelatedSocket.send(JSON.stringify({type: 'ping', pingData: {hash: 1}}));
assert.equal(
    State.socket,
    null,
    'a different-character WebSocket must not be captured'
);
const fallbackSocket = new FakeWebSocket(
    'wss://api-test.milkywayidle.com/ws?characterId=123'
);
fallbackSocket.open();
fallbackSocket.send(JSON.stringify({type: 'ping', pingData: {hash: 1}}));
assert.equal(
    State.socket,
    fallbackSocket,
    'the send hook remains a fallback for an already-created socket'
);

const socket = new fakeWindow.WebSocket(
    'wss://api-test.milkywayidle.com/ws?characterId=123'
);
assert.equal(
    State.socket,
    fallbackSocket,
    'a connecting socket must not become authoritative before open'
);
socket.open();
assert.equal(
    State.socket,
    socket,
    'the constructor hook must activate the matching socket on open'
);

function inventoryItem(itemId, level, count) {
    return characterItem(
        itemId,
        level,
        count,
        '/item_locations/inventory'
    );
}

function characterItem(
    itemId,
    level,
    count,
    itemLocationHrid = '/item_locations/inventory'
) {
    return {
        itemLocationHrid,
        itemHrid: `/items/${itemId}`,
        enhancementLevel: level,
        count,
    };
}

function enhancingLoadout({
    characterId = 123,
    id = 17,
    name = 'Enhancing',
    actionTypeHrid = '/action_types/enhancing',
    wearableMap = {
        '/item_locations/charm':
            `${characterId}::/item_locations/charm::`
            + '/items/grandmaster_enhancing_charm::0',
    },
    ...overrides
} = {}) {
    return {
        id,
        characterID: characterId,
        name,
        actionTypeHrid,
        isDefault: true,
        suppressValidation: false,
        useExactEnhancement: false,
        wearableMap,
        foodItemHrids: [],
        drinkItemHrids: [],
        abilityMap: {},
        ...overrides,
    };
}

function emitFullInit({
    targetSocket = socket,
    characterId = 123,
    gameMode = 'standard',
    characterItems = [
        inventoryItem('philosophers_mirror', 0, 20000),
        characterItem(
            'grandmaster_enhancing_charm',
            0,
            1,
            '/item_locations/charm'
        ),
    ],
    characterActions = [],
    actionQueueCap = 100,
    marketListingCap = 20,
    hasAcceptedTradingRules = true,
    characterLoadoutMap = {
        17: enhancingLoadout({characterId}),
    },
    myMarketListings = [],
    itemDetailMap = {
        ...BELT_ITEM_DETAILS,
        '/items/gobo_stabber': {
            isTradable: true,
            sellPrice: 2,
        },
        '/items/gobo_slasher': {
            isTradable: true,
            sellPrice: 2,
        },
        '/items/enhancers_top': {
            isTradable: true,
            sellPrice: 2,
        },
    },
    shopItemDetailMap = BELT_SHOP_DETAILS,
    gameModeDetailMap = {
        standard: {marketRestricted: false},
    },
    emitClientData = true,
} = {}) {
    if (emitClientData) {
        targetSocket.emitMessage({
            type: 'init_client_data',
            itemDetailMap,
            shopItemDetailMap,
            gameModeDetailMap,
        });
    }
    targetSocket.emitMessage({
        type: 'init_character_data',
        character: {id: characterId, gameMode},
        characterInfo: {actionQueueCap, marketListingCap},
        characterSetting: {hasAcceptedTradingRules},
        characterItems,
        characterActions,
        characterLoadoutMap,
        myMarketListings,
    });
}

function createRun(id) {
    let binding = null;
    try {
        binding = getEnhancingLoadoutBinding();
    } catch {
        // Some negative tests intentionally remove the loadout.
    }
    return {
        id,
        active: true,
        mode: 'quick',
        characterId: '123',
        itemIds: ['gobo_stabber'],
        enhancingLoadoutId: binding?.id ?? 17,
        enhancingLoadoutFingerprint: binding?.fingerprint ?? '',
        enhancingLoadoutReservedItemHrids:
            binding?.reservedItemHrids ?? [],
        loadoutTargetReservations: [],
        syncEpoch: State.syncEpoch,
        stopRequested: false,
        interferenceDetected: false,
        ownedActionIds: new Set(),
        ownedActionFingerprints: new Map(),
        ownedActionOrder: [],
        completedOwnedActionIds: new Set(),
        ownedRemovalPending: new Map(),
        ownedOrderValidationPending: false,
        ownedOrderValidationTimer: null,
        integrityFailure: '',
        queueWarning: '',
        allOwnedActionsFinishedLogged: false,
        allowedExternalTypes: new Set(),
        marketInventoryOffsets: new Map(),
        marketAutomationListingIds: new Map(),
        marketQuoteConfirmations: new Map(),
        marketPostInventoryBarriers: new Map(),
        marketPriorityItemId: null,
        marketFinalSweepPending: false,
        marketSteadyMonitoring: false,
        marketFinalSweepPhase: 'idle',
        marketFinalSweepRemaining: new Set(),
        marketFinalSweepAttempts: new Map(),
        marketFinalSweepInventoryDeadline: null,
        marketFinalSweepInventoryTimer: null,
        marketItemRules: new Map([
            [
                'gobo_stabber',
                {
                    isTradable: true,
                    sellPrice: 2,
                },
            ],
        ]),
        currentStage: '',
    };
}

function beginPurchase(run, count = 2) {
    const baseline = State.inventory.get('gobo_stabber')?.[10] || 0;
    return Transactions.begin(run, {
        kind: 'purchase',
        itemId: 'gobo_stabber',
        level: 10,
        count,
        baselineInventory: baseline,
        expectedInventory: baseline + count,
        timeoutMs: 2000,
        timeoutMessage: 'purchase timeout',
        payload: {
            type: 'buy_from_shop',
            buyFromShopData: {
                shopItemHrid: '/shop_items/test/gobo_stabber',
                enhancementLevel: 10,
                count,
            },
        },
    });
}

function actionFingerprint(startLevel, targetLevel) {
    return {
        primaryItemHash:
            `123::/item_locations/inventory::/items/gobo_stabber::${startLevel}`,
        secondaryItemHash:
            '123::/item_locations/inventory::/items/philosophers_mirror::0',
        enhancingMaxLevel: targetLevel,
        enhancingProtectionMinLevel: 2,
        characterLoadoutId: 17,
    };
}

function actionFromFingerprint(id, fingerprint, isDone = false) {
    const {
        characterLoadoutId,
        ...rest
    } = fingerprint;
    return {
        id,
        ordinal: Number(id),
        isDone,
        actionHrid: '/actions/enhancing/enhance',
        ...rest,
        characterLoadoutID: characterLoadoutId,
    };
}

function strictActionFromFingerprint(
    id,
    fingerprint,
    ordinal = Number(id),
    overrides = {}
) {
    return {
        ...actionFromFingerprint(id, fingerprint),
        ordinal,
        difficultyTier: 0,
        hasMaxCount: false,
        maxCount: 0,
        ...overrides,
    };
}

function recoveryFingerprint(journal, command) {
    return createEnhancePayload(
        {
            characterId: journal.characterId,
            enhancingLoadoutId: journal.enhancingLoadout.id,
        },
        command.itemId,
        command.action,
        'quick'
    ).fingerprint;
}

function confirmRecoveryPurchases(journal) {
    for (const purchase of Object.values(journal.purchases)) {
        purchase.status = 'confirmed';
    }
}

function acknowledgeRecoveryPrefix(
    journal,
    commands,
    count,
    idBase = 10_000
) {
    journal.acked.length = 0;
    for (let index = 0; index < count; index++) {
        journal.acked.push({
            commandKey: commands[index].commandKey,
            actionId: String(idBase + index),
            fingerprint: recoveryFingerprint(
                journal,
                commands[index]
            ),
        });
    }
    return journal.acked;
}

function queueActionsForAcknowledgements(
    records,
    firstRecordIndex = 0,
    omitRecordIndexes = new Set()
) {
    const actions = [];
    for (
        let index = firstRecordIndex;
        index < records.length;
        index++
    ) {
        if (omitRecordIndexes.has(index)) continue;
        actions.push(strictActionFromFingerprint(
            records[index].actionId,
            records[index].fingerprint,
            index + 1
        ));
    }
    return actions;
}

function replaceAuthoritativeActions(actions) {
    State.actions.clear();
    for (const action of actions) {
        State.actions.set(String(action.id), action);
    }
}

function seedOwnedAction(run, id, fingerprint, ordinal = Number(id)) {
    const actionId = String(id);
    const action = {
        ...actionFromFingerprint(id, fingerprint),
        ordinal,
    };
    State.actions.set(actionId, action);
    run.ownedActionIds.add(actionId);
    run.ownedActionFingerprints.set(actionId, fingerprint);
    run.ownedActionOrder.push(actionId);
    return action;
}

function marketAsk(listingId, price, quantity = 1) {
    return {listingId, price, quantity};
}

function marketOrderBookSnapshot(
    itemId = 'gobo_stabber',
    asks = [],
    bids = []
) {
    const orderBooks = [];
    orderBooks[20] = {asks, bids};
    return {
        itemHrid: `/items/${itemId}`,
        orderBooks,
        fairPrices: [],
    };
}

function ownMarketListing({
    id = 101,
    itemId = 'gobo_stabber',
    level = 20,
    price = 1000,
    status = '/market_listing_status/active',
    isSell = true,
    orderQuantity = 10,
    filledQuantity = 0,
    unclaimedItemCount = 0,
    unclaimedCoinCount = 0,
} = {}) {
    return {
        id,
        status,
        isSell,
        itemHrid: `/items/${itemId}`,
        enhancementLevel: level,
        price,
        orderQuantity,
        filledQuantity,
        unclaimedItemCount,
        unclaimedCoinCount,
    };
}

function runMarketMaintenanceContractTests() {
    assert.ok(
        MarketMaintenance,
        'runtime export MarketMaintenance is required for +20 market tests'
    );
    for (const functionName of [
        'getLeftOne',
        'getOwnActiveSellListings',
        'planReprice',
        'getFinalRepostQuantity',
        'matchNewActiveListing',
        'createPostPayload',
        'applyMispriceWarning',
    ]) {
        assert.equal(
            typeof MarketMaintenance[functionName],
            'function',
            `MarketMaintenance.${functionName} must be exported`
        );
    }

    const leftOneSnapshot = marketOrderBookSnapshot(
        'gobo_stabber',
        [
            marketAsk(201, 777, 2),
            marketAsk(202, 778, 5),
        ]
    );
    const leftOne = MarketMaintenance.getLeftOne(leftOneSnapshot);
    assert.equal(leftOne?.listingId, 201);
    assert.equal(leftOne?.price, 777);
    assert.equal(leftOne?.quantity, 2);
    assert.equal(
        MarketMaintenance.getLeftOne(
            marketOrderBookSnapshot('gobo_stabber')
        ),
        null,
        'an empty +20 ask book has no left-one price'
    );
    assert.equal(
        MarketMaintenance.getLeftOne(null),
        null,
        'a missing order-book snapshot must fail closed to no quote'
    );

    const targetOwnListing = ownMarketListing({
        id: 101,
        price: 1000,
    });
    const filteredOwnListings =
        MarketMaintenance.getOwnActiveSellListings(
            [
                targetOwnListing,
                ownMarketListing({
                    id: 102,
                    status: '/market_listing_status/cancelled',
                }),
                ownMarketListing({id: 103, isSell: false}),
                ownMarketListing({id: 104, itemId: 'gobo_slasher'}),
                ownMarketListing({id: 105, level: 19}),
            ],
            'gobo_stabber'
        );
    assert.deepEqual(
        Array.from(filteredOwnListings, (listing) => Number(listing.id)),
        [101],
        'only active +20 sell listings for the requested item are owned asks'
    );

    const alreadyLowest = MarketMaintenance.planReprice({
        ownListings: [
            targetOwnListing,
            ownMarketListing({id: 102, price: 1000}),
        ],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(101, 1000, 10),
                marketAsk(102, 1000, 3),
                marketAsk(201, 1005, 2),
            ]
        ),
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(alreadyLowest.kind, 'already_lowest');
    assert.equal(
        alreadyLowest.competingAsk?.listingId,
        201,
        'all of the character own ask IDs must be excluded before '
            + 'choosing the lowest competing ask'
    );
    assert.equal(alreadyLowest.competingAsk?.price, 1005);
    assert.equal(
        Object.prototype.hasOwnProperty.call(alreadyLowest, 'newPrice'),
        false,
        'an already-lowest listing must never be cancelled and raised'
    );

    const reserveReclaim = MarketMaintenance.planReprice({
        ownListings: [targetOwnListing],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [marketAsk(101, 1000, 10)]
        ),
        itemId: 'gobo_stabber',
        inventoryCount: 0,
        vendorPrice: 2,
        maxDropPercent: 10,
    });
    assert.equal(
        reserveReclaim.kind,
        'reserve_reclaim',
        'an active own order must yield one physical reserve when inventory '
            + 'is zero'
    );

    const tiedLowest = MarketMaintenance.planReprice({
        ownListings: [targetOwnListing],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(201, 1000),
                marketAsk(101, 1000),
            ]
        ),
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(
        tiedLowest.kind,
        'already_lowest',
        'sharing the lowest price must not trigger a self-undercut loop'
    );

    const multiListingDecision = MarketMaintenance.planReprice({
        ownListings: [
            ownMarketListing({id: 111, price: 1000}),
            ownMarketListing({id: 112, price: 1100}),
        ],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(211, 950),
                marketAsk(111, 1000),
                marketAsk(112, 1100),
            ]
        ),
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(multiListingDecision.kind, 'reprice');
    assert.equal(
        Number(multiListingDecision.ownListing.id),
        111,
        'a higher guarded own listing must not starve another own listing '
            + 'that can legally reach the official step below the best ask'
    );
    assert.equal(multiListingDecision.newPrice, 940);

    const anchoredFallbackDecision =
        MarketMaintenance.planReprice({
            ownListings: [
                ownMarketListing({id: 111, price: 1000}),
                ownMarketListing({id: 112, price: 1050}),
            ],
            orderBookSnapshot: marketOrderBookSnapshot(
                'gobo_stabber',
                [
                    marketAsk(211, 950),
                    marketAsk(111, 1000),
                    marketAsk(112, 1050),
                ]
            ),
            itemId: 'gobo_stabber',
            maxDropPercent: 11,
            priceAnchors: new Map([
                ['111', 1111],
                ['112', 1050],
            ]),
        });
    assert.equal(anchoredFallbackDecision.kind, 'reprice');
    assert.equal(
        Number(anchoredFallbackDecision.ownListing.id),
        112,
        'a guarded lowest own listing must not starve a higher own listing '
            + 'whose cumulative anchor safely permits left-one-minus'
    );
    assert.equal(anchoredFallbackDecision.newPrice, 940);

    const oneOwnAlreadyLowest = MarketMaintenance.planReprice({
        ownListings: [
            ownMarketListing({id: 111, price: 1000}),
            ownMarketListing({id: 112, price: 1100}),
        ],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(111, 1000),
                marketAsk(211, 1050),
                marketAsk(112, 1100),
            ]
        ),
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(
        oneOwnAlreadyLowest.kind,
        'already_lowest',
        'once any own listing is at the lowest sell price, higher own '
            + 'listings are left untouched'
    );
    assert.equal(oneOwnAlreadyLowest.newPrice, undefined);

    const undercutDecision = MarketMaintenance.planReprice({
        ownListings: [targetOwnListing],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(201, 950, 1),
                marketAsk(101, 1000, 10),
            ]
        ),
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(undercutDecision.kind, 'reprice');
    assert.equal(undercutDecision.oldPrice, 1000);
    assert.equal(undercutDecision.newPrice, 940);
    assert.ok(
        undercutDecision.newPrice < undercutDecision.oldPrice,
        'automatic maintenance may lower a listing but must never raise it'
    );

    const upwardMarket = MarketMaintenance.planReprice({
        ownListings: [targetOwnListing],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(101, 1000),
                marketAsk(201, 1200),
            ]
        ),
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(upwardMarket.kind, 'already_lowest');
    assert.equal(
        upwardMarket.newPrice,
        undefined,
        'maintenance must not chase a higher competing price'
    );

    const guardedDrop = MarketMaintenance.planReprice({
        ownListings: [targetOwnListing],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(201, 500),
                marketAsk(101, 1000),
            ]
        ),
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(
        guardedDrop.kind,
        'guarded',
        'a single repricing step beyond the configured drop limit is blocked'
    );
    assert.equal(guardedDrop.oldPrice, 1000);
    assert.equal(guardedDrop.proposedPrice, 490);
    assert.equal(guardedDrop.newPrice, undefined);

    const boundaryDrop = MarketMaintenance.planReprice({
        ownListings: [targetOwnListing],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(201, 910),
                marketAsk(101, 1000),
            ]
        ),
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(boundaryDrop.kind, 'reprice');
    assert.equal(
        boundaryDrop.newPrice,
        900,
        'a drop exactly equal to the configured maximum remains allowed'
    );

    const noOwnListing = MarketMaintenance.planReprice({
        ownListings: [],
        orderBookSnapshot: leftOneSnapshot,
        itemId: 'gobo_stabber',
        maxDropPercent: 10,
    });
    assert.equal(noOwnListing.kind, 'reserve_only');
    assert.equal(noOwnListing.newPrice, undefined);

    for (const [inventoryCount, expectedExcess, expectedKind] of [
        [0, 0, 'reserve_only'],
        [1, 0, 'reserve_only'],
        [2, 1, 'post_new'],
        [50, 49, 'post_new'],
    ]) {
        const decision = MarketMaintenance.planReprice({
            ownListings: [],
            orderBookSnapshot: marketOrderBookSnapshot(
                'gobo_stabber',
                [marketAsk(801, 1000)]
            ),
            itemId: 'gobo_stabber',
            inventoryCount,
            vendorPrice: 2,
            confirmedQuotePrice: 1000,
            maxDropPercent: 10,
        });
        assert.equal(
            decision.kind,
            expectedKind,
            `inventory ${inventoryCount} follows reserve-one semantics`
        );
        assert.equal(decision.excessQuantity, expectedExcess);
        if (expectedExcess > 0) {
            assert.equal(
                decision.newPrice,
                980,
                'the official price step below 1000 is 980'
            );
        } else {
            assert.equal(decision.newPrice, undefined);
        }
    }

    for (const [leftOnePrice, expectedPreviousPrice] of [
        [30, 29],
        [50, 49],
        [52, 50],
        [100, 98],
        [105, 100],
        [777, 760],
        [1000, 980],
        [10000, 9800],
    ]) {
        const decision = MarketMaintenance.planReprice({
            ownListings: [],
            orderBookSnapshot: marketOrderBookSnapshot(
                'gobo_stabber',
                [marketAsk(802, leftOnePrice)]
            ),
            itemId: 'gobo_stabber',
            inventoryCount: 2,
            vendorPrice: 2,
            confirmedQuotePrice: leftOnePrice,
            maxDropPercent: 50,
        });
        assert.equal(decision.kind, 'post_new');
        assert.equal(
            decision.newPrice,
            expectedPreviousPrice,
            `official minus step from ${leftOnePrice}`
        );
    }
    const vendorFloorDecision = MarketMaintenance.planReprice({
        ownListings: [],
        orderBookSnapshot: marketOrderBookSnapshot(
            'gobo_stabber',
            [marketAsk(803, 777)]
        ),
        itemId: 'gobo_stabber',
        inventoryCount: 2,
        vendorPrice: 770,
        confirmedQuotePrice: 777,
        maxDropPercent: 50,
    });
    assert.equal(
        vendorFloorDecision.kind,
        'price_floor',
        'a vendor-floor round-up that would exceed left one must not post'
    );

    const cancelledAfterPartialFill = ownMarketListing({
        id: 101,
        status: '/market_listing_status/cancelled',
        orderQuantity: 10,
        filledQuantity: 4,
        unclaimedItemCount: 6,
    });
    assert.equal(
        MarketMaintenance.getFinalRepostQuantity(
            cancelledAfterPartialFill
        ),
        6,
        'the final cancellation receipt controls how many returned items '
            + 'the claim must wait for'
    );
    assert.equal(
        MarketMaintenance.getFinalRepostQuantity({
            ...cancelledAfterPartialFill,
            unclaimedItemCount: 0,
        }),
        0,
        'a fully filled listing must not be reposted'
    );

    const expectedPost = {
        isSell: true,
        itemHrid: '/items/gobo_stabber',
        enhancementLevel: 20,
        quantity: 6,
        price: 950,
        isInstantOrder: false,
    };
    const singleNewListing =
        MarketMaintenance.matchNewActiveListing({
            baselineListingIds: new Set([101]),
            endMarketListings: [
                ownMarketListing({
                    id: 101,
                    status: '/market_listing_status/cancelled',
                    price: 1000,
                }),
                ownMarketListing({
                    id: 301,
                    price: 950,
                    orderQuantity: 6,
                }),
            ],
            expected: expectedPost,
        });
    assert.equal(singleNewListing.status, 'confirmed');
    assert.equal(String(singleNewListing.listingId), '301');
    assert.equal(singleNewListing.filled, false);

    const mergedBaselineListing = ownMarketListing({
        id: 305,
        price: 950,
        orderQuantity: 5,
        filledQuantity: 1,
    });
    const mergedIntoExistingListing =
        MarketMaintenance.matchNewActiveListing({
            baselineListingIds: new Set([305]),
            baselineListings: [mergedBaselineListing],
            endMarketListings: [
                ownMarketListing({
                    id: 305,
                    price: 950,
                    orderQuantity: 11,
                    filledQuantity: 1,
                }),
            ],
            expected: expectedPost,
        });
    assert.equal(mergedIntoExistingListing.status, 'confirmed');
    assert.equal(String(mergedIntoExistingListing.listingId), '305');
    assert.equal(mergedIntoExistingListing.merged, true);
    assert.equal(
        mergedIntoExistingListing.postedQuantity,
        6,
        'same-price server aggregation is confirmed only by the exact '
            + 'old-ID orderQuantity growth'
    );

    const immediatelyFilledListing =
        MarketMaintenance.matchNewActiveListing({
            baselineListingIds: new Set([101]),
            endMarketListings: [
                ownMarketListing({
                    id: 303,
                    status: '/market_listing_status/filled',
                    price: 950,
                    orderQuantity: 6,
                    filledQuantity: 6,
                    unclaimedItemCount: 0,
                    unclaimedCoinCount: 5700,
                }),
            ],
            expected: expectedPost,
        });
    assert.equal(immediatelyFilledListing.status, 'confirmed');
    assert.equal(immediatelyFilledListing.filled, true);
    assert.equal(
        String(immediatelyFilledListing.listingId),
        '303',
        'a repost that fills before its first receipt is still a confirmed '
            + 'non-repeatable success'
    );

    const ambiguousNewListing =
        MarketMaintenance.matchNewActiveListing({
            baselineListingIds: new Set([101]),
            endMarketListings: [
                ownMarketListing({
                    id: 301,
                    price: 950,
                    orderQuantity: 6,
                }),
                ownMarketListing({
                    id: 302,
                    price: 950,
                    orderQuantity: 6,
                }),
            ],
            expected: expectedPost,
        });
    assert.equal(
        ambiguousNewListing.status,
        'unknown',
        'multiple indistinguishable new active listings must never be '
            + 'claimed as a confirmed repost'
    );
    assert.equal(ambiguousNewListing.listingId, undefined);

    const postPayload = MarketMaintenance.createPostPayload({
        itemId: 'gobo_stabber',
        level: 20,
        quantity: 6,
        price: 950,
    });
    assert.equal(postPayload.type, 'post_market_order');
    assert.equal(postPayload.postMarketOrderData.isSell, true);
    assert.equal(
        postPayload.postMarketOrderData.itemHrid,
        '/items/gobo_stabber'
    );
    assert.equal(postPayload.postMarketOrderData.enhancementLevel, 20);
    assert.equal(postPayload.postMarketOrderData.quantity, 6);
    assert.equal(postPayload.postMarketOrderData.price, 950);
    assert.equal(postPayload.postMarketOrderData.isInstantOrder, false);
    assert.equal(
        postPayload.postMarketOrderData.confirmedMisprice,
        false,
        'automatic market posts must never pre-confirm a misprice'
    );

    const warningOutcome = MarketMaintenance.applyMispriceWarning(
        {
            enabled: true,
            status: 'posting',
            pendingPost: postPayload,
        },
        {
            type: 'misprice_warning',
            ...expectedPost,
            listingPrice: expectedPost.price,
        }
    );
    assert.equal(warningOutcome.state.enabled, false);
    assert.equal(warningOutcome.state.status, 'disabled');
    assert.equal(warningOutcome.outboundPayload, null);
    assert.doesNotMatch(
        JSON.stringify(warningOutcome),
        /"confirmedMisprice":true/,
        'misprice_warning disables maintenance instead of retrying with '
            + 'confirmedMisprice=true'
    );
}

function lastSentMessage() {
    return JSON.parse(socket.sent.at(-1));
}

async function flushMicrotasks(count = 4) {
    for (let index = 0; index < count; index++) {
        await Promise.resolve();
    }
}

async function waitUntil(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('timed out waiting for runtime condition');
}

async function driveRepriceUntilPost({
    run,
    itemId = 'gobo_stabber',
    oldListing,
    cancelFinalListing,
    inventoryAfterClaim,
    competitorPrice = 950,
    claimInventoryFirst = true,
}) {
    State.marketBusy = true;
    const maintenancePromise = MarketMaintenance.pollAndMaintain(
        run,
        itemId
    );
    await flushMicrotasks();
    assert.equal(
        lastSentMessage().type,
        'get_market_item_order_books'
    );

    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            itemId,
            [
                marketAsk(201, competitorPrice),
                marketAsk(
                    oldListing.id,
                    oldListing.price,
                    oldListing.orderQuantity -
                        oldListing.filledQuantity
                ),
            ]
        ),
    });
    await flushMicrotasks();
    assert.equal(lastSentMessage().type, 'cancel_market_listing');
    assert.equal(
        String(
            lastSentMessage().cancelMarketListingData.marketListingId
        ),
        String(oldListing.id)
    );

    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [cancelFinalListing],
    });
    await flushMicrotasks();
    assert.equal(lastSentMessage().type, 'claim_market_listing');
    assert.equal(
        String(
            lastSentMessage().claimMarketListingData.marketListingId
        ),
        String(oldListing.id)
    );
    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...cancelFinalListing,
            status: '/market_listing_status/active',
            unclaimedItemCount: 0,
            unclaimedCoinCount: 0,
        }],
    });
    await flushMicrotasks();
    assert.equal(
        lastSentMessage().type,
        'claim_market_listing',
        'a delayed stale Active listing with zero unclaimed fields must '
            + 'not be mistaken for the claim acknowledgement'
    );

    const clearedListing = {
            ...cancelFinalListing,
            unclaimedItemCount: 0,
            unclaimedCoinCount: 0,
    };
    const inventoryMessage = {
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem(
                itemId,
                20,
                inventoryAfterClaim
            ),
        ],
    };
    const clearedListingMessage = {
        type: 'market_listings_updated',
        endMarketListings: [clearedListing],
    };
    if (claimInventoryFirst) {
        socket.emitMessage(inventoryMessage);
        await flushMicrotasks();
        assert.equal(
            lastSentMessage().type,
            'claim_market_listing',
            'inventory alone cannot confirm a claim'
        );
        socket.emitMessage(clearedListingMessage);
    } else {
        socket.emitMessage(clearedListingMessage);
        await flushMicrotasks();
        assert.equal(
            lastSentMessage().type,
            'claim_market_listing',
            'listing clearance alone cannot confirm a claim'
        );
        socket.emitMessage(inventoryMessage);
    }
    await flushMicrotasks();
    assert.equal(
        lastSentMessage().type,
        'get_market_item_order_books',
        'the workflow refreshes the book after claiming and before posting'
    );

    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            itemId,
            [marketAsk(201, competitorPrice)]
        ),
    });
    await flushMicrotasks();
    assert.equal(lastSentMessage().type, 'post_market_order');
    return {maintenancePromise};
}

async function driveNoOwnTwoQuotePost({
    run,
    inventoryCount,
    listingId,
    itemId = 'gobo_stabber',
    leftOnePrice = 950,
    expectedPrice = 940,
}) {
    State.marketBusy = true;
    const sentBefore = socket.sent.length;
    const firstPoll = MarketMaintenance.pollAndMaintain(run, itemId);
    await flushMicrotasks();
    assert.equal(lastSentMessage().type, 'get_market_item_order_books');
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            itemId,
            [marketAsk(801, leftOnePrice)]
        ),
    });
    const firstResult = await firstPoll;
    assert.equal(firstResult.needsAnotherPoll, true);
    assert.equal(
        State.marketItemStatus.get(itemId).kind,
        'confirming_quote'
    );
    assert.equal(
        socket.sent.length,
        sentBefore + 1,
        'the first independent quote is read-only'
    );

    const secondPoll = MarketMaintenance.pollAndMaintain(run, itemId);
    await flushMicrotasks();
    assert.equal(lastSentMessage().type, 'get_market_item_order_books');
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            itemId,
            [marketAsk(801, leftOnePrice)]
        ),
    });
    await flushMicrotasks();
    const post = lastSentMessage();
    assert.equal(post.type, 'post_market_order');
    assert.equal(post.postMarketOrderData.quantity, inventoryCount - 1);
    assert.equal(post.postMarketOrderData.price, expectedPrice);
    assert.equal(post.postMarketOrderData.isInstantOrder, false);

    socket.emitMessage({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem(itemId, 20, 1),
        ],
    });
    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [
            ownMarketListing({
                id: listingId,
                itemId,
                price: expectedPrice,
                orderQuantity: inventoryCount - 1,
            }),
        ],
    });
    const result = await secondPoll;
    State.marketBusy = false;
    assert.equal(result.posted, true);
    assert.equal(result.quantity, inventoryCount - 1);
    assert.equal(result.price, expectedPrice);
    assert.equal(State.inventory.get(itemId)?.[20], 1);
    return {post, result};
}

async function runMarketMaintenanceStateMachineTests() {
    assert.ok(MarketTransactions);
    MarketMaintenance.stopScheduling();
    State.settings.marketMaintenanceEnabled = true;
    State.marketWriteBlockedReason = '';

    emitFullInit({myMarketListings: []});
    let run = createRun(189);
    run.marketMaintenanceEnabled = true;
    run.marketMaxDropPercent = 10;
    State.run = run;
    State.marketBusy = true;
    const sentBeforeReadOnly = socket.sent.length;
    const readOnlyPromise = MarketMaintenance.pollAndMaintain(
        run,
        'gobo_stabber'
    );
    await flushMicrotasks();
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            'gobo_stabber',
            [marketAsk(201, 950)]
        ),
    });
    await readOnlyPromise;
    State.marketBusy = false;
    assert.equal(
        socket.sent.length,
        sentBeforeReadOnly + 1,
        'with no excess +20 inventory the state machine only reads'
    );
    assert.equal(
        State.marketItemStatus.get('gobo_stabber').kind,
        'reserve_only'
    );
    run.active = false;
    State.run = null;

    for (const [inventoryCount, listingId] of [
        [2, 381],
        [50, 382],
    ]) {
        emitFullInit({
            characterItems: [
                inventoryItem('philosophers_mirror', 0, 20000),
                inventoryItem(
                    'gobo_stabber',
                    20,
                    inventoryCount
                ),
                characterItem(
                    'grandmaster_enhancing_charm',
                    0,
                    1,
                    '/item_locations/charm'
                ),
            ],
            myMarketListings: [],
        });
        run = createRun(18900 + inventoryCount);
        run.marketMaintenanceEnabled = true;
        run.marketMaxDropPercent = 10;
        State.run = run;
        await driveNoOwnTwoQuotePost({
            run,
            inventoryCount,
            listingId,
        });
        assert.equal(
            State.marketItemStatus.get('gobo_stabber').kind,
            'listed_new'
        );
        run.active = false;
        State.run = null;
    }

    const stoppedReadListing = ownMarketListing({
        id: 391,
        price: 1000,
        orderQuantity: 1,
    });
    emitFullInit({myMarketListings: [stoppedReadListing]});
    run = createRun(1891);
    run.marketMaintenanceEnabled = true;
    run.marketMaxDropPercent = 10;
    State.run = run;
    State.marketBusy = true;
    const sentBeforeStoppedRead = socket.sent.length;
    const stoppedReadPromise = MarketMaintenance.pollAndMaintain(
        run,
        'gobo_stabber'
    );
    await flushMicrotasks();
    assert.equal(
        lastSentMessage().type,
        'get_market_item_order_books'
    );
    run.stopRequested = true;
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(201, 950),
                marketAsk(391, 1000),
            ]
        ),
    });
    await stoppedReadPromise;
    State.marketBusy = false;
    assert.equal(
        socket.sent.length,
        sentBeforeStoppedRead + 1,
        'a stop received during a market read prevents a new cancel'
    );
    run.active = false;
    State.run = null;

    const interruptedAfterClaimListing = ownMarketListing({
        id: 395,
        price: 1000,
        orderQuantity: 1,
    });
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 0),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        myMarketListings: [interruptedAfterClaimListing],
    });
    run = createRun(1892);
    run.marketMaintenanceEnabled = true;
    run.marketMaxDropPercent = 10;
    State.run = run;
    State.marketBusy = true;
    const sentBeforeInterruptedClaim = socket.sent.length;
    const interruptedClaimPromise =
        MarketMaintenance.pollAndMaintain(
            run,
            'gobo_stabber'
        );
    await flushMicrotasks();
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(201, 950),
                marketAsk(395, 1000),
            ]
        ),
    });
    await flushMicrotasks();
    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...interruptedAfterClaimListing,
            status: '/market_listing_status/cancelled',
            unclaimedItemCount: 1,
        }],
    });
    await flushMicrotasks();
    socket.emitMessage({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem('gobo_stabber', 20, 1),
        ],
    });
    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [{
            ...interruptedAfterClaimListing,
            status: '/market_listing_status/cancelled',
            unclaimedItemCount: 0,
            unclaimedCoinCount: 0,
        }],
    });
    run.integrityFailure = 'interference after claim';
    run.stopRequested = true;
    State.blockedReason = 'interference after claim';
    await assert.rejects(
        interruptedClaimPromise,
        /完整性|状态已失效/
    );
    assert.equal(
        socket.sent.length,
        sentBeforeInterruptedClaim + 3,
        'after claim, an integrity lock leaves the item in inventory '
            + 'without another order-book read or repost'
    );
    assert.equal(lastSentMessage().type, 'claim_market_listing');
    State.marketBusy = false;
    run.active = false;
    State.run = null;
    State.blockedReason = '';
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;

    const oldListing = ownMarketListing({
        id: 401,
        price: 1000,
        orderQuantity: 10,
        filledQuantity: 0,
    });
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 2),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        myMarketListings: [oldListing],
    });
    run = createRun(190);
    run.marketMaintenanceEnabled = true;
    run.marketMaxDropPercent = 10;
    State.run = run;
    const sentBeforeReprice = socket.sent.length;
    const {maintenancePromise: repricePromise} =
        await driveRepriceUntilPost({
        run,
        oldListing,
        cancelFinalListing: {
            ...oldListing,
            status: '/market_listing_status/cancelled',
            filledQuantity: 4,
            unclaimedItemCount: 6,
            unclaimedCoinCount: 200,
        },
        inventoryAfterClaim: 8,
        });
    const posted = lastSentMessage();
    assert.deepEqual(
        {
            isSell: posted.postMarketOrderData.isSell,
            itemHrid: posted.postMarketOrderData.itemHrid,
            enhancementLevel:
                posted.postMarketOrderData.enhancementLevel,
            quantity: posted.postMarketOrderData.quantity,
            price: posted.postMarketOrderData.price,
            isInstantOrder:
                posted.postMarketOrderData.isInstantOrder,
            confirmedMisprice:
                posted.postMarketOrderData.confirmedMisprice,
        },
        {
            isSell: true,
            itemHrid: '/items/gobo_stabber',
            enhancementLevel: 20,
            quantity: 7,
            price: 940,
            isInstantOrder: false,
            confirmedMisprice: false,
        },
        'after a partial fill, the repost uses the latest physical '
            + 'inventory minus the one-item reserve'
    );
    socket.emitMessage({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem('gobo_stabber', 20, 1),
        ],
    });
    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [
            ownMarketListing({
                id: 402,
                price: 940,
                orderQuantity: 7,
            }),
        ],
    });
    await repricePromise;
    State.marketBusy = false;
    assert.equal(State.marketOp, null);
    assert.equal(
        State.marketItemStatus.get('gobo_stabber').kind,
        'repriced'
    );
    assert.equal(
        socket.sent.slice(sentBeforeReprice)
            .map((raw) => JSON.parse(raw))
            .some((message) => (
                message.postMarketOrderData
                    ?.confirmedMisprice === true
            )),
        false,
        'the complete workflow never auto-confirms a misprice'
    );
    run.active = false;
    State.run = null;

    const immediatelySoldSource = ownMarketListing({
        id: 451,
        price: 1000,
        orderQuantity: 2,
    });
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 0),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        myMarketListings: [immediatelySoldSource],
    });
    run = createRun(1901);
    run.marketMaintenanceEnabled = true;
    run.marketMaxDropPercent = 10;
    State.run = run;
    const sentBeforeImmediatelySold = socket.sent.length;
    const {maintenancePromise: immediatelySoldPromise} =
        await driveRepriceUntilPost({
            run,
            oldListing: immediatelySoldSource,
            cancelFinalListing: {
                ...immediatelySoldSource,
                status: '/market_listing_status/cancelled',
                unclaimedItemCount: 2,
            },
            inventoryAfterClaim: 2,
        });
    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [
            ownMarketListing({
                id: 452,
                status: '/market_listing_status/filled',
                price: 940,
                orderQuantity: 1,
                filledQuantity: 1,
                unclaimedItemCount: 0,
                unclaimedCoinCount: 940,
            }),
        ],
    });
    await flushMicrotasks();
    assert.equal(
        lastSentMessage().type,
        'claim_market_listing',
        'an immediately filled repost is claimed, not posted again'
    );
    assert.equal(
        String(
            lastSentMessage().claimMarketListingData.marketListingId
        ),
        '452'
    );
    socket.emitMessage({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem('gobo_stabber', 20, 1),
        ],
    });
    await flushMicrotasks();
    assert.equal(
        lastSentMessage().type,
        'claim_market_listing',
        'the delayed post inventory deduction must not be confused with '
            + 'the coin-only claim'
    );
    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [
            ownMarketListing({
                id: 452,
                status: '/market_listing_status/filled',
                price: 940,
                orderQuantity: 1,
                filledQuantity: 1,
                unclaimedItemCount: 0,
                unclaimedCoinCount: 0,
            }),
        ],
    });
    await immediatelySoldPromise;
    State.marketBusy = false;
    assert.equal(
        State.marketItemStatus.get('gobo_stabber').kind,
        'sold_during_post'
    );
    assert.equal(
        socket.sent.slice(sentBeforeImmediatelySold)
            .map((raw) => JSON.parse(raw))
            .filter((message) => (
                message.type === 'post_market_order'
            )).length,
        1,
        'a first-receipt Filled listing confirms the one post and is never '
            + 'automatically posted again'
    );
    run.active = false;
    State.run = null;

    const warningListing = ownMarketListing({
        id: 501,
        price: 1000,
        orderQuantity: 3,
    });
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 0),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        myMarketListings: [warningListing],
    });
    State.settings.marketMaintenanceEnabled = true;
    State.marketWriteBlockedReason = '';
    run = createRun(191);
    run.mode = 'verified';
    run.marketMaintenanceEnabled = true;
    run.marketMaxDropPercent = 10;
    State.run = run;
    const sentBeforeWarning = socket.sent.length;
    const {maintenancePromise: warningPromise} =
        await driveRepriceUntilPost({
        run,
        oldListing: warningListing,
        cancelFinalListing: {
            ...warningListing,
            status: '/market_listing_status/cancelled',
            unclaimedItemCount: 3,
        },
        inventoryAfterClaim: 3,
        claimInventoryFirst: false,
    });
    const warningPost = lastSentMessage().postMarketOrderData;
    socket.emitMessage({
        type: 'misprice_warning',
        isSell: warningPost.isSell,
        itemHrid: warningPost.itemHrid,
        enhancementLevel: warningPost.enhancementLevel,
        quantity: warningPost.quantity,
        listingPrice: warningPost.price,
        isInstantOrder: warningPost.isInstantOrder,
    });
    await assert.rejects(
        warningPromise,
        /错价|人工确认/
    );
    State.marketBusy = false;
    assert.equal(State.settings.marketMaintenanceEnabled, false);
    assert.match(State.marketWriteBlockedReason, /错价/);
    assert.equal(
        run.stopRequested,
        false,
        'a known-not-applied misprice warning disables market writes '
            + 'without stopping verified enhancement'
    );
    assert.equal(
        run.marketInventoryOffsets.get('gobo_stabber'),
        3,
        'claimed items retained after a warning are excluded from later '
            + 'verified +20 production deltas'
    );
    const continuedFingerprint = actionFingerprint(19, 20);
    const continuedPayload = createEnhancePayload(
        run,
        'gobo_stabber',
        {startLevel: 19, targetLevel: 20},
        'verified'
    ).payload;
    const continuedVerifiedPromise = Transactions.begin(run, {
        kind: 'verified',
        itemId: 'gobo_stabber',
        fingerprint: continuedFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'verified continuation timeout',
        payload: continuedPayload,
    });
    const continuedAction = actionFromFingerprint(
        8801,
        continuedFingerprint
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [continuedAction],
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            ...continuedAction,
            isDone: true,
        },
    });
    socket.emitMessage({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem('gobo_stabber', 20, 4),
        ],
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{
            ...continuedAction,
            isDone: true,
        }],
    });
    assert.equal(
        (await continuedVerifiedPromise).status,
        'confirmed',
        'known claimed inventory retained after a warning does not stop '
            + 'the next real +20 output from being verified'
    );
    assert.equal(
        socket.sent.slice(sentBeforeWarning)
            .map((raw) => JSON.parse(raw))
            .filter((message) => (
                message.type === 'post_market_order'
            )).length,
        1,
        'a misprice warning never causes a second post request'
    );

    run.active = false;
    State.run = null;
    State.settings.marketMaintenanceEnabled = true;
    State.marketWriteBlockedReason = '';

    const timeoutListing = ownMarketListing({
        id: 551,
        price: 1000,
        orderQuantity: 1,
    });
    emitFullInit({myMarketListings: [timeoutListing]});
    run = createRun(192);
    run.marketMaintenanceEnabled = true;
    run.marketMaxDropPercent = 10;
    State.run = run;
    State.marketBusy = true;
    const sentBeforeTimeout = socket.sent.length;
    const timeoutOutcome = await MarketTransactions.begin(run, {
        kind: 'cancel',
        itemId: 'gobo_stabber',
        listingId: timeoutListing.id,
        expectedListing: timeoutListing,
        timeoutMs: 15,
        timeoutMessage: 'market cancel timeout test',
        payload: {
            type: 'cancel_market_listing',
            cancelMarketListingData: {
                marketListingId: timeoutListing.id,
            },
        },
    });
    assert.equal(timeoutOutcome.status, 'unknown');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
        socket.sent.length,
        sentBeforeTimeout + 1,
        'an uncertain market write is never automatically resent'
    );
    State.marketBusy = false;
    run.active = false;
    State.run = null;

    run = createRun(193);
    run.active = false;
    run.marketMaintenanceEnabled = true;
    run.ownedActionIds.add('99991');
    State.run = run;
    State.blockedReason = '';
    assert.equal(MarketMaintenance.isMonitoringRun(run), true);
    run.integrityFailure = 'tail integrity failure';
    assert.equal(
        MarketMaintenance.isMonitoringRun(run),
        false,
        'quick-tail market monitoring stops after queue integrity fails'
    );
    run.integrityFailure = '';
    State.blockedReason = 'locked full state';
    assert.equal(
        MarketMaintenance.isMonitoringRun(run),
        false,
        'a globally blocked enhancer cannot start another market cycle'
    );
    State.blockedReason = '';
    run.ownedActionIds.clear();
    State.run = null;

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 2),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        myMarketListings: [],
    });
    run = createRun(194);
    run.active = false;
    run.status = 'completed';
    run.marketMaintenanceEnabled = true;
    run.marketMaxDropPercent = 10;
    State.run = run;
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    assert.equal(
        MarketMaintenance.beginFinalSweep(run),
        true,
        'a healthy completed run can enter the final market sweep'
    );
    MarketMaintenance.stopScheduling();
    run.marketQuoteConfirmations.set(
        'gobo_stabber',
        {
            price: 950,
            at: Date.now(),
            bookSequence: State.marketOrderBookSequence,
        }
    );
    const sentBeforeFinalSweep = socket.sent.length;
    const finalSweepPromise = MarketMaintenance.tick();
    await flushMicrotasks();
    assert.equal(lastSentMessage().type, 'get_market_item_order_books');
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            'gobo_stabber',
            [marketAsk(891, 950)]
        ),
    });
    await flushMicrotasks();
    const finalSweepPost = lastSentMessage();
    assert.equal(finalSweepPost.type, 'post_market_order');
    assert.equal(finalSweepPost.postMarketOrderData.quantity, 1);
    assert.equal(finalSweepPost.postMarketOrderData.price, 940);
    socket.emitMessage({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem('gobo_stabber', 20, 1),
        ],
    });
    socket.emitMessage({
        type: 'market_listings_updated',
        endMarketListings: [
            ownMarketListing({
                id: 892,
                price: 940,
                orderQuantity: 1,
            }),
        ],
    });
    await finalSweepPromise;
    assert.equal(run.marketFinalSweepPending, false);
    assert.equal(run.marketFinalSweepRemaining.size, 0);
    assert.equal(run.marketSteadyMonitoring, true);
    assert.equal(
        run.currentStage,
        '已结束；市场最终扫尾完成，持续监控左一与成交'
    );
    assert.deepEqual(
        socket.sent.slice(sentBeforeFinalSweep)
            .map((raw) => JSON.parse(raw).type),
        [
            'get_market_item_order_books',
            'post_market_order',
        ],
        'one final-sweep item performs one read and one reserve-safe post'
    );
    MarketMaintenance.stopScheduling();
    const sentBeforeSteadyRead = socket.sent.length;
    const steadyReadPromise = MarketMaintenance.tick();
    await flushMicrotasks();
    assert.equal(lastSentMessage().type, 'get_market_item_order_books');
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            'gobo_stabber',
            [
                marketAsk(892, 940),
                marketAsk(893, 960),
            ]
        ),
    });
    await steadyReadPromise;
    assert.deepEqual(
        socket.sent.slice(sentBeforeSteadyRead)
            .map((raw) => JSON.parse(raw).type),
        ['get_market_item_order_books'],
        'steady monitoring must keep reading after the final sweep without '
            + 'self-undercutting an already-lowest listing'
    );
    MarketMaintenance.stopScheduling();
    run.marketSteadyMonitoring = false;
    State.run = null;
    emitFullInit();
}

async function runAdditionalMarketHardeningTests() {
    State.run = null;
    State.blockedReason = '';
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    State.settings.marketAutoSellExcessEnabled = true;
    State.marketOutstandingOrderBookReads.clear();
    State.marketExternalOrderBookGeneration.clear();
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 2),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
    });

    let run = createRun(800);
    run.active = false;
    run.status = 'queued';
    run.marketMaintenanceEnabled = false;
    const tailFingerprint = actionFingerprint(19, 20);
    seedOwnedAction(run, 1800, tailFingerprint, 80);
    State.run = run;
    assert.throws(
        () => buildBatchPlan(),
        /已有批次.*收束/,
        'a completed send loop cannot be replaced while its owned action '
            + 'still awaits completion/removal convergence'
    );
    State.actions.delete('1800');
    run.ownedActionIds.clear();
    run.ownedActionFingerprints.clear();
    run.ownedActionOrder.length = 0;
    run.ownedRemovalPending.set('1800', {timer: null});
    assert.throws(
        () => buildBatchPlan(),
        /已有批次.*收束/,
        'a pending owned-action removal check must block a replacement run'
    );
    run.ownedRemovalPending.clear();
    run.ownedOrderValidationPending = true;
    assert.throws(
        () => buildBatchPlan(),
        /已有批次.*收束/,
        'a pending owned-order validation must block a replacement run'
    );
    run.ownedOrderValidationPending = false;

    run = createRun(801);
    run.active = false;
    run.status = 'completed';
    run.stopRequested = true;
    State.run = run;
    const settlingBarrier = {
        postConfirmed: true,
        inventoryBeforePost: 2,
        expectedAfterPost: 1,
        lastObservedInventoryCount: null,
        lastObservedSequence: 0,
        inventoryMatched: false,
        confirmedAt: Date.now(),
        postReceiptSequence: State.incomingSequence,
        allowPreReceiptInventory: false,
        guardTimer: null,
    };
    run.marketPostInventoryBarriers.set(
        'gobo_stabber',
        settlingBarrier
    );
    MarketMaintenance.armPostInventoryBarrierGuard(
        run,
        'gobo_stabber',
        settlingBarrier
    );
    assert.throws(
        () => buildBatchPlan(),
        /已有批次.*收束/,
        'an acknowledged post with an unsettled absolute inventory value '
            + 'must block a new batch even after stop'
    );
    socket.emitMessage({
        type: 'items_updated',
        endCharacterItems: [
            inventoryItem('gobo_stabber', 20, 1),
        ],
    });
    assert.equal(run.marketPostInventoryBarriers.size, 0);
    assert.equal(State.blockedReason, '');
    assert.doesNotThrow(
        () => buildBatchPlan(),
        'the exact causal inventory receipt releases the stopped run tail'
    );

    const expiringBarrier = {
        postConfirmed: true,
        inventoryBeforePost: 2,
        expectedAfterPost: 0,
        lastObservedInventoryCount: null,
        lastObservedSequence: 0,
        inventoryMatched: false,
        confirmedAt:
            Date.now() - CONFIG.INVENTORY_COMMIT_GRACE_MS - 1,
        postReceiptSequence: State.incomingSequence,
        allowPreReceiptInventory: false,
        guardTimer: null,
    };
    run.marketPostInventoryBarriers.set(
        'gobo_stabber',
        expiringBarrier
    );
    assert.equal(
        MarketMaintenance.expirePostInventoryBarrier(
            run,
            'gobo_stabber',
            expiringBarrier
        ),
        true
    );
    assert.match(State.blockedReason, /库存绝对值.*完整刷新/s);
    assert.throws(() => buildBatchPlan(), /刷新/);
    MarketMaintenance.clearPostInventoryBarrier(
        run,
        'gobo_stabber',
        expiringBarrier
    );

    State.run = null;
    State.blockedReason = '';
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    State.settings.marketAutoSellExcessEnabled = true;
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 1),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        myMarketListings: [
            ownMarketListing({
                id: 1810,
                price: 1000,
                orderQuantity: 5,
            }),
        ],
    });
    run = createRun(802);
    run.marketMaintenanceEnabled = true;
    State.run = run;
    const repriceDecision = {
        kind: 'reprice',
        ownListing: State.myMarketListings.get('1810'),
        oldPrice: 1000,
        newPrice: 980,
        anchorPrice: 1000,
        minimumAllowedPrice: 900,
        inventoryCount: 1,
        excessQuantity: 0,
        leftOne: marketAsk(1811, 990),
    };
    let sentBefore = socket.sent.length;
    State.hasAcceptedTradingRules = false;
    await MarketMaintenance.repriceListing(
        run,
        'gobo_stabber',
        repriceDecision
    );
    assert.equal(
        socket.sent.length,
        sentBefore,
        'changed trading access is rejected before cancelling a healthy ask'
    );
    assert.equal(
        State.myMarketListings.get('1810').status,
        '/market_listing_status/active'
    );

    State.hasAcceptedTradingRules = true;
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    State.settings.marketAutoSellExcessEnabled = true;
    run.stopRequested = false;
    State.marketListingCap = 0;
    sentBefore = socket.sent.length;
    await MarketMaintenance.repriceListing(
        run,
        'gobo_stabber',
        repriceDecision
    );
    assert.equal(
        socket.sent.length,
        sentBefore,
        'repricing is rejected before cancel when no repost slot can be '
            + 'proved'
    );
    State.marketListingCap = 20;

    State.run = null;
    State.blockedReason = '';
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    State.settings.marketAutoSellExcessEnabled = true;
    State.marketOutstandingOrderBookReads.clear();
    State.marketExternalOrderBookGeneration.clear();
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 2),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        myMarketListings: [],
    });
    run = createRun(803);
    run.active = false;
    run.status = 'completed';
    run.marketMaintenanceEnabled = true;
    State.run = run;
    assert.equal(MarketMaintenance.beginFinalSweep(run), true);
    MarketMaintenance.stopScheduling();
    const volatileSentBefore = socket.sent.length;
    for (
        const [index, price]
        of [1000, 990, 980, 970, 960, 950].entries()
    ) {
        const tickPromise = MarketMaintenance.tick();
        await flushMicrotasks();
        assert.equal(
            lastSentMessage().type,
            'get_market_item_order_books'
        );
        socket.emitMessage({
            type: 'market_item_order_books_updated',
            marketItemOrderBooks: marketOrderBookSnapshot(
                'gobo_stabber',
                [marketAsk(1820 + index, price)]
            ),
        });
        await tickPromise;
        MarketMaintenance.stopScheduling();
        if (index === 1) {
            assert.equal(
                run.marketPriorityItemId,
                null,
                'a changed second quote releases priority so another item '
                    + 'cannot be starved'
            );
        }
    }
    assert.equal(run.marketFinalSweepPending, false);
    assert.equal(run.marketFinalSweepPhase, 'completed');
    assert.equal(run.marketSteadyMonitoring, true);
    assert.deepEqual(
        socket.sent.slice(volatileSentBefore)
            .map((raw) => JSON.parse(raw).type),
        new Array(6).fill('get_market_item_order_books'),
        'a perpetually moving first-post quote is bounded and never guessed'
    );
    run.marketSteadyMonitoring = false;
    MarketMaintenance.stopScheduling();

    State.run = null;
    State.blockedReason = '';
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    State.settings.marketAutoSellExcessEnabled = true;
    State.marketOutstandingOrderBookReads.clear();
    State.marketExternalOrderBookGeneration.clear();
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 2),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        myMarketListings: [],
    });
    run = createRun(804);
    run.marketMaintenanceEnabled = true;
    State.run = run;
    const contaminatedSentBefore = socket.sent.length;
    const contaminatedTick = MarketMaintenance.tick();
    await flushMicrotasks();
    assert.equal(lastSentMessage().type, 'get_market_item_order_books');
    socket.send(JSON.stringify({
        type: 'get_market_item_order_books',
        getMarketItemOrderBooksData: {
            itemHrid: '/items/gobo_stabber',
        },
    }));
    assert.equal(
        State.marketOutstandingOrderBookReads.get('gobo_stabber'),
        2
    );
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            'gobo_stabber',
            [marketAsk(1830, 1000)]
        ),
    });
    await flushMicrotasks();
    assert.notEqual(
        State.marketOp,
        null,
        'the first ambiguous response cannot settle the script read'
    );
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            'gobo_stabber',
            [marketAsk(1831, 1000)]
        ),
    });
    await contaminatedTick;
    MarketMaintenance.stopScheduling();
    assert.equal(State.marketOp, null);
    assert.equal(
        State.marketOutstandingOrderBookReads.has('gobo_stabber'),
        false
    );
    assert.equal(
        run.marketQuoteConfirmations.has('gobo_stabber'),
        false,
        'two ambiguous same-item responses are discarded rather than used '
            + 'as a trusted double quote'
    );
    assert.deepEqual(
        socket.sent.slice(contaminatedSentBefore)
            .map((raw) => JSON.parse(raw).type),
        [
            'get_market_item_order_books',
            'get_market_item_order_books',
        ]
    );

    State.run = null;
    State.blockedReason = '';
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    State.settings.marketAutoSellExcessEnabled = true;
    State.marketOutstandingOrderBookReads.clear();
    State.marketExternalOrderBookGeneration.clear();
    emitFullInit();
    run = createRun(805);
    run.marketMaintenanceEnabled = true;
    State.run = run;
    State.marketBusy = true;
    const timedOutRead = MarketTransactions.begin(run, {
        kind: 'order_book',
        itemId: 'gobo_stabber',
        timeoutMs: 20,
        timeoutMessage: 'synthetic order book timeout',
        payload: {
            type: 'get_market_item_order_books',
            getMarketItemOrderBooksData: {
                itemHrid: '/items/gobo_stabber',
            },
        },
    });
    const timedOutOutcome = await timedOutRead;
    State.marketBusy = false;
    assert.equal(timedOutOutcome.status, 'unknown');
    assert.equal(
        State.marketOutstandingOrderBookReads.has('gobo_stabber'),
        false,
        'a failed owned read releases its tracker before market automation '
            + 'is refresh-locked'
    );
    assert.match(
        State.marketWriteBlockedReason,
        /盘口请求.*完整刷新/s
    );
    assert.equal(State.settings.marketMaintenanceEnabled, false);
    socket.emitMessage({
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: marketOrderBookSnapshot(
            'gobo_stabber',
            [marketAsk(1840, 1000)]
        ),
    });
    assert.notEqual(
        State.marketWriteBlockedReason,
        '',
        'a late response cannot silently unlock market writes'
    );

    State.run = null;
    State.blockedReason = '';
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    State.settings.marketAutoSellExcessEnabled = true;
    State.marketOutstandingOrderBookReads.clear();
    State.marketExternalOrderBookGeneration.clear();
    emitFullInit();
}

async function runPersistentRecoveryTests() {
    for (const [name, value] of Object.entries({
        createRecoveryJournal,
        enumeratePlanCommands,
        reconcileRecoveryJournal,
        strictSingleEnhanceActionMatches,
    })) {
        assert.equal(
            typeof value,
            'function',
            `v1.5.0 runtime tests require export ${name}`
        );
    }

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.run = null;
    State.blockedReason = '';
    State.settings.marketMaintenanceEnabled = false;
    State.settings.marketAutoSellExcessEnabled = false;
    State.settings.mode = 'quick';
    State.settings.useExistingInventory = false;
    State.settings.targetCount = 2;
    State.selected.clear();
    State.selected.add('gobo_stabber');
    emitFullInit();

    const frozenBatchPlan = buildBatchPlan();
    assert.equal(frozenBatchPlan.summary.sendCommands, 110);

    const makeJournal = () => {
        const journal = createRecoveryJournal(frozenBatchPlan);
        confirmRecoveryPurchases(journal);
        return journal;
    };

    let journal = makeJournal();
    let commands = enumeratePlanCommands(
        journal.itemPlans,
        journal.mode
    );
    assert.equal(commands.length, 110);
    assert.equal(commands[54].commandKey, '0:0:54');
    assert.equal(commands[55].commandKey, '0:1:0');
    assert.equal(commands[99].commandKey, '0:1:44');

    const acknowledged99 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        99
    );
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(acknowledged99)
    );
    let recovery = reconcileRecoveryJournal(journal);
    assert.equal(recovery.orderedRecords.length, 99);
    assert.equal(recovery.presentOwned.length, 99);
    assert.equal(journal.acked.length, 99);
    assert.equal(
        recovery.commands.length - journal.acked.length,
        11,
        'refresh recovery must continue after the acknowledged prefix'
    );
    assert.equal(
        recovery.commands[journal.acked.length].commandKey,
        '0:1:44',
        '99 acknowledged commands mean one complete 55-command output '
            + 'plus 44 commands of the second output'
    );
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = null;
    const hydratedPrefixPlan = buildBatchPlan();
    assert.equal(hydratedPrefixPlan.isRecovery, true);
    assert.equal(
        hydratedPrefixPlan.recovery.orderedRecords.length,
        99,
        'the authoritative queue and persisted journal are rehydrated '
            + 'instead of starting a fresh 110-command batch'
    );
    assert.equal(
        hydratedPrefixPlan.recovery.commands.length -
            hydratedPrefixPlan.recoveryJournal.acked.length,
        11
    );
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;

    State.settings.targetCount = 80;
    emitFullInit({actionQueueCap: 100});
    const largeBatchPlan = buildBatchPlan();
    assert.equal(
        largeBatchPlan.summary.sendCommands,
        4400,
        '80 outputs reproduce the reported 4400-command batch scale'
    );
    const largeJournal = createRecoveryJournal(largeBatchPlan);
    confirmRecoveryPurchases(largeJournal);
    const largeCommands = enumeratePlanCommands(
        largeJournal.itemPlans,
        largeJournal.mode
    );
    const largeAcknowledged500 = acknowledgeRecoveryPrefix(
        largeJournal,
        largeCommands,
        500,
        200_000
    );
    const interruptedCommand = largeCommands[500];
    const interruptedFingerprint = recoveryFingerprint(
        largeJournal,
        interruptedCommand
    );
    largeJournal.inFlight = {
        type: 'action',
        commandKey: interruptedCommand.commandKey,
        commandIndex: interruptedCommand.commandIndex,
        baselineActionIds: largeAcknowledged500.map(
            (record) => record.actionId
        ),
        predecessorId: largeAcknowledged500.at(-1).actionId,
        sentAt: Date.now() - 1000,
        phase: 'sent',
        errorCode: 'CODE_INTERRUPTED',
        observedActionIds: [],
        fingerprint: interruptedFingerprint,
    };
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            largeAcknowledged500,
            401
        )
    );
    const largeRecovery = reconcileRecoveryJournal(largeJournal);
    assert.equal(
        largeJournal.acked.length,
        500,
        'the 500 exact receipts stay intact while the interrupted '
            + 'dependency remains the next required position'
    );
    assert.equal(
        largeJournal.inFlight.phase,
        'retry_authorized'
    );
    assert.equal(largeJournal.inFlight.commandKey, largeCommands[500].commandKey);
    assert.equal(largeJournal.inFlight.retrySequence, 1);
    assert.equal(
        largeRecovery.commands.length - largeJournal.acked.length,
        3900,
        'the interrupted command remains part of the dependent suffix'
    );
    assert.equal(
        largeRecovery.commands[largeJournal.acked.length].commandKey,
        largeCommands[500].commandKey,
        'recovery must resend command 501 before command 502'
    );
    assert.equal(
        largeRecovery.presentOwned.length,
        99,
        'a rolling 100-slot queue may retain only the authoritative tail '
            + 'without losing the 500-record durable prefix'
    );
    assert.equal(
        isCompletelyAcknowledgedQueueJournal(largeJournal),
        false
    );
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(largeJournal)
    );
    State.recoveryJournal = null;
    const hydratedLargePlan = buildBatchPlan();
    assert.equal(hydratedLargePlan.isRecovery, true);
    assert.equal(hydratedLargePlan.recoveryJournal.acked.length, 500);
    assert.equal(
        hydratedLargePlan.recoveryJournal.inFlight.phase,
        'retry_authorized'
    );
    assert.equal(
        hydratedLargePlan.recovery.commands[
            hydratedLargePlan.recoveryJournal.acked.length
        ].commandKey,
        largeCommands[500].commandKey
    );
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.settings.targetCount = 2;
    emitFullInit();

    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const retryAgainAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        210_000
    );
    const retryAgainCommand = commands[98];
    journal.recoveryRetryCount = 1;
    journal.inFlight = {
        type: 'action',
        commandKey: retryAgainCommand.commandKey,
        commandIndex: retryAgainCommand.commandIndex,
        baselineActionIds: retryAgainAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId: retryAgainAcknowledged98.at(-1).actionId,
        phase: 'ambiguous',
        recoveryRetryAttempt: true,
        observedActionIds: [],
        fingerprint: recoveryFingerprint(journal, retryAgainCommand),
    };
    replaceAuthoritativeActions([]);
    reconcileRecoveryJournal(journal);
    assert.equal(journal.acked.length, 98);
    assert.equal(journal.inFlight.phase, 'retry_authorized');
    assert.equal(journal.inFlight.retrySequence, 2);
    assert.equal(journal.recoveryRetryCount, 2);
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    emitFullInit();

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const acknowledgedProgress = acknowledgeRecoveryPrefix(
        journal,
        commands,
        20,
        15_000
    );
    const progressedActions = queueActionsForAcknowledgements(
        acknowledgedProgress
    );
    const progressedIndex = progressedActions.findIndex((action) => {
        const source = Number(action.primaryItemHash.split('::').at(-1));
        return Number(action.enhancingMaxLevel) > source + 1;
    });
    assert.notEqual(
        progressedIndex,
        -1,
        'the recovery fixture needs one compressed multi-level action'
    );
    const progressedSource = Number(
        progressedActions[progressedIndex]
            .primaryItemHash.split('::').at(-1)
    );
    progressedActions[progressedIndex] = {
        ...progressedActions[progressedIndex],
        primaryItemHash:
            progressedActions[progressedIndex]
                .primaryItemHash.replace(
                    /::\d+$/,
                    `::${progressedSource + 1}`
                ),
    };
    replaceAuthoritativeActions(progressedActions);
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(
        recovery.presentOwned.length,
        20,
        'refresh recovery must accept the same exact action.id after its '
            + 'source level has advanced within the frozen range'
    );

    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const acknowledgedAll = acknowledgeRecoveryPrefix(
        journal,
        commands,
        commands.length - 1,
        16_000
    );
    let lateMultiLevelIndex = -1;
    for (let index = acknowledgedAll.length - 1; index >= 0; index--) {
        const fingerprint = acknowledgedAll[index].fingerprint;
        const source = Number(
            fingerprint.primaryItemHash.split('::').at(-1)
        );
        if (Number(fingerprint.enhancingMaxLevel) > source + 1) {
            lateMultiLevelIndex = index;
            break;
        }
    }
    assert.notEqual(lateMultiLevelIndex, -1);
    const progressedSuffix = queueActionsForAcknowledgements(
        acknowledgedAll,
        lateMultiLevelIndex
    );
    const progressedTarget = Number(
        progressedSuffix[0].enhancingMaxLevel
    );
    progressedSuffix[0] = {
        ...progressedSuffix[0],
        primaryItemHash:
            progressedSuffix[0].primaryItemHash.replace(
                /::\d+$/,
                `::${progressedTarget - 1}`
            ),
    };
    const queuedRemainingMirrors = progressedSuffix.reduce(
        (sum, action) => (
            sum +
            Number(action.enhancingMaxLevel) -
            Number(action.primaryItemHash.split('::').at(-1))
        ),
        0
    );
    const unsentMirrorCount = commands
        .slice(journal.acked.length)
        .reduce(
            (sum, command) => (
                sum +
                Number(command.action.targetLevel) -
                Number(command.action.startLevel)
            ),
            0
        );
    const actualRemainingMirrors =
        queuedRemainingMirrors + unsentMirrorCount;
    emitFullInit({
        characterItems: [
            inventoryItem(
                'philosophers_mirror',
                0,
                actualRemainingMirrors
            ),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        characterActions: progressedSuffix,
    });
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = null;
    const progressedMirrorPlan = buildBatchPlan();
    assert.equal(progressedMirrorPlan.isRecovery, true);
    assert.equal(
        progressedMirrorPlan.mirrorAvailable,
        actualRemainingMirrors,
        'recovery mirror validation must count target-current progress, '
            + 'not the frozen source again'
    );
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    emitFullInit();

    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const acknowledgedWithCompletedHead =
        acknowledgeRecoveryPrefix(journal, commands, 99, 20_000);
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            acknowledgedWithCompletedHead,
            30
        )
    );
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(
        recovery.presentOwned.length,
        69,
        'an acknowledged prefix that completed and disappeared while the '
            + 'page was refreshing is an acceptable active-queue suffix'
    );
    assert.equal(recovery.orderedRecords.length, 99);
    assert.equal(journal.acked.length, 99);

    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const acknowledgedWithMiddleGap =
        acknowledgeRecoveryPrefix(journal, commands, 99, 30_000);
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            acknowledgedWithMiddleGap,
            0,
            new Set([49])
        )
    );
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(
        recovery.presentOwned.length,
        98,
        'an acknowledged action may finish or disappear from any queue '
            + 'position without invalidating the durable enqueue receipt'
    );
    assert.equal(recovery.orderedRecords.length, 99);
    assert.equal(journal.acked.length, 99);

    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const acknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        40_000
    );
    const pendingCommand = commands[98];
    const pendingFingerprint = recoveryFingerprint(
        journal,
        pendingCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: pendingCommand.commandKey,
        baselineActionIds: acknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId:
            acknowledged98[acknowledged98.length - 1].actionId,
        sentAt: Date.now(),
        errorCode: 'errorNotification.requestSpamProtection',
        fingerprint: pendingFingerprint,
    };
    const uniqueCandidate = strictActionFromFingerprint(
        40_098,
        pendingFingerprint,
        99
    );
    replaceAuthoritativeActions([
        ...queueActionsForAcknowledgements(acknowledged98),
        uniqueCandidate,
    ]);
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(journal.inFlight, null);
    assert.equal(journal.acked.length, 99);
    assert.equal(journal.acked[98].actionId, '40098');
    assert.equal(recovery.presentOwned.length, 99);
    assert.equal(
        recovery.commands[journal.acked.length].commandKey,
        '0:1:44',
        'a unique post-refresh in-flight candidate is claimed exactly once'
    );

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const provisionalAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        42_000
    );
    const provisionalCommand = commands[98];
    const provisionalFingerprint = recoveryFingerprint(
        journal,
        provisionalCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: provisionalCommand.commandKey,
        commandIndex: provisionalCommand.commandIndex,
        fingerprint: provisionalFingerprint,
        baselineActionIds: provisionalAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId:
            provisionalAcknowledged98.at(-1).actionId,
        phase: 'candidate_completion_observed',
        observedActionIds: ['42098'],
        spamRetryEvidenceSafe: false,
        exclusiveSpamRejection: false,
    };
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            provisionalAcknowledged98
        )
    );
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(journal.acked.length, 99);
    assert.equal(journal.acked[98].actionId, '42098');
    assert.equal(journal.inFlight, null);
    assert.equal(
        recovery.presentOwned.length,
        98,
        'a durable matching action.id remains valid after that action leaves '
            + 'the active queue during refresh'
    );

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.run = null;
    State.pendingOp = null;
    State.blockedReason = '';
    State.recentAllowedExternalRequest = null;
    State.externalErrorFenceUntil = 0;
    State.pendingExternalQueueAdds.length = 0;
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const liveRetryAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        43_000
    );
    const liveRetryCommand = commands[98];
    const liveRetryFingerprint = recoveryFingerprint(
        journal,
        liveRetryCommand
    );
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            liveRetryAcknowledged98
        )
    );
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = journal;
    const liveRetryRun = createRun(8_430);
    liveRetryRun.recoveryJournal = journal;
    State.run = liveRetryRun;
    const sentBeforeLiveRetry = socket.sent.length;
    const liveRetryPromise = sendEnhanceAndConfirm(
        liveRetryRun,
        liveRetryCommand.itemId,
        liveRetryCommand.action,
        'quick',
        liveRetryCommand
    );
    await waitUntil(() => (
        socket.sent.length === sentBeforeLiveRetry + 1
    ));
    const originalLiveRetryOp = State.pendingOp;
    assert.equal(originalLiveRetryOp?.phase, 'sent');
    socket.emitMessage({
        type: 'error',
        message: 'errorNotification.requestSpamProtection',
    });
    assert.equal(State.pendingOp, originalLiveRetryOp);
    assert.equal(originalLiveRetryOp.phase, 'reconciling');
    assert.equal(
        journal.inFlight.errorCode,
        'errorNotification.requestSpamProtection'
    );
    assert.equal(
        State.actions.has(
            liveRetryAcknowledged98[
                liveRetryAcknowledged98.length - 1
            ].actionId
        ),
        true,
        'the original predecessor remains authoritative at the end of the '
            + 'candidate-free spam observation window'
    );
    assert.equal(
        Transactions.authorizeQueueRetry(
            originalLiveRetryOp
        ),
        false,
        'the durable retry cannot be authorized before the full observation '
            + 'deadline'
    );
    originalLiveRetryOp.reconcileDeadline = Date.now() - 1;
    journal.inFlight.reconcileDeadline = Date.now() - 1;
    originalLiveRetryOp.externalOverlapEver = true;
    originalLiveRetryOp.observedActionIds.add('43999');
    assert.equal(
        Transactions.authorizeQueueRetry(
            originalLiveRetryOp
        ),
        false,
        'observing any provisional action ID disables recovery retry even when '
            + 'all other retry evidence is satisfied'
    );
    originalLiveRetryOp.observedActionIds.clear();
    assert.equal(
        Transactions.authorizeQueueRetry(
            originalLiveRetryOp
        ),
        true,
        'the live pending transaction authorizes a durable retry without '
            + 'requiring a page refresh; unrelated external overlap is ignored'
    );
    await waitUntil(() => (
        socket.sent.length === sentBeforeLiveRetry + 2 &&
        State.pendingOp &&
        State.pendingOp !== originalLiveRetryOp
    ));
    const secondLiveRetryOp = State.pendingOp;
    assert.equal(secondLiveRetryOp.recoveryRetryAttempt, true);
    assert.equal(journal.recoveryRetryCount, 1);
    assert.equal(
        Transactions.authorizeQueueRetry(secondLiveRetryOp),
        false,
        'the retry transaction can never authorize a third send'
    );
    const liveRetryCandidate = strictActionFromFingerprint(
        43_098,
        liveRetryFingerprint,
        99
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            liveRetryCandidate,
        ],
    });
    assert.equal(
        State.pendingOp,
        secondLiveRetryOp,
        'the exact retry action.id remains open for the bounded duplicate '
            + 'candidate check'
    );
    assert.equal(
        secondLiveRetryOp.phase,
        'retry_candidate_observed'
    );
    assert.equal(
        Transactions.commitObservedRetryCandidate(
            secondLiveRetryOp
        ),
        true
    );
    const liveRetryOutcome = await liveRetryPromise;
    assert.equal(liveRetryOutcome.status, 'confirmed');
    assert.equal(liveRetryOutcome.actionId, '43098');
    assert.equal(
        socket.sent.length,
        sentBeforeLiveRetry + 2,
        'the original queue send is retried exactly once'
    );
    assert.equal(journal.recoveryRetryCount, 1);
    assert.equal(journal.acked.length, 99);
    assert.equal(journal.acked[98].actionId, '43098');
    assert.equal(journal.inFlight, null);
    State.run = null;

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.run = null;
    State.pendingOp = null;
    State.blockedReason = '';
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const retryRaceAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        44_000
    );
    const retryRaceCommand = commands[98];
    const retryRaceFingerprint = recoveryFingerprint(
        journal,
        retryRaceCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: retryRaceCommand.commandKey,
        commandIndex: retryRaceCommand.commandIndex,
        baselineActionIds: retryRaceAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId:
            retryRaceAcknowledged98[
                retryRaceAcknowledged98.length - 1
            ].actionId,
        sentAt: Date.now() - CONFIG.QUEUE_RECONCILE_GRACE_MS,
        phase: 'ambiguous',
        errorCode: 'errorNotification.requestSpamProtection',
        exclusiveSpamRejection: true,
        reconcileDeadline: Date.now() - 1,
        observedActionIds: [],
        fingerprint: retryRaceFingerprint,
    };
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            retryRaceAcknowledged98
        )
    );
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = journal;
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(journal.acked.length, 98);
    assert.equal(journal.inFlight.phase, 'retry_authorized');
    assert.equal(journal.recoveryRetryCount, 1);

    const lateRetryRaceCandidate = strictActionFromFingerprint(
        44_098,
        retryRaceFingerprint,
        99
    );
    replaceAuthoritativeActions([
        ...queueActionsForAcknowledgements(
            retryRaceAcknowledged98
        ),
        lateRetryRaceCandidate,
    ]);
    const retryRaceRun = createRun(8_440);
    retryRaceRun.recoveryJournal = journal;
    State.run = retryRaceRun;
    const sentBeforeRetryBoundary = socket.sent.length;
    const retryRaceOutcome = await sendEnhanceAndConfirm(
        retryRaceRun,
        retryRaceCommand.itemId,
        retryRaceCommand.action,
        'quick',
        retryRaceCommand
    );
    assert.equal(retryRaceOutcome.status, 'confirmed');
    assert.equal(retryRaceOutcome.actionId, '44098');
    assert.equal(
        socket.sent.length,
        sentBeforeRetryBoundary,
        'a late original receipt arriving after retry authorization but '
            + 'before the synchronous send boundary is claimed without '
            + 'sending the command again'
    );
    assert.equal(journal.acked.length, 99);
    assert.equal(journal.inFlight, null);
    State.run = null;

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.pendingOp = null;
    State.blockedReason = '';
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const retrySplitAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        46_000
    );
    const retrySplitCommand = commands[98];
    const retrySplitFingerprint = recoveryFingerprint(
        journal,
        retrySplitCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: retrySplitCommand.commandKey,
        commandIndex: retrySplitCommand.commandIndex,
        baselineActionIds: retrySplitAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId:
            retrySplitAcknowledged98[
                retrySplitAcknowledged98.length - 1
            ].actionId,
        sentAt: Date.now() - CONFIG.QUEUE_RECONCILE_GRACE_MS,
        phase: 'ambiguous',
        errorCode: 'errorNotification.requestSpamProtection',
        exclusiveSpamRejection: true,
        reconcileDeadline: Date.now() - 1,
        observedActionIds: [],
        fingerprint: retrySplitFingerprint,
    };
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            retrySplitAcknowledged98
        )
    );
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = journal;
    reconcileRecoveryJournal(journal);
    assert.equal(journal.inFlight.phase, 'retry_authorized');

    const retrySplitRun = createRun(8_460);
    retrySplitRun.recoveryJournal = journal;
    State.run = retrySplitRun;
    const sentBeforeSplitRetry = socket.sent.length;
    const retrySplitPromise = sendEnhanceAndConfirm(
        retrySplitRun,
        retrySplitCommand.itemId,
        retrySplitCommand.action,
        'quick',
        retrySplitCommand
    );
    await waitUntil(() => (
        socket.sent.length === sentBeforeSplitRetry + 1
    ));
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                46_098,
                retrySplitFingerprint,
                99
            ),
        ],
    });
    assert.equal(
        State.pendingOp?.phase,
        'retry_candidate_observed',
        'the first retry candidate stays open for the full window so a split-frame '
            + 'second candidate cannot be missed'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                46_099,
                retrySplitFingerprint,
                100
            ),
        ],
    });
    await assert.rejects(
        retrySplitPromise,
        /多条|无法唯一/
    );
    assert.equal(
        socket.sent.length,
        sentBeforeSplitRetry + 1,
        'split-frame duplicate candidates stop the retry transaction '
            + 'without another send'
    );
    assert.deepEqual(
        [
            ...JSON.parse(
                storage.get('MWI_SAFE_ENHANCER_RECOVERY_V1')
            ).inFlight.observedActionIds,
        ].sort(),
        ['46098', '46099']
    );
    State.run = null;
    State.blockedReason = '';

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.pendingOp = null;
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const retrySingleAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        47_000
    );
    const retrySingleCommand = commands[98];
    const retrySingleFingerprint = recoveryFingerprint(
        journal,
        retrySingleCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: retrySingleCommand.commandKey,
        commandIndex: retrySingleCommand.commandIndex,
        baselineActionIds: retrySingleAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId:
            retrySingleAcknowledged98[
                retrySingleAcknowledged98.length - 1
            ].actionId,
        sentAt: Date.now() - CONFIG.QUEUE_RECONCILE_GRACE_MS,
        phase: 'ambiguous',
        errorCode: 'errorNotification.requestSpamProtection',
        exclusiveSpamRejection: true,
        reconcileDeadline: Date.now() - 1,
        observedActionIds: [],
        fingerprint: retrySingleFingerprint,
    };
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            retrySingleAcknowledged98
        )
    );
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = journal;
    reconcileRecoveryJournal(journal);
    const retrySingleRun = createRun(8_470);
    retrySingleRun.recoveryJournal = journal;
    State.run = retrySingleRun;
    const sentBeforeSingleRetry = socket.sent.length;
    const retrySinglePromise = sendEnhanceAndConfirm(
        retrySingleRun,
        retrySingleCommand.itemId,
        retrySingleCommand.action,
        'quick',
        retrySingleCommand
    );
    await waitUntil(() => (
        socket.sent.length === sentBeforeSingleRetry + 1
    ));
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                47_098,
                retrySingleFingerprint,
                99
            ),
        ],
    });
    assert.equal(
        State.pendingOp?.phase,
        'retry_candidate_observed'
    );
    assert.equal(
        Transactions.commitObservedRetryCandidate(
            State.pendingOp
        ),
        true,
        'the deterministic test advances the full retry candidate window'
    );
    const retrySingleOutcome = await retrySinglePromise;
    assert.equal(retrySingleOutcome.status, 'confirmed');
    assert.equal(retrySingleOutcome.actionId, '47098');
    assert.equal(
        socket.sent.length,
        sentBeforeSingleRetry + 1
    );
    assert.equal(journal.acked.length, 99);
    assert.equal(journal.inFlight, null);
    State.run = null;

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const interruptedRetryAcknowledged98 =
        acknowledgeRecoveryPrefix(
            journal,
            commands,
            98,
            47_500
        );
    const interruptedRetryCommand = commands[98];
    const interruptedRetryFingerprint = recoveryFingerprint(
        journal,
        interruptedRetryCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: interruptedRetryCommand.commandKey,
        commandIndex: interruptedRetryCommand.commandIndex,
        baselineActionIds:
            interruptedRetryAcknowledged98.map(
                (record) => record.actionId
            ),
        predecessorId:
            interruptedRetryAcknowledged98[
                interruptedRetryAcknowledged98.length - 1
            ].actionId,
        phase: 'retry_candidate_observed',
        recoveryRetryAttempt: true,
        observedActionIds: ['47598'],
        candidateObservationDeadline:
            Date.now() + CONFIG.QUEUE_RECONCILE_GRACE_MS,
        fingerprint: interruptedRetryFingerprint,
    };
    replaceAuthoritativeActions([
        ...queueActionsForAcknowledgements(
            interruptedRetryAcknowledged98
        ),
        strictActionFromFingerprint(
            47_598,
            interruptedRetryFingerprint,
            99
        ),
    ]);
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = journal;
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(journal.acked.length, 99);
    assert.equal(journal.acked[98].actionId, '47598');
    assert.equal(journal.inFlight, null);

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const removedRetryAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        47_600
    );
    const removedRetryCommand = commands[98];
    const removedRetryFingerprint = recoveryFingerprint(
        journal,
        removedRetryCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: removedRetryCommand.commandKey,
        commandIndex: removedRetryCommand.commandIndex,
        baselineActionIds: removedRetryAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId: removedRetryAcknowledged98.at(-1).actionId,
        phase: 'retry_candidate_removed_unconfirmed',
        recoveryRetryAttempt: true,
        observedActionIds: ['47698'],
        fingerprint: removedRetryFingerprint,
    };
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            removedRetryAcknowledged98
        )
    );
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(journal.acked.length, 99);
    assert.equal(journal.acked[98].actionId, '47698');
    assert.equal(journal.inFlight, null);

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const observedAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        45_000
    );
    const observedCommand = commands[98];
    const observedFingerprint = recoveryFingerprint(
        journal,
        observedCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: observedCommand.commandKey,
        baselineActionIds: observedAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId:
            observedAcknowledged98[
                observedAcknowledged98.length - 1
            ].actionId,
        sentAt: Date.now(),
        phase: 'candidate_observed',
        errorCode: 'errorNotification.requestSpamProtection',
        exclusiveSpamRejection: true,
        reconcileDeadline: Date.now() - 1,
        observedActionIds: ['45098'],
        fingerprint: observedFingerprint,
    };
    replaceAuthoritativeActions([]);
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = journal;
    recovery = reconcileRecoveryJournal(journal);
    assert.equal(journal.inFlight, null);
    assert.equal(journal.acked.length, 99);
    assert.equal(journal.acked[98].actionId, '45098');
    assert.equal(journal.recoveryRetryCount, 0);
    assert.equal(
        recovery.presentOwned.length,
        0,
        'a uniquely observed action that completed while the page was down '
            + 'is acknowledged from durable evidence, never resent'
    );

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const ambiguousAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        50_000
    );
    const ambiguousCommand = commands[98];
    const ambiguousFingerprint = recoveryFingerprint(
        journal,
        ambiguousCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: ambiguousCommand.commandKey,
        baselineActionIds: ambiguousAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId:
            ambiguousAcknowledged98[
                ambiguousAcknowledged98.length - 1
            ].actionId,
        sentAt: Date.now(),
        errorCode: 'errorNotification.requestSpamProtection',
        fingerprint: ambiguousFingerprint,
    };
    replaceAuthoritativeActions([
        ...queueActionsForAcknowledgements(
            ambiguousAcknowledged98
        ),
        strictActionFromFingerprint(
            50_098,
            ambiguousFingerprint,
            99
        ),
        strictActionFromFingerprint(
            50_099,
            ambiguousFingerprint,
            100
        ),
    ]);
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = journal;
    assert.throws(
        () => reconcileRecoveryJournal(journal),
        (error) => (
            error?.code === 'RECOVERY_AMBIGUOUS' &&
            /多条/.test(error.message)
        ),
        'two matching in-flight candidates must never be guessed or resent'
    );
    assert.equal(journal.acked.length, 98);
    assert.notEqual(journal.inFlight, null);
    assert.deepEqual(
        [
            ...JSON.parse(
                storage.get('MWI_SAFE_ENHANCER_RECOVERY_V1')
            ).inFlight.observedActionIds,
        ].sort(),
        ['50098', '50099'],
        'refresh reconciliation must persist all candidate IDs before '
            + 'reporting ambiguity'
    );

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.run = null;
    State.blockedReason = '';
    replaceAuthoritativeActions([]);
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const sameDeltaAcknowledged98 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        98,
        55_000
    );
    const sameDeltaCommand = commands[98];
    const sameDeltaFingerprint = recoveryFingerprint(
        journal,
        sameDeltaCommand
    );
    journal.inFlight = {
        type: 'action',
        commandKey: sameDeltaCommand.commandKey,
        baselineActionIds: sameDeltaAcknowledged98.map(
            (record) => record.actionId
        ),
        predecessorId:
            sameDeltaAcknowledged98[
                sameDeltaAcknowledged98.length - 1
            ].actionId,
        sentAt: Date.now(),
        phase: 'sent',
        errorCode: '',
        observedActionIds: [],
        fingerprint: sameDeltaFingerprint,
    };
    replaceAuthoritativeActions(
        queueActionsForAcknowledgements(
            sameDeltaAcknowledged98
        )
    );
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    State.recoveryJournal = journal;
    const sameDeltaRun = createRun(8_550);
    sameDeltaRun.recoveryJournal = journal;
    State.run = sameDeltaRun;
    const sameDeltaPayload = createEnhancePayload(
        {
            characterId: journal.characterId,
            enhancingLoadoutId: journal.enhancingLoadout.id,
        },
        sameDeltaCommand.itemId,
        sameDeltaCommand.action,
        'quick'
    ).payload;
    const sameDeltaOutcomePromise = Transactions.begin(
        sameDeltaRun,
        {
            kind: 'queue',
            itemId: sameDeltaCommand.itemId,
            fingerprint: sameDeltaFingerprint,
            baselineActionIds:
                journal.inFlight.baselineActionIds,
            commandKey: sameDeltaCommand.commandKey,
            commandIndex: sameDeltaCommand.commandIndex,
            recoveryJobId: journal.jobId,
            predecessorId: journal.inFlight.predecessorId,
            timeoutMs: 2000,
            timeoutMessage: 'same-delta ambiguity timeout',
            payload: sameDeltaPayload,
        }
    );
    const sameDeltaCandidateA = strictActionFromFingerprint(
        55_098,
        sameDeltaFingerprint,
        99
    );
    const sameDeltaCandidateB = strictActionFromFingerprint(
        55_099,
        sameDeltaFingerprint,
        100
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            sameDeltaCandidateA,
            sameDeltaCandidateB,
        ],
    });
    const sameDeltaOutcome = await sameDeltaOutcomePromise;
    assert.equal(sameDeltaOutcome.status, 'unknown');
    const persistedSameDeltaJournal = JSON.parse(
        storage.get('MWI_SAFE_ENHANCER_RECOVERY_V1')
    );
    assert.deepEqual(
        [...persistedSameDeltaJournal.inFlight.observedActionIds]
            .sort(),
        ['55098', '55099'],
        'same-delta ambiguity evidence must be persisted before stopping'
    );

    State.run = null;
    State.recoveryJournal = null;
    replaceAuthoritativeActions([
        ...queueActionsForAcknowledgements(
            sameDeltaAcknowledged98
        ),
        sameDeltaCandidateB,
    ]);
    assert.throws(
        () => reconcileRecoveryJournal(
            persistedSameDeltaJournal
        ),
        (error) => (
            error?.code === 'RECOVERY_AMBIGUOUS' &&
            /历史歧义|观察到多条/.test(error.message)
        ),
        'refreshing after one of two matching candidates disappears must '
            + 'not downgrade the persisted ambiguity to a unique receipt'
    );

    const strictFingerprint = actionFingerprint(19, 20);
    const canonicalSingleAction = strictActionFromFingerprint(
        60_000,
        strictFingerprint
    );
    assert.equal(
        strictSingleEnhanceActionMatches(
            canonicalSingleAction,
            strictFingerprint
        ),
        true
    );
    const batchCountAction = {
        ...canonicalSingleAction,
        hasMaxCount: true,
        maxCount: 99,
    };
    assert.equal(
        actionFingerprintMatches(batchCountAction, strictFingerprint),
        true,
        'the base receipt fingerprint intentionally ignores command-count '
            + 'shape'
    );
    assert.equal(
        strictSingleEnhanceActionMatches(
            batchCountAction,
            strictFingerprint
        ),
        false,
        'recovery/adoption must not count a batch action as one command'
    );
    assert.equal(
        strictSingleEnhanceActionMatches(
            {
                ...canonicalSingleAction,
                difficultyTier: 1,
            },
            strictFingerprint
        ),
        false
    );

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.run = null;
    State.blockedReason = '';
    journal = makeJournal();
    commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    const controllerAcknowledged99 = acknowledgeRecoveryPrefix(
        journal,
        commands,
        99,
        70_000
    );
    journal.inFlight = {
        type: 'action',
        commandKey: commands[99].commandKey,
        commandIndex: commands[99].commandIndex,
        baselineActionIds: controllerAcknowledged99.map(
            (record) => record.actionId
        ),
        predecessorId: controllerAcknowledged99.at(-1).actionId,
        phase: 'sent',
        sentAt: Date.now() - 1000,
        observedActionIds: [],
        fingerprint: recoveryFingerprint(journal, commands[99]),
    };
    replaceAuthoritativeActions([]);
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(journal)
    );
    socket.sent.length = 0;
    const resumedController = Controller.start();
    await waitUntil(() => (
        socket.sent.some((raw) => (
            JSON.parse(raw).type === 'new_character_action'
        ))
    ));
    const resumedEnhanceMessages = socket.sent
        .map((raw) => JSON.parse(raw))
        .filter((message) => (
            message.type === 'new_character_action'
        ));
    assert.equal(
        resumedEnhanceMessages.length,
        1,
        'the resumed controller resends only the first position without '
            + 'a unique action.id'
    );
    const expectedMissingPayload = createEnhancePayload(
        {
            characterId: journal.characterId,
            enhancingLoadoutId: journal.enhancingLoadout.id,
        },
        commands[99].itemId,
        commands[99].action,
        'quick'
    ).payload.newCharacterActionData;
    assert.equal(
        resumedEnhanceMessages[0].newCharacterActionData.primaryItemHash,
        expectedMissingPayload.primaryItemHash
    );
    assert.equal(
        resumedEnhanceMessages[0].newCharacterActionData
            .enhancingMaxLevel,
        expectedMissingPayload.enhancingMaxLevel
    );
    assert.equal(
        State.run?.recoveryJournal?.inFlight?.commandKey,
        commands[99].commandKey
    );
    const resumedFingerprint = recoveryFingerprint(
        State.run.recoveryJournal,
        commands[99]
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                70_099,
                resumedFingerprint,
                100
            ),
        ],
    });
    assert.equal(
        State.pendingOp?.phase,
        'retry_candidate_observed'
    );
    assert.equal(
        Transactions.commitObservedRetryCandidate(State.pendingOp),
        true
    );
    await waitUntil(() => (
        State.run?.ackedCommandKeys?.has(commands[99].commandKey)
    ));
    assert.equal(
        socket.sent
            .map((raw) => JSON.parse(raw))
            .filter((message) => (
                message.type === 'new_character_action'
            )).length,
        1,
        'the dependent suffix stays blocked until the resent position has '
            + 'a unique action.id'
    );
    await waitUntil(() => (
        socket.sent
            .map((raw) => JSON.parse(raw))
            .filter((message) => (
                message.type === 'new_character_action'
            )).length === 2
    ));
    assert.equal(
        State.run?.recoveryJournal?.inFlight?.commandKey,
        commands[100].commandKey,
        'after the missing position is acknowledged, the controller sends '
            + 'the immediately following dependent position'
    );
    assert.equal(
        State.run?.recoveryJournal?.acked?.length,
        100
    );
    const nextDependentFingerprint =
        State.pendingOp?.fingerprint;
    assert.ok(nextDependentFingerprint);
    State.run.stopRequested = true;
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                70_100,
                nextDependentFingerprint,
                101
            ),
        ],
    });
    await waitUntil(() => (
        State.run?.ackedCommandKeys?.has(commands[100].commandKey)
    ));
    await resumedController;
    assert.equal(
        socket.sent
            .map((raw) => JSON.parse(raw))
            .filter((message) => (
                message.type === 'new_character_action'
            )).length,
        2,
        'the controller sends exactly the recovered position and its next '
            + 'dependent position, with no skip or duplicate'
    );
    const stoppedRecoveryRun = State.run;
    if (stoppedRecoveryRun?.ownedOrderValidationTimer) {
        clearTimeout(stoppedRecoveryRun.ownedOrderValidationTimer);
        stoppedRecoveryRun.ownedOrderValidationTimer = null;
        stoppedRecoveryRun.ownedOrderValidationPending = false;
    }
    for (
        const pending of
            stoppedRecoveryRun?.ownedRemovalPending?.values() || []
    ) {
        if (pending?.timer) clearTimeout(pending.timer);
    }
    State.run = null;

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.blockedReason = '';
    State.recentAllowedExternalRequest = null;
    replaceAuthoritativeActions([]);
    const lateRun = createRun(8_600);
    State.run = lateRun;
    const lateFingerprint = actionFingerprint(18, 19);
    const latePayload = createEnhancePayload(
        lateRun,
        'gobo_stabber',
        {startLevel: 18, targetLevel: 19},
        'quick'
    ).payload;
    const sentBeforeLateReceipt = socket.sent.length;
    const lateReceiptPromise = Transactions.begin(lateRun, {
        kind: 'queue',
        itemId: 'gobo_stabber',
        fingerprint: lateFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'late spam receipt timeout',
        payload: latePayload,
    });
    socket.emitMessage({
        type: 'error',
        message: 'errorNotification.requestSpamProtection',
    });
    assert.equal(
        socket.sent.length,
        sentBeforeLateReceipt + 1,
        'spam protection must not cause an immediate resend'
    );
    assert.equal(
        State.pendingOp?.phase,
        'reconciling',
        'an uncorrelated spam error keeps a bounded read-only reconciliation '
            + 'window for a late exact action receipt'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                60_001,
                lateFingerprint,
                1
            ),
        ],
    });
    const lateOutcome = await lateReceiptPromise;
    assert.equal(lateOutcome.status, 'confirmed');
    assert.equal(lateOutcome.actionId, '60001');
    assert.equal(
        socket.sent.length,
        sentBeforeLateReceipt + 1,
        'a late exact actions_updated receipt confirms the original send '
            + 'without any duplicate request'
    );

    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.recoveryJournal = null;
    State.run = null;
    State.pendingOp = null;
    State.blockedReason = '';
    State.starting = false;
    State.settings.mode = 'quick';
    State.settings.useExistingInventory = false;
    State.settings.targetCount = 5;
    State.settings.marketMaintenanceEnabled = false;
    State.settings.marketAutoSellExcessEnabled = false;
    State.selected.clear();
    State.selected.add('grandmaster_brewing_charm');
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20_000),
            inventoryItem('grandmaster_brewing_charm', 20, 1),
            ...Array.from(
                {length: 11},
                (_, offset) => inventoryItem(
                    'grandmaster_brewing_charm',
                    9 + offset,
                    100
                )
            ),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
    });
    const brewingPlan = buildBatchPlan();
    assert.equal(brewingPlan.summary.sendCommands, 275);
    const brewingJournal = createRecoveryJournal(
        brewingPlan,
        'commands_queued'
    );
    brewingJournal.scriptVersion = '1.5.3';
    brewingJournal.marketMaintenanceEnabled = true;
    brewingJournal.marketInventoryOffsets = {
        grandmaster_brewing_charm: -4,
    };
    confirmRecoveryPurchases(brewingJournal);
    const brewingCommands = enumeratePlanCommands(
        brewingJournal.itemPlans,
        brewingJournal.mode
    );
    acknowledgeRecoveryPrefix(
        brewingJournal,
        brewingCommands,
        brewingCommands.length,
        90_000
    );
    const brewingTailActions = queueActionsForAcknowledgements(
        brewingJournal.acked,
        brewingJournal.acked.length - 4
    );
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20_000),
            inventoryItem('grandmaster_brewing_charm', 20, 1),
            ...Array.from(
                {length: 11},
                (_, offset) => inventoryItem(
                    'grandmaster_brewing_charm',
                    9 + offset,
                    100
                )
            ),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        characterActions: brewingTailActions,
    });
    storage.set(
        'MWI_SAFE_ENHANCER_RECOVERY_V1',
        JSON.stringify(brewingJournal)
    );
    State.recoveryJournal = null;
    State.run = null;
    State.pendingOp = null;
    State.blockedReason = '';
    socket.sent.length = 0;

    const previousConfirm = fakeWindow.confirm;
    fakeWindow.confirm = () => false;
    await Controller.start();
    fakeWindow.confirm = previousConfirm;

    assert.equal(
        storage.has('MWI_SAFE_ENHANCER_RECOVERY_V1'),
        false,
        'a v1.5.3 journal with all 275 exact enqueue receipts is cleared '
            + 'without waiting for +20 production'
    );
    assert.equal(State.recoveryJournal, null);
    assert.equal(
        State.run,
        null,
        'startup releases the finished legacy journal before attempting '
            + 'to preview a new batch'
    );
    assert.equal(State.blockedReason, '');
    assert.equal(
        State.inventory.get('grandmaster_brewing_charm')?.[20],
        1,
        'only the one reserved +20 may remain after the other outputs sold'
    );
    assert.equal(
        State.actions.size,
        4,
        'the old Brewing queue tail may keep running after its enqueue '
            + 'journal is released'
    );
    const recoveryResends = socket.sent
        .map((raw) => JSON.parse(raw))
        .filter((message) => (
            message.type === 'new_character_action' ||
            message.type === 'get_market_item_order_books' ||
            message.type === 'post_market_order' ||
            message.type === 'cancel_market_listing' ||
            message.type === 'claim_market_listing'
        ));
    assert.equal(
        recoveryResends.length,
        0,
        'releasing a fully acknowledged legacy journal sends neither a '
            + 'duplicate enhance command nor any market request'
    );

    const continuedBrewingPlan = buildBatchPlan();
    assert.equal(
        continuedBrewingPlan.itemPlans[0].forceFreshBases,
        true,
        'a fully acknowledged but still-running tail forces fresh bases '
            + 'instead of blocking the next same-equipment batch'
    );
    assert.equal(continuedBrewingPlan.summary.sendCommands, 275);
    State.selected.clear();
    State.selected.add('grandmaster_attack_charm');
    const attackPlan = buildBatchPlan();
    assert.equal(Boolean(attackPlan.isRecovery), false);
    assert.deepEqual(
        Array.from(attackPlan.itemIds),
        ['grandmaster_attack_charm']
    );
    assert.equal(attackPlan.summary.sendCommands, 275);

    const stopRaceJournal = createRecoveryJournal(
        brewingPlan,
        'running'
    );
    confirmRecoveryPurchases(stopRaceJournal);
    const stopRaceCommands = enumeratePlanCommands(
        stopRaceJournal.itemPlans,
        stopRaceJournal.mode
    );
    acknowledgeRecoveryPrefix(
        stopRaceJournal,
        stopRaceCommands,
        stopRaceCommands.length,
        100_000
    );
    const stopRaceRun = {
        recoveryJournal: stopRaceJournal,
        recoveryCommands: stopRaceCommands,
        active: true,
        stopRequested: true,
        status: 'running',
        ownedActionIds: new Set(['100001']),
        ownedActionFingerprints: new Map([['100001', {}]]),
        ownedActionProgressLevels: new Map([['100001', 19]]),
        ownedCompatibleCompletions: new Map(),
        completedOwnedActionIds: new Set(),
        completedOwnedOutputActionIds: new Set(),
        ownedRemovalPending: new Map(),
        ownedActionOrder: ['100001'],
        marketPostInventoryBarriers: new Map(),
        results: [{status: 'stopped', error: 'late stop'}],
    };
    State.recoveryJournal = stopRaceJournal;
    assert.equal(
        isCompletelyAcknowledgedQueueJournal(stopRaceJournal),
        true
    );
    assert.equal(
        finalizeCompletelyAcknowledgedQueueRun(stopRaceRun),
        true,
        'a stop click racing with the final exact acknowledgement must not '
            + 'leave a complete queue journal behind'
    );
    assert.equal(stopRaceRun.stopRequested, false);
    assert.equal(stopRaceRun.status, 'queued');
    assert.equal(stopRaceRun.results[0].status, 'queued');
    assert.equal(
        stopRaceRun.ownedActionIds.size,
        0,
        'once every command has an exact action.id, the queue-only helper '
            + 'releases old action monitoring so another batch may start'
    );
    assert.equal(storage.has('MWI_SAFE_ENHANCER_RECOVERY_V1'), false);
    stopRaceRun.active = false;
    State.run = stopRaceRun;
    assert.doesNotThrow(
        () => buildBatchPlan(),
        'a queued run whose monitoring was released must not block the next '
            + 'batch on the same page'
    );
    socket.emitMessage({type: 'actions_updated', endCharacterActions: [{
        id: 179999, ordinal: 500, actionHrid: '/actions/foraging/apple',
    }]});
    await flushMicrotasks(20);
    assert.equal(stopRaceRun.ownedOrderValidationPending, false,
        'unrelated Task updates cannot rearm order checks on a released batch');
    assert.doesNotThrow(() => buildBatchPlan(),
        'a released run stays ready for the next batch after external queue updates');
    State.run = null;

    const duplicateIdJournal = createRecoveryJournal(
        brewingPlan,
        'running'
    );
    const duplicateCommands = enumeratePlanCommands(
        duplicateIdJournal.itemPlans,
        duplicateIdJournal.mode
    );
    const firstDuplicateFingerprint = recoveryFingerprint(
        duplicateIdJournal,
        duplicateCommands[0]
    );
    const secondDuplicateFingerprint = recoveryFingerprint(
        duplicateIdJournal,
        duplicateCommands[1]
    );
    duplicateIdJournal.acked.push({
        commandKey: duplicateCommands[0].commandKey,
        actionId: '110000',
        fingerprint: firstDuplicateFingerprint,
    });
    duplicateIdJournal.inFlight = {
        type: 'action',
        commandKey: duplicateCommands[1].commandKey,
        fingerprint: secondDuplicateFingerprint,
    };
    State.run = {recoveryJournal: duplicateIdJournal};
    assert.throws(
        () => Transactions.commitQueueAcknowledgement(
            {
                recoveryJobId: duplicateIdJournal.jobId,
                commandKey: duplicateCommands[1].commandKey,
                commandIndex: duplicateCommands[1].commandIndex,
                fingerprint: secondDuplicateFingerprint,
            },
            '110000'
        ),
        (error) => (
            error?.code === 'RECOVERY_INVALID' &&
            /重复记账/.test(error.message)
        ),
        'one action.id cannot acknowledge two frozen command positions'
    );
    assert.equal(duplicateIdJournal.acked.length, 1);

    assert.throws(
        () => Network.sendOwned({
            type: 'post_market_order',
            postMarketOrderData: {},
        }),
        (error) => error?.code === 'OUTBOUND_NOT_ALLOWED',
        'the production queue sender must reject every market request type'
    );

    State.run = null;
    State.blockedReason = '';
    State.recoveryJournal = null;
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    replaceAuthoritativeActions([]);
    emitFullInit();
}

async function runPurchaseStockRecoveryTests() {
    assert.equal(typeof getRecoveryPurchaseRequirements, 'function');
    assert.equal(typeof purchaseAndConfirm, 'function');
    State.run = null;
    State.blockedReason = '';
    State.recoveryJournal = null;
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.settings.marketMaintenanceEnabled = false;
    State.settings.marketAutoSellExcessEnabled = false;
    State.settings.mode = 'quick';
    State.settings.useExistingInventory = false;
    State.settings.targetCount = 1;
    State.selected.clear();
    State.selected.add('gobo_stabber');
    emitFullInit();
    const frozen = buildBatchPlan();
    assert.equal(frozen.itemPlans[0].plan.purchases[10], 89);
    assert.equal(frozen.itemPlans[0].plan.purchases[9], 55);

    function snapshot(high, low = 55, actions = [], extraItems = [], savedJournal = null) {
        State.run = null;
        State.blockedReason = '';
        State.recoveryJournal = null;
        storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
        if (savedJournal) storage.set('MWI_SAFE_ENHANCER_RECOVERY_V1', JSON.stringify(savedJournal));
        emitFullInit({characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 9, low),
            inventoryItem('gobo_stabber', 10, high),
            characterItem('grandmaster_enhancing_charm', 0, 1, '/item_locations/charm'),
            ...extraItems,
        ], characterActions: actions});
    }
    function interruptedPurchase(overrides = {}) {
        const journal = createRecoveryJournal(frozen, 'running');
        journal.purchases['gobo_stabber:9'].status = 'confirmed';
        journal.inFlight = {
            type: 'purchase', purchaseKey: 'gobo_stabber:10', itemId: 'gobo_stabber', level: 10,
            count: 89, baselineInventory: 0, expectedInventory: 89, ...overrides,
        };
        return journal;
    }
    let runId = 1500;
    async function checkPurchase(journal, level, expectedCount, currentCount) {
        const run = createRun(++runId);
        run.recoveryJournal = journal;
        State.run = run;
        const before = socket.sent.length;
        const promise = purchaseAndConfirm(run, 'gobo_stabber', level, frozen.itemPlans[0].plan.purchases[level]);
        if (expectedCount > 0) {
            await waitUntil(() => socket.sent.length > before);
            assert.deepEqual(JSON.parse(socket.sent[before]).buyFromShopData, {
                shopItemHrid: '/shop_items/test/gobo_stabber', enhancementLevel: level, count: expectedCount,
            });
            assert.ok(journal.inFlight?.syncMarker, 'a new purchase records its full-snapshot identity');
            socket.emitMessage({type: 'inventory_updated', updatedCharacterItems: [
                inventoryItem('gobo_stabber', level, currentCount + expectedCount),
            ]});
        }
        await promise;
        assert.equal(socket.sent.length - before, expectedCount > 0 ? 1 : 0);
        assert.equal(journal.inFlight, null);
        State.run = null;
    }

    for (const [name, high, shortage] of [
        ['not delivered', 0, 89], ['partial inventory', 30, 59],
        ['consumed after delivery', 88, 1], ['exact delivery', 89, 0], ['extra inventory', 100, 0],
    ]) {
        snapshot(high);
        const journal = interruptedPurchase();
        const before = socket.sent.length;
        const recovery = reconcileRecoveryJournal(journal);
        assert.equal(socket.sent.length, before, `${name}: reconciling never sends the old request`);
        assert.equal(journal.inFlight, null, name);
        assert.equal(recovery.commands.length, 55);
        assert.equal(journal.acked.length, 0);
        const demand = getRecoveryPurchaseRequirements(journal, 'gobo_stabber');
        assert.equal(demand.projected[10], high, name);
        assert.equal(demand.required[10], 89, name);
        assert.equal(demand.shortages[10], shortage, name);
        if (high !== 89) {
            for (const level of [9, 10]) {
                assert.equal(journal.purchases[`gobo_stabber:${level}`].recoveryStock, true, name);
                assert.equal(journal.purchases[`gobo_stabber:${level}`].status, 'recheck', name);
            }
            assert.equal(journal.purchases['gobo_stabber:10'].count, 89, 'the original purchase budget stays in the journal');
        }
        const recorded = JSON.stringify(journal.purchases);
        reconcileRecoveryJournal(journal);
        assert.equal(JSON.stringify(journal.purchases), recorded, 'repeated reconciliation is idempotent');
        await checkPurchase(journal, 10, shortage, high);
        await checkPurchase(journal, 10, 0, Math.max(high, 89));
    }

    // A previously confirmed +9 purchase can have been consumed as well.
    snapshot(30, 5);
    const bothBases = interruptedPurchase();
    reconcileRecoveryJournal(bothBases);
    assert.equal(getRecoveryPurchaseRequirements(bothBases, 'gobo_stabber').shortages[9], 50);
    await checkPurchase(bothBases, 10, 59, 30);
    await checkPurchase(bothBases, 9, 50, 5);

    // Another automation owns the lane while inventory changes. Calculate
    // the new shortage only after acquiring it, then require a new full
    // snapshot before reconciling that newly sent transaction as ambiguous.
    snapshot(30);
    const waitingJournal = interruptedPurchase();
    reconcileRecoveryJournal(waitingJournal);
    const coordinator = fakeWindow[Symbol.for('MWI_SHARED_AUTOMATION_COORDINATOR_V1')];
    const releaseOther = await coordinator.acquire('test-purchase-stock-change');
    const waitingRun = createRun(++runId);
    waitingRun.recoveryJournal = waitingJournal;
    State.run = waitingRun;
    const beforeWaiting = socket.sent.length;
    const waitingPurchase = purchaseAndConfirm(waitingRun, 'gobo_stabber', 10, 89);
    await flushMicrotasks();
    assert.equal(socket.sent.length, beforeWaiting);
    socket.emitMessage({type: 'inventory_updated', updatedCharacterItems: [inventoryItem('gobo_stabber', 10, 80)]});
    releaseOther();
    await waitUntil(() => socket.sent.length > beforeWaiting);
    assert.equal(JSON.parse(socket.sent[beforeWaiting]).buyFromShopData.count, 9,
        'inventory received while waiting for the lane reduces the previous 59-item shortage');
    const sameSnapshotJournal = JSON.parse(JSON.stringify(waitingJournal));
    assert.throws(() => reconcileRecoveryJournal(sameSnapshotJournal), /完整|刷新|同步/);
    assert.notEqual(sameSnapshotJournal.inFlight, null);
    assert.equal(socket.sent.length, beforeWaiting + 1);
    socket.emitMessage({type: 'inventory_updated', updatedCharacterItems: [inventoryItem('gobo_stabber', 10, 89)]});
    await waitingPurchase;
    State.run = null;
    snapshot(80, 55, [], [], sameSnapshotJournal);
    reconcileRecoveryJournal(sameSnapshotJournal);
    assert.equal(sameSnapshotJournal.inFlight, null, 'a fresh full snapshot can reconcile the interrupted replacement request');
    assert.equal(getRecoveryPurchaseRequirements(sameSnapshotJournal, 'gobo_stabber').shortages[10], 9);

    // Existing queued work owns one +9/+10 pair before the frozen suffix.
    const olderAction = strictActionFromFingerprint(151000, actionFingerprint(10, 11), 1);
    snapshot(89, 56, [olderAction]);
    const queued = interruptedPurchase({baselineInventory: 1, expectedInventory: 90,
        baselineProjectedInventory: 0, expectedProjectedInventory: 89});
    reconcileRecoveryJournal(queued);
    const projected = getRecoveryPurchaseRequirements(queued, 'gobo_stabber');
    assert.equal(projected.projected[10], 88);
    assert.equal(projected.projected[9], 55);
    assert.equal(projected.shortages[10], 1);
    await checkPurchase(queued, 10, 1, 89);
    snapshot(89, 55, [], [inventoryItem('gobo_stabber', 11, 1)], queued);
    assert.equal(getRecoveryPurchaseRequirements(queued, 'gobo_stabber').shortages[10], 0);
    await checkPurchase(queued, 10, 0, 89);

    // The first acknowledged command has completed: only its unsent suffix
    // needs new bases, and its +11 output is an existing dependency.
    snapshot(0, 0, [], [inventoryItem('gobo_stabber', 11, 1)]);
    const prefix = interruptedPurchase();
    const commands = enumeratePlanCommands(prefix.itemPlans, prefix.mode);
    acknowledgeRecoveryPrefix(prefix, commands, 1, 152000);
    const originalAcked = JSON.stringify(prefix.acked);
    const afterPrefix = reconcileRecoveryJournal(prefix);
    const prefixDemand = getRecoveryPurchaseRequirements(prefix, 'gobo_stabber');
    assert.equal(prefixDemand.required[10], 88);
    assert.equal(prefixDemand.required[9], 54);
    assert.equal(afterPrefix.commands.length - prefix.acked.length, 54);
    await checkPurchase(prefix, 10, 88, 0);
    assert.equal(JSON.stringify(prefix.acked), originalAcked, 'the acknowledged prefix is neither removed nor resent');

    snapshot(0, 0);
    const missingIntermediate = interruptedPurchase();
    acknowledgeRecoveryPrefix(missingIntermediate,
        enumeratePlanCommands(missingIntermediate.itemPlans, missingIntermediate.mode), 1, 153000);
    const beforeInvalid = socket.sent.length;
    assert.throws(() => reconcileRecoveryJournal(missingIntermediate), /中间|\+11|不足|缺少/);
    assert.notEqual(missingIntermediate.inFlight, null);
    assert.equal(socket.sent.length, beforeInvalid);

    snapshot(88, 56, [{...olderAction, hasMaxCount: true, maxCount: 2}]);
    const invalidQueue = interruptedPurchase();
    assert.throws(() => reconcileRecoveryJournal(invalidQueue), /投影|队列|单件/);
    assert.notEqual(invalidQueue.inFlight, null);
    assert.equal(socket.sent.length, beforeInvalid);

    for (const mismatch of ['identity', 'order']) {
        const journal = interruptedPurchase();
        const commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
        acknowledgeRecoveryPrefix(journal, commands, 2, 154000);
        const live = queueActionsForAcknowledgements(journal.acked);
        if (mismatch === 'identity') live[0].characterLoadoutID = 999;
        else [live[0].ordinal, live[1].ordinal] = [live[1].ordinal, live[0].ordinal];
        snapshot(100, 100, live);
        assert.throws(() => reconcileRecoveryJournal(journal), /一致|顺序|身份/);
        assert.notEqual(journal.inFlight, null, `${mismatch}: do not clear the purchase before validating the queue`);
        assert.equal(journal.purchases['gobo_stabber:10'].recoveryStock, undefined);
        assert.equal(socket.sent.length, beforeInvalid);
    }

    snapshot(0);
    const actionPending = interruptedPurchase();
    reconcileRecoveryJournal(actionPending);
    const nextCommand = enumeratePlanCommands(actionPending.itemPlans, actionPending.mode)[0];
    actionPending.inFlight = {
        type: 'action', commandKey: nextCommand.commandKey, commandIndex: nextCommand.commandIndex,
        fingerprint: recoveryFingerprint(actionPending, nextCommand), baselineActionIds: [],
    };
    const pendingActionIntent = JSON.stringify(actionPending.inFlight);
    const pendingActionRun = createRun(++runId);
    pendingActionRun.recoveryJournal = actionPending;
    State.run = pendingActionRun;
    const beforeActionGuard = socket.sent.length;
    await assert.rejects(purchaseAndConfirm(pendingActionRun, 'gobo_stabber', 10, 89),
        error => error?.code === 'RECOVERY_PENDING');
    assert.equal(JSON.stringify(actionPending.inFlight), pendingActionIntent,
        'stock recovery must never overwrite an unresolved action intent');
    assert.equal(socket.sent.length, beforeActionGuard);

    snapshot(0);
    const failedSave = interruptedPurchase();
    const originalIntent = JSON.stringify(failedSave.inFlight);
    const originalPurchases = JSON.stringify(failedSave.purchases);
    const originalSetItem = fakeWindow.localStorage.setItem;
    fakeWindow.localStorage.setItem = () => { throw new Error('synthetic storage failure'); };
    try {
        assert.throws(() => reconcileRecoveryJournal(failedSave), error => error?.code === 'RECOVERY_STORAGE_FAILED');
        assert.equal(JSON.stringify(failedSave.inFlight), originalIntent, 'failed persistence must preserve the unresolved purchase intent');
        assert.equal(JSON.stringify(failedSave.purchases), originalPurchases, 'failed persistence must not retain uncommitted recheck records');
    } finally {
        fakeWindow.localStorage.setItem = originalSetItem;
    }

    State.run = null;
    State.blockedReason = '';
    State.recoveryJournal = null;
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    emitFullInit();
}

async function runBeltSelectionAndNameCacheTests() {
    const persisted = new Map([
        ['MWI_SAFE_ENHANCER_SELECTION_V1', JSON.stringify([
            ...BELT_IDS, 'not_an_equipment', 'small_talisman_belt_refined',
        ])],
        ['MWI_SAFE_ENHANCER_PRESETS_V1', JSON.stringify([{
            name: 'New belts',
            items: [...BELT_IDS, BELT_IDS[0], 'not_an_equipment'],
        }])],
        ['MWI_SAFE_ENHANCER_NAMES_V1', JSON.stringify({
            savedAt: Date.now(),
            names: {gobo_stabber: 'Cached Gobo Stabber'},
        })],
    ]);
    const reloadWindow = {
        ...fakeWindow,
        __MWI_SAFE_ENHANCER_LOADED__: undefined,
        localStorage: {
            getItem: (key) => persisted.get(key) ?? null,
            setItem: (key, value) => persisted.set(key, String(value)),
            removeItem: (key) => persisted.delete(key),
        },
    };
    delete reloadWindow[Symbol.for('MWI_SHARED_AUTOMATION_COORDINATOR_V1')];
    const officialNames = Object.fromEntries(BELT_IDS.map((id) => [
        `/items/${id}`, id.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' '),
    ]));
    const requestedUrls = [];
    const officialBundle = `${location.origin}/static/js/belt-fixture.js`;
    const reloadContext = vm.createContext({
        ...context,
        window: reloadWindow,
        document: {
            ...fakeDocument,
            querySelectorAll: () => [
                {src: 'https://unrelated.invalid/static/js/ignore.js'},
                {src: officialBundle},
            ],
        },
        fetch: async (url, options) => {
            requestedUrls.push(url);
            assert.equal(options.credentials, 'same-origin');
            return {
                ok: true,
                text: async () => `const translations={itemNames:${JSON.stringify(officialNames)}};`,
            };
        },
        __MWI_SAFE_ENHANCER_RUNTIME_TEST_EXPORTS__: undefined,
    });
    vm.runInContext(source, reloadContext, {filename: userscriptPath});
    const reloaded = reloadContext.__MWI_SAFE_ENHANCER_RUNTIME_TEST_EXPORTS__;
    assert.deepEqual(Array.from(reloaded.State.selected), BELT_IDS,
        'a fresh script instance must retain all three persisted belt selections');
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.State.presets)), [
        {name: 'New belts', items: BELT_IDS},
    ], 'saved belt presets survive catalogue validation and still deduplicate');

    await reloaded.loadItemNames();
    assert.deepEqual(requestedUrls, [officialBundle],
        'a fresh but incomplete pre-belt cache must still fetch the same-origin dictionary');
    assert.equal(reloaded.State.names.get('gobo_stabber'), 'Cached Gobo Stabber');
    const updatedCache = JSON.parse(persisted.get('MWI_SAFE_ENHANCER_NAMES_V1'));
    for (const itemId of BELT_IDS) {
        assert.equal(reloaded.State.names.get(itemId), officialNames[`/items/${itemId}`]);
        assert.equal(updatedCache.names[itemId], officialNames[`/items/${itemId}`]);
    }
}

function runBeltPlanningAndLoadoutTests() {
    State.run = null;
    State.blockedReason = '';
    State.recoveryJournal = null;
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.settings.marketMaintenanceEnabled = false;
    State.settings.marketAutoSellExcessEnabled = false;
    State.settings.mode = 'quick';
    State.settings.targetCount = 1;
    State.settings.useExistingInventory = false;
    State.selected = new Set(BELT_IDS);
    emitFullInit();
    const batch = buildBatchPlan();
    assert.deepEqual(Array.from(batch.itemIds), BELT_IDS);
    assert.equal(batch.summary.sendCommands, 55 * BELT_IDS.length);
    const run = createRun(1600);
    for (const entry of batch.itemPlans) {
        assert.equal(entry.plan.purchases[9], 55);
        assert.equal(entry.plan.purchases[10], 89);
        const command = entry.plan.compressedActions[0];
        const {payload, fingerprint} = createEnhancePayload(run, entry.itemId, command, 'quick');
        const data = payload.newCharacterActionData;
        assert.equal(payload.type, 'new_character_action');
        assert.equal(data.primaryItemHash, `123::/item_locations/inventory::/items/${entry.itemId}::${command.startLevel}`);
        assert.equal(data.secondaryItemHash, '123::/item_locations/inventory::/items/philosophers_mirror::0');
        assert.equal(data.enhancingMaxLevel, command.targetLevel);
        assert.equal(data.characterLoadoutId, 17);
        assert.equal(data.isStartNow, false);
        assert.equal(fingerprint.primaryItemHash, data.primaryItemHash);
    }

    State.settings.useExistingInventory = true;
    for (const [index, itemId] of BELT_IDS.entries()) {
        // Exercise default-highest selection and exact +20 selection in the
        // new slot, retaining the worn copy while consuming spare +18/+19.
        const exact = index === BELT_IDS.length - 1;
        const wearableMap = {
            ...enhancingLoadout().wearableMap,
            '/item_locations/belt': `123::/item_locations/belt::/items/${itemId}::${exact ? 20 : 0}`,
        };
        const characterItems = [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem('grandmaster_enhancing_charm', 0, 1, '/item_locations/charm'),
            inventoryItem(itemId, 18, 1),
            inventoryItem(itemId, 19, 1),
            characterItem(itemId, 20, 1, '/item_locations/belt'),
        ];
        const characterLoadoutMap = {17: enhancingLoadout({wearableMap, useExactEnhancement: exact})};
        State.selected = new Set([itemId]);
        emitFullInit({characterItems, characterLoadoutMap});
        const plan = buildBatchPlan();
        assert.equal(plan.summary.sendCommands, 1, itemId);
        assert.deepEqual(JSON.parse(JSON.stringify(plan.loadoutTargetReservations)), [{
            itemId, itemHrid: `/items/${itemId}`, enhancementLevel: 20, count: 1,
        }]);
        const counts = plan.itemPlans[0].plan.consumedExisting;
        assert.equal(counts[18], 1);
        assert.equal(counts[19], 1);
        assert.equal(counts[20], 0, 'the equipped +20 belt cannot become enhancement input');
        assert.doesNotThrow(() => assertLoadoutTargetReservationsAvailable(plan.loadoutTargetReservations));

        if (exact) {
            const wrongLevel = {...wearableMap,
                '/item_locations/belt': `123::/item_locations/inventory::/items/${itemId}::19`};
            emitFullInit({characterItems, characterLoadoutMap: {
                17: enhancingLoadout({wearableMap: wrongLevel, useExactEnhancement: true}),
            }});
            assert.throws(() => buildBatchPlan(), /精确绑定.*\+19.*\+20/s,
                'an exact lower-level belt binding must not be consumed by its own batch');
        }
        emitFullInit({characterItems: characterItems.slice(0, -1), characterLoadoutMap});
        assert.throws(() => buildBatchPlan(), error => error?.code === 'INVALID_LOADOUT',
            'spare low-level belts cannot replace the reserved +20 loadout copy');
        assert.throws(() => assertLoadoutTargetReservationsAvailable(plan.loadoutTargetReservations), /\+20/);
    }

    State.selected = new Set(['gobo_stabber']);
    State.settings.useExistingInventory = false;
    State.blockedReason = '';
    emitFullInit();
}

async function runBeltRulesAndPurchaseTests() {
    const itemId = BELT_IDS[0];
    const hrid = `/items/${itemId}`;
    const validDetail = {...BELT_ITEM_DETAILS[hrid], baseItemHrids: [hrid]};
    State.selected = new Set([itemId]);
    State.settings.useExistingInventory = false;
    emitFullInit({itemDetailMap: {[hrid]: validDetail}});
    const frozen = buildBatchPlan();
    assert.equal(frozen.itemPlans[0].plan.purchases[10], 89,
        'an explicit same-item mirror base remains compatible');

    for (const [name, detail, code] of [
        ['missing item metadata', null, 'STATE_NOT_READY'],
        ['missing category', {...validDetail, categoryHrid: undefined}, 'STATE_NOT_READY'],
        ['non-equipment category', {...validDetail, categoryHrid: '/item_categories/resource'}, 'UNSUPPORTED_ENHANCEMENT'],
        ['no enhancement costs', {...validDetail, enhancementCosts: []}, 'UNSUPPORTED_ENHANCEMENT'],
        ['different mirror base', {...validDetail, baseItemHrids: ['/items/gobo_stabber']}, 'UNSUPPORTED_ENHANCEMENT'],
    ]) {
        State.run = null;
        State.recoveryJournal = null;
        emitFullInit({itemDetailMap: detail ? {[hrid]: detail} : {}});
        const before = socket.sent.length;
        assert.throws(() => buildBatchPlan(), error => error?.code === code, name);
        State.recoveryJournal = createRecoveryJournal(frozen, 'running');
        assert.throws(() => buildBatchPlan(), error => error?.code === code,
            `${name}: restoring a frozen belt plan must recheck current rules`);
        State.recoveryJournal = null;

        const run = createRun(1610);
        run.itemIds = [itemId];
        State.run = run;
        await assert.rejects(purchaseAndConfirm(run, itemId, 10, 2), error => error?.code === code, name);
        await assert.rejects(sendEnhanceAndConfirm(run, itemId, {startLevel: 19, targetLevel: 20}, 'quick'),
            error => error?.code === code, name);
        assert.equal(socket.sent.length, before, `${name}: neither a purchase nor an enhancement is sent`);
        assert.equal(State.pendingOp, null);
    }

    State.run = null;
    State.recoveryJournal = null;
    emitFullInit({itemDetailMap: {[hrid]: validDetail}});
    const run = createRun(1611);
    run.itemIds = [itemId];
    const journal = createRecoveryJournal(frozen, 'running');
    run.recoveryJournal = journal;
    State.run = run;
    for (const shops of [
        {},
        {'/shop_items/wrong_category': {...BELT_SHOP_DETAILS[Object.keys(BELT_SHOP_DETAILS)[0]], category: '/shop_categories/market'}},
        {'/shop_items/wrong_item': {...BELT_SHOP_DETAILS[Object.keys(BELT_SHOP_DETAILS)[0]], itemHrid: '/items/medium_talisman_belt'}},
    ]) {
        socket.emitMessage({type: 'init_client_data', itemDetailMap: {[hrid]: validDetail},
            shopItemDetailMap: shops, gameModeDetailMap: {standard: {marketRestricted: false}}});
        const before = socket.sent.length;
        await assert.rejects(purchaseAndConfirm(run, itemId, 10, 2),
            error => error?.code === 'TESTER_ITEM_UNAVAILABLE');
        assert.equal(journal.inFlight, null, 'unavailable shop mapping must not create a phantom purchase intent');
        assert.equal(socket.sent.length, before, 'unknown or unrelated tester offers never fall back to a guessed key');
    }

    socket.emitMessage({type: 'init_client_data', itemDetailMap: {[hrid]: validDetail},
        shopItemDetailMap: BELT_SHOP_DETAILS, gameModeDetailMap: {standard: {marketRestricted: false}}});
    const before = socket.sent.length;
    const purchase = purchaseAndConfirm(run, itemId, 10, 2);
    await waitUntil(() => socket.sent.length > before);
    assert.deepEqual(JSON.parse(socket.sent[before]).buyFromShopData, {
        shopItemHrid: `/shop_items/test/synthetic_${itemId}_offer`, enhancementLevel: 10, count: 2,
    }, 'belt purchasing uses the exact tester map key instead of deriving one from the item ID');
    socket.emitMessage({type: 'items_updated', endCharacterItems: [inventoryItem(itemId, 10, 2)]});
    assert.equal((await purchase).status, 'confirmed');
    assert.equal(journal.inFlight, null);
    assert.equal(journal.purchases[`${itemId}:10`].count, 2);
    assert.equal(socket.sent.length, before + 1);

    State.run = null;
    State.recoveryJournal = null;
    storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
    State.selected = new Set(['gobo_stabber']);
    State.blockedReason = '';
    emitFullInit();
}

async function runEndOldBatchTests() {
    const recoveryKey = 'MWI_SAFE_ENHANCER_RECOVERY_V1';
    const archiveKey = 'MWI_SAFE_ENHANCER_RECOVERY_ARCHIVE_V1';
    const currentItems = [
        inventoryItem('philosophers_mirror', 0, 20000),
        inventoryItem('gobo_slasher', 18, 1),
        inventoryItem('gobo_slasher', 19, 1),
        characterItem('grandmaster_enhancing_charm', 0, 1, '/item_locations/charm'),
    ];
    const currentLoadouts = {18: enhancingLoadout({id: 18})};
    function prepare() {
        State.run = null;
        State.pendingOp = null;
        State.marketOp = null;
        State.marketBusy = false;
        State.starting = false;
        State.blockedReason = '';
        State.recoveryJournal = null;
        State.socket = socket;
        socket.readyState = FakeWebSocket.OPEN;
        location.hostname = 'test.milkywayidle.com';
        location.search = '?characterId=123';
        storage.delete(recoveryKey);
        storage.delete(archiveKey);
        State.settings.marketMaintenanceEnabled = false;
        State.settings.marketAutoSellExcessEnabled = false;
        State.settings.mode = 'quick';
        State.settings.targetCount = 1;
        State.settings.useExistingInventory = false;
        State.selected = new Set(['gobo_stabber']);
        emitFullInit();
        const journal = createRecoveryJournal(buildBatchPlan(), 'stopped');
        emitFullInit({characterItems: currentItems, characterLoadoutMap: currentLoadouts});
        State.settings.useExistingInventory = true;
        State.selected = new Set(['gobo_slasher']);
        State.recoveryJournal = journal;
        const raw = JSON.stringify(journal);
        storage.set(recoveryKey, raw);
        return {journal, raw};
    }
    function assertUnchanged(raw, sentBefore, message) {
        assert.equal(storage.get(recoveryKey), raw, message);
        assert.equal(socket.sent.length, sentBefore, `${message}: no server write`);
    }
    assert.equal(typeof Controller.endOldBatch, 'function');
    let {journal, raw} = prepare();
    assert.throws(() => buildBatchPlan(), error => error?.code === 'RECOVERY_INVALID',
        'reproduce a frozen old-loadout journal blocking an otherwise empty current queue');
    const oldRun = createRun(1700);
    oldRun.active = false;
    oldRun.recoveryJournal = journal;
    State.run = oldRun;
    const inventoryBefore = JSON.stringify([...State.inventory]);
    const slotsBefore = JSON.stringify([...State.characterItemSlots]);
    const settingsBefore = JSON.stringify(State.settings);
    const selectionBefore = [...State.selected];
    const presetsBefore = JSON.stringify(State.presets);
    const unrelatedStorage = [...storage].filter(([key]) => key !== recoveryKey && key !== archiveKey);
    const sentBeforeSuccess = socket.sent.length;
    const previousConfirm = fakeWindow.confirm;
    fakeWindow.confirm = () => { throw new Error('ending an explicitly requested old record must not prompt again'); };
    try {
        assert.equal(await Controller.endOldBatch(), true);
    } finally {
        fakeWindow.confirm = previousConfirm;
    }
    assert.equal(storage.has(recoveryKey), false);
    const archive = JSON.parse(storage.get(archiveKey));
    assert.deepEqual(archive.journal, JSON.parse(raw), 'the complete old journal is archived before deletion');
    assert.ok(Number.isFinite(archive.endedAt) && archive.endedAt > 0);
    assert.equal(typeof archive.scriptVersion, 'string');
    assert.equal(State.recoveryJournal, null);
    assert.equal(State.run, null);
    assert.equal(oldRun.monitoringReleased, true);
    assert.equal(socket.sent.length, sentBeforeSuccess, 'ending a record does not queue, cancel, purchase or start anything');
    assert.equal(JSON.stringify([...State.inventory]), inventoryBefore);
    assert.equal(JSON.stringify([...State.characterItemSlots]), slotsBefore);
    assert.equal(State.actions.size, 0);
    assert.equal(JSON.stringify(State.settings), settingsBefore);
    assert.deepEqual([...State.selected], selectionBefore);
    assert.equal(JSON.stringify(State.presets), presetsBefore);
    for (const [key, value] of unrelatedStorage) assert.equal(storage.get(key), value, key);
    const fresh = buildBatchPlan();
    assert.equal(Boolean(fresh.isRecovery), false);
    assert.deepEqual(Array.from(fresh.itemIds), ['gobo_slasher']);
    assert.equal(fresh.enhancingLoadout.id, 18);
    assert.equal(fresh.summary.sendCommands, 1, 'the next preview uses current +18/+19 stock rather than the old purchased-base target');

    ({journal} = prepare());
    const existingQueue = [
        {id: 17001, ordinal: 1, actionHrid: '/actions/labyrinth/explore', hasMaxCount: false, isDone: false},
        strictActionFromFingerprint(17002, actionFingerprint(19, 20), 2),
        {id: 17003, ordinal: 3, actionHrid: '/actions/foraging/apple', hasMaxCount: true, maxCount: 10, currentCount: 2, isDone: false},
    ];
    emitFullInit({characterItems: currentItems, characterLoadoutMap: currentLoadouts, characterActions: existingQueue});
    const queueBefore = JSON.stringify([...State.actions]);
    const beforeQueuedEnd = socket.sent.length;
    assert.equal(await Controller.endOldBatch(), true);
    assert.equal(JSON.stringify([...State.actions]), queueBefore,
        'ending only the local target keeps labyrinth, enhancement and other queued actions exactly intact');
    assert.equal(socket.sent.length, beforeQueuedEnd, 'existing queue entries are neither cancelled nor recreated');
    assert.deepEqual(JSON.parse(storage.get(archiveKey)).journal, JSON.parse(JSON.stringify(journal)));

    ({journal} = prepare());
    const beforeConcurrentQueue = socket.sent.length;
    const endingWithNewQueue = Controller.endOldBatch();
    const addedAction = {id: 17004, ordinal: 1, actionHrid: '/actions/foraging/apple', isDone: false};
    State.actions.set('17004', addedAction);
    State.queueRevision++;
    assert.equal(await endingWithNewQueue, true);
    assert.deepEqual(State.actions.get('17004'), addedAction,
        'an authoritative new queue entry during quiescence is retained without blocking local record cleanup');
    assert.equal(socket.sent.length, beforeConcurrentQueue);

    const blockers = [
        ...['inventoryReady', 'queueReady', 'loadoutsReady', 'characterItemsReady'].map(key => [key, () => { State[key] = false; }]),
        ['disconnected socket', () => { socket.readyState = FakeWebSocket.CONNECTING; }],
        ['URL character mismatch', () => { location.search = '?characterId=999'; }],
        ['wrong journal character', (value) => { value.characterId = '999'; }],
        ['wrong journal host', (value) => { value.host = 'test.milkywayidlecn.com'; }],
        ['unacknowledged external queue addition', () => { State.pendingExternalQueueAdds.push({expiresAt: Date.now() + 60000}); }],
        ['starting a run', () => { State.starting = true; }],
        ['active run belonging to a different journal', value => {
            State.run = createRun(1701);
            State.run.recoveryJournal = {...value, jobId: `${value.jobId}:other`};
        }],
        ['pending enhancer operation', () => { State.pendingOp = {kind: 'purchase'}; }],
        ['pending market operation', () => { State.marketOp = {kind: 'post'}; }],
        ['busy market operation', () => { State.marketBusy = true; }],
        ['new unresolved intent', value => { value.inFlight = {type: 'purchase', sentAt: State.lastInitAt}; }],
        ['undated intent from this run', value => {
            value.inFlight = {type: 'action'};
            State.run = createRun(1702);
            State.run.active = false;
            State.run.recoveryJournal = value;
        }],
    ];
    for (const [name, mutate] of blockers) {
        ({journal} = prepare());
        mutate(journal);
        raw = JSON.stringify(journal);
        storage.set(recoveryKey, raw);
        const before = socket.sent.length;
        await assert.rejects(Controller.endOldBatch(), undefined, name);
        assertUnchanged(raw, before, name);
        assert.equal(storage.has(archiveKey), false, `${name}: no premature archive`);
    }

    for (const [name, mutate] of [
        ['an external queue addition is awaiting acknowledgment', () => {
            State.pendingExternalQueueAdds.push({expiresAt: Date.now() + 60000});
            State.queueRevision++;
        }],
        ['full snapshot changes', () => { emitFullInit({characterItems: currentItems, characterLoadoutMap: currentLoadouts}); }],
        ['connection epoch changes', () => { State.connectionEpoch++; }],
        ['record revision changes', value => { storage.set(recoveryKey, JSON.stringify({...value, revision: value.revision + 1})); }],
        ['record bytes change without a revision change', value => { storage.set(recoveryKey, JSON.stringify(value, null, 2)); }],
    ]) {
        ({journal} = prepare());
        const before = socket.sent.length;
        const ending = Controller.endOldBatch();
        mutate(journal);
        const expectedRaw = storage.get(recoveryKey);
        await assert.rejects(ending, undefined, name);
        assertUnchanged(expectedRaw, before, `${name} during async quiescence`);
        assert.equal(storage.has(archiveKey), false);
    }

    ({journal, raw} = prepare());
    const coordinator = fakeWindow[Symbol.for('MWI_SHARED_AUTOMATION_COORDINATOR_V1')];
    const release = await coordinator.acquire('test:end-old-batch-external-owner');
    const beforeLaneWait = socket.sent.length;
    const laneEnding = Controller.endOldBatch();
    try {
        await new Promise(resolve => setTimeout(resolve, 180));
        assert.equal(storage.get(recoveryKey), raw, 'an occupied shared lane prevents early deletion');
        assert.equal(storage.has(archiveKey), false);
        State.pendingOp = {kind: 'purchase'};
    } finally {
        release();
    }
    await assert.rejects(laneEnding);
    assertUnchanged(raw, beforeLaneWait, 'a pending request appearing while waiting for the lane is rechecked');

    for (const failure of ['archive', 'delete']) {
        ({journal, raw} = prepare());
        const originalSet = fakeWindow.localStorage.setItem;
        const originalRemove = fakeWindow.localStorage.removeItem;
        fakeWindow.localStorage.setItem = (key, value) => {
            if (failure === 'archive' && key === archiveKey) throw new Error('synthetic archive failure');
            return originalSet(key, value);
        };
        fakeWindow.localStorage.removeItem = key => {
            if (failure === 'delete' && key === recoveryKey) throw new Error('synthetic deletion failure');
            return originalRemove(key);
        };
        const before = socket.sent.length;
        try {
            await assert.rejects(Controller.endOldBatch());
        } finally {
            fakeWindow.localStorage.setItem = originalSet;
            fakeWindow.localStorage.removeItem = originalRemove;
        }
        assertUnchanged(raw, before, `${failure} persistence failure`);
        assert.equal(State.recoveryJournal?.jobId, journal.jobId);
    }

    for (const dated of [true, false]) {
        ({journal} = prepare());
        journal.inFlight = {type: 'purchase', ...(dated ? {sentAt: State.lastInitAt - 1000} : {})};
        storage.set(recoveryKey, JSON.stringify(journal));
        const before = socket.sent.length;
        assert.equal(await Controller.endOldBatch(), true,
            dated ? 'a full snapshot newer than the old intent allows ending it' : 'an undated legacy intent can be ended from a fresh page without its old run');
        assert.equal(socket.sent.length, before);
    }

    // Capture a genuine current-session marker, then remove the live request
    // with its exact ACK. An old-looking timestamp alone must not bypass the
    // marker guard; only another authoritative full sync makes it eligible.
    prepare();
    State.recoveryJournal = null;
    storage.delete(recoveryKey);
    State.selected = new Set(['gobo_stabber']);
    State.settings.useExistingInventory = false;
    emitFullInit();
    journal = createRecoveryJournal(buildBatchPlan(), 'running');
    const markerRun = createRun(1703);
    markerRun.recoveryJournal = journal;
    State.run = markerRun;
    const beforeMarkerPurchase = socket.sent.length;
    const markerPurchase = purchaseAndConfirm(markerRun, 'gobo_stabber', 10, 1);
    await waitUntil(() => socket.sent.length > beforeMarkerPurchase);
    const sameSyncIntent = {...journal.inFlight, sentAt: State.lastInitAt - 1000};
    assert.ok(sameSyncIntent.syncMarker);
    socket.emitMessage({type: 'items_updated', endCharacterItems: [inventoryItem('gobo_stabber', 10, 1)]});
    await markerPurchase;
    State.run = null;
    journal.inFlight = sameSyncIntent;
    State.recoveryJournal = journal;
    raw = JSON.stringify(journal);
    storage.set(recoveryKey, raw);
    const beforeMarkerEnd = socket.sent.length;
    await assert.rejects(Controller.endOldBatch());
    assertUnchanged(raw, beforeMarkerEnd, 'the current full-sync marker forbids ending an unresolved intent');
    emitFullInit();
    assert.equal(await Controller.endOldBatch(), true);
    assert.equal(socket.sent.length, beforeMarkerEnd, 'a fresh snapshot unlocks ending the old intent without replaying it');

    ({journal} = prepare());
    State.blockedReason = 'unrelated unresolved transaction';
    assert.equal(await Controller.endOldBatch(), true);
    assert.equal(State.blockedReason, 'unrelated unresolved transaction', 'ending one journal must not silently clear an unrelated unknown-write barrier');

    State.run = null;
    State.pendingOp = null;
    State.marketOp = null;
    State.marketBusy = false;
    State.starting = false;
    State.blockedReason = '';
    State.recoveryJournal = null;
    storage.delete(recoveryKey);
    storage.delete(archiveKey);
    State.selected = new Set(['gobo_stabber']);
    State.settings.useExistingInventory = false;
    emitFullInit();
}

function runEndOldBatchUiTests() {
    assert.equal(typeof UI.updateEndOldBatchControl, 'function');
    const savedUi = {refs: UI.refs, shadow: UI.shadow, locked: UI.locked, lastPlanPreviewKey: UI.lastPlanPreviewKey};
    const savedState = {
        run: State.run, starting: State.starting, endingOldBatch: State.endingOldBatch,
        pendingOp: State.pendingOp, inventoryReady: State.inventoryReady,
        blockedReason: State.blockedReason, actions: State.actions,
    };
    const button = {disabled: true, textContent: '', title: ''};
    const hint = {textContent: ''};
    const formControl = {disabled: false};
    const node = () => ({textContent: '', className: '', classList: {toggle() {}}});
    // Use the actual button declaration to bridge the minimal DOM double to
    // the generic form-lock selector that caused the inaccessible-button bug.
    const buttonMarkup = source.match(/<button\b[^>]*\bid="end-old-batch"[^>]*>/)?.[0];
    assert.ok(buttonMarkup);
    UI.refs = Object.fromEntries([
        'connection-badge', 'queue-badge', 'mirror-badge', 'loadout-badge',
        'character-badge', 'blocked', 'plan-preview',
    ].map(id => [id, node()]));
    Object.assign(UI.refs, {start: formControl, 'end-old-batch': button, 'end-old-batch-hint': hint});
    UI.shadow = {querySelectorAll: selector => selector === '[data-lock]'
        ? [formControl, ...(/\bdata-lock\b/.test(buttonMarkup) ? [button] : [])] : []};
    try {
        State.run = null;
        State.starting = false;
        State.endingOldBatch = false;
        State.pendingOp = null;
        State.actions = new Map([['17700', {id: 17700, actionHrid: '/actions/labyrinth/explore'}]]);
        UI.setLocked(true);
        assert.equal(formControl.disabled, true);
        assert.equal(button.disabled, false,
            'the actual exit button must remain clickable after the generic form-lock renderer runs');
        assert.match(button.title, /已有.*动作.*保留/);
        assert.match(hint.textContent, /已有动作继续执行/);
        State.blockedReason = 'synthetic stopped-run lock';
        UI.updateStatus();
        assert.equal(button.disabled, false,
            'the full status renderer cannot disable ending because UI.locked, blockedReason or unrelated actions remain');

        State.run = {active: true};
        State.pendingOp = {kind: 'queue'};
        State.inventoryReady = false;
        UI.updateEndOldBatchControl();
        assert.equal(button.disabled, false,
            'transaction and sync guards explain failures on click instead of making the exit inaccessible');
        State.endingOldBatch = true;
        UI.setLocked(false);
        assert.equal(UI.locked, true);
        assert.equal(button.disabled, true, 'only an already-running end operation disables duplicate clicks');
        assert.match(button.textContent, /正在结束/);
        assert.match(hint.textContent, /等待当前请求/);
        State.endingOldBatch = false;
        UI.updateEndOldBatchControl();
        assert.equal(button.disabled, false);
        assert.equal(button.textContent, '结束旧批次记录');
    } finally {
        Object.assign(State, savedState);
        Object.assign(UI, savedUi);
    }
}

async function runEndActiveOldBatchTests() {
    const recoveryKey = 'MWI_SAFE_ENHANCER_RECOVERY_V1';
    const archiveKey = 'MWI_SAFE_ENHANCER_RECOVERY_ARCHIVE_V1';
    const background = {id: 17800, ordinal: 1, actionHrid: '/actions/labyrinth/explore', hasMaxCount: false, isDone: false};
    function reset() {
        State.run = null;
        State.pendingOp = null;
        State.marketOp = null;
        State.marketBusy = false;
        State.starting = false;
        State.blockedReason = '';
        State.recoveryJournal = null;
        storage.delete(recoveryKey);
        storage.delete(archiveKey);
        State.settings.marketMaintenanceEnabled = false;
        State.settings.marketAutoSellExcessEnabled = false;
        State.settings.mode = 'quick';
        State.settings.useExistingInventory = true;
        State.selected = new Set(['gobo_stabber']);
    }
    async function startUntilPending(targetCount) {
        reset();
        State.settings.targetCount = targetCount;
        emitFullInit({characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 18, targetCount),
            inventoryItem('gobo_stabber', 19, targetCount),
            characterItem('grandmaster_enhancing_charm', 0, 1, '/item_locations/charm'),
        ], characterActions: [background]});
        const sentBefore = socket.sent.length;
        const starting = Controller.start();
        await waitUntil(() => State.pendingOp?.kind === 'queue' && socket.sent.length > sentBefore);
        return {starting, run: State.run, fingerprint: {...State.pendingOp.fingerprint}, sentBefore};
    }

    let active = await startUntilPending(2);
    const beforeEnding = JSON.parse(storage.get(recoveryKey));
    const ending = Controller.endOldBatch();
    assert.equal(active.run.stopRequested, true, 'ending an active matching journal first requests a graceful stop');
    assert.equal(State.endingOldBatch, true);
    assert.equal(storage.has(archiveKey), false, 'an in-flight request must finish before the archive snapshot is taken');
    socket.emitMessage({type: 'actions_updated', endCharacterActions: [
        strictActionFromFingerprint(17801, active.fingerprint, 2),
    ]});
    await active.starting;
    const afterAck = JSON.parse(storage.get(recoveryKey));
    assert.equal(afterAck.acked.length, 1);
    assert.ok(afterAck.revision > beforeEnding.revision);
    assert.equal(afterAck.inFlight, null);
    assert.equal(await ending, true);
    assert.deepEqual(JSON.parse(storage.get(archiveKey)).journal, afterAck,
        'auto-stop archives the latest exact ACK, not the pre-stop journal snapshot');
    assert.equal(State.run, null);
    assert.equal(storage.has(recoveryKey), false);
    assert.equal(socket.sent.length, active.sentBefore + 1,
        'the second target is never sent and no existing action is cancelled');
    assert.equal(State.actions.has('17800'), true);
    assert.equal(State.actions.has('17801'), true);

    active = await startUntilPending(2);
    const interruptedJobId = active.run.recoveryJournal.jobId;
    const interruptedEnd = Controller.endOldBatch().then(value => ({value}), error => ({error}));
    assert.equal(active.run.stopRequested, true);
    emitFullInit({characterActions: [background]});
    await active.starting;
    const interrupted = await interruptedEnd;
    assert.equal(interrupted.error?.code, 'RECOVERY_CONFLICT', 'a new full sync while stopping must abort cleanup');
    assert.equal(JSON.parse(storage.get(recoveryKey)).jobId, interruptedJobId);
    assert.equal(storage.has(archiveKey), false);
    assert.equal(State.endingOldBatch, false);
    assert.equal(socket.sent.length, active.sentBefore + 1);

    active = await startUntilPending(1);
    const finishingEnd = Controller.endOldBatch();
    socket.emitMessage({type: 'actions_updated', endCharacterActions: [
        strictActionFromFingerprint(17802, active.fingerprint, 2),
    ]});
    await active.starting;
    assert.equal(await finishingEnd, true,
        'a final exact ACK can naturally complete and clear the journal while ending waits');
    assert.equal(storage.has(recoveryKey), false);
    assert.equal(storage.has(archiveKey), false, 'an already-completed journal needs no second archive or delete');
    assert.equal(active.run.status, 'queued');
    assert.equal(State.actions.has('17800'), true);
    assert.equal(State.actions.has('17802'), true);
    assert.equal(socket.sent.length, active.sentBefore + 1);
    reset();
    State.settings.targetCount = 1;
    State.settings.useExistingInventory = false;
    emitFullInit();
}

async function runCurrentEnhancingLoadoutTests() {
    const recoveryKey = 'MWI_SAFE_ENHANCER_RECOVERY_V1';
    const beltId = BELT_IDS[0];
    const items = [
        inventoryItem('philosophers_mirror', 0, 20000),
        inventoryItem('gobo_stabber', 9, 60),
        inventoryItem('gobo_stabber', 10, 100),
        inventoryItem('gobo_stabber', 20, 1),
        characterItem('grandmaster_enhancing_charm', 0, 1, '/item_locations/charm'),
        characterItem(beltId, 20, 1, '/item_locations/belt'),
    ];
    const withBelt = enhancingLoadout({wearableMap: {
        ...enhancingLoadout().wearableMap,
        '/item_locations/belt': `123::/item_locations/belt::/items/${beltId}::0`,
    }});
    const withSelfTarget = enhancingLoadout({wearableMap: {
        ...withBelt.wearableMap,
        '/item_locations/main_hand': '123::/item_locations/inventory::/items/gobo_stabber::0',
    }});
    function reset(loadout = enhancingLoadout()) {
        State.run = null;
        State.pendingOp = null;
        State.marketOp = null;
        State.marketBusy = false;
        State.starting = false;
        State.blockedReason = '';
        State.recoveryJournal = null;
        storage.delete(recoveryKey);
        State.settings.marketMaintenanceEnabled = false;
        State.settings.marketAutoSellExcessEnabled = false;
        State.settings.mode = 'quick';
        State.settings.targetCount = 1;
        State.settings.useExistingInventory = false;
        State.selected = new Set(['gobo_stabber']);
        emitFullInit({characterItems: items, characterLoadoutMap: {17: loadout}});
    }
    function updateLoadout(loadout) {
        socket.emitMessage({type: 'loadouts_updated', characterLoadoutMap: {[loadout.id]: loadout}});
    }
    reset();
    const frozen = buildBatchPlan();
    const journal = createRecoveryJournal(frozen, 'running');
    const commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
    acknowledgeRecoveryPrefix(journal, commands, 2, 180000);
    replaceAuthoritativeActions(queueActionsForAcknowledgements(journal.acked));
    State.recoveryJournal = journal;
    storage.set(recoveryKey, JSON.stringify(journal));
    const oldRecovery = buildBatchPlan();
    const originalJournal = JSON.stringify(journal);
    const sentBefore = socket.sent.length;
    updateLoadout(withBelt);
    const recovered = buildBatchPlan();
    assert.equal(recovered.isRecovery, true);
    assert.equal(recovered.enhancingLoadout.id, 17);
    assert.equal(recovered.enhancingLoadout.fingerprint, getEnhancingLoadoutBinding().fingerprint);
    assert.notEqual(recovered.enhancingLoadout.fingerprint, journal.enhancingLoadout.fingerprint);
    assert.notEqual(recovered.signature, oldRecovery.signature,
        'the confirmation signature reflects the current same-ID loadout');
    assert.ok(recovered.enhancingLoadout.reservedItemHrids.includes(`/items/${beltId}`));
    assert.equal(JSON.stringify(journal), originalJournal,
        'adding a belt must not rewrite the frozen plan, original binding or acknowledged action fingerprints');
    assert.equal(storage.get(recoveryKey), originalJournal);
    assert.equal(recovered.recovery.presentOwned.length, 2);
    assert.equal(socket.sent.length, sentBefore);

    updateLoadout(withSelfTarget);
    const selfRecovered = buildBatchPlan();
    assert.deepEqual(JSON.parse(JSON.stringify(selfRecovered.loadoutTargetReservations)), [{
        itemId: 'gobo_stabber', itemHrid: '/items/gobo_stabber', enhancementLevel: 20, count: 1,
    }], 'a target newly used by the current loadout gains a +20 reservation');
    assert.notEqual(selfRecovered.signature, recovered.signature);
    assert.equal(JSON.stringify(journal), originalJournal);
    socket.emitMessage({type: 'items_updated', endCharacterItems: [inventoryItem('gobo_stabber', 20, 0)]});
    assert.throws(() => buildBatchPlan(), error => error?.code === 'INVALID_LOADOUT',
        'resuming with a newly self-used target still requires the protected +20');
    socket.emitMessage({type: 'items_updated', endCharacterItems: [inventoryItem('gobo_stabber', 20, 1)]});
    updateLoadout(enhancingLoadout({id: 18}));
    assert.throws(() => buildBatchPlan(), error => error?.code === 'RECOVERY_INVALID',
        'a deleted and recreated loadout cannot change the IDs of historical actions');
    assert.equal(JSON.stringify(journal), originalJournal);

    reset();
    let run = createRun(1801);
    State.run = run;
    const originalFingerprint = run.enhancingLoadoutFingerprint;
    updateLoadout(withBelt);
    assert.equal(run.stopRequested, false);
    assert.equal(State.blockedReason, '');
    assert.notEqual(run.enhancingLoadoutFingerprint, originalFingerprint);
    assert.ok(run.enhancingLoadoutReservedItemHrids.includes(`/items/${beltId}`));
    updateLoadout(withSelfTarget);
    assert.equal(run.loadoutTargetReservations.length, 1);
    assert.equal(run.loadoutTargetReservations[0].count, 1);
    assert.equal(run.stopRequested, false);
    updateLoadout(withBelt);
    assert.equal(run.loadoutTargetReservations.length, 0,
        'removing a target from the current loadout releases its old +20 reservation');
    socket.emitMessage({type: 'items_updated', endCharacterItems: [inventoryItem('gobo_stabber', 20, 0)]});
    assert.equal(run.stopRequested, false, 'a released old reservation cannot stop the current valid run');
    assert.equal(State.blockedReason, '');
    updateLoadout(withSelfTarget);
    assert.equal(run.stopRequested, true, 're-adding the target without its +20 must fail current validation');
    assert.match(State.blockedReason, /\+20/);

    for (const invalid of [enhancingLoadout({wearableMap: {}}), enhancingLoadout({id: 18})]) {
        reset();
        run = createRun(1802);
        State.run = run;
        updateLoadout(invalid);
        assert.equal(run.stopRequested, true, 'missing charm or a different ID still stops the run');
        assert.notEqual(State.blockedReason, '');
    }

    reset();
    run = createRun(1803);
    State.run = run;
    const coordinator = fakeWindow[Symbol.for('MWI_SHARED_AUTOMATION_COORDINATOR_V1')];
    const release = await coordinator.acquire('test:current-loadout-send-check');
    let operationCalled = false;
    const guarded = runOperationSafely(run, () => {
        operationCalled = true;
        return {status: 'confirmed'};
    });
    // Change authoritative state while the send waits for its lane, without
    // invoking the event monitor, so the final send guard must revalidate it.
    State.loadouts.set('17', enhancingLoadout({wearableMap: {}}));
    release();
    await assert.rejects(guarded);
    assert.equal(operationCalled, false, 'the shared-lane send guard must read the latest loadout');

    reset();
    const livePlan = buildBatchPlan();
    const liveJournal = createRecoveryJournal(livePlan, 'running');
    const liveCommands = enumeratePlanCommands(liveJournal.itemPlans, liveJournal.mode);
    const frozenDefinition = JSON.stringify(liveJournal.enhancingLoadout);
    const frozenPlans = JSON.stringify(liveJournal.itemPlans);
    run = createRun(1804);
    run.recoveryJournal = liveJournal;
    State.run = run;
    const beforeQueue = socket.sent.length;
    const queuePromise = sendEnhanceAndConfirm(run, 'gobo_stabber', liveCommands[0].action, 'quick', liveCommands[0]);
    await waitUntil(() => socket.sent.length > beforeQueue);
    const pendingIntent = JSON.stringify(liveJournal.inFlight);
    const pendingFingerprint = {...liveJournal.inFlight.fingerprint};
    updateLoadout(withBelt);
    assert.equal(run.stopRequested, false);
    assert.equal(JSON.stringify(liveJournal.inFlight), pendingIntent,
        'a valid incoming same-ID definition cannot rewrite an outstanding action intent');

    const metadataSave = {
        type: 'update_loadout',
        updateLoadoutData: {characterLoadoutUpdate: {
            id: 17, name: 'Enhancing', isDefault: false,
            suppressValidation: false, useExactEnhancement: false,
        }},
    };
    const beltHash = `123::/item_locations/belt::/items/${beltId}::20`;
    const slotSave = {
        type: 'update_loadout_slot',
        updateLoadoutSlotData: {characterLoadoutSlotUpdate: {
            id: 17, slotType: 'equipment', slotKey: '/item_locations/belt', itemIdentifier: beltHash,
        }},
    };
    socket.send(JSON.stringify(metadataSave));
    socket.send(JSON.stringify(slotSave));
    assert.equal(State.pendingEnhancingLoadoutSaves, 2);
    assert.equal(run.stopRequested, false);
    assert.deepEqual(JSON.parse(JSON.stringify(liveJournal.inFlight.fingerprint)), pendingFingerprint,
        'saving the loadout must preserve the already-sent action identity even when concurrency evidence is recorded');
    socket.emitMessage({type: 'actions_updated', endCharacterActions: [
        strictActionFromFingerprint(180020, pendingFingerprint, 1),
    ]});
    assert.equal((await queuePromise).status, 'confirmed',
        'the original exact action ACK remains valid while loadout saves wait');
    assert.equal(liveJournal.acked.length, 1);
    assert.equal(liveJournal.acked[0].fingerprint.characterLoadoutId, 17);
    const acknowledged = JSON.stringify(liveJournal.acked);

    const beforeDeferredPurchase = socket.sent.length;
    const deferredPurchase = purchaseAndConfirm(run, 'gobo_stabber', 10, 1);
    updateLoadout(enhancingLoadout());
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(State.pendingEnhancingLoadoutSaves, 2,
        'an unrelated full loadout map that does not reflect the first save cannot acknowledge it');
    assert.equal(socket.sent.length, beforeDeferredPurchase);
    const metadataApplied = enhancingLoadout({isDefault: false});
    updateLoadout(metadataApplied);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(State.pendingEnhancingLoadoutSaves, 1);
    assert.equal(socket.sent.length, beforeDeferredPurchase, 'one acknowledged save cannot release a second pending save');
    updateLoadout(metadataApplied);
    assert.equal(State.pendingEnhancingLoadoutSaves, 1, 'replaying the first map cannot acknowledge a missing belt slot');
    const bothApplied = enhancingLoadout({isDefault: false, wearableMap: {
        ...enhancingLoadout().wearableMap, '/item_locations/belt': beltHash,
    }});
    updateLoadout(bothApplied);
    assert.equal(State.pendingEnhancingLoadoutSaves, 0);
    await waitUntil(() => socket.sent.length > beforeDeferredPurchase);
    assert.equal(JSON.parse(socket.sent[beforeDeferredPurchase]).type, 'buy_from_shop');
    socket.emitMessage({type: 'items_updated', endCharacterItems: [inventoryItem('gobo_stabber', 10, 101)]});
    assert.equal((await deferredPurchase).status, 'confirmed');
    assert.equal(socket.sent.length, beforeDeferredPurchase + 1, 'the queued purchase is sent once after both exact saves');
    assert.equal(JSON.stringify(liveJournal.acked), acknowledged);
    assert.equal(JSON.stringify(liveJournal.enhancingLoadout), frozenDefinition);
    assert.equal(JSON.stringify(liveJournal.itemPlans), frozenPlans);
    assert.equal(run.enhancingLoadoutFingerprint, getEnhancingLoadoutBinding().fingerprint);
    assert.ok(run.enhancingLoadoutReservedItemHrids.includes(`/items/${beltId}`));

    reset();
    const copyJournal = createRecoveryJournal(buildBatchPlan(), 'running');
    storage.set(recoveryKey, JSON.stringify(copyJournal));
    State.recoveryJournal = copyJournal;
    run = createRun(1805);
    run.recoveryJournal = copyJournal;
    State.run = run;
    socket.send(JSON.stringify({type: 'copy_setup_to_loadout',
        copySetupToLoadoutData: {characterLoadoutId: 17}}));
    assert.equal(State.pendingEnhancingLoadoutSaves, 1);
    assert.equal(run.stopRequested, false);
    const beforeCopyWait = socket.sent.length;
    let copyOperationCalled = false;
    const copyWaiting = runOperationSafely(run, () => {
        copyOperationCalled = true;
        return {status: 'confirmed'};
    });
    const copyOutcome = copyWaiting.then(value => ({value}), error => ({error}));
    updateLoadout(withBelt);
    updateLoadout(bothApplied);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(State.pendingEnhancingLoadoutSaves, 1,
        'copy_setup has no expected patch, so ordinary full maps cannot prove it completed');
    assert.equal(copyOperationCalled, false);
    assert.equal(socket.sent.length, beforeCopyWait);
    emitFullInit({characterItems: items, characterLoadoutMap: {17: bothApplied}});
    assert.equal(State.pendingEnhancingLoadoutSaves, 0, 'a new authoritative init resets the copy-save barrier');
    assert.ok((await copyOutcome).error, 'the old active run cannot send across a full sync');
    assert.equal(copyOperationCalled, false);
    assert.equal(socket.sent.length, beforeCopyWait);
    assert.equal(JSON.parse(storage.get(recoveryKey)).jobId, copyJournal.jobId,
        'resynchronizing a save barrier preserves the unfinished batch');

    for (const type of ['delete_loadout', 'future_loadout_write']) {
        reset();
        run = createRun(1806);
        State.run = run;
        socket.send(JSON.stringify({type, data: {characterLoadoutId: 17}}));
        assert.equal(run.stopRequested, true, `${type} remains outside the known save exception`);
        assert.equal(State.pendingEnhancingLoadoutSaves, 0);
    }
    reset();
}

async function runBackgroundWorkSignalTests() {
    const watchdog = setTimeout(() => {
        throw new Error('background event wait did not resolve while browser timers were suspended');
    }, 5000);
    const runtimeDate = vm.runInContext('Date', context);
    const originalNow = runtimeDate.now;
    const originalSetTimeout = fakeWindow.setTimeout;
    const originalClearTimeout = fakeWindow.clearTimeout;
    const delayedTimers = new Map();
    const runs = [];
    let clock = Date.now();
    let timerId = 0;
    let runId = 1900;
    // Browser timers are suspended for this group. Only real incoming socket
    // messages and explicit user-stop notifications can finish due work.
    runtimeDate.now = () => clock;
    fakeWindow.setTimeout = (callback, delay) => {
        const id = {backgroundTimer: ++timerId};
        delayedTimers.set(id, {callback, delay, dueAt: clock + Number(delay || 0)});
        return id;
    };
    fakeWindow.clearTimeout = id => {
        if (!delayedTimers.delete(id)) originalClearTimeout(id);
    };
    const emit = async (delta = 0, message = {type: 'pong'}) => {
        clock += delta;
        socket.emitMessage(message);
        await flushMicrotasks(20);
    };
    const reset = async (options = {}) => {
        State.run = null;
        State.blockedReason = '';
        State.recoveryJournal = null;
        storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
        emitFullInit(options);
        await flushMicrotasks(20);
        const run = createRun(++runId);
        State.run = run;
        runs.push(run);
        return run;
    };
    try {
        let run = await reset();
        for (const delay of [1600, 2200, 5000]) {
            let finished = false;
            const beforeTimers = delayedTimers.size;
            const sleeping = sleepFor(delay, run).then(value => { finished = true; return value; });
            assert.equal(delayedTimers.size, beforeTimers + 1, 'pacing arms one deadline instead of chained polling');
            await emit(delay - 1, {type: 'items_updated', endCharacterItems: [inventoryItem('unrelated_resource', 0, delay)]});
            assert.equal(finished, false, `${delay}ms pacing/backoff cannot be shortened by a network notification`);
            await emit(1);
            assert.equal(await sleeping, true, 'an overdue sleep wakes on a socket event even with its timer suspended');
            assert.equal(delayedTimers.size, beforeTimers);
        }
        const stoppedSleep = sleepFor(10000, run);
        Controller.stop();
        await flushMicrotasks(20);
        assert.equal(await stoppedSleep, false, 'a user stop wakes a suspended timer immediately');

        run = await reset({actionQueueCap: 1, characterActions: [{
            id: 19001, actionHrid: '/actions/foraging/apple', ordinal: 1,
        }]});
        let slotFinished = false;
        const slot = waitForQuickQueueSlot(run).then(value => { slotFinished = true; return value; });
        await flushMicrotasks(20);
        await emit(1, {type: 'action_completed', endCharacterAction: {id: 19001, isDone: true}});
        assert.equal(slotFinished, false, 'completion alone does not release an authoritative queue slot');
        await emit(1, {type: 'actions_updated', endCharacterActions: [{id: 19001, isDone: true}]});
        assert.equal(await slot, true, 'queue-space ACK wakes the waiter without a 250ms polling timer');

        run = await reset();
        let quietFinished = false;
        const quiet = waitForStateQuiescence(120, 1000).then(() => { quietFinished = true; });
        await emit(119);
        assert.equal(quietFinished, false);
        await emit(1);
        await quiet;
        socket.send(JSON.stringify({type: 'update_loadout', updateLoadoutData: {characterLoadoutUpdate: {
            id: 17, name: 'Enhancing', isDefault: false, suppressValidation: false, useExactEnhancement: false,
        }}}));
        const saved = waitForEnhancingLoadoutSave(run);
        await emit(0, {type: 'loadouts_updated', characterLoadoutMap: {17: enhancingLoadout({isDefault: false})}});
        await saved;
        assert.equal(State.pendingEnhancingLoadoutSaves, 0, 'a matching save ACK wakes without a short timer poll');

        run = await reset();
        const first = actionFingerprint(17, 18);
        const second = actionFingerprint(18, 19);
        seedOwnedAction(run, 19010, first, 40);
        seedOwnedAction(run, 19011, second, 41);
        await emit(0, {type: 'actions_updated', endCharacterActions: [
            {...actionFromFingerprint(19010, first), ordinal: 42},
        ]});
        const initialOrderDue = run.ownedOrderValidationDueAt;
        const integrity = waitForOwnedQueueIntegrity(run);
        await emit(100, {type: 'actions_updated', endCharacterActions: [
            {...actionFromFingerprint(19011, second), ordinal: 43},
        ]});
        assert.equal(run.ownedOrderValidationDueAt, initialOrderDue + 100,
            'a split owned-order correction starts its own quiet window');
        const stableOrderDue = run.ownedOrderValidationDueAt;
        await emit(100, {type: 'actions_updated', endCharacterActions: [
            {...actionFromFingerprint(19010, first), ordinal: 52},
            {...actionFromFingerprint(19011, second), ordinal: 53},
            {id: 19012, ordinal: 1, actionHrid: '/actions/foraging/apple'},
        ]});
        assert.equal(run.ownedOrderValidationDueAt, stableOrderDue,
            'uniform ordinal shifts and unrelated Task actions do not postpone validation');
        await emit(stableOrderDue - clock - 1);
        assert.equal(run.ownedOrderValidationPending, true);
        await emit(1);
        await integrity;
        assert.equal(run.ownedOrderValidationPending, false);
        assert.equal(run.stopRequested, false);

        run = await reset();
        seedOwnedAction(run, 19020, first, 40);
        seedOwnedAction(run, 19021, second, 41);
        await emit(0, {type: 'actions_updated', endCharacterActions: [
            {...actionFromFingerprint(19020, first), ordinal: 44},
        ]});
        const invalidDue = run.ownedOrderValidationDueAt;
        const invalidOrder = waitForOwnedQueueIntegrity(run).then(value => ({value}), error => ({error}));
        await emit(100, {type: 'actions_updated', endCharacterActions: [{id: 19022, actionHrid: '/actions/foraging/apple', ordinal: 1}]});
        assert.equal(run.ownedOrderValidationDueAt, invalidDue);
        await emit(invalidDue - clock);
        assert.equal((await invalidOrder).error?.code, 'UNKNOWN');
        assert.equal(run.stopRequested, true, 'an overdue genuine order violation still stops the run');

        const queued = strictActionFromFingerprint(19030, actionFingerprint(10, 11), 1);
        const purchaseOptions = {characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 9, 1), inventoryItem('gobo_stabber', 10, 1),
            characterItem('grandmaster_enhancing_charm', 0, 1, '/item_locations/charm'),
        ], characterActions: [queued]};
        for (const changeOtherLevel of [false, true]) {
            run = await reset(purchaseOptions);
            const sentBefore = socket.sent.length;
            const purchased = beginPurchase(run, 89);
            const op = State.pendingOp;
            await emit(0, {type: 'items_updated', endCharacterItems: [
                inventoryItem('gobo_stabber', 9, 0), inventoryItem('gobo_stabber', 10, 89), inventoryItem('gobo_stabber', 11, 1),
            ]});
            const firstDue = op.projectionDueAt;
            await emit(50, {type: 'actions_updated', endCharacterActions: [{...queued, ordinal: 99}]});
            assert.equal(op.projectionDueAt, firstDue, 'an ordinal-only change does not affect purchase projection');
            await emit(50, {type: 'items_updated', endCharacterItems: [inventoryItem('gobo_slasher', 10, 40)]});
            assert.equal(op.projectionDueAt, firstDue, 'other item types do not reset the purchase quiet window');
            await emit(0, {type: 'actions_updated', endCharacterActions: [{...queued, isDone: true}]});
            let due = op.projectionDueAt;
            assert.equal(due, clock + CONFIG.PURCHASE_PROJECTION_QUIET_MS);
            if (changeOtherLevel) {
                const oldToken = op.projectionCheckToken;
                await emit(100, {type: 'items_updated', endCharacterItems: [inventoryItem('gobo_stabber', 11, 2)]});
                assert.equal(op.projectionDueAt, due + 100, 'all levels of the purchased item participate in its stable projection');
                assert.equal(Transactions.checkProjectedPurchase(op, oldToken), false);
                due = op.projectionDueAt;
            }
            await emit(due - clock - 1, {type: 'actions_updated', endCharacterActions: [{
                id: 19031, ordinal: 2, actionHrid: '/actions/foraging/apple',
            }]});
            assert.equal(State.pendingOp, op);
            assert.equal(op.projectionDueAt, due);
            clock++;
            assert.equal(Transactions.checkProjectedPurchase(op, op.projectionCheckToken - 1), false,
                'a stale timer token cannot settle an overdue purchase');
            const epoch = State.connectionEpoch;
            State.connectionEpoch++;
            assert.equal(Transactions.checkProjectedPurchase(op), false, 'a stale connection cannot confirm purchase inventory');
            State.connectionEpoch = epoch;
            await emit();
            assert.equal((await purchased).status, 'confirmed');
            assert.equal(State.pendingOp, null);
            assert.equal(op.projectionTimer, null);
            assert.equal(socket.sent.length, sentBefore + 1, 'event wakeups never resend a projected purchase');
        }

        run = await reset(purchaseOptions);
        const noEvidence = beginPurchase(run, 1);
        const pending = State.pendingOp;
        await emit(0, {type: 'actions_updated', endCharacterActions: [{...queued, isDone: true}]});
        await emit(CONFIG.PURCHASE_PROJECTION_QUIET_MS + 1);
        assert.equal(State.pendingOp, pending, 'an overdue quiet window without a purchase inventory receipt is not an ACK');
        await emit(0, {type: 'items_updated', endCharacterItems: [
            inventoryItem('gobo_stabber', 9, 0), inventoryItem('gobo_stabber', 10, 1), inventoryItem('gobo_stabber', 11, 1),
        ]});
        await emit(CONFIG.PURCHASE_PROJECTION_QUIET_MS);
        assert.equal((await noEvidence).status, 'confirmed');
        assert.equal(WorkSignals.listeners.size, 0, 'completed and stopped waits release every event listener');
    } finally {
        clearTimeout(watchdog);
        for (const run of runs) run.stopRequested = true;
        clock += CONFIG.QUEUE_SPACE_TIMEOUT_MS + CONFIG.QUEUE_ACK_TIMEOUT_MS + 1000;
        WorkSignals.notify();
        await flushMicrotasks(20);
        if (State.pendingOp) Transactions.settle(State.pendingOp, {status: 'rejected', reason: 'background test cleanup'});
        runtimeDate.now = originalNow;
        fakeWindow.setTimeout = originalSetTimeout;
        fakeWindow.clearTimeout = originalClearTimeout;
        delayedTimers.clear();
        State.run = null;
        State.blockedReason = '';
        State.recoveryJournal = null;
        storage.delete('MWI_SAFE_ENHANCER_RECOVERY_V1');
        emitFullInit();
        await flushMicrotasks(20);
    }
}

async function main() {
    // Establish a baseline; dedicated cases below cover both init orders.
    socket.sent.length = 0;
    emitFullInit();
    assert.equal(State.inventoryReady, true);
    assert.equal(State.queueReady, true);
    assert.equal(State.loadoutsReady, true);
    assert.equal(State.characterId, '123');
    assert.equal(State.actionQueueCap, 100);
    assert.equal(State.clientMarketDataReady, true);
    assert.equal(State.characterMarketAccessReady, true);
    assert.equal(State.hasAcceptedTradingRules, true);
    assert.equal(State.marketListingCap, 20);
    assert.deepEqual(
        {
            ...State.itemMarketDetails.get('gobo_stabber'),
        },
        {
            isTradable: true,
            sellPrice: 2,
        },
        'init_client_data freezes the tradability and vendor-price rule'
    );
    assert.equal(socket.sent.length, 0);
    assert.equal(
        State.settings.marketMaintenanceEnabled,
        false,
        'automatic cancel/claim/repost is opt-in by default'
    );
    const initInventoryRevision = State.inventoryRevision;
    socket.send(JSON.stringify({type: 'ping', pingData: {hash: 1}}));
    assert.equal(
        State.inventoryRevision,
        initInventoryRevision,
        'the first send must not reattach or clear server-first init state'
    );

    const cachedVersion = '2026-07-31T12:34:56.000Z';
    const cachedVersionMs = new Date(cachedVersion).getTime();
    const cachedClientData = {
        type: 'init_client_data',
        versionTimestamp: cachedVersion,
        itemDetailMap: {
            ...BELT_ITEM_DETAILS,
            '/items/gobo_stabber': {
                isTradable: true,
                sellPrice: 2,
            },
        },
        shopItemDetailMap: BELT_SHOP_DETAILS,
        gameModeDetailMap: {
            standard: {marketRestricted: false},
        },
    };
    const compressedClientData = compressLzStringUtf16(
        JSON.stringify(cachedClientData)
    );
    assert.deepEqual(
        JSON.parse(decompressLzStringUtf16(compressedClientData)),
        cachedClientData,
        'the embedded decoder must read the game compressToUTF16 format'
    );
    const upstreamUnicodeVector =
        '\u4e05\u19ba\u36ad\u69c8\u6d47\u2121\u752b\u4ec8\u11e8'
        + '\u6150\u4aa6\u241a\u01cd\u5436\u2000\u6a22\u3924\u4c40'
        + '\u606c\u0039\u00e3\u7f23\u1f0a\u0023\u4a2f\u1c77\u1835'
        + '\u0e70\u3bfc\u503e\u05c0\u5999\u2060\u0661\u33a9\u4181'
        + '\u1aa3\u55d5\u009a\u155d\u7fef\u5baf\u1020\u0020';
    assert.equal(
        decompressLzStringUtf16(upstreamUnicodeVector),
        '银河奶牛市场规则缓存：+9→+20，左一减一个价格位。'
            + '重复字典重复字典重复字典重复字典',
        'the decoder must match the upstream lz-string 1.5.0 UTF-16 '
            + 'vector, including Chinese and dictionary reuse'
    );
    for (const [encoding, storedData] of [
        ['LZ UTF-16', compressedClientData],
        ['plain JSON', `  ${JSON.stringify(cachedClientData)}`],
    ]) {
        storage.set('initClientData', storedData);
        const cachedSocket = new fakeWindow.WebSocket(
            'wss://api-test.milkywayidle.com/ws?characterId=123'
            + `&versionTimestamp=${cachedVersionMs}`
        );
        cachedSocket.open();
        assert.equal(State.clientMarketDataReady, true, encoding);
        assert.equal(State.clientMarketDataSource, 'game_cache', encoding);
        assert.equal(State.clientMarketDataCacheStatus, 'loaded', encoding);
        assert.equal(State.itemMarketDetails.get(BELT_IDS[0])?.hasEnhancementCosts, true, encoding);
        assert.equal(State.itemMarketDetails.get(BELT_IDS[0])?.testerShopItemHrid,
            `/shop_items/test/synthetic_${BELT_IDS[0]}_offer`,
            `${encoding}: same-version game data restores belt rules and the exact tester mapping`);
        emitFullInit({
            targetSocket: cachedSocket,
            emitClientData: false,
        });
        assert.equal(State.characterMarketAccessReady, true);
        assert.equal(State.myMarketListingsReady, true);
        assert.equal(
            State.gameModeMarketRestrictions.get('standard'),
            false,
            'a same-version game cache must unlock market rules without a '
                + 'network init_client_data message'
        );
    }

    const mismatchedCacheSocket = new fakeWindow.WebSocket(
        'wss://api-test.milkywayidle.com/ws?characterId=123'
        + `&versionTimestamp=${cachedVersionMs + 1}`
    );
    mismatchedCacheSocket.open();
    assert.equal(State.clientMarketDataReady, false);
    assert.equal(
        State.clientMarketDataCacheStatus,
        'version_mismatch',
        'a cache from another client-data version must not be trusted'
    );

    storage.delete('initClientData');
    const characterFirstSocket = new fakeWindow.WebSocket(
        'wss://api-test.milkywayidle.com/ws?characterId=123'
        + '&versionTimestamp=0'
    );
    characterFirstSocket.open();
    emitFullInit({
        targetSocket: characterFirstSocket,
        emitClientData: false,
    });
    assert.equal(State.myMarketListingsReady, true);
    assert.equal(State.characterMarketAccessReady, true);
    assert.equal(State.clientMarketDataReady, false);
    characterFirstSocket.emitMessage({
        type: 'init_client_data',
        itemDetailMap: cachedClientData.itemDetailMap,
        gameModeDetailMap: cachedClientData.gameModeDetailMap,
    });
    assert.equal(
        State.clientMarketDataReady,
        true,
        'client data arriving after character data must complete market init'
    );
    characterFirstSocket.emitMessage({
        type: 'init_client_data',
        itemDetailMap: cachedClientData.itemDetailMap,
        gameModeDetailMap: {
            standard: {},
        },
    });
    assert.equal(
        State.clientMarketDataReady,
        false,
        'a missing marketRestricted boolean must remain fail-closed'
    );

    socket.send(JSON.stringify({type: 'ping', pingData: {hash: 1}}));
    emitFullInit();

    assert.equal(
        parsePositiveInteger('999', '数量', CONFIG.MAX_COUNT_INPUT),
        999
    );
    for (const invalid of ['1000', '1e3', '1.5']) {
        assert.throws(
            () => parsePositiveInteger(
                invalid,
                '数量',
                CONFIG.MAX_COUNT_INPUT
            )
        );
    }

    runMarketMaintenanceContractTests();
    await runMarketMaintenanceStateMachineTests();

    for (const type of READ_ONLY_OUTGOING_TYPES) {
        const classified = classifyExternalOutgoing(
            JSON.stringify({type})
        );
        assert.equal(classified.kind, 'read_only', type);
        assert.equal(classified.type, type);
    }
    assert.equal(
        classifyExternalOutgoing(
            JSON.stringify({type: 'ping', pingData: {hash: 1}})
        ).kind,
        'heartbeat'
    );
    assert.equal(
        classifyExternalOutgoing(
            JSON.stringify({type: 'ping', pingData: {hash: 2}})
        ).kind,
        'state_changing_or_unknown'
    );
    for (const hash of ['1', true]) {
        assert.equal(
            classifyExternalOutgoing(
                JSON.stringify({type: 'ping', pingData: {hash}})
            ).kind,
            'state_changing_or_unknown'
        );
    }
    for (const raw of [
        'not-json',
        JSON.stringify([]),
        JSON.stringify({}),
        {binary: true},
    ]) {
        assert.equal(
            classifyExternalOutgoing(raw).kind,
            'malformed'
        );
    }
    for (const type of [
        'buy_from_shop',
        'post_market_order',
        'future_unknown_request',
    ]) {
        assert.equal(
            classifyExternalOutgoing(JSON.stringify({type})).kind,
            'state_changing_or_unknown',
            type
        );
    }

    emitFullInit();
    assert.equal(State.inventoryReady, true);
    assert.equal(State.queueReady, true);
    assert.equal(State.loadoutsReady, true);
    assert.equal(State.characterId, '123');
    assert.equal(getEnhancingLoadoutBinding().id, 17);

    State.selected.add('gobo_stabber');
    State.settings.mode = 'quick';
    State.settings.targetCount = 1;
    const plan = buildBatchPlan();
    assert.equal(plan.summary.sendCommands, 55);
    assert.equal(plan.enhancingLoadout.id, 17);
    assert.match(buildConfirmationText(plan), /第 1 件.*第 2 件/s);
    assert.match(buildConfirmationText(plan), /不同成品的动作不会交叉穿插/);
    assert.match(
        buildConfirmationText(plan),
        /Enhancing \(ID 17\).*Grandmaster Enhancing Charm/s
    );
    const payloadRun = createRun(89);
    const payloadDetails = createEnhancePayload(
        payloadRun,
        'gobo_stabber',
        {startLevel: 19, targetLevel: 20},
        'quick'
    );
    assert.equal(
        payloadDetails.payload.newCharacterActionData.characterLoadoutId,
        17
    );
    assert.equal(
        payloadDetails.payload.newCharacterActionData.isStartNow,
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            payloadDetails.payload.newCharacterActionData,
            'shouldClearQueue'
        ),
        false,
        'the official new action payload has no shouldClearQueue field'
    );
    assert.equal(payloadDetails.fingerprint.characterLoadoutId, 17);
    const verifiedPayloadDetails = createEnhancePayload(
        payloadRun,
        'gobo_stabber',
        {startLevel: 18, targetLevel: 19},
        'verified'
    );
    assert.equal(
        verifiedPayloadDetails.payload.newCharacterActionData
            .characterLoadoutId,
        17
    );
    assert.equal(
        verifiedPayloadDetails.payload.newCharacterActionData.isStartNow,
        true
    );
    const strictFingerprint = actionFingerprint(19, 20);
    assert.equal(
        actionFingerprintMatches(
            actionFromFingerprint(800, strictFingerprint),
            strictFingerprint
        ),
        true
    );
    const missingLoadoutAction =
        actionFromFingerprint(801, strictFingerprint);
    delete missingLoadoutAction.characterLoadoutID;
    assert.equal(
        actionFingerprintMatches(
            missingLoadoutAction,
            strictFingerprint
        ),
        false,
        'a receipt without a loadout ID must never confirm the action'
    );
    assert.equal(
        actionFingerprintMatches(
            {
                ...actionFromFingerprint(802, strictFingerprint),
                characterLoadoutID: 18,
            },
            strictFingerprint
        ),
        false
    );

    emitFullInit({characterLoadoutMap: null});
    assert.throws(() => buildBatchPlan(), /配装全量/);
    emitFullInit({
        characterLoadoutMap: {
            17: enhancingLoadout(),
            18: enhancingLoadout({id: 18}),
        },
    });
    assert.throws(() => buildBatchPlan(), /同名.*配装/s);
    emitFullInit({
        characterLoadoutMap: {
            17: enhancingLoadout({
                actionTypeHrid: '/action_types/combat',
            }),
        },
    });
    assert.throws(() => buildBatchPlan(), /不是强化或全技能配装/);
    emitFullInit({
        characterLoadoutMap: {
            17: enhancingLoadout({wearableMap: {}}),
        },
    });
    assert.throws(
        () => buildBatchPlan(),
        /Grandmaster Enhancing Charm/
    );
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
        ],
    });
    assert.throws(
        () => buildBatchPlan(),
        /grandmaster_enhancing_charm.*仅找到 0/
    );
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        characterLoadoutMap: {
            17: enhancingLoadout({
                useExactEnhancement: true,
                wearableMap: {
                    '/item_locations/charm':
                        '123::/item_locations/charm::'
                        + '/items/grandmaster_enhancing_charm::5',
                },
            }),
        },
    });
    assert.throws(
        () => buildBatchPlan(),
        /grandmaster_enhancing_charm \+5.*仅找到 0/
    );

    const exactPlus20EnhancingLoadout = enhancingLoadout({
        useExactEnhancement: true,
        wearableMap: {
            '/item_locations/charm':
                '123::/item_locations/charm::'
                + '/items/grandmaster_enhancing_charm::20',
        },
    });
    State.selected.clear();
    State.selected.add('grandmaster_enhancing_charm');
    State.settings.useExistingInventory = true;
    State.settings.targetCount = 1;
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem(
                'grandmaster_enhancing_charm',
                20,
                1,
                '/item_locations/charm'
            ),
        ],
        characterLoadoutMap: {
            17: exactPlus20EnhancingLoadout,
        },
    });
    const selfTargetPlan = buildBatchPlan();
    const selfTargetEntry = selfTargetPlan.itemPlans[0];
    assert.deepEqual(
        Array.from(selfTargetPlan.itemIds),
        ['grandmaster_enhancing_charm']
    );
    assert.equal(selfTargetPlan.summary.sendCommands, 55);
    assert.equal(selfTargetEntry.plan.purchases[9], 55);
    assert.equal(selfTargetEntry.plan.purchases[10], 89);
    assert.equal(selfTargetEntry.plan.consumedExisting[20], 0);
    assert.equal(
        [
            ...selfTargetEntry.plan.rawActions,
            ...selfTargetEntry.plan.compressedActions,
        ].some((action) => (
            action.startLevel >= 20 || action.targetLevel > 20
        )),
        false
    );
    assert.equal(selfTargetPlan.loadoutTargetReservations.length, 1);
    assert.equal(
        selfTargetPlan.loadoutTargetReservations[0].enhancementLevel,
        20
    );
    assert.match(buildConfirmationText(selfTargetPlan), /配装保留件.*\+20/s);
    assert.doesNotThrow(() => (
        assertPlansPreserveLoadoutTargetReservations(
            selfTargetPlan.itemPlans,
            selfTargetPlan.loadoutTargetReservations
        )
    ));
    assert.doesNotThrow(() => (
        assertLoadoutTargetReservationsAvailable(
            selfTargetPlan.loadoutTargetReservations
        )
    ));
    assert.equal(
        getLoadoutTargetReservations(
            ['grandmaster_enhancing_charm'],
            getEnhancingLoadoutBinding()
        )[0].count,
        1
    );

    const selfTargetRun = createRun(87);
    selfTargetRun.itemIds = ['grandmaster_enhancing_charm'];
    selfTargetRun.loadoutTargetReservations =
        selfTargetPlan.loadoutTargetReservations.map(
            (reservation) => ({...reservation})
        );
    State.run = selfTargetRun;
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            characterItem(
                'grandmaster_enhancing_charm',
                20,
                0,
                '/item_locations/charm'
            ),
        ],
    });
    assert.equal(selfTargetRun.stopRequested, true);
    assert.match(State.blockedReason, /\+20.*仅找到 0/);
    State.run = null;
    State.blockedReason = '';

    const queuedSelfTargetFingerprint = {
        ...actionFingerprint(10, 11),
        primaryItemHash:
            '123::/item_locations/inventory::'
            + '/items/grandmaster_enhancing_charm::10',
    };
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('grandmaster_enhancing_charm', 9, 1),
            inventoryItem('grandmaster_enhancing_charm', 10, 1),
            characterItem(
                'grandmaster_enhancing_charm',
                20,
                1,
                '/item_locations/charm'
            ),
        ],
        characterActions: [strictActionFromFingerprint(
            81_020,
            queuedSelfTargetFingerprint,
            1
        )],
        characterLoadoutMap: {
            17: exactPlus20EnhancingLoadout,
        },
    });
    const queuedSelfTargetPlan = buildBatchPlan();
    assert.equal(
        queuedSelfTargetPlan.itemPlans[0].forceFreshBases,
        true
    );
    assert.equal(queuedSelfTargetPlan.loadoutTargetReservations.length, 1);
    assert.equal(
        queuedSelfTargetPlan.itemPlans[0].plan.consumedExisting[20],
        0
    );

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        characterLoadoutMap: {
            17: exactPlus20EnhancingLoadout,
        },
    });
    assert.throws(
        () => buildBatchPlan(),
        /grandmaster_enhancing_charm \+20.*仅找到 0/
    );

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem(
                'grandmaster_enhancing_charm',
                5,
                1,
                '/item_locations/charm'
            ),
            inventoryItem('grandmaster_enhancing_charm', 20, 1),
        ],
        characterLoadoutMap: {
            17: enhancingLoadout({
                useExactEnhancement: true,
                wearableMap: {
                    '/item_locations/charm':
                        '123::/item_locations/charm::'
                        + '/items/grandmaster_enhancing_charm::5',
                },
            }),
        },
    });
    assert.throws(
        () => buildBatchPlan(),
        /精确绑定.*Grandmaster Enhancing Charm \+5/s
    );

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem(
                'grandmaster_enhancing_charm',
                10,
                1,
                '/item_locations/inventory'
            ),
        ],
        characterLoadoutMap: {
            17: enhancingLoadout({
                wearableMap: {
                    '/item_locations/charm':
                        '123::/item_locations/charm::'
                        + '/items/grandmaster_enhancing_charm::0',
                },
            }),
        },
    });
    assert.throws(
        () => buildBatchPlan(),
        /默认最大强化等级.*\+20.*仅找到 0/s
    );

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('grandmaster_enhancing_charm', 10, 1),
            characterItem(
                'grandmaster_enhancing_charm',
                20,
                1,
                '/item_locations/charm'
            ),
        ],
        characterLoadoutMap: {
            17: enhancingLoadout({
                wearableMap: {
                    '/item_locations/charm':
                        '123::/item_locations/charm::'
                        + '/items/grandmaster_enhancing_charm::0',
                },
            }),
        },
    });
    const maximumLevelSelfTargetPlan = buildBatchPlan();
    assert.equal(
        maximumLevelSelfTargetPlan.enhancingLoadout.useExactEnhancement,
        false
    );
    assert.equal(
        maximumLevelSelfTargetPlan.loadoutTargetReservations[0]
            .enhancementLevel,
        20
    );
    assert.equal(
        maximumLevelSelfTargetPlan.itemPlans[0].plan
            .consumedExisting[20],
        0,
        'default maximum-level loadout must still reserve the owned +20'
    );
    assert.doesNotThrow(() => (
        assertPlansPreserveLoadoutTargetReservations(
            maximumLevelSelfTargetPlan.itemPlans,
            maximumLevelSelfTargetPlan.loadoutTargetReservations
        )
    ));
    State.selected.clear();
    State.selected.add('gobo_stabber');
    emitFullInit();

    emitFullInit({
        characterLoadoutMap: {
            17: enhancingLoadout({name: ' Enhancing '}),
        },
    });
    assert.throws(() => buildBatchPlan(), /找不到名为“Enhancing”/);
    emitFullInit({
        characterLoadoutMap: {
            17: enhancingLoadout({characterId: null}),
        },
    });
    assert.throws(() => buildBatchPlan(), /缺少可验证的角色 ID/);
    const defaultEnhancersTopWearableMap = {
        '/item_locations/charm':
            '123::/item_locations/charm::'
            + '/items/grandmaster_enhancing_charm::0',
        '/item_locations/body':
            '123::/item_locations/body::/items/enhancers_top::0',
    };
    const defaultEnhancersTopCharacterItems = [
        inventoryItem('philosophers_mirror', 0, 20000),
        characterItem(
            'grandmaster_enhancing_charm',
            20,
            1,
            '/item_locations/charm'
        ),
        inventoryItem('enhancers_top', 18, 1),
        inventoryItem('enhancers_top', 19, 1),
        characterItem(
            'enhancers_top',
            20,
            1,
            '/item_locations/body'
        ),
    ];
    State.selected.clear();
    State.selected.add('enhancers_top');
    emitFullInit({
        characterItems: defaultEnhancersTopCharacterItems,
        characterLoadoutMap: {
            17: enhancingLoadout({
                wearableMap: defaultEnhancersTopWearableMap,
            }),
        },
    });
    const fullBinding = getEnhancingLoadoutBinding();
    assert.equal(
        fullBinding.reservedItemHrids.includes('/items/enhancers_top'),
        true
    );
    const defaultEnhancersTopPlan = buildBatchPlan();
    const defaultEnhancersTopEntry =
        defaultEnhancersTopPlan.itemPlans[0];
    assert.deepEqual(
        Array.from(defaultEnhancersTopPlan.itemIds),
        ['enhancers_top']
    );
    assert.equal(defaultEnhancersTopPlan.summary.sendCommands, 1);
    assert.equal(
        defaultEnhancersTopPlan.loadoutTargetReservations.length,
        1
    );
    assert.deepEqual(
        {
            itemId:
                defaultEnhancersTopPlan.loadoutTargetReservations[0]
                    .itemId,
            enhancementLevel:
                defaultEnhancersTopPlan.loadoutTargetReservations[0]
                    .enhancementLevel,
            count:
                defaultEnhancersTopPlan.loadoutTargetReservations[0]
                    .count,
        },
        {
            itemId: 'enhancers_top',
            enhancementLevel: 20,
            count: 1,
        }
    );
    assert.equal(
        defaultEnhancersTopEntry.plan.consumedExisting[18],
        1,
        'lower-level loadout-target stock remains available to the plan'
    );
    assert.equal(defaultEnhancersTopEntry.plan.consumedExisting[19], 1);
    assert.equal(defaultEnhancersTopEntry.plan.consumedExisting[20], 0);
    assert.equal(defaultEnhancersTopEntry.plan.remainingInventory[20], 0);
    assert.match(
        buildConfirmationText(defaultEnhancersTopPlan),
        /配装保留件：Enhancers Top \+20 ×1/s
    );
    assert.doesNotThrow(() => (
        assertPlansPreserveLoadoutTargetReservations(
            defaultEnhancersTopPlan.itemPlans,
            defaultEnhancersTopPlan.loadoutTargetReservations
        )
    ));

    const ordinaryTargetRun = createRun(88);
    ordinaryTargetRun.itemIds = ['enhancers_top'];
    ordinaryTargetRun.loadoutTargetReservations =
        defaultEnhancersTopPlan.loadoutTargetReservations.map(
            (reservation) => ({...reservation})
        );
    State.run = ordinaryTargetRun;
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            characterItem(
                'enhancers_top',
                20,
                0,
                '/item_locations/body'
            ),
        ],
    });
    assert.equal(
        ordinaryTargetRun.stopRequested,
        true,
        'losing the reserved ordinary +20 must stop further queue sends'
    );
    assert.match(State.blockedReason, /(?:enhancers_top|Enhancers Top).*\+20.*仅(?:有|找到) 0/s);
    State.run = null;
    State.blockedReason = '';

    emitFullInit({
        characterItems: defaultEnhancersTopCharacterItems,
        characterLoadoutMap: {
            17: enhancingLoadout({
                wearableMap: defaultEnhancersTopWearableMap,
            }),
        },
    });
    State.actions.set('819', {
        id: 819,
        actionHrid: '/actions/foraging/apple',
        primaryItemHash:
            '123::/item_locations/body::/items/enhancers_top::20',
        isDone: false,
    });
    let resourceRun = createRun(88);
    State.run = resourceRun;
    assert.equal(
        isSafeExternalQueueMutation({
            type: 'move_character_action_to_front',
            moveCharacterActionToFrontData: {
                characterActionId: 819,
            },
        }),
        false,
        'every wearable in Enhancing is reserved, not only the charm'
    );
    State.run = null;

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem(
                'grandmaster_enhancing_charm',
                20,
                1,
                '/item_locations/charm'
            ),
            inventoryItem('enhancers_top', 18, 1),
            inventoryItem('enhancers_top', 19, 1),
            characterItem(
                'enhancers_top',
                7,
                1,
                '/item_locations/body'
            ),
        ],
        characterLoadoutMap: {
            17: enhancingLoadout({
                wearableMap: defaultEnhancersTopWearableMap,
            }),
        },
    });
    assert.throws(
        () => buildBatchPlan(),
        /Enhancers Top.*默认最大强化等级.*\+20 ×1.*仅找到 0/s,
        'a lower-level loadout copy cannot replace the reserved +20'
    );

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem(
                'grandmaster_enhancing_charm',
                20,
                1,
                '/item_locations/charm'
            ),
            characterItem(
                'enhancers_top',
                7,
                1,
                '/item_locations/body'
            ),
            inventoryItem('enhancers_top', 20, 1),
        ],
        characterLoadoutMap: {
            17: enhancingLoadout({
                useExactEnhancement: true,
                wearableMap: {
                    '/item_locations/charm':
                        '123::/item_locations/charm::'
                        + '/items/grandmaster_enhancing_charm::20',
                    '/item_locations/body':
                        '123::/item_locations/body::'
                        + '/items/enhancers_top::7',
                },
            }),
        },
    });
    assert.throws(
        () => buildBatchPlan(),
        /精确绑定 Enhancers Top \+7.*保存为使用 \+20/s
    );

    State.selected.clear();
    State.selected.add('gobo_stabber');
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            characterItem(
                'grandmaster_enhancing_charm',
                20,
                1,
                '/item_locations/charm'
            ),
            inventoryItem('gobo_stabber', 18, 1),
            inventoryItem('gobo_stabber', 19, 1),
            characterItem(
                'gobo_stabber',
                20,
                1,
                '/item_locations/main_hand'
            ),
            characterItem(
                'gobo_stabber',
                20,
                1,
                '/item_locations/off_hand'
            ),
        ],
        characterLoadoutMap: {
            17: enhancingLoadout({
                useExactEnhancement: true,
                wearableMap: {
                    '/item_locations/charm':
                        '123::/item_locations/charm::'
                        + '/items/grandmaster_enhancing_charm::20',
                    '/item_locations/main_hand':
                        '123::/item_locations/main_hand::'
                        + '/items/gobo_stabber::20',
                    '/item_locations/off_hand':
                        '123::/item_locations/off_hand::'
                        + '/items/gobo_stabber::20',
                },
            }),
        },
    });
    const repeatedExactTargetPlan = buildBatchPlan();
    assert.equal(
        repeatedExactTargetPlan.loadoutTargetReservations[0].count,
        2,
        'two exact +20 loadout slots require two protected copies'
    );
    assert.equal(
        repeatedExactTargetPlan.itemPlans[0].plan.consumedExisting[18],
        1
    );
    assert.equal(
        repeatedExactTargetPlan.itemPlans[0].plan.consumedExisting[19],
        1
    );
    assert.equal(
        repeatedExactTargetPlan.itemPlans[0].plan.consumedExisting[20],
        0
    );
    emitFullInit();

    const previousUseExistingInventory =
        State.settings.useExistingInventory;
    State.settings.useExistingInventory = true;
    const sameItemQueuedFingerprint = actionFingerprint(10, 11);
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20_000),
            inventoryItem('gobo_stabber', 9, 999),
            inventoryItem('gobo_stabber', 10, 999),
            inventoryItem('gobo_stabber', 19, 50),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        characterActions: [
            strictActionFromFingerprint(
                81_001,
                sameItemQueuedFingerprint,
                1
            ),
        ],
    });
    const sameItemQueuedPlan = buildBatchPlan();
    const freshItemPlan = sameItemQueuedPlan.itemPlans[0];
    assert.equal(
        freshItemPlan.forceFreshBases,
        true,
        'an existing queue for the selected item forces a fresh-base plan '
            + 'instead of blocking another batch'
    );
    assert.equal(freshItemPlan.plan.purchases[9], 55);
    assert.equal(freshItemPlan.plan.purchases[10], 89);
    assert.equal(freshItemPlan.plan.purchaseItemCount, 144);
    assert.equal(
        Array.from(freshItemPlan.plan.consumedExisting)
            .slice(9, 21)
            .reduce((sum, count) => sum + Number(count || 0), 0),
        0,
        'the fresh batch must not reuse any +9 through +20 inventory '
            + 'that may belong to the running batch'
    );
    assert.equal(sameItemQueuedPlan.summary.sendCommands, 55);
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 19_999),
            inventoryItem('gobo_stabber', 9, 998),
            inventoryItem('gobo_stabber', 10, 998),
            inventoryItem('gobo_stabber', 11, 1),
            inventoryItem('gobo_stabber', 19, 50),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
    });
    const sameItemAfterNaturalCompletion = buildBatchPlan({
        forceFreshBaseItemIds:
            sameItemQueuedPlan.forceFreshBaseItemIds,
    });
    assert.equal(
        sameItemAfterNaturalCompletion.itemPlans[0].forceFreshBases,
        true
    );
    assert.equal(
        sameItemAfterNaturalCompletion.signature,
        sameItemQueuedPlan.signature,
        'natural completion during the confirmation dialog preserves the '
            + 'frozen fresh-base plan and mirror commitment'
    );
    State.settings.useExistingInventory =
        previousUseExistingInventory;
    emitFullInit();

    State.actionQueueCap = null;
    assert.throws(() => buildBatchPlan(), /队列容量/);
    State.actionQueueCap = 100;

    State.settings.targetCount = 50;
    const rollingPlan = buildBatchPlan();
    assert.equal(rollingPlan.summary.sendCommands, 2750);
    assert.equal(rollingPlan.queueFreeSlots, 100);
    State.settings.targetCount = 1;

    let queueWaitRun = createRun(90);
    State.run = queueWaitRun;
    State.actions.set('700', {
        id: 700,
        actionHrid: '/actions/test/wait',
    });
    State.actionQueueCap = 1;
    let slotSettled = false;
    const slotPromise = waitForQuickQueueSlot(queueWaitRun).then((value) => {
        slotSettled = true;
        return value;
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 700,
            isDone: true,
            actionHrid: '/actions/test/wait',
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
        State.actions.has('700'),
        true,
        'action_completed must not release a queue slot'
    );
    assert.equal(slotSettled, false);
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{
            id: 700,
            isDone: true,
        }],
    });
    assert.equal(await slotPromise, true);

    queueWaitRun = createRun(91);
    State.run = queueWaitRun;
    State.actions.set('701', {
        id: 701,
        actionHrid: '/actions/test/wait',
    });
    const stoppedSlotPromise = waitForQuickQueueSlot(queueWaitRun);
    setTimeout(() => {
        Controller.stop();
    }, 20);
    assert.equal(await stoppedSlotPromise, false);
    State.actions.clear();

    queueWaitRun = createRun(92);
    State.run = queueWaitRun;
    State.actions.set('702', {
        id: 702,
        actionHrid: '/actions/test/wait',
    });
    await assert.rejects(
        waitForQuickQueueSlot(queueWaitRun, 10),
        (error) => (
            error?.code === 'QUEUE_WAIT_TIMEOUT' &&
            /不会被清除/.test(error.message)
        )
    );
    State.actions.clear();
    State.actionQueueCap = 100;
    State.run = null;

    location.search = '?characterId=124';
    assert.throws(() => buildBatchPlan(), /不一致/);
    location.search = '?characterId=123';

    emitFullInit({characterItems: null});
    assert.equal(State.inventoryReady, false);
    assert.equal(State.queueReady, true);
    emitFullInit({characterItems: null, characterActions: null});
    assert.equal(State.queueReady, false);
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [],
    });
    assert.equal(
        State.queueReady,
        false,
        'a delta must not replace the missing full queue snapshot'
    );
    emitFullInit();

    let run = createRun(1);
    State.run = run;
    socket.sent.length = 0;
    const purchasePromise = beginPurchase(run);
    assert.equal(socket.sent.length, 1);
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            inventoryItem('gobo_stabber', 10, 2),
        ],
    });
    assert.equal((await purchasePromise).status, 'confirmed');

    run = createRun(2);
    State.run = run;
    State.blockedReason = '';
    const sentBeforeError = socket.sent.length;
    const readOverlapPromise = runOperationSafely(
        run,
        () => beginPurchase(run, 1)
    );
    await waitUntil(() => socket.sent.length > sentBeforeError);
    const pendingBeforeRead = State.pendingOp;
    socket.send(JSON.stringify({
        type: 'get_market_item_order_books',
        getMarketItemOrderBooksData: {
            itemHrid: '/items/gobo_stabber',
        },
    }));
    assert.equal(run.stopRequested, false);
    assert.equal(run.interferenceDetected, false);
    assert.equal(State.blockedReason, '');
    assert.equal(State.pendingOp, pendingBeforeRead);
    socket.emitMessage({
        type: 'error',
        message: 'errorNotification.requestSpamProtection',
    });
    assert.equal(
        State.pendingOp,
        pendingBeforeRead,
        'an uncorrelated error immediately after an allowed read is not '
            + 'assigned to the owned request'
    );
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            inventoryItem('gobo_stabber', 10, 3),
        ],
    });
    assert.equal((await readOverlapPromise).status, 'confirmed');
    assert.equal(
        socket.sent.length,
        sentBeforeError + 2,
        'the ignored read error must never trigger an automatic resend'
    );
    assert.equal(State.blockedReason, '');

    State.externalErrorFenceUntil = 0;
    State.recentAllowedExternalRequest = null;
    const consumingQueuedFingerprint = actionFingerprint(10, 11);
    const consumingQueuedAction = strictActionFromFingerprint(
        81_101,
        consumingQueuedFingerprint,
        1
    );
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20_000),
            inventoryItem('gobo_stabber', 9, 1),
            inventoryItem('gobo_stabber', 10, 1),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        characterActions: [consumingQueuedAction],
    });
    State.run = null;
    State.blockedReason = '';
    const projectedRecoveryPlan = buildBatchPlan();
    const projectedRecoveryJournal = createRecoveryJournal(
        projectedRecoveryPlan,
        'running'
    );
    projectedRecoveryJournal.inFlight = {
        type: 'purchase',
        purchaseKey: 'gobo_stabber:10',
        itemId: 'gobo_stabber',
        level: 10,
        count: 89,
        baselineInventory: 1,
        expectedInventory: 90,
        baselineProjectedInventory: 0,
        expectedProjectedInventory: 89,
    };
    run = createRun(202);
    State.run = run;
    const sentBeforeProjectedPurchase = socket.sent.length;
    const projectedPurchase = beginPurchase(run, 89);
    assert.equal(
        socket.sent.length,
        sentBeforeProjectedPurchase + 1
    );
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            inventoryItem('gobo_stabber', 9, 0),
            inventoryItem('gobo_stabber', 10, 89),
            inventoryItem('gobo_stabber', 11, 1),
        ],
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{
            ...consumingQueuedAction,
            isDone: true,
        }],
    });
    assert.equal(
        (await projectedPurchase).status,
        'confirmed',
        'a successful +10 purchase is confirmed by the projected queue-tail '
            + 'balance even when an older action consumes one +10 first'
    );
    assert.equal(
        socket.sent.slice(sentBeforeProjectedPurchase)
            .map((raw) => JSON.parse(raw))
            .filter((message) => message.type === 'buy_from_shop')
            .length,
        1,
        'the queue-adjusted purchase receipt never triggers a duplicate buy'
    );
    assert.equal(State.blockedReason, '');
    reconcileRecoveryJournal(projectedRecoveryJournal);
    assert.equal(
        projectedRecoveryJournal.inFlight,
        null,
        'refresh recovery confirms the same successful purchase from the '
            + 'queue-tail projection instead of requiring physical +10=90'
    );
    assert.equal(
        projectedRecoveryJournal.purchases['gobo_stabber:10'].status,
        'confirmed'
    );
    State.run = null;

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20_000),
            inventoryItem('gobo_stabber', 9, 1),
            inventoryItem('gobo_stabber', 10, 1),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
        characterActions: [consumingQueuedAction],
    });
    run = createRun(203);
    State.run = run;
    const reverseOrderPurchase = beginPurchase(run, 1);
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{
            ...consumingQueuedAction,
            isDone: true,
        }],
    });
    await new Promise((resolve) => setTimeout(
        resolve,
        CONFIG.PURCHASE_PROJECTION_QUIET_MS + 30
    ));
    assert.equal(
        State.pendingOp != null,
        true,
        'queue removal alone cannot impersonate a purchase receipt when '
            + 'its inventory delta arrives later'
    );
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            inventoryItem('gobo_stabber', 9, 0),
            inventoryItem('gobo_stabber', 10, 1),
            inventoryItem('gobo_stabber', 11, 1),
        ],
    });
    assert.equal((await reverseOrderPurchase).status, 'confirmed');
    State.run = null;

    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20_000),
            inventoryItem('gobo_stabber', 10, 3),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
    });

    State.actions.clear();
    State.actions.set('705', {
        id: 705,
        ordinal: 5,
        actionHrid: '/actions/foraging/apple',
        isDone: false,
    });
    State.actions.set('706', {
        id: 706,
        ordinal: 6,
        actionHrid: '/actions/foraging/orange',
        isDone: false,
    });
    State.pendingExternalQueueAdds.length = 0;
    State.recentAllowedExternalRequest = null;
    run = createRun(21);
    State.run = run;
    State.blockedReason = '';
    const queueOverlapFingerprint = actionFingerprint(18, 19);
    const queueOverlapPayload = createEnhancePayload(
        run,
        'gobo_stabber',
        {startLevel: 18, targetLevel: 19},
        'quick'
    ).payload;
    const sentBeforeQueueOverlap = socket.sent.length;
    const queueOverlapPromise = Transactions.begin(run, {
        kind: 'queue',
        itemId: 'gobo_stabber',
        fingerprint: queueOverlapFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'external queue overlap timeout',
        payload: queueOverlapPayload,
    });
    const queueOverlapPending = State.pendingOp;
    const externalQueueRequests = [
        {
            type: 'new_character_action',
            newCharacterActionData: {
                actionHrid: '/actions/foraging/apple',
                isStartNow: false,
            },
        },
        {
            type: 'move_character_action',
            moveCharacterActionData: {
                characterActionId: 705,
                afterCharacterActionId: 0,
            },
        },
        {
            type: 'cancel_character_action',
            cancelCharacterActionData: {
                characterActionId: 706,
            },
        },
    ];
    for (const request of externalQueueRequests) {
        const sentBeforeExternalQueue = socket.sent.length;
        socket.send(JSON.stringify(request));
        assert.equal(
            socket.sent.length,
            sentBeforeExternalQueue + 1,
            `${request.type} must be forwarded while an owned queue `
                + 'request is pending'
        );
        assert.equal(State.pendingOp, queueOverlapPending);
        assert.equal(run.stopRequested, false);
        assert.equal(run.interferenceDetected, false);
        assert.equal(State.blockedReason, '');
    }
    assert.equal(queueOverlapPending.externalOverlapEver, true);
    assert.equal(
        queueOverlapPending.externalMatchingQueueAddSeen,
        false,
        'the unrelated external tail add must not match the owned enhance '
            + 'fingerprint'
    );
    socket.emitMessage({
        type: 'error',
        message: 'errorNotification.requestSpamProtection',
    });
    assert.equal(
        State.pendingOp,
        queueOverlapPending,
        'an uncorrelated spam error after external queue overlap must not '
            + 'settle or stop the owned queue request'
    );
    assert.equal(queueOverlapPending.phase, 'sent');
    assert.equal(run.stopRequested, false);
    assert.equal(State.blockedReason, '');
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                707,
                queueOverlapFingerprint,
                7
            ),
        ],
    });
    const queueOverlapOutcome = await queueOverlapPromise;
    assert.equal(queueOverlapOutcome.status, 'confirmed');
    assert.equal(queueOverlapOutcome.actionId, '707');
    assert.equal(
        socket.sent.length,
        sentBeforeQueueOverlap + 4,
        'one owned send plus three external queue requests complete without '
            + 'an automatic resend'
    );
    State.pendingExternalQueueAdds.length = 0;
    replaceAuthoritativeActions([]);

    State.externalErrorFenceUntil = 0;
    State.recentAllowedExternalRequest = null;
    run = createRun(212);
    State.run = run;
    const identicalExternalFingerprint =
        actionFingerprint(17, 18);
    const identicalExternalPayload = createEnhancePayload(
        run,
        'gobo_stabber',
        {startLevel: 17, targetLevel: 18},
        'quick'
    ).payload;
    const sentBeforeIdenticalExternal =
        socket.sent.length;
    const identicalExternalPromise = Transactions.begin(run, {
        kind: 'queue',
        itemId: 'gobo_stabber',
        fingerprint: identicalExternalFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'identical external queue timeout',
        payload: identicalExternalPayload,
    });
    socket.send(JSON.stringify(identicalExternalPayload));
    assert.equal(
        socket.sent.length,
        sentBeforeIdenticalExternal + 2,
        'an identical external queue request is forwarded, not intercepted'
    );
    assert.equal(
        State.pendingOp?.externalMatchingQueueAddSeen,
        true
    );
    assert.equal(run.stopRequested, false);
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                708,
                identicalExternalFingerprint,
                8
            ),
        ],
    });
    const identicalExternalOutcome =
        await identicalExternalPromise;
    assert.equal(identicalExternalOutcome.status, 'unknown');
    assert.match(
        identicalExternalOutcome.reason,
        /完全相同|无法安全判断/
    );
    assert.equal(
        identicalExternalOutcome.actionId,
        undefined,
        'a no-request-id candidate shared by identical owned/external sends '
            + 'must never be claimed as the owned action'
    );
    State.pendingExternalQueueAdds.length = 0;
    replaceAuthoritativeActions([]);

    State.externalErrorFenceUntil = 0;
    State.recentAllowedExternalRequest = null;
    run = createRun(213);
    State.run = run;
    const preOwnedExternalFingerprint =
        actionFingerprint(16, 17);
    const preOwnedExternalPayload = createEnhancePayload(
        run,
        'gobo_stabber',
        {startLevel: 16, targetLevel: 17},
        'quick'
    ).payload;
    socket.send(JSON.stringify(preOwnedExternalPayload));
    const preOwnedExternalPromise = Transactions.begin(run, {
        kind: 'queue',
        itemId: 'gobo_stabber',
        fingerprint: preOwnedExternalFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'pre-owned external queue timeout',
        payload: preOwnedExternalPayload,
    });
    assert.equal(
        State.pendingOp?.externalMatchingQueueAddSeen,
        true,
        'an unresolved identical external enqueue sent before Transactions.begin '
            + 'is inherited by the owned operation'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            strictActionFromFingerprint(
                709,
                preOwnedExternalFingerprint,
                9
            ),
        ],
    });
    assert.equal(
        (await preOwnedExternalPromise).status,
        'unknown'
    );
    State.pendingExternalQueueAdds.length = 0;
    replaceAuthoritativeActions([]);

    run = createRun(211);
    State.run = run;
    const sentBeforeInheritedFence = socket.sent.length;
    const inheritedFencePromise = Transactions.begin(run, {
        kind: 'purchase',
        itemId: 'gobo_stabber',
        level: 10,
        count: 1,
        baselineInventory:
            State.inventory.get('gobo_stabber')?.[10] || 0,
        expectedInventory:
            (State.inventory.get('gobo_stabber')?.[10] || 0) + 1,
        timeoutMs: 40,
        timeoutMessage: 'inherited external error fence timeout',
        payload: {
            type: 'buy_from_shop',
            buyFromShopData: {
                shopItemHrid:
                    '/shop_items/test/gobo_stabber',
                enhancementLevel: 10,
                count: 1,
            },
        },
    });
    socket.emitMessage({
        type: 'error',
        message: 'delayed external queue error',
    });
    assert.ok(
        State.pendingOp,
        'a delayed error from the just-finished external queue window is not '
            + 'misassigned to the next owned operation'
    );
    const inheritedFenceOutcome =
        await inheritedFencePromise;
    assert.equal(inheritedFenceOutcome.status, 'unknown');
    assert.match(
        inheritedFenceOutcome.reason,
        /inherited external error fence timeout/
    );
    assert.equal(
        socket.sent.length,
        sentBeforeInheritedFence + 1
    );
    State.externalErrorFenceUntil = 0;
    State.recentAllowedExternalRequest = null;

    run = createRun(22);
    State.run = run;
    const sentBeforeOwnedError = socket.sent.length;
    const unknownPromise = runOperationSafely(
        run,
        () => beginPurchase(run, 1)
    );
    await waitUntil(() => socket.sent.length > sentBeforeOwnedError);
    socket.emitMessage({
        type: 'error',
        message: 'errorNotification.requestSpamProtection',
    });
    await assert.rejects(unknownPromise, /不会重发/);
    assert.equal(
        socket.sent.length,
        sentBeforeOwnedError + 1,
        'an unattributed owned error must never trigger an automatic resend'
    );
    assert.match(State.blockedReason, /不会重发/);

    State.blockedReason = '';
    run = createRun(3);
    State.run = run;
    const firstFingerprint = actionFingerprint(19, 20);
    const firstVerified = Transactions.begin(run, {
        kind: 'verified',
        itemId: 'gobo_stabber',
        fingerprint: firstFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'verified timeout',
        payload: {type: 'new_character_action'},
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(7, firstFingerprint),
        ],
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(77, firstFingerprint),
        ],
    });
    assert.equal(
        State.pendingOp?.actionId,
        '7',
        'the first exact action.id must stay locked'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(77, firstFingerprint, true),
        ],
    });
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            inventoryItem('gobo_stabber', 20, 1),
        ],
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: actionFromFingerprint(
            7,
            firstFingerprint,
            true
        ),
    });
    assert.equal(
        State.pendingOp?.actionId,
        '7',
        'completion plus inventory is insufficient before removal'
    );
    assert.equal(
        State.actions.has('7'),
        true,
        'action_completed must not remove a verified action'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(7, firstFingerprint, true),
        ],
    });
    assert.equal((await firstVerified).status, 'confirmed');

    run = createRun(4);
    State.run = run;
    const secondFingerprint = actionFingerprint(19, 20);
    const secondVerified = Transactions.begin(run, {
        kind: 'verified',
        itemId: 'gobo_stabber',
        fingerprint: secondFingerprint,
        baselineTargetCount: 1,
        timeoutMs: 2000,
        timeoutMessage: 'verified reverse-order timeout',
        payload: {type: 'new_character_action'},
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(8, secondFingerprint),
        ],
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(8, secondFingerprint, true),
        ],
    });
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            inventoryItem('gobo_stabber', 20, 2),
        ],
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: actionFromFingerprint(
            8,
            secondFingerprint
        ),
    });
    assert.equal((await secondVerified).status, 'confirmed');

    run = createRun(40);
    State.run = run;
    const multiCycleVerifiedFingerprint = actionFingerprint(9, 12);
    const multiCycleVerified = Transactions.begin(run, {
        kind: 'verified',
        itemId: 'gobo_stabber',
        fingerprint: multiCycleVerifiedFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'verified multi-cycle timeout',
        payload: {type: 'new_character_action'},
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(
                80,
                multiCycleVerifiedFingerprint
            ),
        ],
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 80,
            primaryItemHash:
                '123::/item_locations/inventory::'
                + '/items/gobo_stabber::10',
        },
    });
    assert.equal(State.pendingOp?.completionSeen, false);
    assert.equal(State.pendingOp?.phase, 'waiting_completion');
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 80,
            primaryItemHash:
                '123::/item_locations/inventory::'
                + '/items/gobo_stabber::12',
        },
        endCharacterItems: [
            inventoryItem('gobo_stabber', 12, 1),
        ],
    });
    assert.equal(State.pendingOp?.completionSeen, true);
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{id: 80, isDone: true}],
    });
    assert.equal((await multiCycleVerified).status, 'confirmed');

    run = createRun(41);
    State.run = run;
    State.blockedReason = '';
    State.actions.set('900', {
        id: 900,
        actionHrid: '/actions/foraging/apple',
        isDone: false,
    });
    const rollingFingerprint = actionFingerprint(18, 19);
    const rollingQueuePromise = Transactions.begin(run, {
        kind: 'queue',
        itemId: 'gobo_stabber',
        fingerprint: rollingFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'rolling queue timeout',
        payload: {type: 'new_character_action'},
    });
    const rollingPending = State.pendingOp;
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {id: 902},
    });
    assert.equal(
        State.pendingOp,
        rollingPending,
        'an unrelated partial completion cannot supply identity for an '
            + 'unbound queue acknowledgement'
    );
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 900,
            actionHrid: '/actions/foraging/apple',
            isDone: true,
        },
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{
            id: 900,
            actionHrid: '/actions/foraging/apple',
            isDone: true,
        }],
    });
    assert.equal(
        State.pendingOp,
        rollingPending,
        'a previous queue action finishing must not abort the owned enqueue'
    );
    assert.equal(run.stopRequested, false);
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(901, rollingFingerprint),
        ],
    });
    const rollingOutcome = await rollingQueuePromise;
    assert.equal(rollingOutcome.status, 'confirmed');
    assert.equal(rollingOutcome.actionId, '901');
    run.ownedActionIds.add(String(rollingOutcome.actionId));

    run = createRun(411);
    State.run = run;
    State.actions.clear();
    const firstVisibleProgressFingerprint = actionFingerprint(9, 20);
    const firstVisibleProgressPromise = Transactions.begin(run, {
        kind: 'queue',
        itemId: 'gobo_stabber',
        fingerprint: firstVisibleProgressFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'first visible progress timeout',
        payload: {type: 'new_character_action'},
    });
    const firstVisibleProgress = {
        ...actionFromFingerprint(
            905,
            firstVisibleProgressFingerprint
        ),
        primaryItemHash:
            '123::/item_locations/inventory::'
            + '/items/gobo_stabber::10',
    };
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: firstVisibleProgress,
    });
    assert.equal(
        State.pendingOp?.observedActionIds.has('905'),
        true,
        'an identifying intermediate completion may lock a provisional ID '
            + 'but must not be settled as terminal'
    );
    assert.equal(State.pendingOp?.completionSeen, false);
    assert.equal(
        State.pendingOp?.spamRetryEvidenceSafe,
        false,
        'any provisional action ID permanently revokes automatic spam retry'
    );
    socket.emitMessage({
        type: 'error',
        message: 'errorNotification.requestSpamProtection',
    });
    assert.equal(State.pendingOp?.phase, 'reconciling');
    assert.equal(
        State.pendingOp?.spamRetryEvidenceSafe,
        false,
        'a later exact spam error cannot restore retry eligibility after '
            + 'an action ID was observed'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [firstVisibleProgress],
    });
    const firstVisibleProgressOutcome =
        await firstVisibleProgressPromise;
    assert.equal(firstVisibleProgressOutcome.status, 'confirmed');
    assert.equal(firstVisibleProgressOutcome.actionId, '905');
    assert.equal(firstVisibleProgressOutcome.terminal, false);

    run = createRun(42);
    State.run = run;
    State.actions.clear();
    const ambiguousFingerprint = actionFingerprint(17, 18);
    const ambiguousPromise = Transactions.begin(run, {
        kind: 'queue',
        itemId: 'gobo_stabber',
        fingerprint: ambiguousFingerprint,
        baselineTargetCount: 0,
        timeoutMs: 2000,
        timeoutMessage: 'ambiguous queue timeout',
        payload: {type: 'new_character_action'},
    });
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(902, ambiguousFingerprint),
            actionFromFingerprint(903, ambiguousFingerprint),
        ],
    });
    assert.equal((await ambiguousPromise).status, 'unknown');

    State.actions.clear();
    State.actions.set('910', {
        id: 910,
        actionHrid: '/actions/foraging/apple',
        isDone: false,
    });
    run = createRun(43);
    State.run = run;
    State.blockedReason = '';
    const safeQueuePurchase = beginPurchase(run, 1);
    const safeQueuePending = State.pendingOp;
    const queueMutationRevision =
        State.outgoingQueueMutationRevision;
    socket.send(JSON.stringify({
        type: 'move_character_action_to_front',
        moveCharacterActionToFrontData: {
            characterActionId: 910,
        },
    }));
    assert.equal(run.stopRequested, false);
    assert.equal(run.interferenceDetected, false);
    assert.equal(State.blockedReason, '');
    assert.equal(State.pendingOp, safeQueuePending);
    assert.equal(
        State.outgoingQueueMutationRevision,
        queueMutationRevision + 1
    );
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            inventoryItem('gobo_stabber', 10, 4),
        ],
    });
    assert.equal((await safeQueuePurchase).status, 'confirmed');

    socket.send(JSON.stringify({
        type: 'move_character_action',
        moveCharacterActionData: {
            characterActionId: 910,
            afterCharacterActionId: 0,
        },
    }));
    assert.equal(
        run.stopRequested,
        false,
        'the official drag-to-front shape uses afterCharacterActionId: 0'
    );

    const tailMutationRevision =
        State.outgoingQueueMutationRevision;
    socket.send(JSON.stringify({
        type: 'new_character_action',
        newCharacterActionData: {
            actionHrid: '/actions/foraging/apple',
            isStartNow: false,
        },
    }));
    assert.equal(run.stopRequested, false);
    assert.equal(State.blockedReason, '');
    assert.equal(
        State.outgoingQueueMutationRevision,
        tailMutationRevision + 1
    );
    assert.equal(State.pendingExternalQueueAdds.length, 1);
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{
            id: 912,
            ordinal: 12,
            actionHrid: '/actions/foraging/apple',
            isDone: false,
        }],
    });
    assert.equal(
        State.pendingExternalQueueAdds.length,
        0,
        'the external slot reservation clears only on a matching queue ack'
    );
    assert.equal(
        isSafeExternalQueueMutation({
            type: 'new_character_action',
            newCharacterActionData: {
                actionHrid: '/actions/foraging/apple',
            },
        }),
        false,
        'a tail action must explicitly carry isStartNow: false'
    );
    assert.equal(
        isSafeExternalQueueMutation({
            type: 'cancel_character_action',
            cancelCharacterActionData: {
                characterActionId: 999999,
            },
        }),
        false,
        'unknown or stale action IDs fail closed'
    );

    run.ownedActionIds.add('911');
    const sentBeforeOwnedCancel = socket.sent.length;
    socket.send(JSON.stringify({
        type: 'cancel_character_action',
        cancelCharacterActionData: {
            characterActionId: 911,
        },
    }));
    assert.equal(
        socket.sent.length,
        sentBeforeOwnedCancel + 1,
        'even a potentially unsafe external queue request is forwarded'
    );
    assert.equal(
        run.stopRequested,
        false,
        'outgoing cancellation alone does not prove that an owned action '
            + 'was actually removed'
    );
    assert.equal(run.interferenceDetected, false);
    assert.equal(State.blockedReason, '');

    State.run = null;
    State.blockedReason = '';
    emitFullInit();
    run = createRun(44);
    State.run = run;
    socket.emitMessage({
        type: 'loadouts_updated',
        characterLoadoutMap: {
            17: enhancingLoadout(),
            99: enhancingLoadout({
                id: 99,
                name: 'Unrelated',
                actionTypeHrid: '/action_types/combat',
            }),
        },
    });
    assert.equal(
        run.stopRequested,
        false,
        'an unrelated loadout update must not stop the batch'
    );
    socket.emitMessage({
        type: 'loadouts_updated',
        characterLoadoutMap: {
            17: enhancingLoadout({wearableMap: {}}),
        },
    });
    assert.equal(run.stopRequested, true);
    assert.match(State.blockedReason, /Enhancing.*配装/);

    State.run = null;
    State.blockedReason = '';
    emitFullInit();
    run = createRun(441);
    State.run = run;
    socket.emitMessage({
        type: 'inventory_updated',
        updatedCharacterItems: [
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                0,
                '/item_locations/charm'
            ),
        ],
    });
    assert.equal(run.stopRequested, true);
    assert.match(
        State.blockedReason,
        /仅找到 0|所需物品已不可用/
    );

    State.run = null;
    State.blockedReason = '';
    emitFullInit();
    run = createRun(45);
    run.active = false;
    run.status = 'queued';
    seedOwnedAction(run, 920, actionFingerprint(19, 20), 20);
    State.run = run;
    socket.emitMessage({
        type: 'loadouts_updated',
        characterLoadoutMap: {
            17: enhancingLoadout({wearableMap: {}}),
        },
    });
    assert.match(
        run.queueWarning,
        /已入队动作全部完成前发生变化/
    );
    assert.match(State.blockedReason, /队列中的动作可能/);

    State.run = null;
    State.blockedReason = '';
    emitFullInit();
    run = createRun(451);
    run.active = false;
    run.status = 'queued';
    seedOwnedAction(run, 921, actionFingerprint(19, 20), 21);
    State.run = run;
    socket.send(JSON.stringify({
        type: 'get_market_item_order_books',
        getMarketItemOrderBooksData: {
            itemHrid: '/items/gobo_stabber',
        },
    }));
    assert.equal(State.blockedReason, '');
    socket.send(JSON.stringify({type: 'sell_to_shop'}));
    assert.equal(
        run.status,
        'unknown',
        'a known item mutation with no item identity remains ambiguous and '
            + 'invalidates an already-queued run tail'
    );
    assert.equal(run.stopRequested, true);
    assert.match(
        State.blockedReason,
        /触碰本批装备|外部请求/
    );

    State.run = null;
    State.blockedReason = '';
    emitFullInit();
    run = createRun(46);
    const naturalFingerprint = actionFingerprint(18, 19);
    seedOwnedAction(run, 930, naturalFingerprint, 30);
    State.run = run;
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            {
                ...actionFromFingerprint(
                    930,
                    naturalFingerprint,
                    true
                ),
                ordinal: 30,
            },
        ],
    });
    assert.equal(run.ownedRemovalPending.has('930'), true);
    assert.equal(run.stopRequested, false);
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: actionFromFingerprint(
            930,
            naturalFingerprint,
            true
        ),
    });
    assert.equal(run.ownedActionIds.size, 0);
    assert.equal(run.ownedRemovalPending.size, 0);
    assert.equal(run.stopRequested, false);
    assert.equal(State.blockedReason, '');

    State.run = null;
    emitFullInit();
    run = createRun(461);
    const compressedFingerprint = actionFingerprint(9, 12);
    seedOwnedAction(run, 931, compressedFingerprint, 31);
    State.run = run;
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            ...actionFromFingerprint(
                931,
                compressedFingerprint
            ),
            primaryItemHash:
                '123::/item_locations/inventory::'
                + '/items/gobo_stabber::10',
        },
    });
    assert.equal(run.stopRequested, false);
    assert.equal(
        run.completedOwnedActionIds.has('931'),
        false,
        'the first cycle of a compressed action is progress, not terminal'
    );
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 931,
            actionHrid: '/actions/enhancing/enhance',
            primaryItemHash:
                '123::/item_locations/inventory::'
                + '/items/gobo_stabber::11',
        },
    });
    assert.equal(run.stopRequested, false);
    assert.equal(run.completedOwnedActionIds.has('931'), false);
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 931,
            primaryItemHash:
                '123::/item_locations/inventory::'
                + '/items/gobo_stabber::12',
        },
    });
    assert.equal(
        run.completedOwnedActionIds.has('931'),
        true,
        'reaching the frozen target is terminal evidence'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{id: 931, isDone: true}],
    });
    assert.equal(run.ownedActionIds.size, 0);
    assert.equal(run.stopRequested, false);

    State.run = null;
    emitFullInit();
    run = createRun(462);
    const outputFingerprint = actionFingerprint(9, 20);
    seedOwnedAction(run, 932, outputFingerprint, 32);
    State.run = run;
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            ...actionFromFingerprint(932, outputFingerprint),
            primaryItemHash:
                '123::/item_locations/inventory::'
                + '/items/gobo_stabber::10',
        },
    });
    assert.equal(
        run.completedOwnedOutputCounts?.get('gobo_stabber') || 0,
        0,
        'an intermediate cycle must not count a +20 output'
    );
    const terminalOutput = {
        id: 932,
        primaryItemHash:
            '123::/item_locations/inventory::'
            + '/items/gobo_stabber::20',
    };
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: terminalOutput,
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: terminalOutput,
    });
    assert.equal(
        run.completedOwnedOutputCounts.get('gobo_stabber'),
        1,
        'duplicate terminal completion events must be idempotent'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{id: 932, isDone: true}],
    });
    assert.equal(run.ownedActionIds.size, 0);
    assert.equal(run.stopRequested, false);

    State.run = null;
    emitFullInit();
    run = createRun(463);
    const partialAfterRemovalFingerprint = actionFingerprint(19, 20);
    seedOwnedAction(run, 933, partialAfterRemovalFingerprint, 33);
    State.run = run;
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{id: 933, isDone: true}],
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 933,
            actionHrid: '/actions/enhancing/enhance',
        },
    });
    assert.equal(run.ownedActionIds.size, 0);
    assert.equal(run.stopRequested, false);
    assert.equal(
        actionCompletionMatches(
            {id: 933},
            partialAfterRemovalFingerprint
        ),
        true,
        'a partial completion may omit unchanged identity fields'
    );

    State.run = null;
    emitFullInit();
    run = createRun(4630);
    const removalBeforeIntermediateFingerprint =
        actionFingerprint(9, 20);
    seedOwnedAction(
        run,
        937,
        removalBeforeIntermediateFingerprint,
        34
    );
    State.run = run;
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{id: 937, isDone: true}],
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            ...actionFromFingerprint(
                937,
                removalBeforeIntermediateFingerprint
            ),
            primaryItemHash:
                '123::/item_locations/inventory::'
                + '/items/gobo_stabber::10',
        },
    });
    assert.equal(
        run.ownedActionIds.has('937'),
        true,
        'removal followed by an early multi-cycle completion is not terminal'
    );
    assert.equal(
        run.completedOwnedOutputCounts?.get('gobo_stabber') || 0,
        0
    );
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 937,
            primaryItemHash:
                '123::/item_locations/inventory::'
                + '/items/gobo_stabber::19',
        },
    });
    assert.equal(run.ownedActionIds.size, 0);
    assert.equal(run.stopRequested, false);
    assert.equal(
        run.completedOwnedOutputCounts.get('gobo_stabber'),
        1
    );

    State.run = null;
    emitFullInit();
    run = createRun(4631);
    const partialBeforeRemovalFingerprint = actionFingerprint(19, 20);
    seedOwnedAction(run, 936, partialBeforeRemovalFingerprint, 34);
    State.run = run;
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            id: 936,
            actionHrid: '/actions/enhancing/enhance',
        },
    });
    assert.equal(run.completedOwnedActionIds.has('936'), false);
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{id: 936, isDone: true}],
    });
    assert.equal(
        run.ownedActionIds.size,
        0,
        'a compatible one-step completion followed by removal must pair '
            + 'without waiting for a duplicate completion event'
    );
    assert.equal(run.stopRequested, false);
    assert.equal(
        run.completedOwnedOutputCounts.get('gobo_stabber'),
        1
    );
    assert.equal(
        actionProgressMatches(
            {
                ...actionFromFingerprint(
                    934,
                    compressedFingerprint
                ),
                primaryItemHash:
                    '123::/item_locations/inventory::'
                    + '/items/gobo_stabber::11',
            },
            compressedFingerprint
        ),
        true
    );
    assert.equal(
        progressSingleEnhanceActionMatches(
            {
                ...actionFromFingerprint(
                    934,
                    compressedFingerprint
                ),
                primaryItemHash:
                    '123::/item_locations/inventory::'
                    + '/items/gobo_slasher::11',
            },
            compressedFingerprint
        ),
        false,
        'progress compatibility must still reject a different item'
    );

    State.run = null;
    emitFullInit();
    run = createRun(464);
    const refreshedAtTargetFingerprint = actionFingerprint(19, 20);
    const refreshedAtTargetAction = {
        ...actionFromFingerprint(
            935,
            refreshedAtTargetFingerprint
        ),
        primaryItemHash:
            '123::/item_locations/inventory::'
            + '/items/gobo_stabber::20',
    };
    State.actions.set('935', refreshedAtTargetAction);
    State.run = run;
    registerOwnedAction(
        run,
        935,
        refreshedAtTargetFingerprint,
        true
    );
    assert.equal(run.completedOwnedActionIds.has('935'), true);
    assert.equal(
        run.completedOwnedOutputCounts.get('gobo_stabber'),
        1,
        'refresh recovery at the frozen target restores terminal state'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{id: 935, isDone: true}],
    });
    assert.equal(run.ownedActionIds.size, 0);
    assert.equal(run.stopRequested, false);

    State.run = null;
    emitFullInit();
    run = createRun(47);
    const firstOwnedFingerprint = actionFingerprint(17, 18);
    const secondOwnedFingerprint = actionFingerprint(18, 19);
    seedOwnedAction(run, 940, firstOwnedFingerprint, 40);
    seedOwnedAction(run, 941, secondOwnedFingerprint, 41);
    State.run = run;
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            {
                ...actionFromFingerprint(
                    940,
                    firstOwnedFingerprint
                ),
                ordinal: 42,
            },
        ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            {
                ...actionFromFingerprint(
                    941,
                    secondOwnedFingerprint
                ),
                ordinal: 43,
            },
        ],
    });
    await new Promise((resolve) => {
        setTimeout(resolve, CONFIG.OWNED_ORDER_SETTLE_MS + 50);
    });
    assert.equal(
        run.stopRequested,
        false,
        'split ordinal updates may settle before relative-order validation'
    );
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            {
                ...actionFromFingerprint(
                    940,
                    firstOwnedFingerprint
                ),
                ordinal: 44,
            },
            {
                ...actionFromFingerprint(
                    941,
                    secondOwnedFingerprint
                ),
                ordinal: 41,
            },
        ],
    });
    await new Promise((resolve) => {
        setTimeout(resolve, CONFIG.OWNED_ORDER_SETTLE_MS + 50);
    });
    assert.equal(run.stopRequested, true);
    assert.match(State.blockedReason, /相对顺序发生变化/);

    State.run = null;
    State.blockedReason = '';
    emitFullInit();
    run = createRun(48);
    const removedWithoutCompletion =
        actionFingerprint(16, 17);
    seedOwnedAction(run, 950, removedWithoutCompletion, 50);
    State.run = run;
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [
            actionFromFingerprint(
                950,
                removedWithoutCompletion,
                true
            ),
        ],
    });
    await new Promise((resolve) => {
        setTimeout(resolve, CONFIG.OWNED_REMOVAL_GRACE_MS + 75);
    });
    assert.equal(run.stopRequested, true);
    assert.match(State.blockedReason, /未收到对应完成回执/);

    State.run = null;
    State.blockedReason = '';
    emitFullInit();
    run = createRun(5);
    State.run = run;
    State.blockedReason = '';
    const closePromise = beginPurchase(run, 1);
    const sentBeforeClose = socket.sent.length;
    socket.emitMessage({type: 'close_session'});
    assert.equal((await closePromise).status, 'unknown');
    assert.equal(socket.sent.length, sentBeforeClose);
    assert.equal(State.inventoryReady, false);
    assert.match(State.blockedReason, /会话/);

    State.run = null;
    State.starting = true;
    State.blockedReason = '';
    socket.send(JSON.stringify({
        type: 'get_market_item_order_books',
        getMarketItemOrderBooksData: {
            itemHrid: '/items/gobo_stabber',
        },
    }));
    assert.equal(State.blockedReason, '');
    socket.send(JSON.stringify({
        type: 'sell_to_shop',
        sellToShopData: {
            itemHrid: '/items/gobo_stabber',
        },
    }));
    assert.match(
        State.blockedReason,
        /触碰本批装备|外部请求/
    );
    State.starting = false;

    State.run = null;
    State.blockedReason = '';
    State.recentAllowedExternalRequest = null;
    emitFullInit();
    const allowedExternalOutgoing = [
        {
            label: 'escape_labyrinth',
            message: {
                type: 'escape_labyrinth',
                escapeLabyrinthData: {
                    labyrinthHrid: '/labyrinths/elemental',
                },
            },
        },
        {
            label: 'unknown request with unrelated resources',
            message: {
                type: 'future_unrelated_request',
                futureUnrelatedRequestData: {
                    itemHrid: '/items/apple',
                    characterLoadoutId: 99,
                },
            },
        },
        {
            label: 'noncanonical ping with no protected resources',
            message: {
                type: 'ping',
                pingData: {
                    hash: 2,
                },
            },
        },
        {
            label: 'unknown queue mutation',
            message: {
                type: 'future_queue_mutation',
                futureQueueMutationData: {
                    characterActionId: 910,
                    afterCharacterActionId: 0,
                },
            },
        },
        {
            label: 'known unsafe queue mutation',
            message: {
                type: 'cancel_all_queued_character_actions',
                cancelAllQueuedCharacterActionsData: {},
            },
        },
    ];
    for (
        let index = 0;
        index < allowedExternalOutgoing.length;
        index++
    ) {
        const {label, message} = allowedExternalOutgoing[index];
        run = createRun(58 + index);
        State.run = run;
        State.blockedReason = '';
        const sentBeforeAllowed = socket.sent.length;
        socket.send(JSON.stringify(message));
        assert.equal(
            socket.sent.length,
            sentBeforeAllowed + 1,
            `${label} must still be forwarded to the game`
        );
        assert.equal(
            run.stopRequested,
            false,
            `${label} must not stop a non-conflicting batch`
        );
        assert.equal(run.interferenceDetected, false, label);
        assert.equal(State.blockedReason, '', label);
    }

    const protectedExternalOutgoing = [
        {
            label: 'unknown request touching the batch item',
            message: {
                type: 'future_unrelated_request',
                futureUnrelatedRequestData: {
                    itemHrid: '/items/gobo_stabber',
                    characterLoadoutId: 99,
                },
            },
        },
        {
            label: 'unknown request touching the Enhancing loadout',
            message: {
                type: 'future_unrelated_request',
                futureUnrelatedRequestData: {
                    itemHrid: '/items/apple',
                    characterLoadoutId: 17,
                },
            },
        },
    ];
    for (
        let index = 0;
        index < protectedExternalOutgoing.length;
        index++
    ) {
        const {label, message} = protectedExternalOutgoing[index];
        run = createRun(64 + index);
        State.run = run;
        State.blockedReason = '';
        const sentBeforeProtected = socket.sent.length;
        socket.send(JSON.stringify(message));
        assert.equal(
            socket.sent.length,
            sentBeforeProtected + 1,
            `${label} must still be forwarded to the game`
        );
        assert.equal(
            run.stopRequested,
            true,
            `${label} must stop subsequent enhancer writes`
        );
        assert.equal(run.interferenceDetected, true, label);
        assert.notEqual(State.blockedReason, '', label);
    }
    run = createRun(67);
    State.run = run;
    State.blockedReason = '';
    const sentBeforeIndependentMarket = socket.sent.length;
    socket.send(JSON.stringify({
        type: 'post_market_order',
        postMarketOrderData: {
            itemHrid: '/items/gobo_stabber',
            enhancementLevel: 20,
            price: 1000,
            quantity: 1,
        },
    }));
    assert.equal(socket.sent.length, sentBeforeIndependentMarket + 1);
    assert.equal(run.stopRequested, false);
    assert.equal(run.interferenceDetected, false);
    assert.equal(State.blockedReason, '');
    State.run = null;

    const rejectedOutgoing = [
        'not-json',
        {binary: true},
    ];
    for (
        let index = 0;
        index < rejectedOutgoing.length;
        index++
    ) {
        run = createRun(60 + index);
        State.run = run;
        State.blockedReason = '';
        const sentBeforeRejected = socket.sent.length;
        socket.send(rejectedOutgoing[index]);
        assert.equal(
            socket.sent.length,
            sentBeforeRejected + 1,
            'external requests must still be forwarded to the game'
        );
        assert.equal(run.stopRequested, true);
        assert.equal(run.interferenceDetected, true);
        assert.notEqual(State.blockedReason, '');
    }
    State.run = null;

    State.blockedReason = '';
    emitFullInit();
    run = createRun(70);
    State.run = run;
    socket.emit('message', {data: 'not-json'});
    assert.equal(run.stopRequested, true);
    assert.match(State.blockedReason, /无法解析|缺少 type/);
    State.run = null;

    State.blockedReason = '';
    socket.send = Network.originalSend;
    assert.throws(
        () => Network.assertHookIntegrity(),
        /send.*覆盖/
    );
    delete socket.send;

    const patchedSend = Network.patchedSend;
    FakeWebSocket.prototype.send = function replacedSend() {};
    assert.throws(
        () => Network.assertHookIntegrity(),
        /send.*覆盖/
    );
    FakeWebSocket.prototype.send = patchedSend;

    const patchedWebSocket = Network.patchedWebSocket;
    fakeWindow.WebSocket = FakeWebSocket;
    assert.doesNotThrow(
        () => Network.assertHookIntegrity(),
        'an outer constructor-only market hook may coexist'
    );
    fakeWindow.WebSocket = patchedWebSocket;

    await runAdditionalMarketHardeningTests();
    await runPersistentRecoveryTests();
    await runPurchaseStockRecoveryTests();
    await runBeltSelectionAndNameCacheTests();
    runBeltPlanningAndLoadoutTests();
    await runBeltRulesAndPurchaseTests();
    await runEndOldBatchTests();
    runEndOldBatchUiTests();
    await runEndActiveOldBatchTests();
    await runCurrentEnhancingLoadoutTests();
    await runBackgroundWorkSignalTests();

    State.blockedReason = '';
    emitFullInit({characterId: 999});
    assert.equal(State.inventoryReady, false);
    assert.equal(State.queueReady, false);
    assert.equal(State.characterItemsReady, false);

    State.run = null;
    State.blockedReason = '';
    State.marketWriteBlockedReason = '';
    State.settings.marketMaintenanceEnabled = true;
    emitFullInit({
        characterItems: [
            inventoryItem('philosophers_mirror', 0, 20000),
            inventoryItem('gobo_stabber', 20, 2),
            characterItem(
                'grandmaster_enhancing_charm',
                0,
                1,
                '/item_locations/charm'
            ),
        ],
    });
    run = createRun(71);
    run.active = false;
    run.status = 'queued';
    run.marketMaintenanceEnabled = true;
    const finalQueuedFingerprint = actionFingerprint(19, 20);
    seedOwnedAction(run, 990, finalQueuedFingerprint, 90);
    State.run = run;
    socket.emitMessage({
        type: 'actions_updated',
        endCharacterActions: [{
            ...actionFromFingerprint(
                990,
                finalQueuedFingerprint,
                true
            ),
            ordinal: 90,
        }],
    });
    socket.emitMessage({
        type: 'action_completed',
        endCharacterAction: {
            ...actionFromFingerprint(
                990,
                finalQueuedFingerprint,
                true
            ),
            ordinal: 90,
        },
    });
    assert.equal(run.ownedActionIds.size, 0);
    assert.equal(
        run.marketFinalSweepPending,
        true,
        'the final queued action completing must automatically start the '
            + 'reserve-one market sweep'
    );
    assert.deepEqual(
        [...run.marketFinalSweepRemaining],
        ['gobo_stabber']
    );
    MarketMaintenance.stopScheduling();
    State.run = null;

    assert.equal(CONFIG.MAX_ENHANCE_COMMANDS, 10000);
    console.log('mwi_safe_enhancer runtime state tests: PASS');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
