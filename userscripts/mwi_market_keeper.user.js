// ==UserScript==
// @name         [银河奶牛] +20 市场守价助手（独立版）
// @namespace    local.milkyway.market-keeper
// @version      1.3.3
// @description  测试服市场走量：+20 留一抢左一，并用 1 个牛铃包买单维护当前交易区间 Max
// @author       Codex / based on DelayNoMore and sunrishe concepts
// @match        https://test.milkywayidle.com/*
// @match        https://test.milkywayidlecn.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * This script is intentionally independent from the queue enhancer.
 * It never reads an enhancement job, expected output count, loadout or mirror
 * balance. Its only inputs are authoritative character-item locations
 * (inventory plus currently equipped slots), the character's own listings
 * and freshly requested +20 / level-zero cowbell-bag order books.
 * Multiple own listings for one item are always cancelled, claimed and
 * consolidated into one replacement listing before more inventory is posted.
 * Current test-server price bands come directly from priceBandMins/Maxs, and
 * price-minus follows the game's enhancement-aware bin-gap algorithm. The
 * script uses the in-band left one, or exact Min when the +20 band has no
 * asks. Locked +20 items are never changed. Cowbell bags separately keep one
 * resting bid at the current Max unless the first in-band ask is already Max.
 */

(function () {
    'use strict';

    const VERSION = '1.3.3';
    const TARGET_LEVEL = 20;
    const COWBELL_BAG_ITEM_ID = 'bag_of_10_cowbells';
    const COWBELL_LEVEL = 0;
    const COIN_ITEM_ID = 'coin';
    const INVENTORY_LOCATION_HRID = '/item_locations/inventory';
    const EQUIPPED_LOCATION_HRIDS = new Set([
        '/item_locations/two_hand',
        '/item_locations/main_hand',
        '/item_locations/off_hand',
        '/item_locations/back',
        '/item_locations/head',
        '/item_locations/body',
        '/item_locations/legs',
        '/item_locations/hands',
        '/item_locations/feet',
        '/item_locations/belt',
        '/item_locations/pouch',
        '/item_locations/neck',
        '/item_locations/earrings',
        '/item_locations/ring',
        '/item_locations/charm',
        '/item_locations/trinket',
        '/item_locations/milking_tool',
        '/item_locations/foraging_tool',
        '/item_locations/woodcutting_tool',
        '/item_locations/cheesesmithing_tool',
        '/item_locations/crafting_tool',
        '/item_locations/tailoring_tool',
        '/item_locations/cooking_tool',
        '/item_locations/brewing_tool',
        '/item_locations/alchemy_tool',
        '/item_locations/enhancing_tool',
    ]);
    const ACTIVE_STATUS = '/market_listing_status/active';
    const FILLED_STATUS = '/market_listing_status/filled';
    const TERMINAL_STATUSES = new Set([
        FILLED_STATUS,
        '/market_listing_status/cancelled',
        '/market_listing_status/expired',
    ]);
    const BIN_GAP_UNIT_TIERS = Object.freeze([
        [12, 4],
        [15, 5],
        [18, 6],
        [24, 8],
        [30, 10],
        [36, 12],
        [48, 16],
        [60, 20],
        [75, 25],
        [90, 30],
    ]);
    const CONFIG = Object.freeze({
        RESERVED_INVENTORY: 1,
        POLL_MS: 5500,
        COWBELL_POLL_MS: 15000,
        IDLE_SCAN_MS: 100,
        MIN_REQUEST_GAP_MS: 1000,
        READ_TIMEOUT_MS: 12000,
        WRITE_TIMEOUT_MS: 15000,
        INVENTORY_GRACE_MS: 5000,
        SPAM_BACKOFF_MS: 48000,
        MAX_POST_QUANTITY: 10_000_000_000,
        MAX_POST_PRICE: 1_000_000_000_000,
        MAX_POST_NOTIONAL: 9_000_000_000_000_000,
        NAME_CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
    });

    const externalTestRealm = typeof globalThis === 'object'
        ? globalThis
        : null;
    const runtimeTestMode = externalTestRealm && Boolean(
        globalThis.__MWI_MARKET_KEEPER_RUNTIME_TEST_MODE__
    );
    const allowedHosts = new Set([
        'test.milkywayidle.com',
        'test.milkywayidlecn.com',
    ]);
    if (!runtimeTestMode && !allowedHosts.has(window.location.hostname)) return;
    if (window.__MWI_MARKET_KEEPER_LOADED__) return;
    window.__MWI_MARKET_KEEPER_LOADED__ = VERSION;

    const STORAGE_KEY = 'MWI_MARKET_KEEPER_V1';
    const LEGACY_SELECTION_KEY = 'MWI_SAFE_ENHANCER_SELECTION_V1';
    const LEGACY_NAME_CACHE_KEY = 'MWI_SAFE_ENHANCER_NAMES_V1';
    const PAGE_SESSION_ID = `${Date.now().toString(36)}-`
        + `${Math.random().toString(36).slice(2)}`;
    const SHARED_COORDINATOR_KEY = Symbol.for(
        'MWI_SHARED_AUTOMATION_COORDINATOR_V1'
    );

    class MarketError extends Error {
        constructor(message, code = 'MARKET_FAILED') {
            super(message);
            this.name = 'MarketError';
            this.code = code;
        }
    }

    function getSharedAutomationCoordinator() {
        const existing = window[SHARED_COORDINATOR_KEY];
        if (
            existing &&
            existing.schema === 1 &&
            typeof existing.acquire === 'function' &&
            typeof existing.publishSocket === 'function'
        ) {
            /*
             * Early enhancer builds exposed publishSocket() but did not yet
             * expose subscribeSocket(). Upgrade that plain coordinator in
             * place so saving a new market script does not require the old
             * page realm to disappear before network capture can install.
             */
            if (typeof existing.subscribeSocket !== 'function') {
                try {
                    const compatibilitySubscribers = new Set();
                    const previousPublish = existing.publishSocket;
                    existing.publishSocket = function publishCompatibleSocket(
                        socket
                    ) {
                        const result = previousPublish.call(this, socket);
                        this.socket = socket || null;
                        for (const subscriber of compatibilitySubscribers) {
                            try {
                                subscriber(this.socket);
                            } catch {
                                // One compatibility subscriber cannot break another.
                            }
                        }
                        return result;
                    };
                    existing.subscribeSocket = function subscribeCompatibleSocket(
                        subscriber
                    ) {
                        if (typeof subscriber !== 'function') return () => {};
                        compatibilitySubscribers.add(subscriber);
                        if (this.socket) subscriber(this.socket);
                        return () => compatibilitySubscribers.delete(subscriber);
                    };
                } catch {
                    // Network.install() still has constructor and message-event
                    // capture paths if a foreign coordinator is not extensible.
                }
            }
            return existing;
        }
        const coordinator = {
            schema: 1,
            socket: null,
            holder: null,
            waiters: [],
            socketSubscribers: new Set(),
            acquire(owner) {
                const normalizedOwner = String(owner || 'anonymous');
                return new Promise((resolve) => {
                    const ticket = {
                        owner: normalizedOwner,
                        token: Symbol(normalizedOwner),
                        resolve,
                    };
                    this.waiters.push(ticket);
                    this.grantNext();
                });
            },
            grantNext() {
                if (this.holder || this.waiters.length === 0) return;
                const ticket = this.waiters.shift();
                this.holder = ticket;
                let released = false;
                ticket.resolve(() => {
                    if (released) return;
                    released = true;
                    if (this.holder?.token === ticket.token) {
                        this.holder = null;
                        this.grantNext();
                    }
                });
            },
            publishSocket(socket) {
                this.socket = socket || null;
                for (const subscriber of this.socketSubscribers) {
                    try {
                        subscriber(this.socket);
                    } catch {
                        // One subscriber cannot break another script.
                    }
                }
            },
            subscribeSocket(subscriber) {
                if (typeof subscriber !== 'function') return () => {};
                this.socketSubscribers.add(subscriber);
                if (this.socket) subscriber(this.socket);
                return () => this.socketSubscribers.delete(subscriber);
            },
        };
        Object.defineProperty(window, SHARED_COORDINATOR_KEY, {
            value: coordinator,
            configurable: false,
            enumerable: false,
            writable: false,
        });
        return coordinator;
    }

    const SharedAutomation = getSharedAutomationCoordinator();

    function readJsonStorage(key, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch {
            return fallback;
        }
    }

    function writeJsonStorage(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.warn('[市场守价助手] 保存设置失败:', error);
            return false;
        }
    }

    function safeJsonParse(raw) {
        if (typeof raw !== 'string') return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    function normalizeShortItemId(value) {
        if (typeof value !== 'string') return '';
        const itemId = value.split('/').filter(Boolean).pop() || '';
        return /^[a-z0-9_]+$/.test(itemId) ? itemId : '';
    }

    function fullItemHrid(itemId) {
        return `/items/${normalizeShortItemId(itemId)}`;
    }

    function normalizeCharacterId(value) {
        if (!/^\d+$/.test(String(value ?? ''))) return '';
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) && numeric > 0
            ? String(numeric)
            : '';
    }

    function getPageCharacterId() {
        return normalizeCharacterId(
            new URLSearchParams(window.location.search).get('characterId')
        );
    }

    function normalizeListingId(value) {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) && numeric > 0
            ? String(numeric)
            : '';
    }

    function prettifyItemId(itemId) {
        return String(itemId)
            .split('_')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    const integerFormatter = new Intl.NumberFormat('zh-CN');

    function formatInt(value) {
        return integerFormatter.format(Number(value) || 0);
    }

    function waitForDocumentBody() {
        if (document.body) return Promise.resolve(document.body);
        return new Promise((resolve) => {
            const observer = new MutationObserver(() => {
                if (!document.body) return;
                observer.disconnect();
                resolve(document.body);
            });
            observer.observe(document, {childList: true, subtree: true});
        });
    }

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
        const readBits = (count) => {
            let bits = 0;
            let power = 1;
            const maximum = 2 ** count;
            while (power !== maximum) {
                const bit = data.value & data.position;
                data.position >>= 1;
                if (data.position === 0) {
                    data.position = 16384;
                    data.value = data.index < compressed.length
                        ? compressed.charCodeAt(data.index) - 32
                        : 0;
                    data.index++;
                }
                if (bit > 0) bits |= power;
                power *= 2;
            }
            return bits;
        };
        const first = readBits(2);
        let character;
        if (first === 0) character = String.fromCharCode(readBits(8));
        else if (first === 1) character = String.fromCharCode(readBits(16));
        else if (first === 2) return '';
        else return null;
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
            if (dictionary[code] != null) entry = dictionary[code];
            else if (code === dictionarySize) {
                entry = previous + previous.charAt(0);
            } else return null;
            result.push(entry);
            dictionary[dictionarySize++] = previous + entry.charAt(0);
            enlargeIn--;
            previous = entry;
            if (enlargeIn === 0) {
                enlargeIn = 2 ** numberOfBits;
                numberOfBits++;
            }
        }
        return null;
    }

    const State = {
        socket: null,
        attachedSockets: new WeakSet(),
        observedMessageEvents: new WeakSet(),
        connectionEpoch: 0,
        syncEpoch: 0,
        characterId: getPageCharacterId(),
        inventoryReady: false,
        listingsReady: false,
        itemMarksReady: false,
        inventorySnapshotRows: null,
        listingSnapshotRows: null,
        itemMarkSnapshotRows: null,
        clientReady: false,
        accessReady: false,
        tradingRulesKnown: false,
        acceptedTradingRules: false,
        characterGameMode: '',
        listingCap: null,
        inventory: new Map(),
        characterItemSlots: new Map(),
        itemMarks: new Map(),
        myListings: new Map(),
        itemRules: new Map(),
        gameModeRestrictions: new Map(),
        marketplaceLimits: {
            maxQuantity: CONFIG.MAX_POST_QUANTITY,
            maxPrice: CONFIG.MAX_POST_PRICE,
            maxNotional: CONFIG.MAX_POST_NOTIONAL,
        },
        candidateItemIds: new Set(),
        names: new Map(),
        watchlist: new Set(),
        enabled: false,
        cowbellEnabled: false,
        pausedItems: new Map(),
        pendingWrite: null,
        profileLoaded: false,
        op: null,
        nextOpId: 0,
        busy: false,
        timer: null,
        roundRobinIndex: 0,
        idleScanStreak: 0,
        lastCowbellPollAt: 0,
        currentItemId: '',
        lastPolledItemId: '',
        lastPollAt: 0,
        itemStatus: new Map(),
        lastRequestAt: 0,
        backoffUntil: 0,
        lastInitAt: 0,
        logs: [],
        renderScheduled: false,
        ui: null,
    };

    function profileKey() {
        return `${window.location.hostname}:${State.characterId}`;
    }

    function readStore() {
        const value = readJsonStorage(STORAGE_KEY, {});
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : {};
    }

    function loadProfile() {
        const store = readStore();
        const raw = store[profileKey()] || {};
        State.enabled = raw.enabled === true;
        State.cowbellEnabled = raw.cowbellEnabled === true;
        State.watchlist = new Set(
            Array.isArray(raw.watchlist)
                ? raw.watchlist
                    .map(normalizeShortItemId)
                    .filter((itemId) => (
                        itemId && itemId !== COWBELL_BAG_ITEM_ID
                    ))
                : []
        );
        State.pausedItems = new Map(
            Object.entries(raw.pausedItems || {})
                .map(([itemId, reason]) => [
                    normalizeShortItemId(itemId),
                    String(reason || ''),
                ])
                .filter(([itemId, reason]) => itemId && reason)
        );
        State.pendingWrite = raw.pendingWrite || null;
        State.backoffUntil = Number(raw.backoffUntil || 0);
        State.profileLoaded = true;
        scheduleUiRefresh();
    }

    function saveProfile() {
        if (!State.characterId) return false;
        const store = readStore();
        store[profileKey()] = {
            enabled: State.enabled,
            cowbellEnabled: State.cowbellEnabled,
            watchlist: [...State.watchlist],
            pausedItems: Object.fromEntries(State.pausedItems),
            pendingWrite: State.pendingWrite,
            backoffUntil: State.backoffUntil,
        };
        return writeJsonStorage(STORAGE_KEY, store);
    }

    function log(message, type = 'info') {
        const entry = {time: new Date(), type, message: String(message)};
        State.logs.push(entry);
        if (State.logs.length > 400) State.logs.shift();
        State.ui?.appendLog(entry);
        scheduleUiRefresh();
    }

    function scheduleUiRefresh() {
        if (State.renderScheduled) return;
        State.renderScheduled = true;
        const render = () => {
            State.renderScheduled = false;
            State.ui?.update();
        };
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(render);
        } else {
            window.setTimeout(render, 0);
        }
    }

    function getItemName(itemId) {
        return State.names.get(itemId) || prettifyItemId(itemId);
    }

    function isOpenWebSocket(socket) {
        // OPEN is fixed to 1 by the WebSocket standard. Avoid consulting the
        // live global constructor because another userscript may wrap it
        // without copying static constants.
        return Boolean(socket && Number(socket.readyState) === 1);
    }

    function mergeNames(dictionary) {
        if (!dictionary || typeof dictionary !== 'object') return;
        for (const [key, value] of Object.entries(dictionary)) {
            const itemId = normalizeShortItemId(key);
            const name = typeof value === 'string'
                ? value.trim()
                : String(value?.name || '').trim();
            if (itemId && name && name !== key && name !== itemId) {
                State.names.set(itemId, name);
            }
        }
    }

    async function loadItemNames() {
        const cached = readJsonStorage(LEGACY_NAME_CACHE_KEY, null);
        if (
            cached &&
            Number(cached.savedAt) >
                Date.now() - CONFIG.NAME_CACHE_TTL_MS &&
            cached.names
        ) {
            mergeNames(cached.names);
            scheduleUiRefresh();
        }
    }

    function getItemCount(itemId, level = TARGET_LEVEL) {
        const counts = State.inventory.get(normalizeShortItemId(itemId));
        return Number(counts?.[level] || 0);
    }

    function normalizeCharacterItemSlot(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return null;
        }
        const itemLocationHrid = String(item.itemLocationHrid || '');
        const itemHrid = String(item.itemHrid || '');
        const enhancementLevel = Number(item.enhancementLevel || 0);
        const count = Number(item.count || 0);
        if (
            !/^\/item_locations\/[a-z0-9_]+$/.test(itemLocationHrid) ||
            !/^\/items\/[a-z0-9_]+$/.test(itemHrid) ||
            !Number.isSafeInteger(enhancementLevel) ||
            enhancementLevel < 0 ||
            !Number.isSafeInteger(count) ||
            count < 0
        ) {
            return null;
        }
        return {
            key: `${itemLocationHrid}::${itemHrid}::${enhancementLevel}`,
            itemLocationHrid,
            itemHrid,
            enhancementLevel,
            count,
        };
    }

    function updateCharacterItemSlot(item) {
        const normalized = normalizeCharacterItemSlot(item);
        if (!normalized) return;
        if (normalized.count === 0) {
            State.characterItemSlots.delete(normalized.key);
            return;
        }
        State.characterItemSlots.set(normalized.key, normalized);
        if (normalized.enhancementLevel === TARGET_LEVEL) {
            const itemId = normalizeShortItemId(normalized.itemHrid);
            if (itemId) State.candidateItemIds.add(itemId);
        }
    }

    function getEquippedItemCount(itemId, level = TARGET_LEVEL) {
        const itemHrid = fullItemHrid(itemId);
        let total = 0;
        for (const item of State.characterItemSlots.values()) {
            if (
                EQUIPPED_LOCATION_HRIDS.has(item.itemLocationHrid) &&
                item.itemHrid === itemHrid &&
                item.enhancementLevel === Number(level)
            ) {
                total += item.count;
            }
        }
        return total;
    }

    function getInventoryReserveNeeded(itemId) {
        return Math.max(
            0,
            CONFIG.RESERVED_INVENTORY - getEquippedItemCount(itemId)
        );
    }

    function getCharacterHeldItemCount(itemId, level = TARGET_LEVEL) {
        return getItemCount(itemId, level) +
            getEquippedItemCount(itemId, level);
    }

    function getSellableInventoryCount(
        itemId,
        inventoryCount = getItemCount(itemId)
    ) {
        return Math.max(
            0,
            Number(inventoryCount) - getInventoryReserveNeeded(itemId)
        );
    }

    function updateInventoryItem(item) {
        if (
            !item ||
            item.itemLocationHrid !== INVENTORY_LOCATION_HRID
        ) {
            return;
        }
        const itemId = normalizeShortItemId(item.itemHrid);
        const level = Number(item.enhancementLevel || 0);
        const count = Number(item.count || 0);
        if (
            !itemId ||
            !Number.isSafeInteger(level) ||
            level < 0 ||
            !Number.isFinite(count) ||
            count < 0
        ) {
            return;
        }
        const counts = State.inventory.get(itemId) || [];
        while (counts.length <= level) counts.push(0);
        counts[level] = count;
        State.inventory.set(itemId, counts);
        if (level === TARGET_LEVEL && count > 0) {
            State.candidateItemIds.add(itemId);
        }
    }

    function messageUpdatesTargetCharacterItem(
        message,
        itemId,
        enhancementLevel = TARGET_LEVEL
    ) {
        const itemHrid = fullItemHrid(itemId);
        const level = Number(enhancementLevel);
        return [
            message?.characterItems,
            message?.endCharacterItems,
            message?.updatedCharacterItems,
        ].some(
            (items) => (
                Array.isArray(items) &&
                items.some((item) => (
                    (
                        item?.itemLocationHrid ===
                            INVENTORY_LOCATION_HRID ||
                        EQUIPPED_LOCATION_HRIDS.has(
                            item?.itemLocationHrid
                        )
                    ) &&
                    item.itemHrid === itemHrid &&
                    Number(item.enhancementLevel) === level &&
                    Number.isFinite(Number(item.count))
                ))
            )
        );
    }

    function replaceInventory(items) {
        State.inventory.clear();
        State.characterItemSlots.clear();
        State.inventoryReady = Array.isArray(items);
        State.inventorySnapshotRows = State.inventoryReady
            ? items.length
            : null;
        if (State.inventoryReady) {
            for (const item of items) {
                updateCharacterItemSlot(item);
                updateInventoryItem(item);
            }
        }
    }

    function replaceItemMarks(marks) {
        State.itemMarks.clear();
        State.itemMarksReady = Array.isArray(marks);
        State.itemMarkSnapshotRows = State.itemMarksReady
            ? marks.length
            : null;
        if (!State.itemMarksReady) return;
        for (const mark of marks) {
            if (
                !mark ||
                mark.kind !== 'lock'
            ) continue;
            const itemId = normalizeShortItemId(mark.itemHrid);
            const minimum = Number(mark.minEnhancementLevel);
            const maximum = Number(mark.maxEnhancementLevel);
            if (
                !itemId ||
                !Number.isSafeInteger(minimum) ||
                !Number.isSafeInteger(maximum) ||
                minimum < 0 ||
                maximum < minimum
            ) continue;
            const ranges = State.itemMarks.get(itemId) || [];
            ranges.push({minimum, maximum});
            State.itemMarks.set(itemId, ranges);
        }
    }

    function isItemMarketLocked(itemId, level = TARGET_LEVEL) {
        const numericLevel = Number(level);
        if (!Number.isSafeInteger(numericLevel) || numericLevel < 0) {
            return false;
        }
        return (State.itemMarks.get(normalizeShortItemId(itemId)) || [])
            .some((range) => (
                numericLevel >= range.minimum &&
                numericLevel <= range.maximum
            ));
    }

    function listingRemaining(listing) {
        const orderQuantity = Number(listing?.orderQuantity);
        const filledQuantity = Number(listing?.filledQuantity);
        if (
            !Number.isSafeInteger(orderQuantity) ||
            orderQuantity <= 0 ||
            !Number.isSafeInteger(filledQuantity) ||
            filledQuantity < 0 ||
            filledQuantity > orderQuantity
        ) {
            return null;
        }
        return orderQuantity - filledQuantity;
    }

    function shouldRetainListing(listing) {
        return Boolean(
            listing &&
            (
                listing.status === ACTIVE_STATUS ||
                Number(listing.unclaimedItemCount || 0) > 0 ||
                Number(listing.unclaimedCoinCount || 0) > 0
            )
        );
    }

    function replaceMyListings(listings) {
        State.myListings.clear();
        State.listingsReady = Array.isArray(listings);
        State.listingSnapshotRows = State.listingsReady
            ? listings.length
            : null;
        if (!State.listingsReady) return;
        for (const listing of listings) {
            const listingId = normalizeListingId(listing?.id);
            if (!listingId || !shouldRetainListing(listing)) continue;
            State.myListings.set(listingId, listing);
            const itemId = normalizeShortItemId(listing.itemHrid);
            if (itemId) State.candidateItemIds.add(itemId);
        }
    }

    function applyListingDeltas(listings) {
        if (!Array.isArray(listings)) return;
        for (const listing of listings) {
            const listingId = normalizeListingId(listing?.id);
            if (!listingId) continue;
            if (shouldRetainListing(listing)) {
                State.myListings.set(listingId, listing);
                const itemId = normalizeShortItemId(listing.itemHrid);
                if (itemId) State.candidateItemIds.add(itemId);
            } else {
                State.myListings.delete(listingId);
            }
        }
    }

    function normalizeClientVersionMs(value) {
        if (
            (typeof value !== 'string' && typeof value !== 'number') ||
            value === ''
        ) {
            return null;
        }
        if (
            typeof value === 'number' ||
            /^\d+$/.test(String(value))
        ) {
            const numeric = Number(value);
            return Number.isSafeInteger(numeric) && numeric >= 0
                ? numeric
                : null;
        }
        const milliseconds = new Date(value).getTime();
        return Number.isSafeInteger(milliseconds) && milliseconds >= 0
            ? milliseconds
            : null;
    }

    function replaceClientData(message) {
        State.itemRules.clear();
        State.gameModeRestrictions.clear();
        State.marketplaceLimits = {
            maxQuantity: CONFIG.MAX_POST_QUANTITY,
            maxPrice: CONFIG.MAX_POST_PRICE,
            maxNotional: CONFIG.MAX_POST_NOTIONAL,
        };
        const itemDetailMap = message?.itemDetailMap;
        const gameModeDetailMap = message?.gameModeDetailMap;
        if (
            !itemDetailMap ||
            typeof itemDetailMap !== 'object' ||
            Array.isArray(itemDetailMap) ||
            !gameModeDetailMap ||
            typeof gameModeDetailMap !== 'object' ||
            Array.isArray(gameModeDetailMap)
        ) {
            State.clientReady = false;
            return false;
        }
        for (const [itemHrid, detail] of Object.entries(itemDetailMap)) {
            const itemId = normalizeShortItemId(itemHrid);
            const sellPrice = Number(detail?.sellPrice);
            if (
                !itemId ||
                !Number.isSafeInteger(sellPrice) ||
                sellPrice < 0
            ) {
                continue;
            }
            State.itemRules.set(itemId, {
                isTradable: detail?.isTradable === true,
                sellPrice,
            });
            if (detail?.isTradable === true) {
                State.candidateItemIds.add(itemId);
            }
            const possibleName =
                detail?.name || detail?.displayName || detail?.itemName;
            if (typeof possibleName === 'string' && possibleName.trim()) {
                State.names.set(itemId, possibleName.trim());
            }
        }
        for (const [gameMode, detail] of Object.entries(gameModeDetailMap)) {
            if (
                typeof gameMode === 'string' &&
                gameMode &&
                typeof detail?.marketRestricted === 'boolean'
            ) {
                State.gameModeRestrictions.set(
                    gameMode,
                    detail.marketRestricted
                );
            }
        }
        const marketplaceLimits = message?.marketplaceLimits;
        if (
            marketplaceLimits &&
            typeof marketplaceLimits === 'object' &&
            !Array.isArray(marketplaceLimits)
        ) {
            for (const key of [
                'maxQuantity',
                'maxPrice',
                'maxNotional',
            ]) {
                const value = Number(marketplaceLimits[key]);
                if (Number.isSafeInteger(value) && value > 0) {
                    State.marketplaceLimits[key] = value;
                }
            }
        }
        State.clientReady =
            State.itemRules.size > 0 &&
            State.gameModeRestrictions.size > 0;
        scheduleUiRefresh();
        return State.clientReady;
    }

    function restoreClientDataFromCache(socket) {
        let socketVersion = null;
        try {
            const raw = new URL(socket?.url || '')
                .searchParams.get('versionTimestamp');
            if (/^\d+$/.test(raw || '')) {
                const numeric = Number(raw);
                if (Number.isSafeInteger(numeric) && numeric > 0) {
                    socketVersion = numeric;
                }
            }
        } catch {
            return false;
        }
        if (socketVersion == null) return false;
        let compressed = null;
        try {
            compressed = window.localStorage.getItem('initClientData');
        } catch {
            return false;
        }
        const cached = safeJsonParse(decompressLzStringUtf16(compressed));
        if (
            !cached ||
            cached.type !== 'init_client_data' ||
            normalizeClientVersionMs(cached.versionTimestamp) !==
                socketVersion
        ) {
            return false;
        }
        const restored = replaceClientData(cached);
        if (restored) log('已从游戏同版本缓存恢复市场规则', 'success');
        return restored;
    }

    function replaceAccess(message) {
        const rawCap = message?.characterInfo?.marketListingCap;
        const cap = Number(rawCap);
        State.listingCap = (
            rawCap != null &&
            Number.isSafeInteger(cap) &&
            cap >= 0
        ) ? cap : null;
        State.characterGameMode = String(
            message?.character?.gameMode || ''
        );
        const accepted =
            message?.characterSetting?.hasAcceptedTradingRules;
        State.tradingRulesKnown = typeof accepted === 'boolean';
        State.acceptedTradingRules = accepted === true;
        State.accessReady = Boolean(
            State.listingCap != null &&
            State.characterGameMode &&
            State.tradingRulesKnown
        );
    }

    function initializationIssue() {
        if (!isOpenWebSocket(State.socket)) {
            return 'WebSocket 未连接';
        }
        if (!State.inventoryReady) return '完整库存未同步';
        if (!State.listingsReady) return '本人挂单全量未同步';
        if (!State.itemMarksReady) return '物品锁定规则未同步';
        if (!State.clientReady) return '市场物品与模式规则未同步';
        if (!State.accessReady) return '角色市场权限未同步';
        if (!State.acceptedTradingRules) return '尚未接受游戏市场规则';
        if (
            State.gameModeRestrictions.get(State.characterGameMode) !== false
        ) {
            return '当前模式禁止市场或限制规则未知';
        }
        return '';
    }

    function getOrderBookLevel(snapshot, level = TARGET_LEVEL) {
        if (!snapshot?.orderBooks) return null;
        return snapshot.orderBooks[level]
            ?? snapshot.orderBooks[String(level)]
            ?? null;
    }

    function normalizeAsk(ask) {
        const listingId = normalizeListingId(ask?.listingId);
        const price = Number(ask?.price);
        const quantity = Number(ask?.quantity);
        if (
            !listingId ||
            !Number.isSafeInteger(price) ||
            price <= 0 ||
            !Number.isSafeInteger(quantity) ||
            quantity <= 0
        ) {
            return null;
        }
        return {...ask, listingId, price, quantity};
    }

    function getOfficialMarketBinGap(value, enhancementLevel = TARGET_LEVEL) {
        const price = Number.parseInt(value, 10);
        const level = Number(enhancementLevel);
        if (
            !Number.isSafeInteger(price) ||
            price < 0 ||
            !Number.isSafeInteger(level) ||
            level < 0
        ) return null;
        const text = String(price);
        const digits = text.length;
        if (digits <= 2) return 1;
        if (digits === 3) {
            const firstDigit = Number(text[0]);
            if (level > 0) {
                if (firstDigit === 1) return 2;
                if (firstDigit <= 3) return 5;
                if (firstDigit <= 7) return 10;
                return 20;
            }
            if (firstDigit <= 3) return 1;
            if (firstDigit <= 7) return 2;
            return 4;
        }
        const firstTwoDigits = Number.parseInt(text.slice(0, 2), 10);
        let unit = 40;
        for (const [exclusiveUpperBound, tierUnit] of BIN_GAP_UNIT_TIERS) {
            if (firstTwoDigits < exclusiveUpperBound) {
                unit = tierUnit;
                break;
            }
        }
        const base = unit * Math.pow(10, digits - 4);
        return level > 0 ? 5 * base : base;
    }

    function getOfficialBinnedMarketPrice(
        value,
        roundUp = false,
        vendorPrice = 0,
        enhancementLevel = TARGET_LEVEL
    ) {
        let price = parseInt(value, 10);
        const vendor = Number(vendorPrice);
        if (
            !Number.isSafeInteger(price) ||
            !Number.isSafeInteger(vendor) ||
            vendor < 0
        ) return null;
        if (price <= 1) return 2;
        const step = getOfficialMarketBinGap(price, enhancementLevel);
        if (!Number.isSafeInteger(step) || step <= 0) return null;
        const remainder = price % step;
        price -= remainder;
        if (price < vendor) roundUp = true;
        if (roundUp && remainder >= 1) price += step;
        return Number.isSafeInteger(price) ? price : null;
    }

    function getPreviousOfficialMarketPrice(
        bestAskPrice,
        vendorPrice,
        enhancementLevel = TARGET_LEVEL
    ) {
        const bestAsk = Number(bestAskPrice);
        const vendor = Number(vendorPrice);
        if (
            !Number.isSafeInteger(bestAsk) ||
            bestAsk <= 0 ||
            !Number.isSafeInteger(vendor) ||
            vendor < 0
        ) return null;
        const candidate = getOfficialBinnedMarketPrice(
            bestAsk - 1,
            false,
            vendor,
            enhancementLevel
        );
        return (
            Number.isSafeInteger(candidate) &&
            candidate > 0 &&
            candidate < bestAsk &&
            candidate >= vendor
        ) ? candidate : null;
    }

    function getOwnActiveSellListings(itemId) {
        const itemHrid = fullItemHrid(itemId);
        return [...State.myListings.values()]
            .filter((listing) => (
                listing?.status === ACTIVE_STATUS &&
                listing.isSell === true &&
                listing.itemHrid === itemHrid &&
                Number(listing.enhancementLevel) === TARGET_LEVEL &&
                normalizeListingId(listing.id) &&
                Number(listingRemaining(listing)) > 0
            ))
            .sort((left, right) => (
                getListingCurrentPrice(left) -
                    getListingCurrentPrice(right) ||
                Number(left.id) - Number(right.id)
            ));
    }

    function getOwnActiveBuyListings(
        itemId,
        enhancementLevel = COWBELL_LEVEL
    ) {
        const itemHrid = fullItemHrid(itemId);
        const level = Number(enhancementLevel);
        return [...State.myListings.values()]
            .filter((listing) => (
                listing?.status === ACTIVE_STATUS &&
                listing.isSell === false &&
                listing.itemHrid === itemHrid &&
                Number(listing.enhancementLevel) === level &&
                normalizeListingId(listing.id)
            ))
            .sort((left, right) => (
                Number(right.price) - Number(left.price) ||
                Number(left.id) - Number(right.id)
            ));
    }

    function getListingCurrentPrice(listing, asks = []) {
        const listingId = normalizeListingId(listing?.id);
        const exactAsk = Array.isArray(asks)
            ? asks.find((ask) => (
                normalizeListingId(ask?.listingId) === listingId
            ))
            : null;
        const candidates = [
            exactAsk?.price,
            listing?.workingPrice,
            listing?.price,
        ];
        for (const candidate of candidates) {
            const price = Number(candidate);
            if (Number.isSafeInteger(price) && price > 0) return price;
        }
        return NaN;
    }

    function getTerminalMarketListings(
        itemId,
        enhancementLevel,
        isSell
    ) {
        const itemHrid = fullItemHrid(itemId);
        const level = Number(enhancementLevel);
        return [...State.myListings.values()]
            .filter((listing) => (
                TERMINAL_STATUSES.has(listing?.status) &&
                listing.isSell === isSell &&
                listing.itemHrid === itemHrid &&
                Number(listing.enhancementLevel) === level &&
                (
                    Number(listing.unclaimedItemCount || 0) > 0 ||
                    Number(listing.unclaimedCoinCount || 0) > 0
                )
            ));
    }

    function getTerminalListings(itemId) {
        return getTerminalMarketListings(itemId, TARGET_LEVEL, true);
    }

    function hasBlockingOwnSellRecord(itemId) {
        const itemHrid = fullItemHrid(itemId);
        const hasUnsettledValue = (value) => {
            const numeric = Number(value ?? 0);
            return (
                !Number.isSafeInteger(numeric) ||
                numeric < 0 ||
                numeric > 0
            );
        };
        return [...State.myListings.values()].some((listing) => (
            listing?.isSell === true &&
            listing.itemHrid === itemHrid &&
            Number(listing.enhancementLevel) === TARGET_LEVEL &&
            (
                listing.status === ACTIVE_STATUS ||
                hasUnsettledValue(listing.unclaimedItemCount) ||
                hasUnsettledValue(listing.unclaimedCoinCount)
            )
        ));
    }

    function hasBlockingOwnBuyRecord(
        itemId,
        enhancementLevel = COWBELL_LEVEL
    ) {
        const itemHrid = fullItemHrid(itemId);
        const level = Number(enhancementLevel);
        const hasUnsettledValue = (value) => {
            const numeric = Number(value ?? 0);
            return (
                !Number.isSafeInteger(numeric) ||
                numeric < 0 ||
                numeric > 0
            );
        };
        return [...State.myListings.values()].some((listing) => (
            listing?.isSell === false &&
            listing.itemHrid === itemHrid &&
            Number(listing.enhancementLevel) === level &&
            (
                listing.status === ACTIVE_STATUS ||
                hasUnsettledValue(listing.unclaimedItemCount) ||
                hasUnsettledValue(listing.unclaimedCoinCount)
            )
        ));
    }

    function getIndexedMarketValue(values, level = TARGET_LEVEL) {
        if (!values || typeof values !== 'object') return null;
        const numeric = Number(values[level] ?? values[String(level)]);
        return Number.isSafeInteger(numeric) && numeric > 0
            ? numeric
            : null;
    }

    function getTradablePriceRange(snapshot, level = TARGET_LEVEL) {
        const rawMaximum = Number(
            snapshot?.priceBandMaxs?.[level] ??
            snapshot?.priceBandMaxs?.[String(level)] ??
            0
        );
        if (Number.isFinite(rawMaximum) && rawMaximum <= 0) return null;
        const minimum = getIndexedMarketValue(
            snapshot?.priceBandMins,
            level
        );
        const maximum = getIndexedMarketValue(
            snapshot?.priceBandMaxs,
            level
        );
        if (
            !Number.isSafeInteger(minimum) ||
            !Number.isSafeInteger(maximum) ||
            minimum <= 0 ||
            maximum < minimum
        ) {
            return {invalid: true, min: null, max: null, marketValue: null};
        }
        return {
            min: minimum,
            max: maximum,
            marketValue: getIndexedMarketValue(
                snapshot?.marketValues,
                level
            ),
        };
    }

    function desiredListingPrice(book, vendorPrice) {
        if (book.competitor) {
            return getPreviousOfficialMarketPrice(
                book.competitor.price,
                vendorPrice
            );
        }
        if (book.tradeRange) {
            return getOfficialBinnedMarketPrice(
                book.tradeRange.min,
                false,
                vendorPrice,
                TARGET_LEVEL
            );
        }
        return null;
    }

    function getReplacementListingPrice(
        currentPrice,
        tradeRange,
        vendorPrice
    ) {
        const current = Number(currentPrice);
        const vendor = Number(vendorPrice);
        const isPeggedAtBandMinimum = Boolean(
            tradeRange &&
            Number(tradeRange.min) === current
        );
        let candidate = getOfficialBinnedMarketPrice(
            current,
            !isPeggedAtBandMinimum,
            vendor,
            TARGET_LEVEL
        );
        if (
            !Number.isSafeInteger(candidate) ||
            candidate <= 0 ||
            candidate < vendor
        ) {
            candidate = getOfficialBinnedMarketPrice(
                current,
                true,
                vendor,
                TARGET_LEVEL
            );
        }
        return (
            Number.isSafeInteger(candidate) &&
            candidate > 0 &&
            candidate >= vendor
        ) ? candidate : null;
    }

    function analyzeOrderBook(snapshot, ownListings) {
        const asks = getOrderBookLevel(snapshot)?.asks;
        if (!Array.isArray(asks)) {
            return {
                valid: false,
                leftOne: null,
                rawLeftOne: null,
                competitor: null,
                tradeRange: null,
                asks: [],
            };
        }
        const ownIds = new Set(
            ownListings.map((listing) => normalizeListingId(listing.id))
        );
        const tradeRange = getTradablePriceRange(snapshot);
        if (tradeRange?.invalid) {
            return {
                valid: false,
                leftOne: null,
                rawLeftOne: null,
                competitor: null,
                tradeRange,
                asks: [],
            };
        }
        let previousPrice = 0;
        let rawLeftOne = null;
        let leftOne = null;
        let competitor = null;
        const normalizedAsks = [];
        for (let index = 0; index < asks.length; index++) {
            const ask = normalizeAsk(asks[index]);
            if (!ask || ask.price < previousPrice) {
                return {
                    valid: false,
                    leftOne: null,
                    rawLeftOne: null,
                    competitor: null,
                    tradeRange,
                    asks: [],
                };
            }
            previousPrice = ask.price;
            normalizedAsks.push(ask);
            if (index === 0) rawLeftOne = ask;
            const insideBand = !tradeRange || (
                ask.price >= tradeRange.min &&
                ask.price <= tradeRange.max
            );
            if (!insideBand) continue;
            if (!leftOne) leftOne = ask;
            if (!competitor && !ownIds.has(ask.listingId)) {
                competitor = ask;
            }
        }
        return {
            valid: true,
            leftOne,
            rawLeftOne,
            competitor,
            tradeRange,
            asks: normalizedAsks,
        };
    }

    function getCowbellBuyEffectivePrice(listing, bids = []) {
        const listingId = normalizeListingId(listing?.id);
        const exactBid = Array.isArray(bids)
            ? bids.find((bid) => (
                normalizeListingId(bid?.listingId) === listingId
            ))
            : null;
        for (const candidate of [
            exactBid?.price,
            listing?.workingPrice,
            listing?.price,
        ]) {
            const price = Number(candidate);
            if (Number.isSafeInteger(price) && price > 0) return price;
        }
        return NaN;
    }

    function analyzeCowbellBuyBook(snapshot) {
        const level = getOrderBookLevel(snapshot, COWBELL_LEVEL);
        const rawAsks = level?.asks;
        const rawBids = level?.bids;
        const tradeRange = getTradablePriceRange(
            snapshot,
            COWBELL_LEVEL
        );
        if (
            !Array.isArray(rawAsks) ||
            !Array.isArray(rawBids) ||
            !tradeRange ||
            tradeRange.invalid
        ) {
            return {
                valid: false,
                tradeRange,
                rawLeftOne: null,
                leftOne: null,
                asks: [],
                bids: [],
            };
        }
        const asks = [];
        let previousAskPrice = 0;
        for (const rawAsk of rawAsks) {
            const ask = normalizeAsk(rawAsk);
            if (!ask || ask.price < previousAskPrice) {
                return {
                    valid: false,
                    tradeRange,
                    rawLeftOne: null,
                    leftOne: null,
                    asks: [],
                    bids: [],
                };
            }
            previousAskPrice = ask.price;
            asks.push(ask);
        }
        const bids = [];
        let previousBidPrice = Number.POSITIVE_INFINITY;
        for (const rawBid of rawBids) {
            const bid = normalizeAsk(rawBid);
            if (!bid || bid.price > previousBidPrice) {
                return {
                    valid: false,
                    tradeRange,
                    rawLeftOne: asks[0] || null,
                    leftOne: null,
                    asks,
                    bids: [],
                };
            }
            previousBidPrice = bid.price;
            bids.push(bid);
        }
        const leftOne = asks.find((ask) => (
            ask.price >= tradeRange.min &&
            ask.price <= tradeRange.max
        )) || null;
        const limitPrice = getOfficialBinnedMarketPrice(
            tradeRange.max,
            true,
            0,
            COWBELL_LEVEL
        );
        if (!Number.isSafeInteger(limitPrice) || limitPrice <= 0) {
            return {
                valid: false,
                tradeRange,
                rawLeftOne: asks[0] || null,
                leftOne,
                asks,
                bids,
            };
        }
        return {
            valid: true,
            tradeRange,
            rawLeftOne: asks[0] || null,
            leftOne,
            asks,
            bids,
            targetPrice: tradeRange.max,
            limitPrice,
            atCeiling: Boolean(
                leftOne && leftOne.price === tradeRange.max
            ),
        };
    }

    function planCowbellBuyDecision({
        ownBuyListings,
        orderBookSnapshot,
        coinCount,
        listingSlotAvailable,
    }) {
        const own = Array.isArray(ownBuyListings)
            ? ownBuyListings
            : [];
        const book = analyzeCowbellBuyBook(orderBookSnapshot);
        if (!book.valid) return {kind: 'cowbell_invalid_book', ...book};
        if (book.atCeiling) {
            return {
                kind: own.length > 0
                    ? 'cowbell_remove_at_ceiling'
                    : 'cowbell_at_ceiling',
                ownBuyListings: own,
                ...book,
            };
        }
        const only = own.length === 1 ? own[0] : null;
        const remaining = only ? listingRemaining(only) : null;
        const effectivePrice = only
            ? getCowbellBuyEffectivePrice(only, book.bids)
            : null;
        const correct = Boolean(
            only &&
            Number(only.orderQuantity) === 1 &&
            Number(only.filledQuantity) === 0 &&
            remaining === 1 &&
            effectivePrice === book.targetPrice &&
            Number(only.unclaimedItemCount || 0) === 0 &&
            Number(only.unclaimedCoinCount || 0) === 0
        );
        if (correct) {
            return {
                kind: 'cowbell_buy_stable',
                ownBuyListings: own,
                ownListing: only,
                effectivePrice,
                ...book,
            };
        }
        if (own.length > 0) {
            return {
                kind: 'cowbell_replace_buy',
                ownBuyListings: own,
                effectivePrice,
                ...book,
            };
        }
        if (!listingSlotAvailable) {
            return {kind: 'cowbell_listing_cap', ...book};
        }
        const coins = Number(coinCount);
        if (!Number.isSafeInteger(coins) || coins < book.limitPrice) {
            return {
                kind: 'cowbell_insufficient_coins',
                coinCount: coins,
                ...book,
            };
        }
        return {
            kind: 'cowbell_post_buy',
            quantity: 1,
            price: book.limitPrice,
            ...book,
        };
    }

    function planMarketDecision({
        itemId,
        inventoryCount,
        equippedCount = 0,
        ownListings,
        orderBookSnapshot,
        vendorPrice,
        listingSlotAvailable,
    }) {
        const inventory = Number(inventoryCount);
        const equipped = Number.isSafeInteger(Number(equippedCount))
            ? Math.max(0, Number(equippedCount))
            : 0;
        const inventoryReserveNeeded = Math.max(
            0,
            CONFIG.RESERVED_INVENTORY - equipped
        );
        const normalizedOwn = Array.isArray(ownListings)
            ? ownListings
            : [];
        const book = analyzeOrderBook(
            orderBookSnapshot,
            normalizedOwn
        );
        const excessQuantity = Number.isSafeInteger(inventory)
            ? Math.max(0, inventory - inventoryReserveNeeded)
            : 0;
        if (!book.valid) {
            return {kind: 'invalid_book', excessQuantity};
        }
        const ownEntries = normalizedOwn.map((listing) => ({
            listing,
            currentPrice: getListingCurrentPrice(
                listing,
                book.asks
            ),
            limitPrice: Number(listing?.price),
        })).sort((left, right) => (
            left.currentPrice - right.currentPrice ||
            left.limitPrice - right.limitPrice ||
            Number(left.listing?.id) - Number(right.listing?.id)
        ));
        const own = ownEntries[0]?.listing || null;
        const ownCurrentPrice = ownEntries[0]?.currentPrice ?? NaN;
        const oldPrice = ownCurrentPrice;
        const oldLimitPrice = ownEntries[0]?.limitPrice ?? NaN;

        if (own && ownEntries.some((entry) => (
            !Number.isSafeInteger(entry.limitPrice) ||
            entry.limitPrice <= 0 ||
            !Number.isSafeInteger(entry.currentPrice) ||
            entry.currentPrice <= 0
        ))) {
            return {kind: 'invalid_listing', ownListing: own, excessQuantity};
        }

        if (own && inventory < inventoryReserveNeeded) {
            return {
                kind: 'reserve_reclaim',
                ownListing: own,
                ownListings: normalizedOwn,
                leftOne: book.leftOne,
                rawLeftOne: book.rawLeftOne,
                competitor: book.competitor,
                tradeRange: book.tradeRange,
                oldPrice,
                oldLimitPrice,
                newPrice: getReplacementListingPrice(
                    oldPrice,
                    book.tradeRange,
                    vendorPrice
                ),
                excessQuantity,
            };
        }

        if (!own) {
            if (excessQuantity <= 0) {
                return {
                    kind: 'reserve_only',
                    leftOne: book.leftOne,
                    rawLeftOne: book.rawLeftOne,
                    competitor: book.competitor,
                    tradeRange: book.tradeRange,
                    excessQuantity,
                };
            }
            if (!listingSlotAvailable) {
                return {
                    kind: 'listing_cap',
                    leftOne: book.leftOne,
                    rawLeftOne: book.rawLeftOne,
                    tradeRange: book.tradeRange,
                    excessQuantity,
                };
            }
            const desired = desiredListingPrice(book, vendorPrice);
            if (!desired) {
                return {
                    kind: book.rawLeftOne
                        ? 'price_floor'
                        : 'no_quote',
                    leftOne: book.leftOne,
                    rawLeftOne: book.rawLeftOne,
                    tradeRange: book.tradeRange,
                    excessQuantity,
                };
            }
            return {
                kind: 'post_new',
                leftOne: book.leftOne,
                rawLeftOne: book.rawLeftOne,
                tradeRange: book.tradeRange,
                newPrice: desired,
                excessQuantity,
            };
        }

        const competitorPrice = Number(book.competitor?.price);
        const needsConsolidation = (
            excessQuantity > 0 || normalizedOwn.length > 1
        );
        const consolidationPrice = getReplacementListingPrice(
            Math.min(...ownEntries.map((entry) => entry.currentPrice)),
            book.tradeRange,
            vendorPrice
        );
        const planConsolidation = () => {
            return {
                kind: 'consolidate',
                ownListing: own,
                ownListings: normalizedOwn,
                leftOne: book.leftOne,
                rawLeftOne: book.rawLeftOne,
                competitor: book.competitor,
                tradeRange: book.tradeRange,
                oldPrice,
                oldLimitPrice,
                ownCurrentPrice,
                newPrice: consolidationPrice,
                excessQuantity,
            };
        };
        const ownIsLowest = (
            book.competitor
                ? ownCurrentPrice <= competitorPrice
                : book.tradeRange
                    ? ownCurrentPrice <= book.tradeRange.max
                    : true
        );
        if (ownIsLowest) {
            if (
                !needsConsolidation
            ) {
                return {
                    kind: 'already_lowest',
                    ownListing: own,
                    ownListings: normalizedOwn,
                    leftOne: book.leftOne,
                    rawLeftOne: book.rawLeftOne,
                    competitor: book.competitor,
                    tradeRange: book.tradeRange,
                    oldPrice,
                    oldLimitPrice,
                    ownCurrentPrice,
                    excessQuantity,
                };
            }
            return planConsolidation();
        }

        const desired = desiredListingPrice(book, vendorPrice);
        if (!desired) {
            if (needsConsolidation) return planConsolidation();
            return {
                kind: 'price_floor',
                ownListing: own,
                ownListings: normalizedOwn,
                leftOne: book.leftOne,
                rawLeftOne: book.rawLeftOne,
                competitor: book.competitor,
                tradeRange: book.tradeRange,
                oldPrice,
                oldLimitPrice,
                excessQuantity,
            };
        }
        return {
            kind: 'reprice',
            ownListing: own,
            ownListings: normalizedOwn,
            leftOne: book.leftOne,
            rawLeftOne: book.rawLeftOne,
            competitor: book.competitor,
            tradeRange: book.tradeRange,
            oldPrice,
            oldLimitPrice,
            ownCurrentPrice,
            newPrice: desired,
            excessQuantity,
        };
    }

    function listingIdentityMatches(listing, expected) {
        return Boolean(
            listing &&
            expected &&
            normalizeListingId(listing.id) ===
                normalizeListingId(expected.id) &&
            listing.isSell === expected.isSell &&
            listing.itemHrid === expected.itemHrid &&
            Number(listing.enhancementLevel) ===
                Number(expected.enhancementLevel) &&
            Number(listing.price) === Number(expected.price) &&
            Number(listing.orderQuantity) ===
                Number(expected.orderQuantity)
        );
    }

    function validateTerminalListing(listing, expected) {
        if (!listingIdentityMatches(listing, expected)) {
            return '终态市场订单身份与发送前冻结记录不一致';
        }
        if (!TERMINAL_STATUSES.has(listing.status)) {
            return '撤单回执不是可识别的终态';
        }
        const filled = Number(listing.filledQuantity);
        const order = Number(listing.orderQuantity);
        const items = Number(listing.unclaimedItemCount || 0);
        const coins = Number(listing.unclaimedCoinCount || 0);
        if (
            !Number.isSafeInteger(filled) ||
            filled < 0 ||
            filled > order ||
            !Number.isSafeInteger(items) ||
            items < 0 ||
            !Number.isSafeInteger(coins) ||
            coins < 0
        ) {
            return '终态市场订单的成交或未领取字段无效';
        }
        return '';
    }

    function serializeListings(listings = State.myListings) {
        return [...listings.entries()].map(([id, listing]) => [
            id,
            {...listing},
        ]);
    }

    function deserializeListings(entries) {
        return new Map(
            Array.isArray(entries)
                ? entries
                    .map(([id, listing]) => [
                        normalizeListingId(id),
                        listing,
                    ])
                    .filter(([id, listing]) => id && listing)
                : []
        );
    }

    function matchPostResult({
        baselineListings,
        currentListings,
        expectedPost,
    }) {
        const baseline = baselineListings instanceof Map
            ? baselineListings
            : deserializeListings(baselineListings);
        const current = currentListings instanceof Map
            ? currentListings
            : deserializeListings(currentListings);
        const matches = [];
        for (const [listingId, listing] of current) {
            if (
                listing?.isSell !== expectedPost?.isSell ||
                listing.itemHrid !== expectedPost?.itemHrid ||
                Number(listing.enhancementLevel) !==
                    Number(expectedPost?.enhancementLevel) ||
                Number(listing.price) !== Number(expectedPost?.price)
            ) continue;
            const before = baseline.get(listingId);
            if (!before) {
                if (
                    Number(listing.orderQuantity) ===
                        Number(expectedPost.quantity)
                ) matches.push(listing);
                continue;
            }
            if (
                before.status === ACTIVE_STATUS &&
                before.isSell === expectedPost.isSell &&
                before.itemHrid === expectedPost.itemHrid &&
                Number(before.enhancementLevel) ===
                    Number(expectedPost.enhancementLevel) &&
                Number(before.price) === Number(expectedPost.price) &&
                Number(listing.orderQuantity) ===
                    Number(before.orderQuantity) +
                        Number(expectedPost.quantity) &&
                Number(listing.filledQuantity) >=
                    Number(before.filledQuantity)
            ) {
                matches.push(listing);
            }
        }
        if (matches.length > 1) {
            return {
                status: 'unknown',
                reason: '同一挂单回执出现多条精确候选',
            };
        }
        if (matches.length === 0) return {status: 'pending'};
        const listing = matches[0];
        if (
            listing.status !== ACTIVE_STATUS &&
            listing.status !== FILLED_STATUS
        ) {
            return {status: 'unknown', reason: '新市场订单首态无效'};
        }
        const remaining = listingRemaining(listing);
        const orderQuantity = Number(listing.orderQuantity);
        const filledQuantity = Number(listing.filledQuantity);
        const unclaimedItems = Number(listing.unclaimedItemCount || 0);
        const unclaimedCoins = Number(listing.unclaimedCoinCount || 0);
        if (
            remaining == null ||
            (listing.status === ACTIVE_STATUS && remaining <= 0) ||
            (listing.status === FILLED_STATUS && remaining !== 0) ||
            !Number.isSafeInteger(unclaimedItems) ||
            unclaimedItems < 0 ||
            !Number.isSafeInteger(unclaimedCoins) ||
            unclaimedCoins < 0 ||
            (expectedPost.isSell === true && unclaimedItems !== 0)
        ) {
            return {status: 'unknown', reason: '新市场订单数量字段无效'};
        }
        if (expectedPost.isSell === false) {
            const expectedQuantity = Number(expectedPost.quantity);
            const validActiveBuy = (
                listing.status === ACTIVE_STATUS &&
                orderQuantity === expectedQuantity &&
                filledQuantity === 0 &&
                remaining === expectedQuantity &&
                unclaimedItems === 0 &&
                unclaimedCoins === 0
            );
            const validFilledBuy = (
                listing.status === FILLED_STATUS &&
                orderQuantity === expectedQuantity &&
                filledQuantity === expectedQuantity &&
                remaining === 0 &&
                unclaimedItems === expectedQuantity
            );
            if (!validActiveBuy && !validFilledBuy) {
                return {
                    status: 'unknown',
                    reason: '新牛铃包买单的成交或待领取字段无法证明数量完整',
                };
            }
        }
        return {
            status: 'confirmed',
            listing,
            listingId: normalizeListingId(listing.id),
            filled: listing.status === FILLED_STATUS,
        };
    }

    function createMarketPostPayload({
        isSell,
        itemId,
        enhancementLevel,
        quantity,
        price,
    }) {
        const level = Number(enhancementLevel);
        const maximumQuantity = Number(
            State.marketplaceLimits?.maxQuantity ??
            CONFIG.MAX_POST_QUANTITY
        );
        const maximumPrice = Number(
            State.marketplaceLimits?.maxPrice ??
            CONFIG.MAX_POST_PRICE
        );
        const maximumNotional = Number(
            State.marketplaceLimits?.maxNotional ??
            CONFIG.MAX_POST_NOTIONAL
        );
        const notional = quantity * price;
        const binnedPrice = getOfficialBinnedMarketPrice(
            price,
            false,
            0,
            level
        );
        if (
            !Number.isSafeInteger(quantity) ||
            quantity <= 0 ||
            quantity > maximumQuantity ||
            !Number.isSafeInteger(level) ||
            level < 0 ||
            level > TARGET_LEVEL ||
            !Number.isSafeInteger(price) ||
            price <= 0 ||
            price > maximumPrice ||
            binnedPrice !== price ||
            !Number.isSafeInteger(notional) ||
            notional > maximumNotional
        ) {
            throw new MarketError(
                '挂单数量或价格超出允许范围，或不是游戏允许的合法档位'
            );
        }
        return {
            type: 'post_market_order',
            postMarketOrderData: {
                isSell: isSell === true,
                itemHrid: fullItemHrid(itemId),
                enhancementLevel: level,
                quantity,
                price,
                isInstantOrder: false,
            },
        };
    }

    function createPostPayload(itemId, quantity, price) {
        return createMarketPostPayload({
            isSell: true,
            itemId,
            enhancementLevel: TARGET_LEVEL,
            quantity,
            price,
        });
    }

    function createCowbellBuyPayload(price) {
        return createMarketPostPayload({
            isSell: false,
            itemId: COWBELL_BAG_ITEM_ID,
            enhancementLevel: COWBELL_LEVEL,
            quantity: 1,
            price,
        });
    }

    function marketWarningMatches(message, expected) {
        return Boolean(
            message &&
            expected &&
            message.isSell === expected.isSell &&
            message.itemHrid === expected.itemHrid &&
            Number(message.enhancementLevel) ===
                Number(expected.enhancementLevel) &&
            Number(message.quantity) === Number(expected.quantity) &&
            Number(message.listingPrice ?? message.price) ===
                Number(expected.price) &&
            message.isInstantOrder === expected.isInstantOrder
        );
    }

    function setItemStatus(itemId, status) {
        State.itemStatus.set(itemId, {
            ...(State.itemStatus.get(itemId) || {}),
            ...status,
            itemId,
            updatedAt: Date.now(),
        });
        scheduleUiRefresh();
    }

    function pauseItem(itemId, reason, keepPending = true) {
        const normalized = normalizeShortItemId(itemId);
        if (!normalized) return;
        State.pausedItems.set(normalized, String(reason));
        if (!keepPending && State.pendingWrite?.itemId === normalized) {
            State.pendingWrite = null;
        }
        saveProfile();
        setItemStatus(normalized, {kind: 'paused', reason: String(reason)});
        log(`${getItemName(normalized)} 已暂停市场写入：${reason}`, 'error');
    }

    function clearPendingWrite() {
        State.pendingWrite = null;
        saveProfile();
    }

    function persistPendingWrite(record) {
        State.pendingWrite = {
            ...record,
            characterId: State.characterId,
            pageSessionId: PAGE_SESSION_ID,
            syncEpoch: State.syncEpoch,
            sentAt: Date.now(),
        };
        if (!saveProfile()) {
            State.pendingWrite = null;
            throw new MarketError(
                '无法在发送前持久化市场待决记录',
                'STORAGE_FAILED'
            );
        }
    }

    const MarketTransactions = {
        settle(op, outcome) {
            if (!op || op.settled || State.op !== op) return;
            op.settled = true;
            if (op.timer) window.clearTimeout(op.timer);
            State.op = null;
            op.resolve(outcome);
        },

        maybeSettlePost(op) {
            if (
                op?.kind === 'post' &&
                op.postListingSeen &&
                (
                    op.requiresInventoryCommit === false ||
                    (
                        op.inventoryCommitSeen &&
                        getCharacterHeldItemCount(
                            op.itemId,
                            op.enhancementLevel
                        ) >= Number(
                            op.expectedHeldCount ?? op.expectedInventory
                        )
                    )
                )
            ) {
                MarketTransactions.settle(op, {
                    status: 'confirmed',
                    listing: op.postListing,
                    listingId: normalizeListingId(op.postListing?.id),
                });
            }
        },

        maybeSettleClaim(op) {
            if (
                op?.kind === 'claim' &&
                op.listingClearedSeen &&
                (
                    Number(op.quantity) === 0 ||
                    (
                        op.inventoryCommitSeen &&
                        getCharacterHeldItemCount(
                            op.itemId,
                            op.enhancementLevel
                        ) >=
                            Number(
                                op.expectedHeldCount ??
                                op.expectedInventory
                            )
                    )
                ) &&
                (
                    op.requiresCoinCommit !== true ||
                    (
                        op.coinCommitSeen &&
                        getItemCount(COIN_ITEM_ID, 0) >=
                            Number(op.expectedCoinCount)
                    )
                )
            ) {
                MarketTransactions.settle(op, {status: 'confirmed'});
            }
        },

        begin(options) {
            if (State.op) {
                throw new MarketError('已有市场请求等待回执');
            }
            if (
                options.kind !== 'order_book' &&
                State.pendingWrite
            ) {
                throw new MarketError(
                    '仍有一笔市场写入等待完整快照接管；刷新前不再发送新的市场写入'
                );
            }
            if (!isOpenWebSocket(State.socket)) {
                throw new MarketError('WebSocket 未连接');
            }
            if (typeof options.preflight === 'function') {
                options.preflight();
            }
            const op = {
                id: ++State.nextOpId,
                epoch: State.connectionEpoch,
                syncEpoch: State.syncEpoch,
                kind: options.kind,
                itemId: options.itemId,
                enhancementLevel: Number(
                    options.enhancementLevel ??
                    options.expectedPost?.enhancementLevel ??
                    options.expectedListing?.enhancementLevel ??
                    TARGET_LEVEL
                ),
                listingId: normalizeListingId(options.listingId),
                expectedPost: options.expectedPost || null,
                expectedListing: options.expectedListing || null,
                baselineListings: options.baselineListings || new Map(),
                baselineInventory: options.baselineInventory,
                expectedInventory: options.expectedInventory,
                baselineHeldCount: options.baselineHeldCount,
                expectedHeldCount: options.expectedHeldCount,
                requiresInventoryCommit:
                    options.requiresInventoryCommit !== false,
                requiresCoinCommit: options.requiresCoinCommit === true,
                baselineCoinCount: options.baselineCoinCount,
                expectedCoinCount: options.expectedCoinCount,
                quantity: options.quantity,
                postListingSeen: false,
                postListing: null,
                listingClearedSeen: false,
                inventoryCommitSeen: false,
                coinCommitSeen: false,
                lastUnattributedError: '',
                settled: false,
                timer: null,
                resolve: null,
            };
            if (options.kind !== 'order_book') {
                persistPendingWrite({
                    kind: options.kind,
                    itemId: options.itemId,
                    enhancementLevel: op.enhancementLevel,
                    listingId: op.listingId,
                    expectedPost: op.expectedPost,
                    expectedListing: op.expectedListing,
                    baselineListings: serializeListings(
                        op.baselineListings
                    ),
                    baselineInventory: op.baselineInventory,
                    expectedInventory: op.expectedInventory,
                    baselineHeldCount: op.baselineHeldCount,
                    expectedHeldCount: op.expectedHeldCount,
                    requiresInventoryCommit: op.requiresInventoryCommit,
                    requiresCoinCommit: op.requiresCoinCommit,
                    baselineCoinCount: op.baselineCoinCount,
                    expectedCoinCount: op.expectedCoinCount,
                    quantity: op.quantity,
                });
            }
            const promise = new Promise((resolve) => {
                op.resolve = resolve;
            });
            State.op = op;
            op.timer = window.setTimeout(() => {
                MarketTransactions.settle(op, {
                    status: options.kind === 'order_book'
                        ? 'failed'
                        : 'unknown',
                    reason: (
                        options.timeoutMessage || '市场请求超时'
                    ) + (
                        op.lastUnattributedError
                            ? `；等待期间收到无法关联的服务器错误：`
                                + op.lastUnattributedError
                            : ''
                    ),
                });
            }, options.timeoutMs);
            try {
                State.lastRequestAt = Date.now();
                State.socket.send(JSON.stringify({
                    ...options.payload,
                    ts: Date.now(),
                }));
            } catch (error) {
                MarketTransactions.settle(op, {
                    status: options.kind === 'order_book'
                        ? 'failed'
                        : 'unknown',
                    reason: `发送失败：${error.message || String(error)}`,
                });
            }
            return promise;
        },

        handleIncoming(message) {
            const op = State.op;
            if (
                !op ||
                op.epoch !== State.connectionEpoch ||
                op.syncEpoch !== State.syncEpoch
            ) return;

            if (
                (op.kind === 'post' || op.kind === 'claim') &&
                messageUpdatesTargetCharacterItem(
                    message,
                    op.itemId,
                    op.enhancementLevel
                )
            ) {
                op.inventoryCommitSeen = true;
            }
            if (
                op.kind === 'claim' &&
                op.requiresCoinCommit === true &&
                messageUpdatesTargetCharacterItem(
                    message,
                    COIN_ITEM_ID,
                    0
                )
            ) {
                op.coinCommitSeen = true;
            }

            if (
                op.kind === 'order_book' &&
                message.type === 'market_item_order_books_updated' &&
                normalizeShortItemId(
                    message.marketItemOrderBooks?.itemHrid
                ) === op.itemId
            ) {
                MarketTransactions.settle(op, {
                    status: 'confirmed',
                    snapshot: message.marketItemOrderBooks,
                });
                return;
            }

            if (
                message.type === 'market_listings_updated' &&
                Array.isArray(message.endMarketListings)
            ) {
                if (op.kind === 'post') {
                    const matched = matchPostResult({
                        baselineListings: op.baselineListings,
                        currentListings: State.myListings,
                        expectedPost: op.expectedPost,
                    });
                    if (matched.status === 'unknown') {
                        MarketTransactions.settle(op, matched);
                        return;
                    }
                    if (matched.status === 'confirmed') {
                        op.postListingSeen = true;
                        op.postListing = matched.listing;
                        MarketTransactions.maybeSettlePost(op);
                    }
                }

                if (op.kind === 'cancel') {
                    const exact = message.endMarketListings.filter(
                        (listing) => (
                            normalizeListingId(listing?.id) ===
                                op.listingId
                        )
                    );
                    if (exact.length > 1) {
                        MarketTransactions.settle(op, {
                            status: 'unknown',
                            reason: '撤单回执含多条相同 listing id',
                        });
                        return;
                    }
                    if (exact.length === 1 &&
                        TERMINAL_STATUSES.has(exact[0].status)) {
                        const invalid = validateTerminalListing(
                            exact[0],
                            op.expectedListing
                        );
                        MarketTransactions.settle(op, invalid
                            ? {status: 'unknown', reason: invalid}
                            : {status: 'confirmed', listing: exact[0]});
                        return;
                    }
                }

                if (op.kind === 'claim') {
                    const exact = message.endMarketListings.filter(
                        (listing) => (
                            normalizeListingId(listing?.id) ===
                                op.listingId
                        )
                    );
                    if (exact.length > 1) {
                        MarketTransactions.settle(op, {
                            status: 'unknown',
                            reason: '领取回执含多条相同 listing id',
                        });
                        return;
                    }
                    if (
                        exact.length === 1 &&
                        listingIdentityMatches(
                            exact[0],
                            op.expectedListing
                        ) &&
                        Number(exact[0].unclaimedItemCount || 0) === 0 &&
                        Number(exact[0].unclaimedCoinCount || 0) === 0
                    ) {
                        op.listingClearedSeen = true;
                        MarketTransactions.maybeSettleClaim(op);
                    }
                }
            }

            if (
                op.kind === 'post' &&
                (
                    message.type === 'items_updated' ||
                    message.type === 'market_listings_updated'
                )
            ) {
                MarketTransactions.maybeSettlePost(op);
            }
            if (
                op.kind === 'claim' &&
                (
                    message.type === 'items_updated' ||
                    message.type === 'market_listings_updated'
                )
            ) {
                MarketTransactions.maybeSettleClaim(op);
            }

            if (
                op.kind === 'post' &&
                message.type === 'misprice_warning' &&
                marketWarningMatches(message, op.expectedPost)
            ) {
                MarketTransactions.settle(op, {
                    status: 'misprice',
                    reason: '服务器要求人工确认错价，脚本拒绝确认',
                });
                return;
            }

            if (message.type === 'error') {
                const reason = String(
                    message.message || '游戏服务器返回错误'
                );
                // Game error packets have no request id. A manual game
                // request may overlap this observation window, so an error
                // alone cannot prove that our market write failed. Preserve
                // it for timeout diagnostics and keep waiting for the exact
                // listing/inventory result.
                op.lastUnattributedError = reason;
                if (reason === 'errorNotification.requestSpamProtection') {
                    State.backoffUntil = Math.max(
                        State.backoffUntil,
                        Date.now() + CONFIG.SPAM_BACKOFF_MS
                    );
                    saveProfile();
                }
            }
        },

        abort(reason) {
            if (!State.op) return;
            MarketTransactions.settle(State.op, {
                status: State.op.kind === 'order_book'
                    ? 'failed'
                    : 'unknown',
                reason,
            });
        },
    };

    async function waitForRequestGap() {
        const wait = Math.max(
            0,
            State.lastRequestAt + CONFIG.MIN_REQUEST_GAP_MS - Date.now(),
            State.backoffUntil - Date.now()
        );
        if (wait <= 0) return;
        await new Promise((resolve) => window.setTimeout(resolve, wait));
    }

    async function performMarketOperation(options) {
        const plannedConnectionEpoch = State.connectionEpoch;
        const plannedSyncEpoch = State.syncEpoch;
        const plannedCharacterId = State.characterId;
        await waitForRequestGap();
        const release = await SharedAutomation.acquire(
            `market:${options.kind}:${options.itemId || ''}`
        );
        try {
            if (
                State.connectionEpoch !== plannedConnectionEpoch ||
                State.syncEpoch !== plannedSyncEpoch ||
                State.characterId !== plannedCharacterId
            ) {
                throw new MarketError(
                    '等待发送期间连接、角色或全量状态已经变化；本轮按新状态重新规划'
                );
            }
            const issue = initializationIssue();
            if (issue) {
                throw new MarketError(
                    `等待发送期间市场条件已变化：${issue}`
                );
            }
            if (!isOpenWebSocket(State.socket)) {
                throw new MarketError('等待发送期间 WebSocket 已断开');
            }
            return await MarketTransactions.begin(options);
        } finally {
            release();
        }
    }

    async function requireOutcome(options) {
        const outcome = await performMarketOperation(options);
        if (outcome.status === 'confirmed') {
            if (options.kind !== 'order_book') clearPendingWrite();
            return outcome;
        }
        if (options.kind === 'order_book') {
            throw new MarketError(outcome.reason || '盘口读取失败');
        }
        if (outcome.status === 'misprice') {
            clearPendingWrite();
            pauseItem(options.itemId, outcome.reason, false);
            throw new MarketError(outcome.reason, 'MISPRICE');
        }
        if (!State.pendingWrite) {
            throw new MarketError(
                '本次写入已由角色全量快照接管，将按当前库存与本人挂单重新规划',
                'RECONCILED'
            );
        }
        pauseItem(
            options.itemId,
            `${outcome.reason || '市场写结果未知'}；刷新后只按完整挂单和库存核对，绝不盲重发`,
            true
        );
        throw new MarketError(
            outcome.reason || '市场写结果未知',
            'UNKNOWN'
        );
    }

    function reconcilePersistedPendingWrite() {
        const pending = State.pendingWrite;
        if (!pending) return 'none';
        if (!State.inventoryReady || !State.listingsReady) return 'waiting';
        const isRecord = Boolean(
            pending &&
            typeof pending === 'object' &&
            !Array.isArray(pending)
        );
        if (
            isRecord &&
            pending.pageSessionId === PAGE_SESSION_ID
        ) {
            return 'current_session';
        }
        const itemId = isRecord
            ? normalizeShortItemId(pending.itemId)
            : '';
        const pendingCharacterId = isRecord
            ? normalizeCharacterId(pending.characterId)
            : '';
        const validKind = isRecord && new Set([
            'post',
            'cancel',
            'claim',
        ]).has(pending.kind);
        if (
            !itemId ||
            !pendingCharacterId ||
            pendingCharacterId !== State.characterId ||
            !validKind
        ) {
            State.pendingWrite = null;
            if (itemId) State.pausedItems.delete(itemId);
            saveProfile();
            log(
                '已在完整库存与本人挂单快照后丢弃不兼容的旧市场恢复记录；'
                + '不会重放其中的请求',
                'warn'
            );
            return 'discarded';
        }
        const operationName = {
            post: '挂单',
            cancel: '撤单',
            claim: '领取',
        }[pending.kind] || '市场写入';
        State.pendingWrite = null;
        State.pausedItems.delete(itemId);
        saveProfile();
        log(
            `${getItemName(itemId)} 刷新前的${operationName}已由完整库存与`
            + '本人挂单快照接管；下一轮按当前事实收束，不按旧请求盲重发',
            'success'
        );
        return 'reconciled';
    }

    function pendingWriteStatusText() {
        if (!State.pendingWrite) return '';
        if (!State.inventoryReady) return '待决写入：等待完整库存快照';
        if (!State.listingsReady) return '待决写入：等待本人挂单全量快照';
        const itemId = normalizeShortItemId(State.pendingWrite?.itemId);
        return itemId
            ? `${getItemName(itemId)} 写入结果未知，请完整刷新接管`
            : '旧市场恢复记录待完整刷新接管';
    }

    async function refreshOrderBook(itemId) {
        return requireOutcome({
            kind: 'order_book',
            itemId,
            timeoutMs: CONFIG.READ_TIMEOUT_MS,
            timeoutMessage: `${getItemName(itemId)} +20 盘口读取超时`,
            payload: {
                type: 'get_market_item_order_books',
                getMarketItemOrderBooksData: {
                    itemHrid: fullItemHrid(itemId),
                },
            },
        });
    }

    async function postInventory(
        itemId,
        quantity,
        price
    ) {
        const assertReadyToPost = () => {
            const currentInventory = getItemCount(itemId);
            if (isItemMarketLocked(itemId, TARGET_LEVEL)) {
                throw new MarketError(
                    `${getItemName(itemId)} +20 已被游戏物品锁定，不能挂售`,
                    'ITEM_LOCKED'
                );
            }
            if (
                quantity !== getSellableInventoryCount(
                    itemId,
                    currentInventory
                )
            ) {
                throw new MarketError(
                    `${getItemName(itemId)} 发送前仓库或当前装备已变化；本轮跳过`
                );
            }
            if (hasBlockingOwnSellRecord(itemId)) {
                throw new MarketError(
                    `${getItemName(itemId)} 合并重挂前仍有本人卖单或待领取`
                    + '订单；本轮不会再新增第二张卖单'
                );
            }
            if (
                !Number.isSafeInteger(Number(State.listingCap)) ||
                activeListingCount() >= Number(State.listingCap)
            ) {
                throw new MarketError(
                    '发送挂单前可用市场槽位已经变化；本轮跳过'
                );
            }
            const currentRule = State.itemRules.get(itemId);
            if (
                !currentRule ||
                currentRule.isTradable !== true ||
                price < currentRule.sellPrice
            ) {
                throw new MarketError(
                    `${getItemName(itemId)} 拟挂价低于游戏允许的最低卖店价`
                );
            }
            createPostPayload(itemId, quantity, price);
            return {
                inventory: currentInventory,
                heldCount: getCharacterHeldItemCount(itemId),
            };
        };
        const initialState = assertReadyToPost();
        const payload = createPostPayload(itemId, quantity, price);
        const baselineListings = new Map(
            [...State.myListings.entries()].map(([id, listing]) => [
                id,
                {...listing},
            ])
        );
        setItemStatus(itemId, {
            kind: 'posting',
            inventoryCount: initialState.inventory,
            equippedCount: getEquippedItemCount(itemId),
            ownPrice: price,
            excessQuantity: quantity,
            reason: '仓库与当前装备合计固定留 1 件',
        });
        const operation = {
            kind: 'post',
            itemId,
            quantity,
            baselineInventory: initialState.inventory,
            expectedInventory: initialState.inventory - quantity,
            baselineHeldCount: initialState.heldCount,
            expectedHeldCount: initialState.heldCount - quantity,
            baselineListings,
            expectedPost: payload.postMarketOrderData,
            timeoutMs: CONFIG.WRITE_TIMEOUT_MS,
            timeoutMessage:
                `${getItemName(itemId)} +20 挂单回执或库存扣除超时`,
            payload,
        };
        operation.preflight = () => {
            const current = assertReadyToPost();
            operation.baselineInventory = current.inventory;
            operation.expectedInventory = current.inventory - quantity;
            operation.baselineHeldCount = current.heldCount;
            operation.expectedHeldCount = current.heldCount - quantity;
        };
        await requireOutcome(operation);
        setItemStatus(itemId, {
            kind: 'listed',
            inventoryCount: getItemCount(itemId),
            ownPrice: price,
            excessQuantity: 0,
            reason: `已挂 ${quantity} 件，仓库与当前装备合计留 1`,
        });
        log(
            `${getItemName(itemId)} +20 已挂 ${formatInt(quantity)} 件，`
            + `价格 ${formatInt(price)}`,
            'success'
        );
    }

    async function cancelListing(itemId, listing) {
        const listingId = normalizeListingId(listing?.id);
        if (!listingId) throw new MarketError('待撤市场订单缺少有效 ID');
        setItemStatus(itemId, {
            kind: 'cancelling',
            ownPrice: Number(listing.price),
            reason: `撤销市场订单 ${listingId}`,
        });
        const outcome = await requireOutcome({
            kind: 'cancel',
            itemId,
            listingId,
            expectedListing: {...listing},
            preflight: () => {
                const live = State.myListings.get(listingId);
                if (
                    live?.status !== ACTIVE_STATUS ||
                    !listingIdentityMatches(live, listing)
                ) {
                    throw new MarketError(
                        `市场订单 ${listingId} 在实际撤单前已变化；本轮重新规划`
                    );
                }
            },
            timeoutMs: CONFIG.WRITE_TIMEOUT_MS,
            timeoutMessage: `撤销市场订单 ${listingId} 超时`,
            payload: {
                type: 'cancel_market_listing',
                cancelMarketListingData: {
                    marketListingId: listing.id,
                },
            },
        });
        return outcome.listing;
    }

    async function claimListing(itemId, listing) {
        const listingId = normalizeListingId(listing?.id);
        const enhancementLevel = Number(listing?.enhancementLevel);
        const quantity = Number(listing?.unclaimedItemCount || 0);
        const coins = Number(listing?.unclaimedCoinCount || 0);
        if (
            !listingId ||
            listing?.itemHrid !== fullItemHrid(itemId) ||
            typeof listing?.isSell !== 'boolean' ||
            !Number.isSafeInteger(enhancementLevel) ||
            enhancementLevel < 0 ||
            !Number.isSafeInteger(quantity) ||
            quantity < 0 ||
            !Number.isSafeInteger(coins) ||
            coins < 0
        ) {
            throw new MarketError('待领取市场订单字段无效');
        }
        if (quantity === 0 && coins === 0) return;
        const requiresCoinCommit = listing.isSell === false && coins > 0;
        const baselineInventory = getItemCount(itemId, enhancementLevel);
        const baselineHeldCount = getCharacterHeldItemCount(
            itemId,
            enhancementLevel
        );
        const baselineCoinCount = getItemCount(COIN_ITEM_ID, 0);
        setItemStatus(itemId, {
            kind: 'claiming',
            inventoryCount: baselineInventory,
            reason: quantity > 0
                ? `领取物品 ${quantity} 件`
                    + (coins > 0 ? '及退回铜币' : '')
                : '领取退回铜币',
        });
        const operation = {
            kind: 'claim',
            itemId,
            enhancementLevel,
            listingId,
            expectedListing: {...listing},
            preflight: () => {
                const live = State.myListings.get(listingId);
                if (
                    !live ||
                    !TERMINAL_STATUSES.has(live.status) ||
                    !listingIdentityMatches(live, listing) ||
                    Number(live.unclaimedItemCount || 0) !== quantity ||
                    Number(live.unclaimedCoinCount || 0) !== coins
                ) {
                    throw new MarketError(
                        `市场订单 ${listingId} 在实际领取前已变化；本轮重新规划`
                    );
                }
                const currentInventory = getItemCount(
                    itemId,
                    enhancementLevel
                );
                operation.baselineInventory = currentInventory;
                operation.expectedInventory = currentInventory + quantity;
                const currentHeldCount = getCharacterHeldItemCount(
                    itemId,
                    enhancementLevel
                );
                operation.baselineHeldCount = currentHeldCount;
                operation.expectedHeldCount = currentHeldCount + quantity;
                const currentCoinCount = getItemCount(COIN_ITEM_ID, 0);
                operation.baselineCoinCount = currentCoinCount;
                operation.expectedCoinCount = currentCoinCount + coins;
            },
            quantity,
            baselineInventory,
            expectedInventory: baselineInventory + quantity,
            baselineHeldCount,
            expectedHeldCount: baselineHeldCount + quantity,
            requiresCoinCommit,
            baselineCoinCount,
            expectedCoinCount: baselineCoinCount + coins,
            timeoutMs: CONFIG.WRITE_TIMEOUT_MS,
            timeoutMessage: `领取市场订单 ${listingId} 超时`,
            payload: {
                type: 'claim_market_listing',
                claimMarketListingData: {
                    marketListingId: listing.id,
                },
            },
        };
        await requireOutcome(operation);
        log(
            `${getItemName(itemId)} 已领取市场订单 ${listingId}`
            + (quantity > 0 ? ` 的 ${quantity} 件物品` : '')
            + (coins > 0 ? ` 及 ${formatInt(coins)} 铜币` : ''),
            'success'
        );
    }

    async function claimAllTerminalListings(itemId) {
        const terminals = getTerminalListings(itemId);
        for (const listing of terminals) {
            const live = State.myListings.get(
                normalizeListingId(listing.id)
            );
            if (!live) continue;
            if (
                Number(live?.unclaimedItemCount || 0) > 0 ||
                Number(live?.unclaimedCoinCount || 0) > 0
            ) {
                await claimListing(itemId, live);
            }
        }
    }

    async function cancelAndClaimAllOwnListings(
        itemId,
        initialListings
    ) {
        const originals = Array.isArray(initialListings)
            ? initialListings
            : [];
        const listingIds = [
            ...new Set(
                originals
                    .map((listing) => normalizeListingId(listing?.id))
                    .filter(Boolean)
            ),
        ];
        for (const listingId of listingIds) {
            let live = State.myListings.get(listingId);
            if (!live) continue;
            if (live.status === ACTIVE_STATUS) {
                live = await cancelListing(itemId, live);
            }
            if (
                live &&
                TERMINAL_STATUSES.has(live.status) &&
                (
                    Number(live.unclaimedItemCount || 0) > 0 ||
                    Number(live.unclaimedCoinCount || 0) > 0
                )
            ) {
                await claimListing(itemId, live);
            }
        }
        await claimAllTerminalListings(itemId);
        if (hasBlockingOwnSellRecord(itemId)) {
            throw new MarketError(
                `${getItemName(itemId)} 合并期间出现新的本人卖单或待领取`
                + '订单；已停止本轮重挂，下一轮会继续收束'
            );
        }
    }

    async function claimAllCowbellTerminalListings() {
        const terminals = getTerminalMarketListings(
            COWBELL_BAG_ITEM_ID,
            COWBELL_LEVEL,
            false
        );
        for (const listing of terminals) {
            const live = State.myListings.get(
                normalizeListingId(listing.id)
            );
            if (!live) continue;
            if (
                Number(live.unclaimedItemCount || 0) > 0 ||
                Number(live.unclaimedCoinCount || 0) > 0
            ) {
                await claimListing(COWBELL_BAG_ITEM_ID, live);
            }
        }
    }

    async function cancelAndClaimAllCowbellBuyListings(
        initialListings
    ) {
        const listingIds = [
            ...new Set(
                (Array.isArray(initialListings) ? initialListings : [])
                    .map((listing) => normalizeListingId(listing?.id))
                    .filter(Boolean)
            ),
        ];
        for (const listingId of listingIds) {
            let live = State.myListings.get(listingId);
            if (!live) continue;
            if (live.status === ACTIVE_STATUS) {
                live = await cancelListing(COWBELL_BAG_ITEM_ID, live);
            }
            if (
                live &&
                TERMINAL_STATUSES.has(live.status) &&
                (
                    Number(live.unclaimedItemCount || 0) > 0 ||
                    Number(live.unclaimedCoinCount || 0) > 0
                )
            ) {
                await claimListing(COWBELL_BAG_ITEM_ID, live);
            }
        }
        await claimAllCowbellTerminalListings();
        if (hasBlockingOwnBuyRecord(COWBELL_BAG_ITEM_ID)) {
            throw new MarketError(
                '牛铃包买单收束期间出现新的本人买单或待领取订单；'
                + '本轮不再新增买单'
            );
        }
    }

    async function postCowbellBuy(price) {
        const assertReadyToPost = () => {
            const currentRule = State.itemRules.get(
                COWBELL_BAG_ITEM_ID
            );
            if (!currentRule || currentRule.isTradable !== true) {
                throw new MarketError('当前游戏规则不允许交易牛铃包');
            }
            if (hasBlockingOwnBuyRecord(COWBELL_BAG_ITEM_ID)) {
                throw new MarketError(
                    '发送牛铃包买单前仍有本人买单或待领取订单'
                );
            }
            if (
                !Number.isSafeInteger(Number(State.listingCap)) ||
                activeListingCount() >= Number(State.listingCap)
            ) {
                throw new MarketError('发送牛铃包买单前市场槽位已满');
            }
            const coinCount = getItemCount(COIN_ITEM_ID, 0);
            if (!Number.isSafeInteger(coinCount) || coinCount < price) {
                throw new MarketError('发送牛铃包买单前铜币已不足');
            }
            createCowbellBuyPayload(price);
            return {coinCount};
        };
        const initialState = assertReadyToPost();
        const payload = createCowbellBuyPayload(price);
        const baselineListings = new Map(
            [...State.myListings.entries()].map(([id, listing]) => [
                id,
                {...listing},
            ])
        );
        setItemStatus(COWBELL_BAG_ITEM_ID, {
            kind: 'cowbell_posting',
            ownPrice: price,
            coinCount: initialState.coinCount,
            reason: `正在 Max ${formatInt(price)} 挂 1 个牛铃包买单`,
        });
        const operation = {
            kind: 'post',
            itemId: COWBELL_BAG_ITEM_ID,
            enhancementLevel: COWBELL_LEVEL,
            quantity: 1,
            requiresInventoryCommit: false,
            baselineListings,
            expectedPost: payload.postMarketOrderData,
            timeoutMs: CONFIG.WRITE_TIMEOUT_MS,
            timeoutMessage: '牛铃包买单回执超时',
            payload,
        };
        operation.preflight = () => {
            const current = assertReadyToPost();
            operation.baselineCoinCount = current.coinCount;
        };
        const outcome = await requireOutcome(operation);
        const filled = outcome.listing?.status === FILLED_STATUS;
        setItemStatus(COWBELL_BAG_ITEM_ID, {
            kind: filled ? 'cowbell_buy_filled' : 'cowbell_buy_stable',
            ownPrice: price,
            ownQuantity: filled ? 0 : 1,
            coinCount: getItemCount(COIN_ITEM_ID, 0),
            reason: filled
                ? '牛铃包买单已成交，下一轮领取后继续检查'
                : `已在 Max ${formatInt(price)} 保持 1 个买单`,
        });
        log(
            `牛铃包已在 Max ${formatInt(price)} 挂出 1 个买单`
            + (filled ? '（已立即成交）' : ''),
            'success'
        );
    }

    function setCowbellDecisionStatus(decision) {
        const ownListings = decision.ownBuyListings || [];
        const statusReasons = {
            cowbell_invalid_book: '牛铃包盘口或交易区间不完整，本轮不写入',
            cowbell_remove_at_ceiling: '范围内左一卖价已是 Max，撤掉不需要的买单',
            cowbell_at_ceiling: '范围内左一卖价已是 Max，无需买单',
            cowbell_buy_stable: '已在当前 Max 保持唯一数量 1 的买单',
            cowbell_replace_buy: '旧买单价格、数量或张数不匹配，需要收束后重挂',
            cowbell_listing_cap: '市场挂单槽位已满',
            cowbell_insufficient_coins: '铜币不足以在当前 Max 挂买单',
            cowbell_post_buy: '当前需要在 Max 挂 1 个买单',
        };
        setItemStatus(COWBELL_BAG_ITEM_ID, {
            kind: decision.kind,
            leftOnePrice: Number(decision.leftOne?.price || 0) || null,
            rawLeftOnePrice:
                Number(decision.rawLeftOne?.price || 0) || null,
            priceBandMin:
                Number(decision.tradeRange?.min || 0) || null,
            priceBandMax:
                Number(decision.tradeRange?.max || 0) || null,
            ownPrice: ownListings.length === 1
                ? Number(
                    decision.effectivePrice ||
                    getCowbellBuyEffectivePrice(
                        ownListings[0],
                        decision.bids
                    ) ||
                    0
                ) || null
                : null,
            ownQuantity: ownListings.reduce(
                (sum, listing) => (
                    sum + Number(listingRemaining(listing) || 0)
                ),
                0
            ),
            ownListingCount: ownListings.length,
            coinCount: getItemCount(COIN_ITEM_ID, 0),
            reason: statusReasons[decision.kind] || '',
        });
    }

    async function maintainCowbellBuy() {
        const rule = State.itemRules.get(COWBELL_BAG_ITEM_ID);
        if (!rule || rule.isTradable !== true) {
            setItemStatus(COWBELL_BAG_ITEM_ID, {
                kind: 'cowbell_untradable',
                reason: '当前游戏规则不允许交易牛铃包',
            });
            return;
        }
        if (
            getTerminalMarketListings(
                COWBELL_BAG_ITEM_ID,
                COWBELL_LEVEL,
                false
            ).length > 0
        ) {
            await claimAllCowbellTerminalListings();
        }

        let ownBuyListings = getOwnActiveBuyListings(
            COWBELL_BAG_ITEM_ID,
            COWBELL_LEVEL
        );
        let quote = await refreshOrderBook(COWBELL_BAG_ITEM_ID);
        let decision = planCowbellBuyDecision({
            ownBuyListings,
            orderBookSnapshot: quote.snapshot,
            coinCount: getItemCount(COIN_ITEM_ID, 0),
            listingSlotAvailable:
                activeListingCount() < Number(State.listingCap),
        });
        setCowbellDecisionStatus(decision);

        if (decision.kind === 'cowbell_remove_at_ceiling') {
            await cancelAndClaimAllCowbellBuyListings(ownBuyListings);
            setItemStatus(COWBELL_BAG_ITEM_ID, {
                kind: 'cowbell_at_ceiling',
                leftOnePrice: Number(decision.leftOne?.price || 0) || null,
                priceBandMin: Number(decision.tradeRange?.min || 0) || null,
                priceBandMax: Number(decision.tradeRange?.max || 0) || null,
                ownPrice: null,
                ownQuantity: 0,
                ownListingCount: 0,
                reason: '范围内左一卖价已是 Max，已撤掉牛铃包买单',
            });
            return;
        }
        if (decision.kind === 'cowbell_replace_buy') {
            await cancelAndClaimAllCowbellBuyListings(ownBuyListings);
            quote = await refreshOrderBook(COWBELL_BAG_ITEM_ID);
            ownBuyListings = getOwnActiveBuyListings(
                COWBELL_BAG_ITEM_ID,
                COWBELL_LEVEL
            );
            decision = planCowbellBuyDecision({
                ownBuyListings,
                orderBookSnapshot: quote.snapshot,
                coinCount: getItemCount(COIN_ITEM_ID, 0),
                listingSlotAvailable:
                    activeListingCount() < Number(State.listingCap),
            });
            setCowbellDecisionStatus(decision);
        }
        if (decision.kind === 'cowbell_post_buy') {
            await postCowbellBuy(decision.price);
        }
    }

    async function repriceOrReclaim(itemId, decision) {
        const originals = decision.ownListings || [
            decision.ownListing,
        ].filter(Boolean);
        await cancelAndClaimAllOwnListings(itemId, originals);
        const inventory = getItemCount(itemId);
        const quantity = getSellableInventoryCount(itemId, inventory);
        if (quantity <= 0) {
            setItemStatus(itemId, {
                kind: 'reserve_only',
                inventoryCount: inventory,
                excessQuantity: 0,
                reason: '撤领后仓库与当前装备合计仅有自用件，无需重挂',
            });
            return;
        }
        let targetPrice = Number(decision.newPrice);
        if (decision.kind === 'reprice') {
            const quote = await refreshOrderBook(itemId);
            if (hasBlockingOwnSellRecord(itemId)) {
                throw new MarketError(
                    `${getItemName(itemId)} 重读盘口期间出现新的本人卖单或待领取`
                    + '订单；本轮不新增卖单，下一轮重新收束'
                );
            }
            const book = analyzeOrderBook(quote.snapshot, []);
            if (!book.valid) throw new MarketError('重挂前盘口结构无效');
            const rule = State.itemRules.get(itemId);
            const refreshedTarget = desiredListingPrice(
                book,
                rule.sellPrice
            );
            if (
                !Number.isSafeInteger(refreshedTarget) ||
                refreshedTarget <= 0
            ) {
                throw new MarketError(
                    `${getItemName(itemId)} 重挂前没有可用左一价格；保留在仓库等待下一轮`
                );
            }
            targetPrice = refreshedTarget;
        }
        if (!Number.isSafeInteger(targetPrice) || targetPrice <= 0) {
            throw new MarketError('重挂前没有合法目标价格');
        }
        await postInventory(
            itemId,
            quantity,
            targetPrice
        );
        log(
            `${getItemName(itemId)} 已把 ${originals.length} 张本人卖单`
            + `与当前仓库余货合并为 1 张，数量 ${formatInt(quantity)}`,
            'success'
        );
    }

    function activeListingCount() {
        return [...State.myListings.values()].filter(
            (listing) => listing?.status === ACTIVE_STATUS
        ).length;
    }

    async function maintainItem(itemId) {
        const rule = State.itemRules.get(itemId);
        if (!rule || rule.isTradable !== true) {
            setItemStatus(itemId, {
                kind: 'untradable',
                reason: '当前游戏规则不允许交易此物品',
            });
            return;
        }
        if (getTerminalListings(itemId).length > 0) {
            await claimAllTerminalListings(itemId);
        }
        if (isItemMarketLocked(itemId, TARGET_LEVEL)) {
            setItemStatus(itemId, {
                kind: 'locked',
                inventoryCount: getItemCount(itemId),
                equippedCount: getEquippedItemCount(itemId),
                reason: '+20 已被游戏物品锁定；只领取已结算资产，不再挂售、撤单或改价',
            });
            return;
        }
        const inventory = getItemCount(itemId);
        const equipped = getEquippedItemCount(itemId);
        const inventoryReserveNeeded = getInventoryReserveNeeded(itemId);
        const sellableInventory = getSellableInventoryCount(
            itemId,
            inventory
        );
        const ownListings = getOwnActiveSellListings(itemId);
        if (sellableInventory <= 0 && ownListings.length === 0) {
            setItemStatus(itemId, {
                kind: 'reserve_only',
                inventoryCount: inventory,
                equippedCount: equipped,
                excessQuantity: 0,
                reason: inventoryReserveNeeded > 0
                    ? '仓库中的 1 件作为自用保留，无需读取盘口'
                    : '当前装备已满足自用保留，仓库暂无可售件',
            });
            return;
        }

        const quote = await refreshOrderBook(itemId);
        const listingSlotAvailable =
            activeListingCount() < Number(State.listingCap);
        const decision = planMarketDecision({
            itemId,
            inventoryCount: inventory,
            equippedCount: equipped,
            ownListings,
            orderBookSnapshot: quote.snapshot,
            vendorPrice: rule.sellPrice,
            listingSlotAvailable,
        });
        const leftOnePrice = Number(decision.leftOne?.price || 0) || null;
        const ownPrice = Number(
            decision.ownCurrentPrice ||
            decision.ownListing?.workingPrice ||
            decision.ownListing?.price ||
            0
        ) || null;
        setItemStatus(itemId, {
            kind: decision.kind,
            leftOnePrice,
            rawLeftOnePrice:
                Number(decision.rawLeftOne?.price || 0) || null,
            priceBandMin:
                Number(decision.tradeRange?.min || 0) || null,
            priceBandMax:
                Number(decision.tradeRange?.max || 0) || null,
            ownPrice,
            ownQuantity: ownListings.reduce(
                (sum, listing) => (
                    sum + Number(listingRemaining(listing) || 0)
                ),
                0
            ),
            ownListingCount: ownListings.length,
            inventoryCount: inventory,
            equippedCount: equipped,
            excessQuantity: decision.excessQuantity,
            reason: '',
        });

        if (
            decision.kind === 'post_new'
        ) {
            await postInventory(
                itemId,
                decision.excessQuantity,
                decision.newPrice
            );
            return;
        }
        if (
            decision.kind === 'reprice' ||
            decision.kind === 'reserve_reclaim' ||
            decision.kind === 'consolidate'
        ) {
            await repriceOrReclaim(itemId, decision);
        }
    }

    const MarketKeeper = {
        isReady() {
            return State.profileLoaded && !initializationIssue();
        },

        hasRunnableTarget() {
            const cowbellAvailable = (
                State.cowbellEnabled &&
                !State.pausedItems.has(COWBELL_BAG_ITEM_ID)
            );
            const hasSellTarget = [...State.watchlist].some(
                (itemId) => (
                    itemId !== COWBELL_BAG_ITEM_ID &&
                    !State.pausedItems.has(itemId)
                )
            );
            return cowbellAvailable || hasSellTarget;
        },

        isRunning() {
            return Boolean(
                State.enabled &&
                MarketKeeper.hasRunnableTarget() &&
                MarketKeeper.isReady()
            );
        },

        schedule(delay = CONFIG.POLL_MS) {
            if (State.timer) {
                window.clearTimeout(State.timer);
                State.timer = null;
            }
            if (!State.enabled || !MarketKeeper.hasRunnableTarget()) return;
            const effectiveDelay = Math.max(
                0,
                delay,
                State.backoffUntil - Date.now()
            );
            State.timer = window.setTimeout(() => {
                State.timer = null;
                MarketKeeper.tick().catch((error) => {
                    log(`市场轮询异常：${error.message || String(error)}`, 'error');
                });
            }, effectiveDelay);
        },

        stop() {
            if (State.timer) window.clearTimeout(State.timer);
            State.timer = null;
            scheduleUiRefresh();
        },

        async tick() {
            if (State.busy || State.op || !MarketKeeper.isRunning()) {
                MarketKeeper.schedule();
                return;
            }
            if (State.pendingWrite) {
                MarketKeeper.schedule();
                return;
            }
            const selected = [...State.watchlist].filter(
                (itemId) => (
                    itemId !== COWBELL_BAG_ITEM_ID &&
                    !State.pausedItems.has(itemId)
                )
            );
            const now = Date.now();
            const cowbellAvailable = (
                State.cowbellEnabled &&
                !State.pausedItems.has(COWBELL_BAG_ITEM_ID)
            );
            const cowbellElapsed = State.lastCowbellPollAt > 0
                ? now - State.lastCowbellPollAt
                : Number.POSITIVE_INFINITY;
            const cowbellDue = (
                cowbellAvailable &&
                cowbellElapsed >= CONFIG.COWBELL_POLL_MS
            );
            if (!cowbellDue && selected.length === 0) {
                State.idleScanStreak = 0;
                MarketKeeper.schedule(Math.max(
                    CONFIG.IDLE_SCAN_MS,
                    CONFIG.COWBELL_POLL_MS - cowbellElapsed
                ));
                return;
            }
            const isCowbell = cowbellDue;
            const itemId = isCowbell
                ? COWBELL_BAG_ITEM_ID
                : selected[State.roundRobinIndex % selected.length];
            if (isCowbell) {
                State.lastCowbellPollAt = now;
            } else {
                State.roundRobinIndex =
                    (State.roundRobinIndex + 1) % selected.length;
            }
            State.currentItemId = itemId;
            State.lastPolledItemId = itemId;
            State.lastPollAt = now;
            const requestAtStart = State.lastRequestAt;
            let nextDelay = isCowbell && selected.length === 0
                ? CONFIG.COWBELL_POLL_MS
                : CONFIG.POLL_MS;
            State.busy = true;
            scheduleUiRefresh();
            try {
                if (isCowbell) await maintainCowbellBuy();
                else await maintainItem(itemId);
                if (!isCowbell && State.lastRequestAt === requestAtStart) {
                    // Cold watchlist entries do not consume a market request.
                    // Skip them quickly instead of making 27 empty entries
                    // delay one actionable item for several minutes.
                    State.idleScanStreak++;
                    if (State.idleScanStreak < selected.length) {
                        nextDelay = CONFIG.IDLE_SCAN_MS;
                    } else {
                        State.idleScanStreak = 0;
                    }
                } else {
                    State.idleScanStreak = 0;
                }
            } catch (error) {
                if (
                    error?.code !== 'UNKNOWN' &&
                    error?.code !== 'MISPRICE' &&
                    error?.code !== 'RECONCILED'
                ) {
                    setItemStatus(itemId, {
                        kind: 'read_error',
                        reason: error.message || String(error),
                    });
                    log(
                        `${getItemName(itemId)} 本轮跳过：`
                        + `${error.message || String(error)}`,
                        'warn'
                    );
                }
            } finally {
                State.busy = false;
                State.currentItemId = '';
                MarketKeeper.schedule(nextDelay);
                scheduleUiRefresh();
            }
        },
    };

    const Network = {
        nativeWebSocket: null,
        patchedWebSocket: null,
        nativeSend: null,
        patchedSend: null,
        nativeMessageDataGetter: null,
        patchedMessageDataGetter: null,
        sharedUnsubscribe: null,
        installed: false,
        capturePaths: {
            constructor: false,
            outgoingSend: false,
            incomingMessage: false,
            sharedSocket: false,
        },
        installWarnings: [],
        messageDataHookMarker: Symbol.for(
            'MWI_MARKET_KEEPER_MESSAGE_DATA_HOOK_V1'
        ),
        sendHookMarker: Symbol.for(
            'MWI_MARKET_KEEPER_SEND_HOOK_V1'
        ),
        enhancerSendHookMarker: Symbol.for(
            'MWI_SAFE_ENHANCER_SEND_HOOK_V1'
        ),

        isGameSocket(socket) {
            if (!socket || typeof socket.url !== 'string') return false;
            try {
                const url = new URL(socket.url);
                const expectedHost = window.location.hostname.endsWith(
                    'milkywayidlecn.com'
                )
                    ? 'api-test.milkywayidlecn.com'
                    : 'api-test.milkywayidle.com';
                return (
                    url.protocol === 'wss:' &&
                    url.hostname === expectedHost &&
                    url.port === '' &&
                    url.pathname === '/ws' &&
                    normalizeCharacterId(
                        url.searchParams.get('characterId')
                    ) === getPageCharacterId()
                );
            } catch {
                return false;
            }
        },

        warnInstall(message) {
            const normalized = String(message || '未知网络监听错误');
            Network.installWarnings.push(normalized);
            log(`网络监听兼容提示：${normalized}`, 'warn');
        },

        installIncomingMessageObserver() {
            const prototype = window.MessageEvent?.prototype;
            const descriptor = prototype
                ? Object.getOwnPropertyDescriptor(prototype, 'data')
                : null;
            if (
                !prototype ||
                !descriptor ||
                typeof descriptor.get !== 'function' ||
                descriptor.configurable !== true
            ) {
                throw new Error('MessageEvent.data 不可观察');
            }
            if (descriptor.get[Network.messageDataHookMarker]) {
                Network.capturePaths.incomingMessage = true;
                return;
            }
            const previousGetter = descriptor.get;
            const patchedGetter = function marketKeeperMessageDataGetter() {
                const rawData = previousGetter.call(this);
                try {
                    Network.observeIncoming(
                        this?.currentTarget,
                        rawData,
                        this
                    );
                } catch (error) {
                    console.warn(
                        '[市场守价助手] 观察游戏回执失败:',
                        error
                    );
                }
                return rawData;
            };
            Object.defineProperty(
                patchedGetter,
                Network.messageDataHookMarker,
                {value: true}
            );
            Object.defineProperty(prototype, 'data', {
                ...descriptor,
                get: patchedGetter,
            });
            Network.nativeMessageDataGetter = previousGetter;
            Network.patchedMessageDataGetter = patchedGetter;
            Network.capturePaths.incomingMessage = true;
        },

        installOutgoingSendObserver(webSocketConstructor) {
            const prototype = webSocketConstructor?.prototype;
            if (!prototype || typeof prototype.send !== 'function') {
                throw new Error('WebSocket.send 不可观察');
            }
            if (prototype.send[Network.sendHookMarker]) {
                Network.capturePaths.outgoingSend = true;
                return;
            }
            if (prototype[Network.enhancerSendHookMarker]) {
                // The enhancer's top-level send observer publishes sockets to
                // the shared coordinator. Wrapping above it would make the
                // enhancer correctly report that its integrity was broken.
                return;
            }
            const previousSend = prototype.send;
            const patchedSend = function marketKeeperObservedSend() {
                try {
                    if (Network.isGameSocket(this)) Network.attach(this);
                } catch (error) {
                    console.warn(
                        '[市场守价助手] 观察游戏发包失败:',
                        error
                    );
                }
                return previousSend.apply(this, arguments);
            };
            Object.defineProperty(
                patchedSend,
                Network.sendHookMarker,
                {value: true}
            );
            prototype.send = patchedSend;
            if (prototype.send !== patchedSend) {
                throw new Error('无法替换 WebSocket.send');
            }
            Network.nativeSend = previousSend;
            Network.patchedSend = patchedSend;
            Network.capturePaths.outgoingSend = true;
        },

        install() {
            if (Network.installed) return;
            Network.installWarnings.length = 0;

            try {
                Network.installIncomingMessageObserver();
            } catch (error) {
                Network.warnInstall(
                    `既有连接回执捕获不可用：${error.message || String(error)}`
                );
            }

            const previous = window.WebSocket;
            if (typeof previous === 'function') {
                try {
                    Network.installOutgoingSendObserver(previous);
                } catch (error) {
                    Network.warnInstall(
                        `既有连接发包捕获不可用：${error.message || String(error)}`
                    );
                }
                try {
                    Network.nativeWebSocket = previous;
                    Network.patchedWebSocket = new Proxy(previous, {
                        construct(target, argumentsList, newTarget) {
                            const effectiveNewTarget =
                                newTarget === Network.patchedWebSocket
                                    ? target
                                    : newTarget;
                            const socket = Reflect.construct(
                                target,
                                argumentsList,
                                effectiveNewTarget
                            );
                            if (Network.isGameSocket(socket)) {
                                Network.attach(socket);
                            }
                            return socket;
                        },
                    });
                    window.WebSocket = Network.patchedWebSocket;
                    if (window.WebSocket !== Network.patchedWebSocket) {
                        throw new Error('无法替换页面 WebSocket 构造器');
                    }
                    Network.capturePaths.constructor = true;
                } catch (error) {
                    Network.warnInstall(
                        `新连接捕获不可用：${error.message || String(error)}`
                    );
                }
            } else {
                Network.warnInstall('页面没有可用的 WebSocket 构造器');
            }

            try {
                if (Network.isGameSocket(SharedAutomation.socket)) {
                    Network.attach(SharedAutomation.socket);
                    Network.capturePaths.sharedSocket = true;
                }
                if (typeof SharedAutomation.subscribeSocket === 'function') {
                    Network.sharedUnsubscribe =
                        SharedAutomation.subscribeSocket((socket) => {
                            if (Network.isGameSocket(socket)) {
                                Network.attach(socket);
                            }
                        });
                    Network.capturePaths.sharedSocket = true;
                } else {
                    Network.warnInstall(
                        '旧共享通道不支持订阅；已改用独立回执捕获'
                    );
                }
            } catch (error) {
                Network.warnInstall(
                    `共享连接捕获不可用：${error.message || String(error)}`
                );
            }

            const activePaths = Object.entries(Network.capturePaths)
                .filter(([, active]) => active)
                .map(([name]) => name);
            if (activePaths.length === 0) {
                throw new Error('所有 WebSocket 捕获方式均安装失败');
            }
            Network.installed = true;
            log(
                `网络监听已就绪：${activePaths.join(' + ')}`,
                'success'
            );
        },

        observeIncoming(socket, rawData, event = null) {
            if (!Network.isGameSocket(socket)) return false;
            Network.attach(socket);
            if (State.socket !== socket) return false;
            if (
                event &&
                (typeof event === 'object' || typeof event === 'function')
            ) {
                if (State.observedMessageEvents.has(event)) return false;
                State.observedMessageEvents.add(event);
            }
            const message = safeJsonParse(rawData);
            if (
                !message ||
                typeof message !== 'object' ||
                Array.isArray(message) ||
                typeof message.type !== 'string'
            ) return false;
            Network.handleIncoming(message);
            return true;
        },

        resetConnection(reason = '') {
            if (reason) MarketTransactions.abort(reason);
            MarketKeeper.stop();
            State.inventoryReady = false;
            State.listingsReady = false;
            State.itemMarksReady = false;
            State.inventorySnapshotRows = null;
            State.listingSnapshotRows = null;
            State.itemMarkSnapshotRows = null;
            State.clientReady = false;
            State.accessReady = false;
            State.inventory.clear();
            State.characterItemSlots.clear();
            State.itemMarks.clear();
            State.myListings.clear();
            State.itemRules.clear();
            State.gameModeRestrictions.clear();
            State.itemStatus.clear();
            State.busy = false;
            State.currentItemId = '';
            State.lastPolledItemId = '';
            State.lastPollAt = 0;
            State.lastCowbellPollAt = 0;
            State.idleScanStreak = 0;
            State.connectionEpoch++;
            scheduleUiRefresh();
        },

        attach(socket) {
            const alreadyAttached = State.attachedSockets.has(socket);
            // Mark the socket before publishing it. publishSocket() notifies
            // this script's own subscriber synchronously; without the early
            // mark that re-entrant attach would install every listener twice.
            if (!alreadyAttached) State.attachedSockets.add(socket);
            if (
                State.socket !== socket &&
                isOpenWebSocket(socket)
            ) {
                if (State.socket) {
                    Network.resetConnection(
                        '游戏 WebSocket 已切换；待决市场写将在全量同步后核对'
                    );
                }
                State.socket = socket;
                State.connectionEpoch++;
                restoreClientDataFromCache(socket);
                SharedAutomation.publishSocket(socket);
                log('已捕获游戏 WebSocket，等待角色与本人挂单全量同步');
            }
            if (alreadyAttached) return;
            socket.addEventListener('open', () => {
                if (!Network.isGameSocket(socket)) return;
                Network.attach(socket);
            });
            socket.addEventListener('message', (event) => {
                if (State.socket !== socket) return;
                Network.observeIncoming(socket, event.data, event);
            });
            socket.addEventListener('close', () => {
                if (State.socket !== socket) return;
                Network.resetConnection(
                    'WebSocket 已断开；市场写结果需刷新后核对'
                );
                State.socket = null;
                if (SharedAutomation.socket === socket) {
                    SharedAutomation.publishSocket(null);
                }
                log('游戏 WebSocket 已断开', 'error');
            });
            socket.addEventListener('error', () => {
                if (State.socket !== socket) return;
                MarketTransactions.abort(
                    'WebSocket 报告连接错误；市场写结果需刷新后核对'
                );
                MarketKeeper.stop();
                log('游戏 WebSocket 连接错误', 'error');
            });
        },

        handleIncoming(message) {
            if (message.type === 'close_session') {
                Network.resetConnection('服务器已关闭当前游戏会话');
                log('服务器已关闭当前游戏会话', 'error');
                return;
            }
            if (message.type === 'init_client_data') {
                replaceClientData(message);
            }
            if (message.type === 'init_character_data') {
                if (State.op) {
                    MarketTransactions.abort(
                        '收到角色全量重同步；待决市场写改由新快照核对'
                    );
                }
                State.syncEpoch++;
                const urlCharacterId = getPageCharacterId();
                const messageCharacterId = normalizeCharacterId(
                    message.character?.id
                );
                if (
                    !messageCharacterId ||
                    (urlCharacterId && urlCharacterId !== messageCharacterId)
                ) {
                    State.inventoryReady = false;
                    State.listingsReady = false;
                    log('服务器角色与当前页面角色不一致，市场助手保持禁用', 'error');
                    return;
                }
                const changedCharacter =
                    State.characterId !== messageCharacterId;
                State.characterId = messageCharacterId;
                replaceInventory(message.characterItems);
                replaceMyListings(message.myMarketListings);
                // The official client treats an omitted mark collection as an
                // empty full snapshot. Mirror that compatibility behavior for
                // accounts with no saved favorite/lock rules.
                replaceItemMarks(
                    Array.isArray(message.characterItemMarks)
                        ? message.characterItemMarks
                        : []
                );
                replaceAccess(message);
                State.lastInitAt = Date.now();
                if (changedCharacter || !State.profileLoaded) {
                    State.profileLoaded = false;
                    loadProfile();
                }
                reconcilePersistedPendingWrite();
                const issue = initializationIssue();
                log(
                    `角色 ${State.characterId} 初始化：库存全量 `
                    + `${State.inventoryReady ? `${State.inventorySnapshotRows} 行` : '缺失'}，`
                    + `本人挂单全量 `
                    + `${State.listingsReady ? `${State.listingSnapshotRows} 行` : '缺失'}`
                    + `，物品锁定规则 `
                    + `${State.itemMarksReady ? `${State.itemMarkSnapshotRows} 行` : '缺失'}`
                    + (issue ? `；尚未就绪：${issue}` : '；市场全量已同步'),
                    issue ? 'warn' : 'success'
                );
                if (State.enabled) MarketKeeper.schedule(250);
            }

            if (
                message.type === 'character_info_updated' &&
                message.characterInfo
            ) {
                const raw = message.characterInfo.marketListingCap;
                const numeric = Number(raw);
                State.listingCap = (
                    raw != null &&
                    Number.isSafeInteger(numeric) &&
                    numeric >= 0
                ) ? numeric : null;
                State.accessReady = Boolean(
                    State.listingCap != null &&
                    State.characterGameMode &&
                    State.tradingRulesKnown
                );
            }
            if (
                message.type === 'setting_updated' &&
                message.characterSetting
            ) {
                const accepted = message.characterSetting
                    .hasAcceptedTradingRules;
                State.tradingRulesKnown = typeof accepted === 'boolean';
                State.acceptedTradingRules = accepted === true;
                State.accessReady = Boolean(
                    State.listingCap != null &&
                    State.characterGameMode &&
                    State.tradingRulesKnown
                );
            }
            if (
                message.type === 'character_updated' &&
                message.character
            ) {
                State.characterGameMode = String(
                    message.character.gameMode || ''
                );
                State.accessReady = Boolean(
                    State.listingCap != null &&
                    State.characterGameMode &&
                    State.tradingRulesKnown
                );
            }

            const characterItemDeltas = Array.isArray(
                message.endCharacterItems
            )
                ? message.endCharacterItems
                : Array.isArray(message.updatedCharacterItems)
                    ? message.updatedCharacterItems
                    : [];
            for (const item of characterItemDeltas) {
                updateCharacterItemSlot(item);
                updateInventoryItem(item);
            }
            if (
                message.type === 'market_listings_updated' &&
                Array.isArray(message.endMarketListings)
            ) {
                applyListingDeltas(message.endMarketListings);
            }
            if (
                message.type === 'item_marks_updated' &&
                Array.isArray(message.characterItemMarks)
            ) {
                replaceItemMarks(message.characterItemMarks);
            }

            MarketTransactions.handleIncoming(message);

            if (
                State.enabled &&
                (
                    message.type === 'items_updated' ||
                    message.type === 'market_listings_updated' ||
                    message.type === 'item_marks_updated'
                )
            ) {
                MarketKeeper.schedule(250);
            }
            scheduleUiRefresh();
        },
    };

    const UI = {
        shadow: null,
        refs: {},

        setOpen(open) {
            const shouldOpen = open === true;
            UI.refs.panel?.classList.toggle('open', shouldOpen);
            UI.refs.fab?.classList.toggle('panel-open', shouldOpen);
            UI.refs.fab?.setAttribute(
                'aria-expanded',
                shouldOpen ? 'true' : 'false'
            );
            if (shouldOpen) UI.update();
        },

        async init() {
            const body = await waitForDocumentBody();
            const host = document.createElement('div');
            host.id = 'mwi-market-keeper-host';
            const shadow = host.attachShadow({mode: 'open'});
            UI.shadow = shadow;
            shadow.innerHTML = `
                <style>
                    :host{all:initial;color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
                    *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}
                    button:disabled,input:disabled{cursor:not-allowed;opacity:.55}
                    #fab{position:fixed;top:126px;right:0;z-index:2147483100;border:1px solid #34d399;border-right:0;border-radius:22px 0 0 22px;padding:9px 14px;color:#d1fae5;background:linear-gradient(135deg,#0f172a,#064e3b);box-shadow:0 8px 24px rgba(0,0,0,.45)}
                    #fab.panel-open{visibility:hidden;pointer-events:none}
                    #fab.running::after{content:"";display:inline-block;width:8px;height:8px;margin-left:7px;border-radius:50%;background:#22c55e}
                    #panel{display:none;position:fixed;top:64px;right:18px;z-index:2147483101;width:min(620px,calc(100vw - 30px));height:min(790px,calc(100vh - 82px));overflow:hidden;border:1px solid #1f6f5b;border-radius:12px;color:#e2e8f0;background:#071510;box-shadow:0 24px 70px rgba(0,0,0,.62)}
                    #panel.open{display:flex;flex-direction:column}.header{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid #173b32}.header h2{margin:0;color:#6ee7b7;font-size:17px}.version{color:#64748b;font-size:11px}.spacer{flex:1}.icon,.btn{border:1px solid #31584d;border-radius:7px;color:#e2e8f0;background:#102a23;padding:6px 9px}.icon{width:30px;height:30px;padding:0}.btn.primary{border-color:#047857;background:#047857;color:#fff}.btn.danger{border-color:#9f1239;background:#881337}.btn.small{padding:4px 7px;font-size:11px}
                    .badges{display:flex;flex-wrap:wrap;gap:7px;padding:8px 14px;border-bottom:1px solid #173b32}.badge{padding:3px 7px;border:1px solid #31584d;border-radius:999px;color:#cbd5e1;font-size:11px}.ok{color:#86efac}.warn{color:#fde68a}.error{color:#fda4af}
                    .content{display:flex;flex:1;min-height:0;flex-direction:column;gap:9px;padding:10px}.card{padding:10px;border:1px solid #173b32;border-radius:9px;background:#0b1f19}.row{display:flex;align-items:center;flex-wrap:wrap;gap:7px}.control{min-height:32px;border:1px solid #31584d;border-radius:7px;color:#e2e8f0;background:#0b211b;padding:6px 8px}.search{flex:1;min-width:170px}.hint{color:#78958c;font-size:11px;line-height:1.45}
                    #items{flex:1;min-height:230px;overflow:auto;border:1px solid #173b32;border-radius:8px;background:#06110e}.item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px 9px;border-bottom:1px solid #102a23}.item.selected{background:#0b3026}.name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.id{display:block;color:#64748b;font:10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}.metrics{max-width:260px;text-align:right;color:#a7c7bd;font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.item-actions{display:flex;justify-content:flex-end;gap:4px;margin-top:3px}
                    #logs{height:150px;overflow:auto;padding:7px;border:1px solid #173b32;border-radius:7px;background:#040b09;font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.log{margin-bottom:3px;color:#94a3b8}.log.success{color:#86efac}.log.warn{color:#fde68a}.log.error{color:#fda4af}.time{color:#475569;margin-right:5px}
                    @media(max-width:640px){#panel{right:5px;width:calc(100vw - 10px)}.metrics{max-width:170px}}
                </style>
                <button id="fab" type="button" aria-controls="panel" aria-expanded="false">📈 市场守价</button>
                <section id="panel" aria-label="+20 市场守价助手">
                    <div class="header"><h2>+20 市场守价助手</h2><span class="version">v${VERSION}</span><span class="spacer"></span><button id="close" class="icon" type="button" title="关闭（Esc）" aria-label="关闭市场守价助手">✕</button></div>
                    <div class="badges"><span id="ws" class="badge">WS 未连接</span><span id="init" class="badge">市场未同步</span><span id="state" class="badge">已停止</span><span id="character" class="badge">角色 -</span></div>
                    <div class="content">
                        <div class="card">
                            <div class="row">
                                <label class="row"><input id="enabled" type="checkbox">启用真实市场维护</label>
                            </div>
                            <div class="hint" style="margin-top:6px">每种勾选物品在仓库与当前装备中合计保留 1 件 +20；穿上或脱下不会改变可售总数。读取一次当前盘口后直接挂售：别人占据可交易范围内左一时，使用游戏“价格 -”的下一合法档；范围内无卖单时使用 Min。本人已是左一或并列左一时不自我压价；真正余货会撤领并合并成一张卖单。不使用历史价格或累计跌幅作为底线。</div>
                            <div class="hint" style="margin-top:7px;color:#a7c7bd"><strong>牛铃买单：</strong>独立维护“10 个牛铃袋”的一张数量 1 买单。可交易范围内左一卖价低于 Max 或没有卖单时挂在 Max；左一卖价已等于 Max 时不挂。成交后会领取并在后续轮询继续检查。关闭独立开关只停止后续维护，不会撤销或领取已有订单。</div>
                            <div class="row" style="margin-top:7px"><label class="row"><input id="cowbell-enabled" type="checkbox">启用牛铃 Max 买单</label></div>
                            <div class="row" style="margin-top:7px"><span id="cowbell-status" class="hint">牛铃买单：等待首次轮询</span><button id="cowbell-unpause" class="btn small" type="button" hidden>解除牛铃暂停</button></div>
                            <div id="diagnostics" class="hint" style="margin-top:7px;color:#a7c7bd">正在读取同步状态…</div>
                        </div>
                        <div class="card">
                            <div class="row"><input id="search" class="control search" type="search" placeholder="搜索名称或物品 ID"><input id="manual-id" class="control" type="text" placeholder="手动输入 item_id" style="width:155px"><button id="add-id" class="btn small" type="button">添加</button></div>
                            <div class="row" style="margin-top:7px"><button id="import" class="btn small" type="button">导入强化脚本当前选择</button><button id="discover" class="btn small" type="button">加入当前持有/挂单 +20</button><span id="selected" class="hint">监控 0 种</span></div>
                        </div>
                        <div id="items"></div>
                        <div class="card">
                            <div class="row"><strong style="font-size:12px;color:#94a3b8">运行日志</strong><span class="spacer"></span><button id="copy" class="btn small" type="button">复制</button><button id="clear" class="btn small" type="button">清空</button></div>
                            <div id="logs" style="margin-top:6px"></div>
                        </div>
                    </div>
                </section>`;
            body.appendChild(host);
            for (const id of [
                'fab', 'panel', 'close', 'ws', 'init', 'state', 'character',
                'enabled', 'search', 'manual-id', 'add-id',
                'import', 'discover', 'selected', 'items', 'copy', 'clear',
                'logs', 'diagnostics', 'cowbell-enabled',
                'cowbell-status', 'cowbell-unpause',
            ]) UI.refs[id] = shadow.getElementById(id);
            State.ui = UI;

            UI.refs.fab.addEventListener('click', () => {
                UI.setOpen(!UI.refs.panel.classList.contains('open'));
            });
            UI.refs.close.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                UI.setOpen(false);
            });
            window.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') UI.setOpen(false);
            });
            for (const entry of State.logs) UI.appendLog(entry);
            UI.refs.search.addEventListener('input', () => UI.renderItems());
            UI.refs['add-id'].addEventListener('click', () => {
                const itemId = normalizeShortItemId(
                    UI.refs['manual-id'].value.trim()
                );
                if (!itemId) {
                    window.alert('请输入合法的物品 ID，例如 grandmaster_attack_charm');
                    return;
                }
                if (itemId === COWBELL_BAG_ITEM_ID) {
                    window.alert('牛铃包买单已是内置维护项，无需加入 +20 列表');
                    return;
                }
                State.watchlist.add(itemId);
                State.candidateItemIds.add(itemId);
                UI.refs['manual-id'].value = '';
                saveProfile();
                UI.renderItems();
                MarketKeeper.schedule(0);
            });
            UI.refs.import.addEventListener('click', () => {
                const imported = readJsonStorage(LEGACY_SELECTION_KEY, []);
                let count = 0;
                for (const raw of Array.isArray(imported) ? imported : []) {
                    const itemId = normalizeShortItemId(raw);
                    if (
                        !itemId ||
                        itemId === COWBELL_BAG_ITEM_ID ||
                        State.watchlist.has(itemId)
                    ) continue;
                    State.watchlist.add(itemId);
                    State.candidateItemIds.add(itemId);
                    count++;
                }
                saveProfile();
                log(`已从强化脚本合并导入 ${count} 种物品`, 'success');
                UI.renderItems();
                MarketKeeper.schedule(0);
            });
            UI.refs.discover.addEventListener('click', () => {
                let count = 0;
                const discovered = new Set();
                for (const [itemId, counts] of State.inventory) {
                    if (Number(counts?.[TARGET_LEVEL] || 0) > 0) {
                        discovered.add(itemId);
                    }
                }
                for (const listing of State.myListings.values()) {
                    if (Number(listing?.enhancementLevel) === TARGET_LEVEL) {
                        discovered.add(normalizeShortItemId(listing.itemHrid));
                    }
                }
                for (const itemId of discovered) {
                    if (
                        !itemId ||
                        itemId === COWBELL_BAG_ITEM_ID ||
                        State.watchlist.has(itemId)
                    ) continue;
                    State.watchlist.add(itemId);
                    count++;
                }
                saveProfile();
                log(`已加入 ${count} 种当前持有或正在挂单的 +20`, 'success');
                UI.renderItems();
                MarketKeeper.schedule(0);
            });
            UI.refs.enabled.addEventListener('change', () => {
                if (UI.refs.enabled.checked) {
                    const issue = initializationIssue();
                    if (issue) {
                        UI.refs.enabled.checked = false;
                        window.alert(`尚不能启用：${issue}`);
                        return;
                    }
                    if (!window.confirm(
                        '启用后会发送真实的盘口、挂单、撤单和领取请求。\n'
                        + '每种勾选物品在仓库与当前装备中合计留 1 件 +20，'
                        + '其余按当前左一规则自动出售。\n'
                        + '牛铃买单由面板上的独立开关控制。\n'
                        + '没有历史价格或累计跌幅保护。\n\n确认启用？'
                    )) {
                        UI.refs.enabled.checked = false;
                        return;
                    }
                    State.enabled = true;
                    saveProfile();
                    log('市场守价已启用', 'success');
                    MarketKeeper.schedule(0);
                } else {
                    State.enabled = false;
                    saveProfile();
                    MarketKeeper.stop();
                    log('已停止创建新的市场请求；当前已发送请求仍会安全收束', 'warn');
                }
                UI.update();
            });
            UI.refs['cowbell-enabled'].addEventListener('change', () => {
                if (UI.refs['cowbell-enabled'].checked) {
                    if (!window.confirm(
                        '启用后会使用真实铜币，在当前交易区间 Max '
                        + '维护一张数量 1 的牛铃包买单。\n'
                        + '买单成交后，后续轮询可继续挂新买单。\n\n'
                        + '确认启用牛铃 Max 买单？'
                    )) {
                        UI.refs['cowbell-enabled'].checked = false;
                        return;
                    }
                    State.cowbellEnabled = true;
                    State.lastCowbellPollAt = 0;
                    saveProfile();
                    log('牛铃 Max 买单已启用', 'success');
                    if (State.enabled) MarketKeeper.schedule(0);
                } else {
                    State.cowbellEnabled = false;
                    State.lastCowbellPollAt = 0;
                    saveProfile();
                    log(
                        '牛铃 Max 买单已关闭；现有买单不会自动撤销或领取',
                        'warn'
                    );
                    if (MarketKeeper.hasRunnableTarget()) {
                        MarketKeeper.schedule(0);
                    } else {
                        MarketKeeper.stop();
                    }
                }
                UI.update();
            });
            UI.refs['cowbell-unpause'].addEventListener('click', () => {
                if (
                    State.pendingWrite?.itemId === COWBELL_BAG_ITEM_ID
                ) return;
                State.pausedItems.delete(COWBELL_BAG_ITEM_ID);
                State.lastCowbellPollAt = 0;
                saveProfile();
                MarketKeeper.schedule(0);
                UI.update();
            });
            UI.refs.copy.addEventListener('click', async () => {
                const text = State.logs.map((entry) => (
                    `[${entry.time.toISOString()}] [${entry.type}] ${entry.message}`
                )).join('\n');
                try {
                    await navigator.clipboard.writeText(text);
                } catch {
                    window.prompt('复制下面的日志：', text);
                }
            });
            UI.refs.clear.addEventListener('click', () => {
                State.logs.length = 0;
                UI.refs.logs.replaceChildren();
            });
            UI.update();
        },

        visibleItems() {
            const query = String(UI.refs.search?.value || '')
                .trim().toLowerCase();
            const ids = new Set(State.watchlist);
            for (const [itemId, counts] of State.inventory) {
                if (Number(counts?.[TARGET_LEVEL] || 0) > 0) ids.add(itemId);
            }
            for (const listing of State.myListings.values()) {
                if (Number(listing?.enhancementLevel) === TARGET_LEVEL) {
                    ids.add(normalizeShortItemId(listing.itemHrid));
                }
            }
            if (query) {
                for (const itemId of State.candidateItemIds) {
                    const name = getItemName(itemId).toLowerCase();
                    if (itemId.includes(query) || name.includes(query)) {
                        ids.add(itemId);
                    }
                }
            }
            return [...ids]
                .filter((itemId) => {
                    if (!itemId || itemId === COWBELL_BAG_ITEM_ID) {
                        return false;
                    }
                    if (!query) return true;
                    return itemId.includes(query) ||
                        getItemName(itemId).toLowerCase().includes(query);
                })
                .sort((left, right) => (
                    Number(State.watchlist.has(right)) -
                        Number(State.watchlist.has(left)) ||
                    getItemName(left).localeCompare(getItemName(right), 'zh-CN')
                ))
                .slice(0, 200);
        },

        renderItems() {
            if (!UI.refs.items) return;
            const fragment = document.createDocumentFragment();
            const statusLabels = {
                reserve_only: '仅留自用',
                already_lowest: '本人已是左一',
                post_new: '准备首次挂售',
                consolidate: '准备合并挂单',
                reprice: '准备左一-',
                reserve_reclaim: '收回自用保留件',
                posting: '正在挂单',
                listed: '已挂售',
                cancelling: '正在撤单',
                claiming: '正在领取',
                no_quote: '无范围且无卖盘，暂不猜价',
                price_floor: '没有更低合法档',
                listing_cap: '挂单槽已满',
                invalid_book: '盘口格式异常',
                invalid_listing: '本人卖单字段异常',
                untradable: '不可交易',
                locked: '游戏物品锁定中',
                read_error: '本轮读取失败',
                paused: '写入已暂停',
            };
            for (const itemId of UI.visibleItems()) {
                const row = document.createElement('label');
                row.className = `item${State.watchlist.has(itemId) ? ' selected' : ''}`;
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = State.watchlist.has(itemId);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) State.watchlist.add(itemId);
                    else State.watchlist.delete(itemId);
                    saveProfile();
                    UI.renderItems();
                    MarketKeeper.schedule(0);
                });
                const name = document.createElement('span');
                name.className = 'name';
                name.textContent = getItemName(itemId);
                const id = document.createElement('span');
                id.className = 'id';
                id.textContent = itemId;
                name.appendChild(id);
                const metrics = document.createElement('span');
                metrics.className = 'metrics';
                const active = getOwnActiveSellListings(itemId);
                const ownQuantity = active.reduce(
                    (sum, listing) => sum + Number(listingRemaining(listing) || 0),
                    0
                );
                const status = State.itemStatus.get(itemId);
                const paused = State.pausedItems.get(itemId);
                const inventoryText = State.inventoryReady
                    ? formatInt(getItemCount(itemId))
                    : '?';
                const equippedText = State.inventoryReady
                    ? formatInt(getEquippedItemCount(itemId))
                    : '?';
                const listingText = State.listingsReady
                    ? formatInt(ownQuantity)
                    : '?';
                const rangeText = status?.priceBandMin &&
                    status?.priceBandMax
                    ? `${formatInt(status.priceBandMin)}~`
                        + `${formatInt(status.priceBandMax)}`
                    : '-';
                const waitingText = !State.inventoryReady
                    ? '等待完整库存'
                    : !State.listingsReady
                        ? '等待本人挂单全量'
                        : !State.itemMarksReady
                            ? '等待物品锁定规则'
                        : !State.enabled
                            ? '尚未启用维护'
                            : '等待轮询';
                metrics.textContent =
                    `仓库20:${inventoryText} `
                    + `装备20:${equippedText} `
                    + `卖单:${listingText}\n`
                    + `左一:${status?.leftOnePrice ? formatInt(status.leftOnePrice) : '-'} `
                    + `我的:${status?.ownPrice ? formatInt(status.ownPrice) : '-'} `
                    + `范围:${rangeText}\n`
                    + `${paused || status?.reason || statusLabels[status?.kind] || waitingText}`;
                const actions = document.createElement('span');
                actions.className = 'item-actions';
                if (paused) {
                    const unpause = document.createElement('button');
                    unpause.type = 'button';
                    unpause.className = 'btn small';
                    unpause.textContent = '解除暂停';
                    unpause.disabled =
                        State.pendingWrite?.itemId === itemId;
                    unpause.title = unpause.disabled
                        ? '仍有待决写记录，刷新并取得完整库存与本人挂单后自动接管'
                        : '';
                    unpause.addEventListener('click', (event) => {
                        event.preventDefault();
                        State.pausedItems.delete(itemId);
                        saveProfile();
                        MarketKeeper.schedule(0);
                        UI.renderItems();
                    });
                    actions.appendChild(unpause);
                }
                metrics.appendChild(actions);
                row.append(checkbox, name, metrics);
                fragment.appendChild(row);
            }
            UI.refs.items.replaceChildren(fragment);
            UI.refs.selected.textContent = `监控 ${State.watchlist.size} 种`;
        },

        update() {
            if (!UI.refs.ws) return;
            const connected = isOpenWebSocket(State.socket);
            UI.refs.ws.textContent = connected ? 'WS 已连接' : 'WS 未连接';
            UI.refs.ws.className = `badge ${connected ? 'ok' : 'warn'}`;
            const issue = initializationIssue();
            UI.refs.init.textContent = issue || '市场全量已同步';
            UI.refs.init.className = `badge ${issue ? 'warn' : 'ok'}`;
            UI.refs.state.textContent = State.pendingWrite
                ? pendingWriteStatusText()
                : State.busy || State.op
                ? '市场处理中'
                : State.enabled
                    ? (!MarketKeeper.hasRunnableTarget()
                        ? '已启用，无活动维护项'
                        : Date.now() < State.backoffUntil
                            ? '限流退避中'
                            : '市场维护中')
                    : '已停止';
            UI.refs.state.className = `badge ${
                State.enabled && !State.pendingWrite ? 'ok' : 'warn'
            }`;
            UI.refs.character.textContent = `角色 ${State.characterId || '-'}`;
            UI.refs.enabled.checked = State.enabled;
            UI.refs['cowbell-enabled'].checked = State.cowbellEnabled;
            UI.refs.fab.classList.toggle('running', MarketKeeper.isRunning());
            if (UI.refs['cowbell-status']) {
                const status = State.itemStatus.get(COWBELL_BAG_ITEM_ID);
                const paused = State.pausedItems.get(COWBELL_BAG_ITEM_ID);
                const kindText = {
                    cowbell_invalid_book: '盘口或交易区间不完整',
                    cowbell_remove_at_ceiling: '左一已是 Max，正在撤买单',
                    cowbell_at_ceiling: '左一已是 Max，无需买单',
                    cowbell_buy_stable: '已在 Max 保持数量 1 的买单',
                    cowbell_replace_buy: '正在收束旧买单',
                    cowbell_listing_cap: '挂单槽位已满',
                    cowbell_insufficient_coins: '铜币不足',
                    cowbell_post_buy: '准备在 Max 挂买单',
                    cowbell_posting: '正在 Max 挂买单',
                    cowbell_buy_filled: '买单已成交，等待领取',
                    cowbell_untradable: '当前规则不可交易',
                    cancelling: '正在撤买单',
                    claiming: '正在领取牛铃包/退币',
                    read_error: '本轮读取失败',
                    paused: '已暂停',
                };
                const details = [
                    status?.leftOnePrice
                        ? `左一 ${formatInt(status.leftOnePrice)}`
                        : '',
                    status?.priceBandMax
                        ? `Max ${formatInt(status.priceBandMax)}`
                        : '',
                    status?.ownPrice
                        ? `我的 ${formatInt(status.ownPrice)}`
                        : '',
                ].filter(Boolean).join(' ｜ ');
                const message = !State.cowbellEnabled
                    ? '独立开关已关闭'
                    : !State.enabled
                        ? '已开启，等待总市场开关'
                        : paused || status?.reason ||
                            kindText[status?.kind] || '等待首次轮询';
                UI.refs['cowbell-status'].textContent = '牛铃买单：'
                    + message
                    + (State.cowbellEnabled && details
                        ? ` ｜ ${details}`
                        : '');
                UI.refs['cowbell-unpause'].hidden = Boolean(
                    !State.cowbellEnabled || !paused
                );
                UI.refs['cowbell-unpause'].disabled = Boolean(
                    State.pendingWrite?.itemId === COWBELL_BAG_ITEM_ID
                );
            }
            if (UI.refs.diagnostics) {
                let watchedInventory = 0;
                let watchedEquipped = 0;
                for (const itemId of State.watchlist) {
                    watchedInventory += getItemCount(itemId);
                    watchedEquipped += getEquippedItemCount(itemId);
                }
                const activeTargetListings = [...State.myListings.values()]
                    .filter((listing) => (
                        listing?.status === ACTIVE_STATUS &&
                        listing.isSell === true &&
                        Number(listing.enhancementLevel) === TARGET_LEVEL
                    ));
                const activeTargetQuantity = activeTargetListings.reduce(
                    (sum, listing) => (
                        sum + Number(listingRemaining(listing) || 0)
                    ),
                    0
                );
                const syncText = [
                    `库存${State.inventoryReady ? '✓' : '✗'}`,
                    `挂单${State.listingsReady ? '✓' : '✗'}`,
                    `规则${State.clientReady ? '✓' : '✗'}`,
                    `权限${State.accessReady ? '✓' : '✗'}`,
                ].join(' ');
                const focusItem = State.currentItemId;
                const pollText = focusItem
                    ? `正在检查：${getItemName(focusItem)}`
                    : State.lastPolledItemId
                        ? `上次检查：${getItemName(State.lastPolledItemId)} `
                            + new Date(State.lastPollAt).toLocaleTimeString(
                                'zh-CN',
                                {hour12: false}
                            )
                        : (State.enabled ? '等待首次轮询' : '维护尚未启用');
                UI.refs.diagnostics.textContent =
                    `同步 ${syncText}｜库存快照 `
                    + `${State.inventorySnapshotRows ?? '?'} 行，`
                    + `挂单快照 ${State.listingSnapshotRows ?? '?'} 行｜`
                    + `监控项仓库/当前装备 +20 `
                    + `${State.inventoryReady ? formatInt(watchedInventory) : '?'}/`
                    + `${State.inventoryReady ? formatInt(watchedEquipped) : '?'} 件｜`
                    + `本人活动 +20 卖单 `
                    + `${State.listingsReady ? activeTargetListings.length : '?'} 张/`
                    + `${State.listingsReady ? formatInt(activeTargetQuantity) : '?'} 件｜`
                    + pollText;
            }
            UI.renderItems();
        },

        appendLog(entry) {
            if (!UI.refs.logs) return;
            const line = document.createElement('div');
            line.className = `log ${entry.type}`;
            const time = document.createElement('span');
            time.className = 'time';
            time.textContent = entry.time.toLocaleTimeString(
                'zh-CN',
                {hour12: false}
            );
            const text = document.createElement('span');
            text.textContent = entry.message;
            line.append(time, text);
            UI.refs.logs.appendChild(line);
            while (UI.refs.logs.children.length > 400) {
                UI.refs.logs.firstElementChild?.remove();
            }
            UI.refs.logs.scrollTop = UI.refs.logs.scrollHeight;
        },
    };

    if (runtimeTestMode) {
        globalThis.__MWI_MARKET_KEEPER_RUNTIME_TEST_EXPORTS__ = {
            CONFIG,
            COWBELL_BAG_ITEM_ID,
            COWBELL_LEVEL,
            COIN_ITEM_ID,
            State,
            Network,
            MarketTransactions,
            MarketKeeper,
            UI,
            analyzeOrderBook,
            analyzeCowbellBuyBook,
            claimListing,
            createCowbellBuyPayload,
            createPostPayload,
            desiredListingPrice,
            getEquippedItemCount,
            getInventoryReserveNeeded,
            getOwnActiveBuyListings,
            getOfficialBinnedMarketPrice,
            getPreviousOfficialMarketPrice,
            getTradablePriceRange,
            initializationIssue,
            isItemMarketLocked,
            listingIdentityMatches,
            matchPostResult,
            maintainCowbellBuy,
            planCowbellBuyDecision,
            planMarketDecision,
            pendingWriteStatusText,
            postCowbellBuy,
            postInventory,
            replaceClientData,
            replaceInventory,
            replaceItemMarks,
            replaceMyListings,
            reconcilePersistedPendingWrite,
            restoreClientDataFromCache,
            updateCharacterItemSlot,
            updateInventoryItem,
        };
        return;
    }

    try {
        Network.install();
    } catch (error) {
        log(`网络监听安装失败：${error.message || String(error)}`, 'error');
    }
    UI.init().catch((error) => {
        console.error('[市场守价助手] 界面初始化失败:', error);
    });
    loadItemNames().catch(() => {});

    window.__MWI_MARKET_KEEPER__ = {
        version: VERSION,
        tick: () => MarketKeeper.tick(),
        openPanel: () => UI.setOpen(true),
        closePanel: () => UI.setOpen(false),
        getState: () => {
            const watchedInventory20 = Object.fromEntries(
                [...State.watchlist].map((itemId) => [
                    itemId,
                    State.inventoryReady
                        ? getItemCount(itemId)
                        : null,
                ])
            );
            const watchedActiveSellQuantity20 = Object.fromEntries(
                [...State.watchlist].map((itemId) => [
                    itemId,
                    State.listingsReady
                        ? getOwnActiveSellListings(itemId).reduce(
                            (sum, listing) => (
                                sum + Number(listingRemaining(listing) || 0)
                            ),
                            0
                        )
                        : null,
                ])
            );
            const watchedEquipped20 = Object.fromEntries(
                [...State.watchlist].map((itemId) => [
                    itemId,
                    State.inventoryReady
                        ? getEquippedItemCount(itemId)
                        : null,
                ])
            );
            return {
                connected: isOpenWebSocket(State.socket),
                characterId: State.characterId,
                enabled: State.enabled,
                cowbellEnabled: State.cowbellEnabled,
                ready: MarketKeeper.isReady(),
                initializationIssue: initializationIssue(),
                sync: {
                    profileLoaded: State.profileLoaded,
                    inventoryReady: State.inventoryReady,
                    listingsReady: State.listingsReady,
                    itemMarksReady: State.itemMarksReady,
                    clientReady: State.clientReady,
                    accessReady: State.accessReady,
                    inventorySnapshotRows: State.inventorySnapshotRows,
                    listingSnapshotRows: State.listingSnapshotRows,
                    itemMarkSnapshotRows: State.itemMarkSnapshotRows,
                },
                scheduler: {
                    busy: State.busy,
                    currentItemId: State.currentItemId,
                    lastPolledItemId: State.lastPolledItemId,
                    lastPollAt: State.lastPollAt,
                    lastCowbellPollAt: State.lastCowbellPollAt,
                    lastRequestAt: State.lastRequestAt,
                    idleScanStreak: State.idleScanStreak,
                },
                watchedInventory20,
                watchedEquipped20,
                watchedActiveSellQuantity20,
                networkCapture: {...Network.capturePaths},
                networkInstallWarnings: [...Network.installWarnings],
                watchlist: [...State.watchlist],
                busy: State.busy,
                pendingWrite: State.pendingWrite,
                pausedItems: Object.fromEntries(State.pausedItems),
                itemStatus: Object.fromEntries(State.itemStatus),
            };
        },
    };
})();
