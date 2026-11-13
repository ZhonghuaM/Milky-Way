#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATHS = {
    enhancer: path.join(__dirname, 'mwi_safe_enhancer.user.js'),
    market: path.join(__dirname, 'mwi_market_keeper.user.js'),
};
const SOURCES = Object.fromEntries(
    Object.entries(SCRIPT_PATHS).map(([name, scriptPath]) => [
        name,
        fs.readFileSync(scriptPath, 'utf8'),
    ])
);
const COORDINATOR_DESCRIPTION =
    'MWI_SHARED_AUTOMATION_COORDINATOR_V1';
const GAME_SOCKET_URL =
    'wss://api-test.milkywayidle.com/ws?characterId=123';

function createRealm() {
    class FakeMessageEvent {
        constructor(type, {data} = {}) {
            this.type = type;
            this.currentTarget = null;
            this._data = data;
        }

        get data() {
            return this._data;
        }
    }

    class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 3;

        constructor(url = GAME_SOCKET_URL) {
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
    const location = {
        hostname: 'test.milkywayidle.com',
        origin: 'https://test.milkywayidle.com',
        href: 'https://test.milkywayidle.com/?characterId=123',
        search: '?characterId=123',
    };
    const fakeWindow = {
        location,
        WebSocket: FakeWebSocket,
        MessageEvent: FakeMessageEvent,
        localStorage: {
            getItem: (key) => (
                storage.has(key) ? storage.get(key) : null
            ),
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
        console: {log() {}, warn() {}, error() {}},
        window: fakeWindow,
        document: fakeDocument,
        WebSocket: FakeWebSocket,
        MessageEvent: FakeMessageEvent,
        URL,
        URLSearchParams,
        Intl,
        setTimeout,
        clearTimeout,
        __MWI_SAFE_ENHANCER_RUNTIME_TEST_MODE__: true,
        __MWI_MARKET_KEEPER_RUNTIME_TEST_MODE__: true,
    };
    vm.createContext(context);
    return {context, fakeWindow, FakeMessageEvent};
}

function evaluateAndInstall(name, realm) {
    vm.runInContext(SOURCES[name], realm.context, {
        filename: SCRIPT_PATHS[name],
    });
    const exportsObject = name === 'enhancer'
        ? realm.context.__MWI_SAFE_ENHANCER_RUNTIME_TEST_EXPORTS__
        : realm.context.__MWI_MARKET_KEEPER_RUNTIME_TEST_EXPORTS__;
    assert.ok(exportsObject, `${name} runtime exports are required`);
    exportsObject.Network.install();
    return exportsObject;
}

function activeEnhancerRun(id) {
    return {
        id,
        active: true,
        stopRequested: false,
        interferenceDetected: false,
        integrityFailure: '',
        allowedExternalTypes: new Set(),
        ownedActionIds: new Set(),
        ownedRemovalPending: new Map(),
        ownedOrderValidationPending: false,
        marketPostInventoryBarriers: new Map(),
        marketFinalSweepPending: false,
        marketFinalSweepPhase: 'idle',
        marketSteadyMonitoring: false,
    };
}

async function assertCoordinatorSerializes(coordinator, label) {
    const events = [];
    const releaseEnhancer = await coordinator.acquire(
        `enhancer-test:${label}`
    );
    events.push('enhancer-acquired');

    let marketGranted = false;
    const marketAcquire = coordinator.acquire(
        `market-test:${label}`
    ).then((release) => {
        marketGranted = true;
        events.push('market-acquired');
        return release;
    });
    await Promise.resolve();
    assert.equal(
        marketGranted,
        false,
        `${label}: the second owner must wait for the shared lane`
    );
    assert.match(
        coordinator.holder?.owner || '',
        /^enhancer-test:/,
        `${label}: the enhancer owner must hold the lane first`
    );

    releaseEnhancer();
    const releaseMarket = await marketAcquire;
    assert.equal(
        marketGranted,
        true,
        `${label}: releasing the first owner must grant the second`
    );
    assert.deepEqual(events, [
        'enhancer-acquired',
        'market-acquired',
    ]);
    assert.match(
        coordinator.holder?.owner || '',
        /^market-test:/,
        `${label}: the market owner must now hold the lane`
    );
    releaseMarket();
    assert.equal(coordinator.holder, null);
}

async function runInstallOrder(order) {
    const label = order.join(' -> ');
    const realm = createRealm();
    const installed = {};
    const coordinatorKey = vm.runInContext(
        `Symbol.for('${COORDINATOR_DESCRIPTION}')`,
        realm.context
    );

    installed[order[0]] = evaluateAndInstall(order[0], realm);
    const firstCoordinator = realm.fakeWindow[coordinatorKey];
    assert.ok(firstCoordinator, `${label}: first script creates coordinator`);
    installed[order[1]] = evaluateAndInstall(order[1], realm);
    assert.equal(
        realm.fakeWindow[coordinatorKey],
        firstCoordinator,
        `${label}: both scripts must reuse the same coordinator`
    );

    const enhancer = installed.enhancer;
    const market = installed.market;
    enhancer.Network.assertHookIntegrity();

    const socket = new realm.fakeWindow.WebSocket(GAME_SOCKET_URL);
    assert.equal(enhancer.State.socket, socket, `${label}: enhancer socket`);
    assert.equal(market.State.socket, socket, `${label}: market socket`);
    assert.equal(
        enhancer.State.attachedSockets.has(socket),
        true,
        `${label}: enhancer must bind the shared socket`
    );
    assert.equal(
        market.State.attachedSockets.has(socket),
        true,
        `${label}: market keeper must bind the shared socket`
    );
    for (const type of ['open', 'message', 'close', 'error']) {
        assert.equal(
            socket.listeners.get(type)?.length,
            2,
            `${label}: each script installs exactly one ${type} listener`
        );
    }
    enhancer.Network.assertHookIntegrity();

    const observed = [];
    const originalObserveOutgoing = enhancer.Network.observeOutgoing;
    enhancer.Network.observeOutgoing = function observeCoexistenceWrite(
        raw,
        isOwned
    ) {
        observed.push({raw: String(raw), isOwned});
        return originalObserveOutgoing.call(this, raw, isOwned);
    };

    const run = activeEnhancerRun(
        order[0] === 'enhancer' ? 101 : 102
    );
    enhancer.State.run = run;
    enhancer.State.blockedReason = '';
    market.State.characterId = '123';
    const outcomePromise = market.MarketTransactions.begin({
        kind: 'post',
        itemId: 'gobo_stabber',
        expectedPost: {
            itemId: 'gobo_stabber',
            enhancementLevel: 20,
            price: 1000,
            quantity: 1,
        },
        baselineListings: new Map(),
        baselineInventory: 2,
        expectedInventory: 1,
        quantity: 1,
        timeoutMs: 5000,
        timeoutMessage: 'coexistence test timeout',
        payload: {
            type: 'post_market_order',
            postMarketOrderData: {
                itemHrid: '/items/gobo_stabber',
                enhancementLevel: 20,
                price: 1000,
                quantity: 1,
            },
        },
    });

    assert.equal(socket.sent.length, 1, `${label}: market write forwarded`);
    assert.equal(JSON.parse(socket.sent[0]).type, 'post_market_order');
    assert.equal(observed.length, 1, `${label}: enhancer observes the write`);
    assert.equal(JSON.parse(observed[0].raw).type, 'post_market_order');
    assert.equal(observed[0].isOwned, false);
    assert.equal(run.stopRequested, false, `${label}: run remains active`);
    assert.equal(run.interferenceDetected, false);
    assert.equal(enhancer.State.blockedReason, '');
    assert.equal(
        run.allowedExternalTypes.has('post_market_order'),
        true,
        `${label}: enhancer explicitly records the allowed market write`
    );
    enhancer.Network.assertHookIntegrity();

    market.MarketTransactions.abort('coexistence test cleanup');
    const outcome = await outcomePromise;
    assert.equal(outcome.status, 'unknown');

    await assertCoordinatorSerializes(firstCoordinator, label);
}

function readIncomingOnPage(realm, socket, message, reads = 1) {
    const event = new realm.FakeMessageEvent('message', {
        data: JSON.stringify(message),
    });
    event.currentTarget = socket;
    // Simulate the game reading MessageEvent.data on a socket that was made
    // before the market script installed its constructor proxy.
    let result;
    for (let index = 0; index < reads; index++) result = event.data;
    return result;
}

function runPreexistingSocketCapture() {
    const realm = createRealm();
    const socket = new realm.fakeWindow.WebSocket(GAME_SOCKET_URL);
    const market = evaluateAndInstall('market', realm);

    assert.equal(
        market.State.socket,
        null,
        'a preexisting socket is unknown until the next page message is read'
    );
    readIncomingOnPage(realm, socket, {
        type: 'init_client_data',
        versionTimestamp: 123,
        itemDetailMap: {
            '/items/grandmaster_attack_charm': {
                isTradable: true,
                sellPrice: 100,
            },
        },
        gameModeDetailMap: {
            standard: {marketRestricted: false},
        },
    });
    readIncomingOnPage(realm, socket, {
        type: 'init_character_data',
        character: {id: 123, gameMode: 'standard'},
        characterInfo: {marketListingCap: 20},
        characterSetting: {hasAcceptedTradingRules: true},
        characterItems: [],
        myMarketListings: [],
        characterItemMarks: [],
    }, 2);

    assert.equal(
        market.State.socket,
        socket,
        'market keeper must adopt a socket created before installation'
    );
    assert.equal(market.State.clientReady, true);
    assert.equal(market.State.inventoryReady, true);
    assert.equal(market.State.listingsReady, true);
    assert.equal(market.State.itemMarksReady, true);
    assert.equal(market.State.accessReady, true);
    assert.equal(
        market.State.syncEpoch,
        1,
        'reading the same MessageEvent twice must not process init twice'
    );
    assert.equal(
        market.MarketKeeper.isReady(),
        true,
        'the first full messages observed through MessageEvent.data must count'
    );
    for (const type of ['open', 'message', 'close', 'error']) {
        assert.equal(
            socket.listeners.get(type)?.length,
            1,
            `late adoption installs exactly one ${type} listener`
        );
    }
}

function runPreexistingSocketSendCapture() {
    const realm = createRealm();
    const socket = new realm.fakeWindow.WebSocket(GAME_SOCKET_URL);
    const market = evaluateAndInstall('market', realm);
    socket.send(JSON.stringify({type: 'get_character_actions'}));
    assert.equal(
        market.State.socket,
        socket,
        'an outgoing page request must reveal a preexisting socket'
    );
    assert.equal(socket.sent.length, 1, 'the page request must still be sent');
}

function runLegacyCoordinatorUpgrade() {
    const realm = createRealm();
    const CachedWebSocket = realm.fakeWindow.WebSocket;
    const coordinatorKey = vm.runInContext(
        `Symbol.for('${COORDINATOR_DESCRIPTION}')`,
        realm.context
    );
    const socket = new realm.fakeWindow.WebSocket(GAME_SOCKET_URL);
    const legacyCoordinator = {
        schema: 1,
        socket,
        holder: null,
        waiters: [],
        acquire: async () => () => {},
        publishSocket(nextSocket) {
            this.socket = nextSocket || null;
        },
    };
    Object.defineProperty(realm.fakeWindow, coordinatorKey, {
        value: legacyCoordinator,
        configurable: false,
        enumerable: false,
        writable: false,
    });

    const market = evaluateAndInstall('market', realm);
    assert.equal(
        typeof legacyCoordinator.subscribeSocket,
        'function',
        'legacy coordinator must gain cooperative socket subscriptions'
    );
    assert.equal(
        market.State.socket,
        socket,
        'market keeper must immediately adopt a legacy shared socket'
    );

    const replacement = new CachedWebSocket(GAME_SOCKET_URL);
    assert.notEqual(
        market.State.socket,
        replacement,
        'the cached constructor must bypass the newly installed proxy'
    );
    legacyCoordinator.publishSocket(replacement);
    assert.equal(
        market.State.socket,
        replacement,
        'upgraded legacy publication must notify the market keeper'
    );
}

async function main() {
    runPreexistingSocketCapture();
    runPreexistingSocketSendCapture();
    runLegacyCoordinatorUpgrade();
    await runInstallOrder(['enhancer', 'market']);
    await runInstallOrder(['market', 'enhancer']);
    console.log('mwi split userscript coexistence runtime tests: PASS');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
