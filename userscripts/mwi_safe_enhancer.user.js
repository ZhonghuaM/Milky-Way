// ==UserScript==
// @name         [银河奶牛] +20 队列强化助手（独立版）
// @namespace    local.milkyway.safe-enhancer
// @version      1.6.10
// @description  测试服多装备逐件 +20：只负责规划、持久续排和确认入队；市场由独立脚本维护
// @author       Codex / based on DelayNoMore and sunrishe concepts
// @match        https://test.milkywayidle.com/*
// @match        https://test.milkywayidlecn.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * Reimplemented from protocol and planning ideas in the MIT-licensed
 * DelayNoMore Dio Enhancer and sunrishe easy20 userscripts.
 *
 * Important semantics:
 * - This script only targets the two Milky Way Idle test hosts above.
 * - "Quick queue" confirms that actions entered the game queue. It does not
 *   claim that the resulting +20 items have already been produced.
 * - Every output has an isolated action segment. Segment N ends at +20 before
 *   segment N+1 is submitted.
 * - Every enhancement action embeds the frozen Enhancing loadout id when the
 *   action is created; the script never sends load_loadout between actions.
 * - The queue helper deliberately does not infer production from the final
 *   +20 inventory. Finished items may already be listed or sold by the
 *   independent market keeper.
 * - A quick-queue job resumes from its durable command prefix. An interrupted
 *   request without a unique action.id is reconciled against the full queue;
 *   if no candidate exists, that exact plan position is durably reauthorized
 *   and resent before any dependent later command.
 * - A timed-out request is never duplicated within the same observation
 *   window. After that window, or after a full refresh, the exact unresolved
 *   plan position is durably reauthorized and resent before its dependent
 *   suffix; previously acknowledged positions are never replayed.
 */

(function () {
    'use strict';

    const VERSION = '1.6.10';
    const RECOVERY_SESSION_ID = `${Date.now()}:${Math.random()}`;
    const RECOVERY_SCHEMA = 1;
    const ENHANCE_ACTION_HRID = '/actions/enhancing/enhance';
    const ENHANCING_ACTION_TYPE_HRID = '/action_types/enhancing';
    const INVENTORY_LOCATION_HRID = '/item_locations/inventory';
    const PHILOSOPHERS_MIRROR = 'philosophers_mirror';
    const ENHANCING_LOADOUT_NAME = 'Enhancing';
    const GRANDMASTER_ENHANCING_CHARM_HRID =
        '/items/grandmaster_enhancing_charm';
    const MARKET_ACTIVE_STATUS = '/market_listing_status/active';
    const MARKET_TERMINAL_STATUSES = new Set([
        '/market_listing_status/filled',
        '/market_listing_status/cancelled',
        '/market_listing_status/expired',
    ]);

    const CONFIG = Object.freeze({
        TARGET_LEVEL: 20,
        BASE_LOW: 9,
        BASE_HIGH: 10,
        PROTECTION_MIN_LEVEL: 2,

        MAX_COUNT_INPUT: 999,
        MAX_TOTAL_OUTPUTS: 200,
        MAX_ENHANCE_COMMANDS: 10000,
        MAX_PURCHASE_ITEMS: 20000,
        MAX_MIRROR_CONSUMPTION: 15000,
        LARGE_BATCH_COMMANDS: 1000,

        PURCHASE_TIMEOUT_MS: 20000,
        PURCHASE_PROJECTION_QUIET_MS: 180,
        QUEUE_ACK_TIMEOUT_MS: 12000,
        QUEUE_RECONCILE_GRACE_MS: 48000,
        QUEUE_SPACE_TIMEOUT_MS: 10 * 60 * 1000,
        QUEUE_SPACE_POLL_MS: 250,
        QUEUE_HEADROOM: 1,
        ACTION_TIMEOUT_MS: 60000,
        INVENTORY_COMMIT_GRACE_MS: 5000,
        OWNED_REMOVAL_GRACE_MS: 5000,
        OWNED_ORDER_SETTLE_MS: 250,
        ALLOWED_EXTERNAL_ERROR_GRACE_MS: 3000,
        EXTERNAL_UNATTRIBUTED_FENCE_MS: 15000,
        EXTERNAL_QUEUE_RESERVATION_MS: 60000,
        MARKET_READ_TIMEOUT_MS: 12000,
        MARKET_WRITE_TIMEOUT_MS: 15000,
        MARKET_POLL_MS: 5500,
        MARKET_QUOTE_CONFIRM_TTL_MS: 30000,
        MARKET_DEFAULT_MAX_DROP_PERCENT: 10,
        MARKET_MIN_DROP_PERCENT: 1,
        MARKET_MAX_DROP_PERCENT: 50,
        MARKET_RESERVED_INVENTORY: 1,
        MARKET_MAX_POST_QUANTITY: 10_000_000_000,
        MARKET_MAX_POST_PRICE: 100_000_000_000,
        MARKET_FINAL_SWEEP_MAX_ATTEMPTS: 3,

        QUICK_DELAY_MIN_MS: 1600,
        QUICK_DELAY_MAX_MS: 2200,
        VERIFIED_DELAY_MIN_MS: 60,
        VERIFIED_DELAY_MAX_MS: 160,
        PURCHASE_GAP_MIN_MS: 500,
        PURCHASE_GAP_MAX_MS: 900,
        ITEM_COOLDOWN_MS: 2500,

        NAME_CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
    });

    /*
     * Standalone equipment catalogue.
     *
     * The list intentionally excludes *_refined items because the game uses
     * different material semantics for refined equipment. Display names are
     * loaded from the current game's same-origin bundle when available; the
     * stable item id remains the fallback.
     */
    const TALISMAN_BELT_IDS = new Set([
        'small_talisman_belt', 'medium_talisman_belt', 'large_talisman_belt',
    ]);
    const EQUIPMENT_IDS = [
        "gobo_stabber", "gobo_slasher", "gobo_smasher", "spiked_bulwark", "werewolf_slasher", "griffin_bulwark", "gobo_shooter", "vampiric_bow",
        "cursed_bow", "gobo_boomstick", "cheese_bulwark", "verdant_bulwark", "azure_bulwark", "burble_bulwark", "crimson_bulwark", "rainbow_bulwark",
        "holy_bulwark", "wooden_bow", "birch_bow", "cedar_bow", "purpleheart_bow", "ginkgo_bow", "redwood_bow", "arcane_bow",
        "stalactite_spear", "granite_bludgeon", "furious_spear", "regal_sword", "chaotic_flail", "soul_hunter_crossbow", "sundering_crossbow", "frost_staff",
        "infernal_battlestaff", "jackalope_staff", "rippling_trident", "blooming_trident", "blazing_trident", "cheese_sword", "verdant_sword", "azure_sword",
        "burble_sword", "crimson_sword", "rainbow_sword", "holy_sword", "cheese_spear", "verdant_spear", "azure_spear", "burble_spear",
        "crimson_spear", "rainbow_spear", "holy_spear", "cheese_mace", "verdant_mace", "azure_mace", "burble_mace", "crimson_mace",
        "rainbow_mace", "holy_mace", "wooden_crossbow", "birch_crossbow", "cedar_crossbow", "purpleheart_crossbow", "ginkgo_crossbow", "redwood_crossbow",
        "arcane_crossbow", "wooden_water_staff", "birch_water_staff", "cedar_water_staff", "purpleheart_water_staff", "ginkgo_water_staff", "redwood_water_staff", "arcane_water_staff",
        "wooden_nature_staff", "birch_nature_staff", "cedar_nature_staff", "purpleheart_nature_staff", "ginkgo_nature_staff", "redwood_nature_staff", "arcane_nature_staff", "wooden_fire_staff",
        "birch_fire_staff", "cedar_fire_staff", "purpleheart_fire_staff", "ginkgo_fire_staff", "redwood_fire_staff", "arcane_fire_staff", "eye_watch", "snake_fang_dirk",
        "vision_shield", "gobo_defender", "vampire_fang_dirk", "knights_aegis", "treant_shield", "manticore_shield", "tome_of_healing", "tome_of_the_elements",
        "watchful_relic", "bishops_codex", "cheese_buckler", "verdant_buckler", "azure_buckler", "burble_buckler", "crimson_buckler", "rainbow_buckler",
        "holy_buckler", "wooden_shield", "birch_shield", "cedar_shield", "purpleheart_shield", "ginkgo_shield", "redwood_shield", "arcane_shield",
        "gatherer_cape", "artificer_cape", "culinary_cape", "chance_cape", "sinister_cape", "chimerical_quiver", "enchanted_cloak", "red_culinary_hat",
        "snail_shell_helmet", "vision_helmet", "fluffy_red_hat", "corsair_helmet", "acrobatic_hood", "magicians_hat", "cheese_helmet", "verdant_helmet",
        "azure_helmet", "burble_helmet", "crimson_helmet", "rainbow_helmet", "holy_helmet", "rough_hood", "reptile_hood", "gobo_hood",
        "beast_hood", "umbral_hood", "cotton_hat", "linen_hat", "bamboo_hat", "silk_hat", "radiant_hat", "dairyhands_top",
        "foragers_top", "lumberjacks_top", "cheesemakers_top", "crafters_top", "tailors_top", "chefs_top", "brewers_top", "alchemists_top",
        "enhancers_top", "gator_vest", "turtle_shell_body", "colossus_plate_body", "demonic_plate_body", "anchorbound_plate_body", "maelstrom_plate_body", "marine_tunic",
        "revenant_tunic", "griffin_tunic", "kraken_tunic", "icy_robe_top", "flaming_robe_top", "luna_robe_top", "royal_water_robe_top", "royal_nature_robe_top",
        "royal_fire_robe_top", "cheese_plate_body", "verdant_plate_body", "azure_plate_body", "burble_plate_body", "crimson_plate_body", "rainbow_plate_body", "holy_plate_body",
        "rough_tunic", "reptile_tunic", "gobo_tunic", "beast_tunic", "umbral_tunic", "cotton_robe_top", "linen_robe_top", "bamboo_robe_top",
        "silk_robe_top", "radiant_robe_top", "dairyhands_bottoms", "foragers_bottoms", "lumberjacks_bottoms", "cheesemakers_bottoms", "crafters_bottoms", "tailors_bottoms",
        "chefs_bottoms", "brewers_bottoms", "alchemists_bottoms", "enhancers_bottoms", "turtle_shell_legs", "colossus_plate_legs", "demonic_plate_legs", "anchorbound_plate_legs",
        "maelstrom_plate_legs", "marine_chaps", "revenant_chaps", "griffin_chaps", "kraken_chaps", "icy_robe_bottoms", "flaming_robe_bottoms", "luna_robe_bottoms",
        "royal_water_robe_bottoms", "royal_nature_robe_bottoms", "royal_fire_robe_bottoms", "cheese_plate_legs", "verdant_plate_legs", "azure_plate_legs", "burble_plate_legs", "crimson_plate_legs",
        "rainbow_plate_legs", "holy_plate_legs", "rough_chaps", "reptile_chaps", "gobo_chaps", "beast_chaps", "umbral_chaps", "cotton_robe_bottoms",
        "linen_robe_bottoms", "bamboo_robe_bottoms", "silk_robe_bottoms", "radiant_robe_bottoms", "enchanted_gloves", "pincer_gloves", "panda_gloves", "magnetic_gloves",
        "dodocamel_gauntlets", "sighted_bracers", "marksman_bracers", "chrono_gloves", "cheese_gauntlets", "verdant_gauntlets", "azure_gauntlets", "burble_gauntlets",
        "crimson_gauntlets", "rainbow_gauntlets", "holy_gauntlets", "rough_bracers", "reptile_bracers", "gobo_bracers", "beast_bracers", "umbral_bracers",
        "cotton_gloves", "linen_gloves", "bamboo_gloves", "silk_gloves", "radiant_gloves", "collectors_boots", "shoebill_shoes", "black_bear_shoes",
        "grizzly_bear_shoes", "polar_bear_shoes", "pathbreaker_boots", "centaur_boots", "pathfinder_boots", "sorcerer_boots", "pathseeker_boots", "cheese_boots",
        "verdant_boots", "azure_boots", "burble_boots", "crimson_boots", "rainbow_boots", "holy_boots", "rough_boots", "reptile_boots",
        "gobo_boots", "beast_boots", "umbral_boots", "cotton_boots", "linen_boots", "bamboo_boots", "silk_boots", "radiant_boots",
        "small_talisman_belt", "medium_talisman_belt", "large_talisman_belt",
        "small_pouch", "medium_pouch", "large_pouch", "giant_pouch", "gluttonous_pouch", "guzzling_pouch", "necklace_of_efficiency", "fighter_necklace",
        "ranger_necklace", "wizard_necklace", "necklace_of_wisdom", "necklace_of_speed", "philosophers_necklace", "earrings_of_gathering", "earrings_of_essence_find", "earrings_of_armor",
        "earrings_of_regeneration", "earrings_of_resistance", "earrings_of_rare_find", "earrings_of_critical_strike", "philosophers_earrings", "ring_of_gathering", "ring_of_essence_find", "ring_of_armor",
        "ring_of_regeneration", "ring_of_resistance", "ring_of_rare_find", "ring_of_critical_strike", "philosophers_ring", "trainee_milking_charm", "basic_milking_charm", "advanced_milking_charm",
        "expert_milking_charm", "master_milking_charm", "grandmaster_milking_charm", "trainee_foraging_charm", "basic_foraging_charm", "advanced_foraging_charm", "expert_foraging_charm", "master_foraging_charm",
        "grandmaster_foraging_charm", "trainee_woodcutting_charm", "basic_woodcutting_charm", "advanced_woodcutting_charm", "expert_woodcutting_charm", "master_woodcutting_charm", "grandmaster_woodcutting_charm", "trainee_cheesesmithing_charm",
        "basic_cheesesmithing_charm", "advanced_cheesesmithing_charm", "expert_cheesesmithing_charm", "master_cheesesmithing_charm", "grandmaster_cheesesmithing_charm", "trainee_crafting_charm", "basic_crafting_charm", "advanced_crafting_charm",
        "expert_crafting_charm", "master_crafting_charm", "grandmaster_crafting_charm", "trainee_tailoring_charm", "basic_tailoring_charm", "advanced_tailoring_charm", "expert_tailoring_charm", "master_tailoring_charm",
        "grandmaster_tailoring_charm", "trainee_cooking_charm", "basic_cooking_charm", "advanced_cooking_charm", "expert_cooking_charm", "master_cooking_charm", "grandmaster_cooking_charm", "trainee_brewing_charm",
        "basic_brewing_charm", "advanced_brewing_charm", "expert_brewing_charm", "master_brewing_charm", "grandmaster_brewing_charm", "trainee_alchemy_charm", "basic_alchemy_charm", "advanced_alchemy_charm",
        "expert_alchemy_charm", "master_alchemy_charm", "grandmaster_alchemy_charm", "trainee_enhancing_charm", "basic_enhancing_charm", "advanced_enhancing_charm", "expert_enhancing_charm", "master_enhancing_charm",
        "grandmaster_enhancing_charm", "trainee_stamina_charm", "basic_stamina_charm", "advanced_stamina_charm", "expert_stamina_charm", "master_stamina_charm", "grandmaster_stamina_charm", "trainee_intelligence_charm",
        "basic_intelligence_charm", "advanced_intelligence_charm", "expert_intelligence_charm", "master_intelligence_charm", "grandmaster_intelligence_charm", "trainee_attack_charm", "basic_attack_charm", "advanced_attack_charm",
        "expert_attack_charm", "master_attack_charm", "grandmaster_attack_charm", "trainee_defense_charm", "basic_defense_charm", "advanced_defense_charm", "expert_defense_charm", "master_defense_charm",
        "grandmaster_defense_charm", "trainee_melee_charm", "basic_melee_charm", "advanced_melee_charm", "expert_melee_charm", "master_melee_charm", "grandmaster_melee_charm", "trainee_ranged_charm",
        "basic_ranged_charm", "advanced_ranged_charm", "expert_ranged_charm", "master_ranged_charm", "grandmaster_ranged_charm", "trainee_magic_charm", "basic_magic_charm", "advanced_magic_charm",
        "expert_magic_charm", "master_magic_charm", "grandmaster_magic_charm", "basic_task_badge", "advanced_task_badge", "expert_task_badge", "celestial_brush", "cheese_brush",
        "verdant_brush", "azure_brush", "burble_brush", "crimson_brush", "rainbow_brush", "holy_brush", "celestial_shears", "cheese_shears",
        "verdant_shears", "azure_shears", "burble_shears", "crimson_shears", "rainbow_shears", "holy_shears", "celestial_hatchet", "cheese_hatchet",
        "verdant_hatchet", "azure_hatchet", "burble_hatchet", "crimson_hatchet", "rainbow_hatchet", "holy_hatchet", "celestial_hammer", "cheese_hammer",
        "verdant_hammer", "azure_hammer", "burble_hammer", "crimson_hammer", "rainbow_hammer", "holy_hammer", "celestial_chisel", "cheese_chisel",
        "verdant_chisel", "azure_chisel", "burble_chisel", "crimson_chisel", "rainbow_chisel", "holy_chisel", "celestial_needle", "cheese_needle",
        "verdant_needle", "azure_needle", "burble_needle", "crimson_needle", "rainbow_needle", "holy_needle", "celestial_spatula", "cheese_spatula",
        "verdant_spatula", "azure_spatula", "burble_spatula", "crimson_spatula", "rainbow_spatula", "holy_spatula", "celestial_pot", "cheese_pot",
        "verdant_pot", "azure_pot", "burble_pot", "crimson_pot", "rainbow_pot", "holy_pot", "celestial_alembic", "cheese_alembic",
        "verdant_alembic", "azure_alembic", "burble_alembic", "crimson_alembic", "rainbow_alembic", "holy_alembic", "celestial_enhancer", "cheese_enhancer",
        "verdant_enhancer", "azure_enhancer", "burble_enhancer", "crimson_enhancer", "rainbow_enhancer", "holy_enhancer"
    ];

    const Planner = (() => {
        function toInventoryArray(input) {
            const result = new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
            if (!input) return result;
            for (let level = 0; level <= CONFIG.TARGET_LEVEL; level++) {
                const raw = Array.isArray(input) ? input[level] : input[level] ?? input[String(level)];
                const count = Number(raw || 0);
                result[level] = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
            }
            return result;
        }

        /*
         * Compatibility helper for simple sequences. The production planner
         * below uses an explicit token DAG, which is optimal even when mixed
         * higher-level inventory is present.
         */
        function compressSources(rawSources) {
            const result = [];
            for (const sourceLevel of rawSources) {
                let extended = false;
                for (let index = result.length - 1; index >= 0; index--) {
                    if (result[index].targetLevel === sourceLevel) {
                        result[index].targetLevel = sourceLevel + 1;
                        extended = true;
                        break;
                    }
                }
                if (extended) continue;

                let insertAt = 0;
                while (
                    insertAt < result.length &&
                    result[insertAt].startLevel >= sourceLevel
                ) {
                    insertAt++;
                }
                result.splice(insertAt, 0, {
                    startLevel: sourceLevel,
                    targetLevel: sourceLevel + 1,
                });
            }
            return result;
        }

        /*
         * Build a token DAG bottom-up.
         *
         * A crafted +(L-1) token is preferred as the primary material for a
         * +L craft. Each such edge joins two one-level operations into one
         * continuous command. Secondary subtrees are emitted before the
         * primary chain that consumes them.
         */
        function buildOptimalActions(craftCounts, stockTokenCounts) {
            const craftedPools = Array.from(
                {length: CONFIG.TARGET_LEVEL + 1},
                () => ({items: [], cursor: 0})
            );
            const stockPools = [...stockTokenCounts];
            const nodes = [];
            let nodeSequence = 0;

            function takeToken(level, preferCrafted) {
                const crafted = craftedPools[level];
                if (
                    preferCrafted &&
                    crafted.cursor < crafted.items.length
                ) {
                    return {node: crafted.items[crafted.cursor++]};
                }
                if (crafted.cursor < crafted.items.length) {
                    return {node: crafted.items[crafted.cursor++]};
                }
                if (stockPools[level] > 0) {
                    stockPools[level]--;
                    return {node: null};
                }
                throw new Error(`规划内部错误：缺少 +${level} token`);
            }

            for (
                let level = CONFIG.BASE_LOW + 2;
                level <= CONFIG.TARGET_LEVEL;
                level++
            ) {
                const count = craftCounts[level] || 0;
                for (let index = 0; index < count; index++) {
                    const primary = takeToken(level - 1, true);
                    const secondary = takeToken(level - 2, false);
                    const node = {
                        id: ++nodeSequence,
                        level,
                        primaryNode: primary.node,
                        secondaryNode: secondary.node,
                    };
                    nodes.push(node);
                    craftedPools[level].items.push(node);
                }
            }

            const targetPool = craftedPools[CONFIG.TARGET_LEVEL];
            const roots = targetPool.items.slice(targetPool.cursor);
            for (
                let level = CONFIG.BASE_LOW;
                level < CONFIG.TARGET_LEVEL;
                level++
            ) {
                const pool = craftedPools[level];
                if (
                    pool.cursor !== pool.items.length ||
                    stockPools[level] > 0
                ) {
                    throw new Error(`规划内部错误：+${level} 存在未分配 token`);
                }
            }
            const emitted = new Set();
            const compressedActions = [];

            function emitPrimaryChain(topNode, outputIndex) {
                if (!topNode || emitted.has(topNode.id)) return;

                const chainTopDown = [];
                let cursor = topNode;
                while (cursor && !emitted.has(cursor.id)) {
                    chainTopDown.push(cursor);
                    cursor = cursor.primaryNode;
                }
                const chainBottomUp = chainTopDown.reverse();

                for (const chainNode of chainBottomUp) {
                    if (chainNode.secondaryNode) {
                        emitPrimaryChain(
                            chainNode.secondaryNode,
                            outputIndex
                        );
                    }
                }

                compressedActions.push({
                    startLevel: chainBottomUp[0].level - 1,
                    targetLevel: chainBottomUp[chainBottomUp.length - 1].level,
                    outputIndex,
                });
                for (const chainNode of chainBottomUp) {
                    emitted.add(chainNode.id);
                }
            }

            // Keep global material optimization, but emit each target root as
            // one closed segment. Replanning targetCount times would be less
            // efficient for some mixed higher-level inventories.
            const compressedOutputSegments = [];
            roots.forEach((root, outputIndex) => {
                const groupStart = compressedActions.length;
                emitPrimaryChain(root, outputIndex);
                const segment = compressedActions.slice(groupStart);
                const lastAction = segment[segment.length - 1];
                if (
                    segment.length < 1 ||
                    lastAction?.outputIndex !== outputIndex ||
                    lastAction.targetLevel !== CONFIG.TARGET_LEVEL ||
                    segment.slice(0, -1).some(
                        (action) => (
                            action.targetLevel === CONFIG.TARGET_LEVEL
                        )
                    )
                ) {
                    throw new Error(
                        `规划内部错误：第 ${outputIndex + 1} 件未独立收束到 +20`
                    );
                }
                compressedOutputSegments.push(segment);
            });

            if (emitted.size !== nodes.length) {
                throw new Error('规划内部错误：存在未输出的合成节点');
            }

            const rawOutputSegments = compressedOutputSegments.map(
                (segment, outputIndex) => {
                    const rawSegment = [];
                    for (const action of segment) {
                        for (
                            let startLevel = action.startLevel;
                            startLevel < action.targetLevel;
                            startLevel++
                        ) {
                            rawSegment.push({
                                startLevel,
                                targetLevel: startLevel + 1,
                                outputIndex,
                            });
                        }
                    }
                    const lastAction =
                        rawSegment[rawSegment.length - 1];
                    if (
                        rawSegment.length < 1 ||
                        lastAction?.targetLevel !==
                            CONFIG.TARGET_LEVEL ||
                        rawSegment.slice(0, -1).some(
                            (action) => (
                                action.targetLevel ===
                                CONFIG.TARGET_LEVEL
                            )
                        )
                    ) {
                        throw new Error(
                            `规划内部错误：第 ${outputIndex + 1} 件单步计划未独立收束到 +20`
                        );
                    }
                    return rawSegment;
                }
            );
            const rawActions = rawOutputSegments.flat();
            const compressedActionsPerOutput =
                compressedOutputSegments.map(
                    (segment) => segment.length
                );
            const rawActionsPerOutput = rawOutputSegments.map(
                (segment) => segment.length
            );

            const linkCount = craftCounts
                .slice(CONFIG.BASE_LOW + 2, CONFIG.TARGET_LEVEL)
                .reduce((sum, count, offset) => {
                    const level = CONFIG.BASE_LOW + 2 + offset;
                    return sum + Math.min(
                        count || 0,
                        craftCounts[level + 1] || 0
                    );
                }, 0);

            if (compressedActions.length !== nodes.length - linkCount) {
                throw new Error('规划内部错误：压缩指令数未达到理论最小值');
            }
            if (rawActions.length !== nodes.length) {
                throw new Error('规划内部错误：原始动作数不一致');
            }

            return {
                rawActions,
                compressedActions,
                rawOutputSegments,
                compressedOutputSegments,
                rawActionsPerOutput,
                compressedActionsPerOutput,
                linkCount,
            };
        }

        function planTo20(currentInventory, targetCount, useExistingInventory = true) {
            if (!Number.isInteger(targetCount) || targetCount < 1) {
                throw new Error('目标数量必须是大于 0 的整数');
            }

            const sourceInventory = toInventoryArray(currentInventory);
            const usableInventory = useExistingInventory
                ? [...sourceInventory]
                : new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
            // targetCount means "produce this many new +20".
            usableInventory[CONFIG.TARGET_LEVEL] = 0;

            const demand = new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
            const craftCounts = new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
            const consumedExisting = new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
            const purchases = {
                [CONFIG.BASE_LOW]: 0,
                [CONFIG.BASE_HIGH]: 0,
            };

            demand[CONFIG.TARGET_LEVEL] = targetCount;
            for (
                let level = CONFIG.TARGET_LEVEL;
                level >= CONFIG.BASE_LOW + 2;
                level--
            ) {
                const used = Math.min(
                    demand[level],
                    usableInventory[level] || 0
                );
                consumedExisting[level] = used;
                craftCounts[level] = demand[level] - used;
                demand[level - 1] += craftCounts[level];
                demand[level - 2] += craftCounts[level];
            }

            for (const level of [CONFIG.BASE_LOW, CONFIG.BASE_HIGH]) {
                const used = Math.min(
                    demand[level],
                    usableInventory[level] || 0
                );
                consumedExisting[level] = used;
                purchases[level] = demand[level] - used;
            }

            const stockTokens = new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
            for (let level = CONFIG.BASE_LOW; level < CONFIG.TARGET_LEVEL; level++) {
                stockTokens[level] = consumedExisting[level];
            }
            stockTokens[CONFIG.BASE_LOW] += purchases[CONFIG.BASE_LOW];
            stockTokens[CONFIG.BASE_HIGH] += purchases[CONFIG.BASE_HIGH];

            const actionPlan = buildOptimalActions(craftCounts, stockTokens);
            if (
                actionPlan.compressedActionsPerOutput.length !== targetCount ||
                actionPlan.rawActionsPerOutput.length !== targetCount
            ) {
                throw new Error('规划内部错误：逐件动作组数量与目标数量不一致');
            }
            const remainingInventory = sourceInventory.map(
                (count, level) => Math.max(0, count - consumedExisting[level])
            );

            return {
                targetCount,
                purchases,
                purchaseItemCount:
                    purchases[CONFIG.BASE_LOW] + purchases[CONFIG.BASE_HIGH],
                mirrorCount: actionPlan.rawActions.length,
                rawActions: actionPlan.rawActions,
                compressedActions: actionPlan.compressedActions,
                rawOutputSegments: actionPlan.rawOutputSegments,
                compressedOutputSegments:
                    actionPlan.compressedOutputSegments,
                rawActionsPerOutput: actionPlan.rawActionsPerOutput,
                compressedActionsPerOutput:
                    actionPlan.compressedActionsPerOutput,
                linkCount: actionPlan.linkCount,
                demand,
                craftCounts,
                consumedExisting,
                remainingInventory,
            };
        }

        function summarize(itemPlans, mode) {
            const summary = {
                itemTypes: itemPlans.length,
                outputs: 0,
                purchaseLow: 0,
                purchaseHigh: 0,
                purchaseItems: 0,
                mirrorCount: 0,
                sendCommands: 0,
                consumedExisting:
                    new Array(CONFIG.TARGET_LEVEL + 1).fill(0),
            };

            for (const entry of itemPlans) {
                const plan = entry.plan;
                summary.outputs += plan.targetCount;
                summary.purchaseLow += plan.purchases[CONFIG.BASE_LOW];
                summary.purchaseHigh += plan.purchases[CONFIG.BASE_HIGH];
                summary.purchaseItems += plan.purchaseItemCount;
                summary.mirrorCount += plan.mirrorCount;
                summary.sendCommands += mode === 'verified'
                    ? plan.rawActions.length
                    : plan.compressedActions.length;
                for (
                    let level = CONFIG.BASE_LOW;
                    level < CONFIG.TARGET_LEVEL;
                    level++
                ) {
                    summary.consumedExisting[level] +=
                        plan.consumedExisting[level] || 0;
                }
            }
            return summary;
        }

        function validateSummary(summary) {
            if (summary.outputs > CONFIG.MAX_TOTAL_OUTPUTS) {
                throw new Error(
                    `本批次要新增 ${summary.outputs} 件 +20，超过安全上限 ${CONFIG.MAX_TOTAL_OUTPUTS}`
                );
            }
            if (summary.sendCommands > CONFIG.MAX_ENHANCE_COMMANDS) {
                throw new Error(
                    `预计发送 ${summary.sendCommands} 条强化指令，超过安全上限 ${CONFIG.MAX_ENHANCE_COMMANDS}`
                );
            }
            if (summary.purchaseItems > CONFIG.MAX_PURCHASE_ITEMS) {
                throw new Error(
                    `预计采购 ${summary.purchaseItems} 件基底，超过安全上限 ${CONFIG.MAX_PURCHASE_ITEMS}`
                );
            }
            if (summary.mirrorCount > CONFIG.MAX_MIRROR_CONSUMPTION) {
                throw new Error(
                    `预计消耗 ${summary.mirrorCount} 面贤者镜，`
                    + `超过安全上限 ${CONFIG.MAX_MIRROR_CONSUMPTION}`
                );
            }
        }

        return {
            toInventoryArray,
            compressSources,
            buildOptimalActions,
            planTo20,
            summarize,
            validateSummary,
        };
    })();

    // Test exports are only available outside the browser page realm. In a
    // real @grant none userscript, window === globalThis, so another page
    // script cannot activate either early-return path.
    const externalTestRealm =
        typeof window === 'undefined' || window !== globalThis;
    const plannerTestMode = externalTestRealm && Boolean(
        globalThis.__MWI_SAFE_ENHANCER_TEST_MODE__
    );
    const runtimeTestMode = externalTestRealm && Boolean(
        globalThis.__MWI_SAFE_ENHANCER_RUNTIME_TEST_MODE__
    );

    if (plannerTestMode) {
        globalThis.__MWI_SAFE_ENHANCER_TEST_EXPORTS__ = {
            CONFIG,
            Planner,
            EQUIPMENT_IDS,
        };
        return;
    }

    const allowedHosts = new Set([
        'test.milkywayidle.com',
        'test.milkywayidlecn.com',
    ]);
    if (!runtimeTestMode && !allowedHosts.has(window.location.hostname)) return;
    if (window.__MWI_SAFE_ENHANCER_LOADED__) return;
    window.__MWI_SAFE_ENHANCER_LOADED__ = VERSION;

    const STORAGE_KEYS = Object.freeze({
        SETTINGS: 'MWI_SAFE_ENHANCER_SETTINGS_V1',
        SELECTION: 'MWI_SAFE_ENHANCER_SELECTION_V1',
        PRESETS: 'MWI_SAFE_ENHANCER_PRESETS_V1',
        NAME_CACHE: 'MWI_SAFE_ENHANCER_NAMES_V1',
        RECOVERY: 'MWI_SAFE_ENHANCER_RECOVERY_V1',
        RECOVERY_ARCHIVE: 'MWI_SAFE_ENHANCER_RECOVERY_ARCHIVE_V1',
    });

    /*
     * The queue helper and the independent market keeper share only this
     * cooperative request lane. Milky Way Idle error packets do not carry a
     * request id, so two automation writes must not be outstanding at once.
     * The first installed script creates the coordinator; the other reuses it.
     */
    const SHARED_COORDINATOR_KEY = Symbol.for(
        'MWI_SHARED_AUTOMATION_COORDINATOR_V1'
    );

    function getSharedAutomationCoordinator() {
        const existing = window[SHARED_COORDINATOR_KEY];
        if (
            existing &&
            existing.schema === 1 &&
            typeof existing.acquire === 'function' &&
            typeof existing.publishSocket === 'function'
        ) {
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
                        // A subscriber cannot break the shared socket path.
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

    const EQUIPMENT_ID_SET = new Set(EQUIPMENT_IDS);

    function readJsonStorage(key, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
            console.warn('[安全强化助手] 读取本地设置失败:', error);
            return fallback;
        }
    }

    function writeJsonStorage(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn('[安全强化助手] 保存本地设置失败:', error);
        }
    }

    function writeJsonStorageCritical(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            throw new BatchError(
                `无法写入本地任务账本：${error.message || error}。`
                + '本次不会发送服务器请求',
                'RECOVERY_STORAGE_FAILED'
            );
        }
    }

    function removeJsonStorageCritical(key) {
        try {
            if (
                typeof window.localStorage.removeItem ===
                    'function'
            ) {
                window.localStorage.removeItem(key);
            } else {
                window.localStorage.setItem(key, '');
            }
        } catch (error) {
            throw new BatchError(
                `无法清除本地任务账本：${error.message || error}`,
                'RECOVERY_STORAGE_FAILED'
            );
        }
    }

    function normalizeShortItemId(itemHrid) {
        if (typeof itemHrid !== 'string') return '';
        return itemHrid.split('/').filter(Boolean).pop() || '';
    }

    function fullItemHrid(itemId) {
        return `/items/${normalizeShortItemId(itemId)}`;
    }

    function normalizeCharacterId(value) {
        if (value == null || !/^\d+$/.test(String(value))) return '';
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) && numeric > 0
            ? String(numeric)
            : '';
    }

    function getCharacterId() {
        const raw = new URLSearchParams(
            window.location.search
        ).get('characterId');
        return normalizeCharacterId(raw);
    }

    function buildItemHash(characterId, itemId, level) {
        return `${characterId}::${INVENTORY_LOCATION_HRID}::${fullItemHrid(itemId)}::${level}`;
    }

    function safeJsonParse(raw) {
        if (typeof raw !== 'string') return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
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

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    const integerFormatter = new Intl.NumberFormat('zh-CN');

    function formatInt(value) {
        return integerFormatter.format(Number(value) || 0);
    }

    function formatDuration(milliseconds) {
        const seconds = Math.max(0, Math.round(milliseconds / 1000));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = seconds % 60;
        if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
        if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
        return `${remainingSeconds}s`;
    }

    function parsePositiveInteger(value, label, maxValue) {
        const text = String(value ?? '').trim();
        if (!/^[1-9]\d*$/.test(text)) {
            throw new Error(`${label}必须是大于 0 的整数`);
        }
        const parsed = Number(text);
        if (!Number.isSafeInteger(parsed)) {
            throw new Error(`${label}数值过大`);
        }
        if (parsed > maxValue) {
            throw new Error(`${label}不能超过 ${maxValue}`);
        }
        return parsed;
    }

    const WorkSignals = {
        listeners: new Set(),
        scheduled: false,

        notify() {
            if (this.scheduled) return;
            this.scheduled = true;
            Promise.resolve().then(() => {
                this.scheduled = false;
                // Apply complete incoming state and exact ACKs first. These
                // quiet-window checks are also allowed to finish on a network
                // event when Chrome has delayed their fallback timers.
                try {
                    Transactions.checkProjectedPurchase(State.pendingOp);
                    checkOwnedActionOrderDue(State.run);
                } catch (error) {
                    Network.failClosedForIncomingObservation(
                        `后台状态核对失败：${error.message || String(error)}`
                    );
                }
                for (const listener of [...this.listeners]) listener();
            });
        },

        wait(milliseconds, run = null, deadlineOnly = false) {
            const dueAt = Date.now() + Math.max(0, Number(milliseconds) || 0);
            return new Promise((resolve) => {
                let timer = null;
                let finished = false;
                const finish = (continued) => {
                    if (finished) return;
                    finished = true;
                    if (timer != null) window.clearTimeout(timer);
                    this.listeners.delete(onSignal);
                    resolve(continued);
                };
                const check = (signal) => {
                    if (run?.stopRequested) finish(false);
                    else if (Date.now() >= dueAt || (signal && !deadlineOnly)) finish(true);
                    return finished;
                };
                const onSignal = () => check(true);
                const onTimer = () => {
                    timer = null;
                    if (!check(false)) {
                        timer = window.setTimeout(onTimer, Math.max(1, dueAt - Date.now()));
                    }
                };
                this.listeners.add(onSignal);
                if (!check(false)) {
                    timer = window.setTimeout(onTimer, Math.max(1, dueAt - Date.now()));
                }
            });
        },
    };

    function sleepFor(milliseconds, run = null) {
        // One deadline, not a chain of 100ms polls. Network wakeups may finish
        // an overdue sleep but can never shorten the requested pacing delay.
        return WorkSignals.wait(milliseconds, run, true);
    }

    function sleepRandom(min, max, run = null) {
        return sleepFor(randomInt(min, max), run);
    }

    function waitForDocumentBody() {
        if (document.body) return Promise.resolve(document.body);
        return new Promise((resolve) => {
            const observer = new MutationObserver(() => {
                if (!document.body) return;
                observer.disconnect();
                resolve(document.body);
            });
            // At document-start, documentElement itself may not exist yet.
            observer.observe(document, {
                childList: true,
                subtree: true,
            });
        });
    }

    const rawSavedSettings = readJsonStorage(STORAGE_KEYS.SETTINGS, {});
    const savedSettings = (
        rawSavedSettings &&
        typeof rawSavedSettings === 'object' &&
        !Array.isArray(rawSavedSettings)
    ) ? rawSavedSettings : {};
    const savedSelection = readJsonStorage(STORAGE_KEYS.SELECTION, []);

    const State = {
        socket: null,
        connectionEpoch: 0,
        syncEpoch: 0,
        incomingSequence: 0,
        attachedSockets: new WeakSet(),
        inventoryReady: false,
        queueReady: false,
        loadoutsReady: false,
        characterItemsReady: false,
        inventory: new Map(),
        actions: new Map(),
        loadouts: new Map(),
        characterItemSlots: new Map(),
        inventoryRevision: 0,
        equipmentInventoryRevision: 0,
        queueRevision: 0,
        loadoutRevision: 0,
        pendingEnhancingLoadoutSaves: 0,
        pendingEnhancingLoadoutSaveChecks: [],
        characterItemsRevision: 0,
        outgoingQueueMutationRevision: 0,
        pendingExternalQueueAdds: [],
        recentAllowedExternalRequest: null,
        externalErrorFenceUntil: 0,
        actionQueueCap: null,
        characterId: getCharacterId(),
        lastInitAt: 0,

        myMarketListingsReady: false,
        myMarketListings: new Map(),
        clientMarketDataReady: false,
        clientMarketDataSource: '',
        clientMarketDataVersionMs: null,
        clientMarketDataCacheStatus: 'not_checked',
        clientMarketDataCacheDetail: '',
        itemMarketDetails: new Map(),
        gameModeMarketRestrictions: new Map(),
        characterGameMode: '',
        characterMarketAccessReady: false,
        hasAcceptedTradingRules: false,
        tradingRulesKnown: false,
        marketListingCap: null,
        marketOrderBooks: new Map(),
        marketOrderBookSequence: 0,
        marketLastOrderBookRequestAt: new Map(),
        marketOutstandingOrderBookReads: new Map(),
        marketExternalOrderBookGeneration: new Map(),
        marketRevision: 0,
        marketOp: null,
        nextMarketOpId: 0,
        marketBusy: false,
        marketTimer: null,
        marketRoundRobinIndex: 0,
        marketWriteBlockedReason: '',
        marketItemStatus: new Map(),
        marketListingPriceAnchors: new Map(),
        marketItemPriceAnchors: new Map(),
        marketAutomationListingIds: new Map(),

        pendingOp: null,
        nextOpId: 0,
        nextRunId: 0,
        ownedSendDepth: 0,
        blockedReason: '',
        starting: false,
        endingOldBatch: false,
        run: null,
        recoveryJournal: null,

        names: new Map(),
        namesRevision: 0,
        selectionRevision: 0,
        selected: new Set(
            Array.isArray(savedSelection)
                ? savedSelection.filter((itemId) => EQUIPMENT_ID_SET.has(itemId))
                : []
        ),
        settings: {
            // v1.6 is intentionally queue-only. Production and marketplace
            // state are outside this script's completion boundary.
            mode: 'quick',
            useExistingInventory: savedSettings.useExistingInventory !== false,
            targetCount: Number.isInteger(savedSettings.targetCount)
                ? Math.min(
                    Math.max(savedSettings.targetCount, 1),
                    CONFIG.MAX_COUNT_INPUT
                )
                : 1,
            marketMaintenanceEnabled: false,
            marketAutoSellExcessEnabled: false,
            marketMaxDropPercent: (
                Number.isFinite(Number(savedSettings.marketMaxDropPercent))
                    ? Math.min(
                        Math.max(
                            Number(savedSettings.marketMaxDropPercent),
                            CONFIG.MARKET_MIN_DROP_PERCENT
                        ),
                        CONFIG.MARKET_MAX_DROP_PERCENT
                    )
                    : CONFIG.MARKET_DEFAULT_MAX_DROP_PERCENT
            ),
        },
        presets: [],
        logs: [],
        ui: null,
        renderScheduled: false,
    };

    function saveSettings() {
        writeJsonStorage(STORAGE_KEYS.SETTINGS, State.settings);
    }

    function saveSelection() {
        State.selectionRevision++;
        writeJsonStorage(STORAGE_KEYS.SELECTION, [...State.selected]);
    }

    function loadPresets() {
        const raw = readJsonStorage(STORAGE_KEYS.PRESETS, []);
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((preset) => preset && typeof preset.name === 'string')
            .map((preset) => ({
                name: preset.name.slice(0, 40),
                items: Array.isArray(preset.items)
                    ? [...new Set(
                        preset.items.filter((itemId) => EQUIPMENT_ID_SET.has(itemId))
                    )]
                    : [],
            }))
            .filter((preset) => preset.items.length > 0);
    }
    State.presets = loadPresets();

    function savePresets() {
        writeJsonStorage(STORAGE_KEYS.PRESETS, State.presets);
    }

    function getItemCounts(itemId) {
        const counts = State.inventory.get(normalizeShortItemId(itemId));
        return counts ? [...counts] : new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
    }

    function getItemCount(itemId, level = 0) {
        return getItemCounts(itemId)[level] || 0;
    }

    function messageUpdatesInventoryItem(message, itemId, level) {
        const expectedItemHrid = fullItemHrid(itemId);
        return [
            message?.characterItems,
            message?.endCharacterItems,
            message?.updatedCharacterItems,
        ].some(
            (items) => Array.isArray(items) && items.some(
                (item) => (
                    item?.itemLocationHrid ===
                        INVENTORY_LOCATION_HRID &&
                    item?.itemHrid === expectedItemHrid &&
                    Number(item?.enhancementLevel || 0) ===
                        Number(level)
                )
            )
        );
    }

    function getRunAdjustedOutputCount(
        run,
        itemId,
        level = CONFIG.TARGET_LEVEL
    ) {
        const offset = Number(level) === CONFIG.TARGET_LEVEL
            ? Number(run?.marketInventoryOffsets?.get(itemId) || 0)
            : 0;
        return getItemCount(itemId, level) - offset;
    }

    function adjustRunMarketInventoryOffset(run, itemId, delta) {
        if (!run?.marketInventoryOffsets || !Number.isFinite(delta)) {
            return;
        }
        const next = Number(
            run.marketInventoryOffsets.get(itemId) || 0
        ) + delta;
        if (next === 0) run.marketInventoryOffsets.delete(itemId);
        else run.marketInventoryOffsets.set(itemId, next);
        if (run.recoveryJournal) {
            run.recoveryJournal.marketInventoryOffsets =
                Object.fromEntries(
                    run.marketInventoryOffsets.entries()
                );
            try {
                saveRecoveryJournalCritical(
                    run.recoveryJournal
                );
            } catch (error) {
                run.stopRequested = true;
                State.blockedReason = State.blockedReason ||
                    '市场库存校正量无法写入持久任务账本';
                throw new BatchError(
                    '市场动作已确认，但库存校正量无法写入持久'
                    + `任务账本：${error.message || String(error)}`,
                    'UNKNOWN'
                );
            }
        }
    }

    function prettifyItemId(itemId) {
        return String(itemId)
            .split('_')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function getItemName(itemId) {
        return State.names.get(itemId) || prettifyItemId(itemId);
    }

    function getEnhancingActions() {
        return [...State.actions.values()].filter(
            (action) => action?.actionHrid === ENHANCE_ACTION_HRID && !action.isDone
        );
    }

    function parseItemHash(itemHash) {
        if (typeof itemHash !== 'string' || itemHash.length === 0) return null;
        const parts = itemHash.split('::');
        if (parts.length !== 4) return null;
        const characterId = normalizeCharacterId(parts[0]);
        const itemLocationHrid = parts[1];
        const itemHrid = parts[2];
        const enhancementLevel = Number(parts[3]);
        if (
            !characterId ||
            !/^\/item_locations\/[a-z0-9_]+$/.test(itemLocationHrid) ||
            !/^\/items\/[a-z0-9_]+$/.test(itemHrid) ||
            !Number.isSafeInteger(enhancementLevel) ||
            enhancementLevel < 0
        ) {
            return null;
        }
        return {
            characterId,
            itemLocationHrid,
            itemHrid,
            enhancementLevel,
        };
    }

    function parseWearableItemHrid(wearableHash) {
        return parseItemHash(wearableHash)?.itemHrid || '';
    }

    function normalizeCharacterItem(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return null;
        }
        const itemLocationHrid = item.itemLocationHrid;
        const itemHrid = item.itemHrid;
        const enhancementLevel = Number(item.enhancementLevel || 0);
        const count = Number(item.count || 0);
        if (
            !/^\/item_locations\/[a-z0-9_]+$/.test(itemLocationHrid) ||
            !/^\/items\/[a-z0-9_]+$/.test(itemHrid) ||
            !Number.isSafeInteger(enhancementLevel) ||
            enhancementLevel < 0 ||
            !Number.isFinite(count) ||
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

    function getOwnedCharacterItemCount(itemHrid, enhancementLevel = null) {
        let total = 0;
        for (const item of State.characterItemSlots.values()) {
            if (
                item.itemHrid === itemHrid &&
                (
                    enhancementLevel == null ||
                    item.enhancementLevel === enhancementLevel
                )
            ) {
                total += item.count;
            }
        }
        return total;
    }

    function normalizeLoadoutId(value) {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) && numeric > 0
            ? numeric
            : null;
    }

    function buildLoadoutFingerprint(loadout) {
        const wearableMap = (
            loadout?.wearableMap &&
            typeof loadout.wearableMap === 'object' &&
            !Array.isArray(loadout.wearableMap)
        )
            ? Object.entries(loadout.wearableMap)
                .sort(([left], [right]) => left.localeCompare(right))
            : [];
        const abilityMap = (
            loadout?.abilityMap &&
            typeof loadout.abilityMap === 'object' &&
            !Array.isArray(loadout.abilityMap)
        )
            ? Object.entries(loadout.abilityMap)
                .sort(([left], [right]) => left.localeCompare(right))
            : [];

        return JSON.stringify({
            id: normalizeLoadoutId(loadout?.id),
            characterId: normalizeCharacterId(
                loadout?.characterID ?? loadout?.characterId
            ),
            name: String(loadout?.name || ''),
            actionTypeHrid: String(loadout?.actionTypeHrid || ''),
            isDefault: Boolean(loadout?.isDefault),
            suppressValidation: Boolean(loadout?.suppressValidation),
            useExactEnhancement: Boolean(loadout?.useExactEnhancement),
            wearableMap,
            abilityMap,
            foodItemHrids: Array.isArray(loadout?.foodItemHrids)
                ? [...loadout.foodItemHrids]
                : [],
            drinkItemHrids: Array.isArray(loadout?.drinkItemHrids)
                ? [...loadout.drinkItemHrids]
                : [],
        });
    }

    function getEnhancingLoadoutBinding() {
        if (State.pendingEnhancingLoadoutSaves > 0) {
            throw new BatchError(
                '正在等待游戏确认保存 Enhancing 配装，请稍候',
                'LOADOUT_SAVE_PENDING'
            );
        }
        if (!State.loadoutsReady || !State.characterItemsReady) {
            throw new BatchError(
                '尚未收到完整的游戏配装或角色物品数据',
                'STATE_NOT_READY'
            );
        }

        const matches = [...State.loadouts.values()].filter(
            (loadout) => (
                String(loadout?.name || '') ===
                ENHANCING_LOADOUT_NAME
            )
        );
        if (matches.length !== 1) {
            throw new BatchError(
                matches.length === 0
                    ? `找不到名为“${ENHANCING_LOADOUT_NAME}”的游戏配装`
                    : `发现 ${matches.length} 个同名“`
                        + `${ENHANCING_LOADOUT_NAME}”配装，请只保留一个`,
                'INVALID_LOADOUT'
            );
        }

        const loadout = matches[0];
        const id = normalizeLoadoutId(loadout.id);
        if (id == null) {
            throw new BatchError(
                `“${ENHANCING_LOADOUT_NAME}”配装缺少有效 ID`,
                'INVALID_LOADOUT'
            );
        }
        const loadoutCharacterId = normalizeCharacterId(
            loadout.characterID ?? loadout.characterId
        );
        if (!loadoutCharacterId || loadoutCharacterId !== State.characterId) {
            throw new BatchError(
                loadoutCharacterId
                    ? `“${ENHANCING_LOADOUT_NAME}”配装属于角色 `
                        + `${loadoutCharacterId}，当前角色是 ${State.characterId}`
                    : `“${ENHANCING_LOADOUT_NAME}”配装缺少可验证的角色 ID`,
                'INVALID_LOADOUT'
            );
        }
        if (
            loadout.actionTypeHrid !== ENHANCING_ACTION_TYPE_HRID &&
            loadout.actionTypeHrid !== ''
        ) {
            throw new BatchError(
                `“${ENHANCING_LOADOUT_NAME}”配装不是强化或全技能配装`,
                'INVALID_LOADOUT'
            );
        }
        if (
            !loadout.wearableMap ||
            typeof loadout.wearableMap !== 'object' ||
            Array.isArray(loadout.wearableMap)
        ) {
            throw new BatchError(
                `“${ENHANCING_LOADOUT_NAME}”配装的装备数据无效`,
                'INVALID_LOADOUT'
            );
        }

        const wearableRequirements = new Map();
        const wearableItemHrids = new Set();
        const useExactEnhancement = loadout.useExactEnhancement === true;
        for (const wearableHash of Object.values(loadout.wearableMap)) {
            if (wearableHash == null || wearableHash === '') continue;
            const parsed = parseItemHash(wearableHash);
            if (!parsed || parsed.characterId !== State.characterId) {
                throw new BatchError(
                    `“${ENHANCING_LOADOUT_NAME}”配装含有格式无效或串角色的装备引用`,
                    'INVALID_LOADOUT'
                );
            }
            wearableItemHrids.add(parsed.itemHrid);
            const key = useExactEnhancement
                ? `${parsed.itemHrid}::${parsed.enhancementLevel}`
                : parsed.itemHrid;
            const requirement = wearableRequirements.get(key) || {
                itemHrid: parsed.itemHrid,
                enhancementLevel: useExactEnhancement
                    ? parsed.enhancementLevel
                    : null,
                count: 0,
            };
            requirement.count++;
            wearableRequirements.set(key, requirement);
        }

        if (!wearableItemHrids.has(GRANDMASTER_ENHANCING_CHARM_HRID)) {
            throw new BatchError(
                `“${ENHANCING_LOADOUT_NAME}”配装中没有 `
                + 'Grandmaster Enhancing Charm',
                'INVALID_LOADOUT'
            );
        }

        for (const requirement of wearableRequirements.values()) {
            const available = getOwnedCharacterItemCount(
                requirement.itemHrid,
                requirement.enhancementLevel
            );
            if (available < requirement.count) {
                const levelText = requirement.enhancementLevel == null
                    ? ''
                    : ` +${requirement.enhancementLevel}`;
                throw new BatchError(
                    `“${ENHANCING_LOADOUT_NAME}”配装需要 `
                    + `${requirement.itemHrid}${levelText} ×${requirement.count}，`
                    + `角色全部物品位置仅找到 ${available}`,
                    'INVALID_LOADOUT'
                );
            }
        }

        const extraItemHrids = [
            ...(Array.isArray(loadout.foodItemHrids)
                ? loadout.foodItemHrids
                : []),
            ...(Array.isArray(loadout.drinkItemHrids)
                ? loadout.drinkItemHrids
                : []),
        ].filter(
            (itemHrid) => (
                typeof itemHrid === 'string' &&
                /^\/items\/[a-z0-9_]+$/.test(itemHrid)
            )
        );
        const reservedItemHrids = [
            ...new Set([...wearableItemHrids, ...extraItemHrids]),
        ].sort();

        return {
            id,
            name: ENHANCING_LOADOUT_NAME,
            fingerprint: buildLoadoutFingerprint(loadout),
            useExactEnhancement,
            wearableRequirements: [
                ...wearableRequirements.values(),
            ].map((requirement) => ({...requirement})),
            wearableItemHrids: [...wearableItemHrids].sort(),
            reservedItemHrids,
        };
    }

    function getLoadoutTargetReservations(itemIds, enhancingLoadout) {
        const selectedLoadoutItems = itemIds.filter(
            (itemId) => (
                enhancingLoadout.wearableItemHrids.includes(
                    fullItemHrid(itemId)
                )
            )
        );
        return selectedLoadoutItems.map((itemId) => {
            const itemHrid = fullItemHrid(itemId);
            const requirements = (
                enhancingLoadout.wearableRequirements || []
            ).filter(
                (requirement) => requirement.itemHrid === itemHrid
            );
            // Every selected item used by Enhancing follows the same rule as
            // the experience charm: the loadout keeps its own +20 copy/copies,
            // while the frozen plan may freely enhance lower-level copies.
            const exactWrongLevel = requirements.find(
                (requirement) => (
                    requirement.enhancementLevel != null &&
                    Number(requirement.enhancementLevel) !==
                        CONFIG.TARGET_LEVEL
                )
            );
            if (exactWrongLevel) {
                throw new BatchError(
                    `“${ENHANCING_LOADOUT_NAME}”配装当前精确绑定 `
                    + `${getItemName(itemId)} +`
                    + `${exactWrongLevel.enhancementLevel}；`
                    + `请把配装保存为使用 +${CONFIG.TARGET_LEVEL} `
                    + '后再强化同名装备',
                    'INVALID_LOADOUT'
                );
            }
            const requiredCount = Math.max(
                1,
                requirements.reduce(
                    (sum, requirement) => (
                        sum + Number(requirement.count || 0)
                    ),
                    0
                )
            );
            const available = getOwnedCharacterItemCount(
                itemHrid,
                CONFIG.TARGET_LEVEL
            );
            if (available < requiredCount) {
                const selectionMode =
                    enhancingLoadout.useExactEnhancement === true
                        ? `精确 +${CONFIG.TARGET_LEVEL}`
                        : '默认最大强化等级';
                throw new BatchError(
                    `强化 ${getItemName(itemId)} 时，`
                    + `${ENHANCING_LOADOUT_NAME} 配装以`
                    + `${selectionMode}使用该装备，仍须保留 `
                    + `+${CONFIG.TARGET_LEVEL} ×${requiredCount}；`
                    + `当前角色全部物品位置仅找到 ${available}`,
                    'INVALID_LOADOUT'
                );
            }
            return {
                itemId,
                itemHrid,
                enhancementLevel: CONFIG.TARGET_LEVEL,
                count: requiredCount,
            };
        });
    }

    function assertPlansPreserveLoadoutTargetReservations(
        itemPlans,
        reservations
    ) {
        for (const reservation of reservations || []) {
            const entry = (itemPlans || []).find(
                (candidate) => candidate.itemId === reservation.itemId
            );
            const plan = entry?.plan;
            const actions = [
                ...(plan?.rawActions || []),
                ...(plan?.compressedActions || []),
            ];
            if (
                !plan ||
                Number(plan.consumedExisting?.[
                    reservation.enhancementLevel
                ] || 0) !== 0 ||
                actions.some((action) => (
                    Number(action.startLevel) >=
                        reservation.enhancementLevel ||
                    Number(action.targetLevel) >
                        reservation.enhancementLevel
                ))
            ) {
                throw new BatchError(
                    `${reservation.itemId} 的强化计划可能消耗 Enhancing `
                    + `配装保留的 +${reservation.enhancementLevel}；`
                    + '本次不会添加队列',
                    'PLAN_RESERVATION_CONFLICT'
                );
            }
        }
    }

    function assertLoadoutTargetReservationsAvailable(reservations) {
        for (const reservation of reservations || []) {
            const available = getOwnedCharacterItemCount(
                reservation.itemHrid,
                reservation.enhancementLevel
            );
            if (available < Number(reservation.count)) {
                throw new BatchError(
                    `Enhancing 配装保留件 ${reservation.itemId} +`
                    + `${reservation.enhancementLevel} 需要 `
                    + `${reservation.count} 件，当前仅有 ${available}；`
                    + '已停止继续添加队列',
                    'LOADOUT_RESERVATION_MISSING'
                );
            }
        }
    }

    function refreshRunEnhancingLoadout(run) {
        const binding = getEnhancingLoadoutBinding();
        if (
            run.characterId !== State.characterId ||
            run.characterId !== getCharacterId() ||
            binding.id !== normalizeLoadoutId(run.enhancingLoadoutId)
        ) {
            throw new BatchError(
                '当前角色或 Enhancing 配装 ID 已变化；旧动作仍绑定原配装，'
                + '不能自动改写，请核对原配装或结束旧批次记录',
                'INVALID_LOADOUT'
            );
        }
        const reservations = getLoadoutTargetReservations(
            run.itemIds || [], binding
        );
        if (run.recoveryJournal?.itemPlans) {
            assertPlansPreserveLoadoutTargetReservations(
                run.recoveryJournal.itemPlans, reservations
            );
        }
        // Saved slot contents may change, but the server loadout ID and every
        // acknowledged command keep their identity. Never rewrite old ACKs.
        run.enhancingLoadoutFingerprint = binding.fingerprint;
        run.enhancingLoadoutReservedItemHrids = [...binding.reservedItemHrids];
        run.loadoutTargetReservations = reservations;
        return binding;
    }

    function assertBeltEnhancementRules(itemIds) {
        for (const itemId of itemIds) {
            if (!TALISMAN_BELT_IDS.has(itemId)) continue;
            const rule = State.itemMarketDetails.get(itemId);
            if (!rule?.categoryHrid) {
                throw new BatchError(`${getItemName(itemId)} 的强化规则尚未同步，请完整刷新游戏后再预检`, 'STATE_NOT_READY');
            }
            if (rule.categoryHrid !== '/item_categories/equipment' ||
                !rule.hasEnhancementCosts || rule.mirrorBaseItemHrid !== fullItemHrid(itemId)) {
                throw new BatchError(`${getItemName(itemId)} 当前不支持本助手的同种装备加贤者镜强化方式，本次不会采购或排队`, 'UNSUPPORTED_ENHANCEMENT');
            }
        }
    }

    function getTesterPurchaseHrid(itemId) {
        if (!TALISMAN_BELT_IDS.has(itemId)) return `/shop_items/test/${itemId}`;
        assertBeltEnhancementRules([itemId]);
        const shopItemHrid = State.itemMarketDetails.get(itemId)?.testerShopItemHrid;
        if (!shopItemHrid) {
            throw new BatchError(`${getItemName(itemId)} 的测试商店商品尚未同步或无法购买，请刷新后核对 shop-tester`, 'TESTER_ITEM_UNAVAILABLE');
        }
        return shopItemHrid;
    }

    function getConnectionLabel() {
        if (!State.socket) return 'WS 未连接';
        if (State.socket.readyState !== WebSocket.OPEN) return 'WS 已断开';
        if (
            !State.inventoryReady ||
            !State.queueReady ||
            !State.loadoutsReady ||
            !State.characterItemsReady
        ) {
            return '等待初始同步';
        }
        return 'WS 已连接';
    }

    function scheduleUiRefresh() {
        if (State.renderScheduled) return;
        State.renderScheduled = true;
        window.requestAnimationFrame(() => {
            State.renderScheduled = false;
            if (State.ui) {
                if (State.ui.isOpen()) {
                    State.ui.updateStatus();
                    State.ui.renderItems(false);
                    State.ui.renderRun();
                } else {
                    State.ui.updateFab();
                }
            }
        });
    }

    function log(message, type = 'info') {
        const entry = {
            time: new Date(),
            message: String(message),
            type,
        };
        State.logs.push(entry);
        if (State.logs.length > 600) State.logs.shift();

        const method = type === 'error'
            ? 'error'
            : type === 'warn'
                ? 'warn'
                : 'log';
        console[method](`[安全强化助手] ${entry.message}`);
        if (State.ui) State.ui.appendLog(entry);
    }

    function mergeNameDictionary(dictionary) {
        if (!dictionary || typeof dictionary !== 'object') return 0;
        let added = 0;
        for (const [key, value] of Object.entries(dictionary)) {
            if (typeof value !== 'string' || !value.trim()) continue;
            const itemId = normalizeShortItemId(key);
            if (!EQUIPMENT_ID_SET.has(itemId)) continue;
            State.names.set(itemId, value.trim());
            added++;
        }
        if (added > 0) State.namesRevision++;
        return added;
    }

    function mergeNamesFromDataCenter() {
        try {
            const getter = window.tmData?.getEnhancerDict;
            if (typeof getter !== 'function') return 0;
            const rawDictionary = getter.call(window.tmData);
            if (!rawDictionary || typeof rawDictionary !== 'object') {
                return 0;
            }
            const translatedDictionary = {};
            for (const [key, value] of Object.entries(rawDictionary)) {
                if (typeof value !== 'string') continue;
                const itemId = normalizeShortItemId(key);
                const normalizedValue = value.trim();
                if (
                    !normalizedValue ||
                    normalizedValue === itemId ||
                    normalizedValue === `/items/${itemId}`
                ) {
                    continue;
                }
                translatedDictionary[itemId] = normalizedValue;
            }
            const added = mergeNameDictionary(
                translatedDictionary
            );
            if (added > 0) scheduleUiRefresh();
            return added;
        } catch (error) {
            log(`读取数据中心名称失败：${error.message}`, 'warn');
            return 0;
        }
    }

    window.addEventListener('tmData:ready', mergeNamesFromDataCenter);

    function extractJsonObject(source, marker) {
        const markerIndex = source.indexOf(marker);
        if (markerIndex < 0) return null;
        const braceStart = markerIndex + marker.length - 1;
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = braceStart; index < source.length; index++) {
            const char = source[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
            } else if (char === '{') {
                depth++;
            } else if (char === '}') {
                depth--;
                if (depth === 0) {
                    return source.slice(braceStart, index + 1);
                }
            }
        }
        return null;
    }

    async function loadItemNames() {
        const cached = readJsonStorage(STORAGE_KEYS.NAME_CACHE, null);
        let cacheHit = false;
        if (
            cached &&
            Number(cached.savedAt) > Date.now() - CONFIG.NAME_CACHE_TTL_MS &&
            cached.names
        ) {
            mergeNameDictionary(cached.names);
            // An older but unexpired cache may omit newly added equipment.
            // Keep its names as fallback while fetching the missing entries.
            cacheHit = EQUIPMENT_IDS.every(itemId => State.names.has(itemId));
            scheduleUiRefresh();
        }

        mergeNamesFromDataCenter();

        if (cacheHit) {
            log(`已从缓存加载 ${State.names.size} 个装备名称`, 'success');
            return;
        }

        await waitForDocumentBody();
        const candidates = [...document.querySelectorAll('script[src]')]
            .map((script) => script.src)
            .filter((url) => {
                try {
                    const parsed = new URL(url, window.location.href);
                    return (
                        parsed.origin === window.location.origin &&
                        parsed.pathname.includes('/static/js/') &&
                        parsed.pathname.endsWith('.js')
                    );
                } catch {
                    return false;
                }
            });

        let officialNames = null;
        for (const url of candidates.slice(0, 12)) {
            try {
                const response = await fetch(url, {
                    credentials: 'same-origin',
                    cache: 'force-cache',
                });
                if (!response.ok) continue;
                const source = await response.text();
                const jsonText = extractJsonObject(source, 'itemNames:{');
                if (!jsonText) continue;
                officialNames = JSON.parse(jsonText);
                break;
            } catch {
                // Try the next same-origin bundle.
            }
        }

        if (officialNames) {
            mergeNameDictionary(officialNames);
            // A real Data Center translation wins over the official English
            // name; identity fallbacks were filtered above.
            mergeNamesFromDataCenter();
            const compactNames = {};
            for (const itemId of EQUIPMENT_IDS) {
                if (State.names.has(itemId)) {
                    compactNames[itemId] = State.names.get(itemId);
                }
            }
            writeJsonStorage(STORAGE_KEYS.NAME_CACHE, {
                savedAt: Date.now(),
                names: compactNames,
            });
            log(`已加载 ${State.names.size} 个装备名称`, 'success');
        } else if (State.names.size === 0) {
            log('未找到官方名称字典，将显示装备英文 ID', 'warn');
        }
        scheduleUiRefresh();
    }

    class BatchError extends Error {
        constructor(message, code = 'FAILED') {
            super(message);
            this.name = 'BatchError';
            this.code = code;
        }
    }

    function getActionLoadoutId(action) {
        if (!action || typeof action !== 'object') return null;
        const camelId = action.characterLoadoutId;
        const acronymId = action.characterLoadoutID;
        if (
            camelId != null &&
            acronymId != null &&
            Number(camelId) !== Number(acronymId)
        ) {
            return null;
        }
        return normalizeLoadoutId(camelId ?? acronymId);
    }

    function actionFingerprintMatches(action, fingerprint) {
        if (!action || !fingerprint) return false;
        if (action.actionHrid !== ENHANCE_ACTION_HRID) return false;
        if (action.primaryItemHash !== fingerprint.primaryItemHash) return false;
        if (action.secondaryItemHash !== fingerprint.secondaryItemHash) return false;
        if (
            Number(action.enhancingMaxLevel) !==
            Number(fingerprint.enhancingMaxLevel)
        ) {
            return false;
        }
        if (
            getActionLoadoutId(action) !==
            normalizeLoadoutId(fingerprint.characterLoadoutId)
        ) {
            return false;
        }
        if (
            Number(action.enhancingProtectionMinLevel) !==
            Number(fingerprint.enhancingProtectionMinLevel)
        ) {
            return false;
        }
        return true;
    }

    function actionProgressLevel(action) {
        return parseItemHash(
            action?.primaryItemHash
        )?.enhancementLevel ?? null;
    }

    function actionProgressMatches(
        action,
        fingerprint,
        {allowPartial = false} = {}
    ) {
        if (
            !action ||
            typeof action !== 'object' ||
            Array.isArray(action) ||
            !fingerprint
        ) {
            return false;
        }
        const hasValue = (key) => action[key] != null;
        if (
            (!allowPartial || hasValue('actionHrid')) &&
            action.actionHrid !== ENHANCE_ACTION_HRID
        ) {
            return false;
        }

        const expectedPrimary = parseItemHash(
            fingerprint.primaryItemHash
        );
        if (!expectedPrimary) return false;
        const targetLevel = Number(
            fingerprint.enhancingMaxLevel
        );
        if (
            !Number.isSafeInteger(targetLevel) ||
            targetLevel <= expectedPrimary.enhancementLevel
        ) {
            return false;
        }
        if (!allowPartial || hasValue('primaryItemHash')) {
            const actualPrimary = parseItemHash(
                action.primaryItemHash
            );
            if (
                !actualPrimary ||
                actualPrimary.characterId !==
                    expectedPrimary.characterId ||
                actualPrimary.itemLocationHrid !==
                    expectedPrimary.itemLocationHrid ||
                actualPrimary.itemHrid !==
                    expectedPrimary.itemHrid ||
                actualPrimary.enhancementLevel <
                    expectedPrimary.enhancementLevel ||
                actualPrimary.enhancementLevel > targetLevel
            ) {
                return false;
            }
        }

        const expectedSecondary = parseItemHash(
            fingerprint.secondaryItemHash
        );
        if (!expectedSecondary) return false;
        if (!allowPartial || hasValue('secondaryItemHash')) {
            const actualSecondary = parseItemHash(
                action.secondaryItemHash
            );
            if (
                !actualSecondary ||
                actualSecondary.characterId !==
                    expectedSecondary.characterId ||
                actualSecondary.itemLocationHrid !==
                    expectedSecondary.itemLocationHrid ||
                actualSecondary.itemHrid !==
                    expectedSecondary.itemHrid ||
                actualSecondary.enhancementLevel !==
                    expectedSecondary.enhancementLevel
            ) {
                return false;
            }
        }

        if (
            (!allowPartial || hasValue('enhancingMaxLevel')) &&
            Number(action.enhancingMaxLevel) !==
                Number(fingerprint.enhancingMaxLevel)
        ) {
            return false;
        }
        const hasLoadout =
            action.characterLoadoutId != null ||
            action.characterLoadoutID != null;
        if (
            (!allowPartial || hasLoadout) &&
            getActionLoadoutId(action) !==
                normalizeLoadoutId(fingerprint.characterLoadoutId)
        ) {
            return false;
        }
        if (
            (
                !allowPartial ||
                hasValue('enhancingProtectionMinLevel')
            ) &&
            Number(action.enhancingProtectionMinLevel) !==
                Number(fingerprint.enhancingProtectionMinLevel)
        ) {
            return false;
        }
        return true;
    }

    function progressSingleEnhanceActionMatches(action, fingerprint) {
        if (!actionProgressMatches(action, fingerprint)) return false;
        if (
            action.difficultyTier != null &&
            Number(action.difficultyTier) !== 0
        ) {
            return false;
        }
        if (
            action.hasMaxCount != null &&
            action.hasMaxCount !== false
        ) {
            return false;
        }
        if (
            action.maxCount != null &&
            Number(action.maxCount) !== 0
        ) {
            return false;
        }
        return true;
    }

    function actionCompletionMatches(action, fingerprint) {
        if (!actionProgressMatches(
            action,
            fingerprint,
            {allowPartial: true}
        )) {
            return false;
        }
        if (
            action.difficultyTier != null &&
            Number(action.difficultyTier) !== 0
        ) {
            return false;
        }
        if (
            action.hasMaxCount != null &&
            action.hasMaxCount !== false
        ) {
            return false;
        }
        if (
            action.maxCount != null &&
            Number(action.maxCount) !== 0
        ) {
            return false;
        }
        return true;
    }

    function completionCarriesIdentifyingFields(action) {
        return Boolean(
            action?.actionHrid === ENHANCE_ACTION_HRID &&
            parseItemHash(action?.primaryItemHash) &&
            action?.enhancingMaxLevel != null &&
            Number.isSafeInteger(
                Number(action?.enhancingMaxLevel)
            )
        );
    }

    function completionHasTerminalEvidence(
        action,
        fingerprint,
        removalSeen = false
    ) {
        if (action?.isDone === true) return true;
        const targetLevel = Number(
            fingerprint?.enhancingMaxLevel
        );
        const progressLevel = actionProgressLevel(action);
        if (
            Number.isSafeInteger(targetLevel) &&
            Number.isSafeInteger(progressLevel) &&
            progressLevel >= targetLevel
        ) {
            return true;
        }
        return Boolean(
            removalSeen &&
            compatibleCompletionCanPairWithRemoval(
                action,
                fingerprint
            )
        );
    }

    function compatibleCompletionCanPairWithRemoval(
        action,
        fingerprint
    ) {
        const frozenPrimary = parseItemHash(
            fingerprint?.primaryItemHash
        );
        const targetLevel = Number(
            fingerprint?.enhancingMaxLevel
        );
        if (
            !frozenPrimary ||
            !Number.isSafeInteger(targetLevel) ||
            targetLevel <= frozenPrimary.enhancementLevel
        ) {
            return false;
        }
        const progressLevel = actionProgressLevel(action);
        if (Number.isSafeInteger(progressLevel)) {
            return progressLevel >= targetLevel - 1;
        }
        // A one-step action has no possible intermediate completion. This
        // also handles the server's compact {id, actionHrid} final event.
        return targetLevel === frozenPrimary.enhancementLevel + 1;
    }

    function strictSingleEnhanceActionMatches(action, fingerprint) {
        if (!actionFingerprintMatches(action, fingerprint)) {
            return false;
        }
        if (
            action.difficultyTier != null &&
            Number(action.difficultyTier) !== 0
        ) {
            return false;
        }
        if (
            action.hasMaxCount != null &&
            action.hasMaxCount !== false
        ) {
            return false;
        }
        if (
            action.maxCount != null &&
            Number(action.maxCount) !== 0
        ) {
            return false;
        }
        return true;
    }

    class MarketAutomationError extends Error {
        constructor(message, mutationMayHaveApplied = false) {
            super(message);
            this.name = 'MarketAutomationError';
            this.mutationMayHaveApplied = mutationMayHaveApplied;
        }
    }

    function normalizeMarketListingId(value) {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) && numeric > 0
            ? String(numeric)
            : '';
    }

    function getMarketOrderBookLevel(snapshot, level) {
        if (
            !snapshot ||
            typeof snapshot !== 'object' ||
            !snapshot.orderBooks
        ) {
            return null;
        }
        const orderBook = snapshot.orderBooks[level]
            ?? snapshot.orderBooks[String(level)];
        return orderBook && typeof orderBook === 'object'
            ? orderBook
            : null;
    }

    function normalizeMarketAsk(ask) {
        if (!ask || typeof ask !== 'object') return null;
        const listingId = normalizeMarketListingId(ask.listingId);
        const price = Number(ask.price);
        const quantity = Number(ask.quantity);
        if (
            !listingId ||
            !Number.isSafeInteger(price) ||
            price <= 0 ||
            !Number.isSafeInteger(quantity) ||
            quantity <= 0
        ) {
            return null;
        }
        return {
            ...ask,
            listingId: ask.listingId,
            price,
            quantity,
        };
    }

    function marketListingValues(listings) {
        if (listings instanceof Map) return [...listings.values()];
        return Array.isArray(listings) ? listings : [];
    }

    function normalizeInitClientDataVersionMs(value) {
        if (
            (typeof value !== 'string' && typeof value !== 'number') ||
            value === ''
        ) {
            return null;
        }
        const milliseconds = new Date(value).getTime();
        return Number.isSafeInteger(milliseconds) && milliseconds >= 0
            ? milliseconds
            : null;
    }

    function replaceClientMarketData(message, source = 'network') {
        State.itemMarketDetails.clear();
        State.gameModeMarketRestrictions.clear();
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
            State.clientMarketDataReady = false;
            State.clientMarketDataSource = '';
            State.clientMarketDataVersionMs = null;
            State.marketRevision++;
            return;
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
            State.itemMarketDetails.set(itemId, {
                isTradable: detail?.isTradable === true,
                sellPrice,
            });
            if (TALISMAN_BELT_IDS.has(itemId)) {
                const testerEntry = Object.entries(message.shopItemDetailMap || {}).find(
                    ([key, shop]) => key.startsWith('/shop_items/') &&
                        shop?.category === '/shop_categories/tester' && shop.itemHrid === itemHrid
                );
                Object.assign(State.itemMarketDetails.get(itemId), {
                    categoryHrid: detail.categoryHrid,
                    hasEnhancementCosts: Array.isArray(detail.enhancementCosts) && detail.enhancementCosts.length > 0,
                    mirrorBaseItemHrid: detail.baseItemHrids == null ? itemHrid
                        : Array.isArray(detail.baseItemHrids) ? detail.baseItemHrids[0] || itemHrid : null,
                    testerShopItemHrid: testerEntry?.[0] || null,
                });
            }
        }
        for (
            const [gameModeHrid, detail]
            of Object.entries(gameModeDetailMap)
        ) {
            if (typeof gameModeHrid !== 'string' || !gameModeHrid) {
                continue;
            }
            if (typeof detail?.marketRestricted !== 'boolean') {
                continue;
            }
            State.gameModeMarketRestrictions.set(
                gameModeHrid,
                detail.marketRestricted
            );
        }
        State.clientMarketDataReady =
            State.itemMarketDetails.size > 0 &&
            State.gameModeMarketRestrictions.size > 0;
        State.clientMarketDataSource = State.clientMarketDataReady
            ? source
            : '';
        State.clientMarketDataVersionMs =
            normalizeInitClientDataVersionMs(
                message?.versionTimestamp
            );
        refreshCharacterMarketAccessReady();
        State.marketRevision++;
    }

    function clearClientMarketData() {
        State.clientMarketDataReady = false;
        State.clientMarketDataSource = '';
        State.clientMarketDataVersionMs = null;
        State.clientMarketDataCacheStatus = 'not_checked';
        State.clientMarketDataCacheDetail = '';
        State.itemMarketDetails.clear();
        State.gameModeMarketRestrictions.clear();
        refreshCharacterMarketAccessReady();
        State.marketRevision++;
    }

    function restoreClientMarketDataFromCache(socket) {
        State.clientMarketDataCacheStatus = 'checking';
        State.clientMarketDataCacheDetail = '';
        let socketVersionMs = null;
        try {
            const rawSocketVersion = new URL(socket?.url || '')
                .searchParams.get('versionTimestamp');
            if (/^\d+$/.test(rawSocketVersion || '')) {
                const numeric = Number(rawSocketVersion);
                if (Number.isSafeInteger(numeric) && numeric > 0) {
                    socketVersionMs = numeric;
                }
            }
        } catch {
            // The socket itself has already passed isGameSocket().
        }
        if (socketVersionMs == null) {
            State.clientMarketDataCacheStatus =
                'socket_has_no_cache_version';
            State.clientMarketDataCacheDetail =
                'WebSocket versionTimestamp 为 0 或缺失，等待服务器全量规则';
            State.marketRevision++;
            return false;
        }

        let compressed = null;
        try {
            compressed = window.localStorage.getItem(
                'initClientData'
            );
        } catch (error) {
            State.clientMarketDataCacheStatus = 'storage_unavailable';
            State.clientMarketDataCacheDetail =
                error?.message || String(error);
            State.marketRevision++;
            return false;
        }
        if (!compressed) {
            State.clientMarketDataCacheStatus = 'missing';
            State.clientMarketDataCacheDetail =
                'localStorage 中没有 initClientData';
            State.marketRevision++;
            return false;
        }

        // The game falls back to plain JSON if cache compression fails.
        // Both representations still require an exact connection version.
        const decompressed = compressed.trimStart().startsWith('{')
            ? compressed : decompressLzStringUtf16(compressed);
        const cached = safeJsonParse(decompressed);
        if (
            !cached ||
            typeof cached !== 'object' ||
            Array.isArray(cached) ||
            cached.type !== 'init_client_data'
        ) {
            State.clientMarketDataCacheStatus = 'invalid';
            State.clientMarketDataCacheDetail =
                'initClientData 无法解压为合法的 init_client_data';
            State.marketRevision++;
            return false;
        }
        const cachedVersionMs = normalizeInitClientDataVersionMs(
            cached.versionTimestamp
        );
        if (
            cachedVersionMs == null ||
            cachedVersionMs !== socketVersionMs
        ) {
            State.clientMarketDataCacheStatus = 'version_mismatch';
            State.clientMarketDataCacheDetail =
                `缓存版本 ${cachedVersionMs ?? '无效'} 与连接版本 `
                + `${socketVersionMs} 不一致`;
            State.marketRevision++;
            return false;
        }

        replaceClientMarketData(cached, 'game_cache');
        if (!State.clientMarketDataReady) {
            State.clientMarketDataCacheStatus = 'invalid_rules';
            State.clientMarketDataCacheDetail =
                '缓存缺少完整、类型明确的市场物品或模式规则';
            State.marketRevision++;
            return false;
        }
        State.clientMarketDataCacheStatus = 'loaded';
        State.clientMarketDataCacheDetail =
            `已匹配连接版本 ${socketVersionMs}`;
        State.marketRevision++;
        log('已从游戏同版本缓存恢复完整市场规则', 'success');
        return true;
    }

    function replaceCharacterMarketAccess(message) {
        const rawListingCap =
            message?.characterInfo?.marketListingCap;
        const listingCap = Number(rawListingCap);
        const gameMode = String(
            message?.character?.gameMode || ''
        );
        const hasAcceptedTradingRules =
            message?.characterSetting?.hasAcceptedTradingRules;
        State.marketListingCap = (
            rawListingCap != null &&
            Number.isSafeInteger(listingCap) &&
            listingCap >= 0
        ) ? listingCap : null;
        State.characterGameMode = gameMode;
        State.hasAcceptedTradingRules =
            hasAcceptedTradingRules === true;
        State.tradingRulesKnown =
            typeof hasAcceptedTradingRules === 'boolean';
        refreshCharacterMarketAccessReady();
        State.marketRevision++;
    }

    function refreshCharacterMarketAccessReady() {
        State.characterMarketAccessReady = Boolean(
            State.marketListingCap != null &&
            State.characterGameMode &&
            State.tradingRulesKnown
        );
    }

    function clearCharacterMarketAccess() {
        State.characterGameMode = '';
        State.characterMarketAccessReady = false;
        State.hasAcceptedTradingRules = false;
        State.tradingRulesKnown = false;
        State.marketListingCap = null;
        State.marketRevision++;
    }

    function isCharacterMarketRestricted() {
        if (
            !State.clientMarketDataReady ||
            !State.characterMarketAccessReady ||
            !State.gameModeMarketRestrictions.has(
                State.characterGameMode
            )
        ) {
            return null;
        }
        return State.gameModeMarketRestrictions.get(
            State.characterGameMode
        ) === true;
    }

    function isMarketInitializationReady() {
        return Boolean(
            State.myMarketListingsReady &&
            State.clientMarketDataReady &&
            State.characterMarketAccessReady &&
            State.gameModeMarketRestrictions.has(
                State.characterGameMode
            )
        );
    }

    function getMissingInitializationParts(includeMarket = false) {
        const missing = [];
        if (!State.inventoryReady) missing.push('库存全量');
        if (!State.queueReady) missing.push('动作队列全量');
        if (!State.loadoutsReady) missing.push('配装全量');
        if (!State.characterItemsReady) {
            missing.push('角色物品全量');
        }
        if (!includeMarket) return missing;
        if (!State.clientMarketDataReady) {
            const cacheStatus =
                State.clientMarketDataCacheStatus || 'not_checked';
            missing.push(`市场客户端规则（缓存：${cacheStatus}）`);
        }
        if (State.marketListingCap == null) {
            missing.push('角色挂单容量');
        }
        if (!State.characterGameMode) {
            missing.push('角色游戏模式');
        }
        if (!State.tradingRulesKnown) {
            missing.push('交易规则接受状态');
        }
        if (
            State.characterGameMode &&
            !State.gameModeMarketRestrictions.has(
                State.characterGameMode
            )
        ) {
            missing.push('当前游戏模式的市场限制规则');
        }
        if (!State.myMarketListingsReady) {
            missing.push('本人挂单全量');
        }
        return missing;
    }

    function getMarketItemRule(itemId) {
        return State.itemMarketDetails.get(
            normalizeShortItemId(itemId)
        ) || null;
    }

    /*
     * Exact price binning used by the official test client:
     * marketplacePanel.getBinnedPrice(value, roundUp).
     */
    function getOfficialBinnedMarketPrice(
        value,
        roundUp = false,
        vendorPrice = 0
    ) {
        let price = parseInt(value, 10);
        const normalizedVendorPrice = Number(vendorPrice);
        if (
            !Number.isSafeInteger(price) ||
            !Number.isSafeInteger(normalizedVendorPrice) ||
            normalizedVendorPrice < 0
        ) {
            return null;
        }
        if (price <= 1) return 2;
        const text = String(price);
        const firstDigit = text[0];
        const digits = text.length;
        let step = 1;
        if (
            (firstDigit === '1' || firstDigit === '2') &&
            digits >= 3
        ) {
            step = 5 * Math.pow(10, digits - 3);
        } else if (
            (firstDigit === '3' || firstDigit === '4') &&
            digits >= 2
        ) {
            step = Math.pow(10, digits - 2);
        } else if (
            ['5', '6', '7', '8', '9'].includes(firstDigit) &&
            digits >= 2
        ) {
            step = 2 * Math.pow(10, digits - 2);
        }
        const remainder = price % step;
        price -= remainder;
        if (price < normalizedVendorPrice) roundUp = true;
        if (roundUp && remainder >= 1) price += step;
        return Number.isSafeInteger(price) ? price : null;
    }

    function getPreviousOfficialMarketPrice(bestAskPrice, vendorPrice) {
        const bestAsk = Number(bestAskPrice);
        const vendor = Number(vendorPrice);
        if (
            !Number.isSafeInteger(bestAsk) ||
            bestAsk <= 0 ||
            !Number.isSafeInteger(vendor) ||
            vendor < 0
        ) {
            return null;
        }
        const candidate = getOfficialBinnedMarketPrice(
            bestAsk - 1,
            false,
            vendor
        );
        return (
            Number.isSafeInteger(candidate) &&
            candidate > 0 &&
            candidate < bestAsk &&
            candidate >= vendor
        ) ? candidate : null;
    }

    function getMarketExcessInventory(itemId) {
        const inventory = Number(
            getItemCount(itemId, CONFIG.TARGET_LEVEL)
        );
        if (!Number.isSafeInteger(inventory) || inventory < 0) {
            return 0;
        }
        return Math.max(
            0,
            inventory - CONFIG.MARKET_RESERVED_INVENTORY
        );
    }

    function actionFingerprintTargetsItemOutput(
        fingerprint,
        itemId
    ) {
        if (
            Number(fingerprint?.enhancingMaxLevel) !==
                CONFIG.TARGET_LEVEL
        ) {
            return false;
        }
        const parsed = parseItemHash(
            fingerprint?.primaryItemHash
        );
        return normalizeShortItemId(parsed?.itemHrid) === itemId;
    }

    function isQuickItemMarketWriteSafe(run, itemId) {
        if (run?.mode !== 'quick') return true;
        for (const actionId of run.ownedActionIds || []) {
            if (
                !run.completedOwnedActionIds?.has(actionId) &&
                actionFingerprintTargetsItemOutput(
                    run.ownedActionFingerprints?.get(actionId),
                    itemId
                )
            ) {
                return false;
            }
        }
        const result = run.results?.find(
            (entry) => entry.itemId === itemId
        );
        if (!result) return true;
        const expected =
            Number(result.baselineOutputCount) +
            Number(
                run.completedOwnedOutputCounts?.get(itemId) || 0
            );
        return getRunAdjustedOutputCount(run, itemId) === expected;
    }

    const MarketMaintenance = {
        getLeftOne(orderBookSnapshot, level = CONFIG.TARGET_LEVEL) {
            const asks = getMarketOrderBookLevel(
                orderBookSnapshot,
                level
            )?.asks;
            if (!Array.isArray(asks) || asks.length === 0) return null;
            // The official client treats asks[0] as the best ask. Skipping a
            // malformed first row could make us post above the real market.
            return normalizeMarketAsk(asks[0]);
        },

        getOwnActiveSellListings(
            myListings,
            itemId,
            level = CONFIG.TARGET_LEVEL
        ) {
            const itemHrid = fullItemHrid(itemId);
            return marketListingValues(myListings)
                .filter((listing) => (
                    listing &&
                    listing.status === MARKET_ACTIVE_STATUS &&
                    listing.isSell === true &&
                    listing.itemHrid === itemHrid &&
                    Number(listing.enhancementLevel) === Number(level) &&
                    normalizeMarketListingId(listing.id)
                ))
                .sort((left, right) => (
                    Number(left.price) - Number(right.price) ||
                    Number(left.id) - Number(right.id)
                ));
        },

        planReprice({
            ownListings,
            orderBookSnapshot,
            itemId,
            level = CONFIG.TARGET_LEVEL,
            maxDropPercent = CONFIG.MARKET_DEFAULT_MAX_DROP_PERCENT,
            priceAnchors = null,
            itemPriceAnchor = null,
            inventoryCount = null,
            reserveCount = CONFIG.MARKET_RESERVED_INVENTORY,
            vendorPrice = 0,
            confirmedQuotePrice = null,
            automationListingIds = null,
            isFinalSweep = false,
            listingSlotAvailable = true,
        }) {
            const listings = MarketMaintenance
                .getOwnActiveSellListings(
                    ownListings,
                    itemId,
                    level
                );
            const leftOne = MarketMaintenance.getLeftOne(
                orderBookSnapshot,
                level
            );
            const ownListingIds = new Set(
                listings.map((listing) => (
                    normalizeMarketListingId(listing.id)
                ))
            );
            const asks = getMarketOrderBookLevel(
                orderBookSnapshot,
                level
            )?.asks;
            let competingAsk = null;
            let invalidOrderBook = !Array.isArray(asks);
            let previousAskPrice = 0;
            if (Array.isArray(asks)) {
                for (const rawAsk of asks) {
                    const ask = normalizeMarketAsk(rawAsk);
                    if (!ask || ask.price < previousAskPrice) {
                        invalidOrderBook = true;
                        break;
                    }
                    previousAskPrice = ask.price;
                    if (
                        !ownListingIds.has(
                            normalizeMarketListingId(ask.listingId)
                        )
                    ) {
                        competingAsk = ask;
                        break;
                    }
                }
            }

            const normalizedInventory = inventoryCount == null
                ? NaN
                : Number(inventoryCount);
            const normalizedReserve = Number(reserveCount);
            const excessQuantity = (
                Number.isSafeInteger(normalizedInventory) &&
                normalizedInventory >= 0 &&
                Number.isSafeInteger(normalizedReserve) &&
                normalizedReserve >= 0
            ) ? Math.max(
                    0,
                    normalizedInventory - normalizedReserve
                )
                : 0;
            const normalizedMaximum = Math.min(
                Math.max(
                    Number(maxDropPercent) ||
                        CONFIG.MARKET_DEFAULT_MAX_DROP_PERCENT,
                    CONFIG.MARKET_MIN_DROP_PERCENT
                ),
                CONFIG.MARKET_MAX_DROP_PERCENT
            );
            const automationIds = new Set(
                [...(automationListingIds || [])]
                    .map(normalizeMarketListingId)
                    .filter(Boolean)
            );
            const configuredItemAnchor = Number(itemPriceAnchor);
            const normalizedItemAnchor = (
                Number.isSafeInteger(configuredItemAnchor) &&
                configuredItemAnchor > 0
            ) ? configuredItemAnchor : 0;
            const evaluatedListings = listings.map((listing) => {
                const listingPrice = Number(listing.price);
                const listingId = normalizeMarketListingId(listing.id);
                const configuredAnchor = Number(
                    priceAnchors &&
                    typeof priceAnchors.get === 'function'
                        ? priceAnchors.get(listingId)
                        : NaN
                );
                const listingAnchor = (
                    Number.isSafeInteger(configuredAnchor) &&
                    configuredAnchor > 0
                ) ? configuredAnchor : listingPrice;
                const anchorPrice = Math.max(
                    listingPrice,
                    listingAnchor,
                    normalizedItemAnchor
                );
                return {
                    ownListing: listing,
                    oldPrice: listingPrice,
                    anchorPrice,
                    minimumAllowedPrice: Math.ceil(
                        anchorPrice *
                            (1 - normalizedMaximum / 100)
                    ),
                    isAutomationListing:
                        automationIds.has(listingId),
                };
            });
            const invalidOwnListing = listings.some((listing) => {
                const price = Number(listing.price);
                const orderQuantity = Number(
                    listing.orderQuantity
                );
                const filledQuantity = Number(
                    listing.filledQuantity
                );
                return (
                    !Number.isSafeInteger(price) ||
                    price <= 0 ||
                    !Number.isSafeInteger(orderQuantity) ||
                    orderQuantity <= 0 ||
                    !Number.isSafeInteger(filledQuantity) ||
                    filledQuantity < 0 ||
                    filledQuantity >= orderQuantity
                );
            });

            if (invalidOrderBook || invalidOwnListing) {
                return {
                    kind: 'market_data_invalid',
                    leftOne: null,
                    competingAsk: null,
                    excessQuantity,
                };
            }

            if (listings.length === 0) {
                if (excessQuantity <= 0) {
                    return {
                        kind: 'reserve_only',
                        leftOne,
                        competingAsk: leftOne,
                        excessQuantity,
                    };
                }
                if (!leftOne) {
                    return {
                        kind: 'no_quote',
                        leftOne: null,
                        competingAsk: null,
                        excessQuantity,
                    };
                }
                const proposedPrice =
                    getPreviousOfficialMarketPrice(
                        leftOne.price,
                        vendorPrice
                    );
                if (!proposedPrice) {
                    return {
                        kind: 'price_floor',
                        leftOne,
                        competingAsk: leftOne,
                        excessQuantity,
                        proposedPrice: null,
                    };
                }
                const anchorPrice = normalizedItemAnchor > 0
                    ? normalizedItemAnchor
                    : Number(leftOne.price);
                const minimumAllowedPrice = Math.ceil(
                    anchorPrice *
                        (1 - normalizedMaximum / 100)
                );
                if (proposedPrice < minimumAllowedPrice) {
                    return {
                        kind: 'guarded',
                        leftOne,
                        competingAsk: leftOne,
                        excessQuantity,
                        proposedPrice,
                        anchorPrice,
                        minimumAllowedPrice,
                    };
                }
                if (
                    Number(confirmedQuotePrice) !==
                        Number(leftOne.price)
                ) {
                    return {
                        kind: 'confirming_quote',
                        leftOne,
                        competingAsk: leftOne,
                        excessQuantity,
                        proposedPrice,
                        anchorPrice,
                        minimumAllowedPrice,
                    };
                }
                return {
                    kind: 'post_new',
                    leftOne,
                    competingAsk: leftOne,
                    excessQuantity,
                    newPrice: proposedPrice,
                    anchorPrice,
                    minimumAllowedPrice,
                };
            }

            const ownListing = listings[0];
            const oldPrice = Number(ownListing.price);
            if (
                !Number.isSafeInteger(oldPrice) ||
                oldPrice <= 0
            ) {
                return {
                    kind: 'market_access_blocked',
                    leftOne,
                    competingAsk,
                    ownListing,
                    oldPrice,
                    excessQuantity,
                };
            }
            if (
                Number.isSafeInteger(normalizedInventory) &&
                normalizedInventory >= 0 &&
                normalizedInventory < normalizedReserve
            ) {
                const selectedForReserve =
                    evaluatedListings.find(
                        (evaluated) => evaluated.isAutomationListing
                    ) || evaluatedListings[0];
                return {
                    kind: 'reserve_reclaim',
                    leftOne,
                    competingAsk,
                    ownListing:
                        selectedForReserve.ownListing,
                    oldPrice: selectedForReserve.oldPrice,
                    newPrice: selectedForReserve.oldPrice,
                    excessQuantity,
                    anchorPrice:
                        selectedForReserve.anchorPrice,
                    minimumAllowedPrice:
                        selectedForReserve.minimumAllowedPrice,
                };
            }
            const competingPrice = Number(competingAsk?.price);
            const desiredPrice = competingAsk
                ? getPreviousOfficialMarketPrice(
                    competingPrice,
                    vendorPrice
                )
                : null;
            if (
                !competingAsk ||
                !Number.isSafeInteger(competingPrice) ||
                competingPrice <= 0 ||
                oldPrice <= competingPrice
            ) {
                if (excessQuantity <= 0) {
                    return {
                        kind: 'already_lowest',
                        leftOne,
                        competingAsk,
                        ownListing,
                        oldPrice,
                        excessQuantity,
                    };
                }
                const activeAutomation = evaluatedListings.find(
                    (evaluated) => evaluated.isAutomationListing
                );
                if (activeAutomation && !isFinalSweep) {
                    return {
                        kind: 'accumulating',
                        leftOne,
                        competingAsk,
                        ownListing,
                        oldPrice,
                        excessQuantity,
                    };
                }
                if (activeAutomation && isFinalSweep) {
                    const targetPrice = oldPrice;
                    if (
                        targetPrice <
                            activeAutomation.minimumAllowedPrice
                    ) {
                        return {
                            kind: 'guarded',
                            leftOne,
                            competingAsk,
                            ownListing:
                                activeAutomation.ownListing,
                            oldPrice:
                                activeAutomation.oldPrice,
                            excessQuantity,
                            proposedPrice: targetPrice,
                            anchorPrice:
                                activeAutomation.anchorPrice,
                            minimumAllowedPrice:
                                activeAutomation
                                    .minimumAllowedPrice,
                        };
                    }
                    return {
                        kind: 'consolidate',
                        leftOne,
                        competingAsk,
                        ownListing:
                            activeAutomation.ownListing,
                        oldPrice:
                            activeAutomation.oldPrice,
                        newPrice: targetPrice,
                        excessQuantity,
                        anchorPrice:
                            activeAutomation.anchorPrice,
                        minimumAllowedPrice:
                            activeAutomation.minimumAllowedPrice,
                    };
                }
                if (!listingSlotAvailable) {
                    const selectedForMerge = evaluatedListings[0];
                    if (
                        selectedForMerge.oldPrice <
                            selectedForMerge.minimumAllowedPrice
                    ) {
                        return {
                            kind: 'guarded',
                            leftOne,
                            competingAsk,
                            ownListing:
                                selectedForMerge.ownListing,
                            oldPrice: selectedForMerge.oldPrice,
                            excessQuantity,
                            proposedPrice:
                                selectedForMerge.oldPrice,
                            anchorPrice:
                                selectedForMerge.anchorPrice,
                            minimumAllowedPrice:
                                selectedForMerge.minimumAllowedPrice,
                        };
                    }
                    return {
                        kind: 'consolidate',
                        leftOne,
                        competingAsk,
                        ownListing:
                            selectedForMerge.ownListing,
                        oldPrice: selectedForMerge.oldPrice,
                        newPrice: selectedForMerge.oldPrice,
                        excessQuantity,
                        anchorPrice:
                            selectedForMerge.anchorPrice,
                        minimumAllowedPrice:
                            selectedForMerge.minimumAllowedPrice,
                    };
                }
                return {
                    kind: 'post_extra',
                    leftOne,
                    competingAsk,
                    ownListing,
                    oldPrice,
                    newPrice: oldPrice,
                    excessQuantity,
                    anchorPrice: evaluatedListings[0].anchorPrice,
                    minimumAllowedPrice:
                        evaluatedListings[0].minimumAllowedPrice,
                };
            }
            if (!desiredPrice) {
                return {
                    kind: 'price_floor',
                    leftOne,
                    competingAsk,
                    ownListing,
                    oldPrice,
                    excessQuantity,
                    proposedPrice: null,
                };
            }
            const eligible = evaluatedListings.filter(
                (evaluated) => (
                    desiredPrice >= evaluated.minimumAllowedPrice
                )
            );
            const selected = eligible.find(
                (evaluated) => evaluated.isAutomationListing
            ) || eligible[0];
            if (!selected) {
                const guarded = evaluatedListings[0];
                return {
                    kind: 'guarded',
                    leftOne,
                    competingAsk,
                    ownListing: guarded.ownListing,
                    oldPrice: guarded.oldPrice,
                    excessQuantity,
                    proposedPrice: desiredPrice,
                    anchorPrice: guarded.anchorPrice,
                    minimumAllowedPrice:
                        guarded.minimumAllowedPrice,
                };
            }

            return {
                kind: 'reprice',
                leftOne,
                competingAsk,
                ownListing: selected.ownListing,
                oldPrice: selected.oldPrice,
                newPrice: desiredPrice,
                excessQuantity,
                anchorPrice: selected.anchorPrice,
                minimumAllowedPrice:
                    selected.minimumAllowedPrice,
            };
        },

        getFinalRepostQuantity(finalListing) {
            const quantity = Number(finalListing?.unclaimedItemCount);
            return Number.isSafeInteger(quantity) && quantity > 0
                ? quantity
                : 0;
        },

        matchNewActiveListing({
            baselineListingIds,
            baselineListings,
            endMarketListings,
            expected,
        }) {
            const baselineMap = new Map();
            if (baselineListings instanceof Map) {
                for (const [id, listing] of baselineListings) {
                    const listingId = normalizeMarketListingId(id);
                    if (listingId) {
                        baselineMap.set(listingId, listing);
                    }
                }
            } else if (Array.isArray(baselineListings)) {
                for (const listing of baselineListings) {
                    const listingId = normalizeMarketListingId(
                        listing?.id
                    );
                    if (listingId) {
                        baselineMap.set(listingId, listing);
                    }
                }
            }
            const baselineIds = new Set(
                [
                    ...(baselineListingIds || []),
                    ...baselineMap.keys(),
                ]
                    .map(normalizeMarketListingId)
                    .filter(Boolean)
            );
            if (!Array.isArray(endMarketListings)) {
                return {status: 'pending'};
            }
            const matches = [];
            for (const listing of endMarketListings) {
                const listingId = normalizeMarketListingId(
                    listing?.id
                );
                if (
                    !listing ||
                    !listingId ||
                    listing.isSell !== expected?.isSell ||
                    listing.itemHrid !== expected?.itemHrid ||
                    Number(listing.enhancementLevel) !==
                        Number(expected?.enhancementLevel) ||
                    Number(listing.price) !== Number(expected?.price)
                ) {
                    continue;
                }
                const baseline = baselineMap.get(listingId);
                if (!baselineIds.has(listingId)) {
                    if (
                        Number(listing.orderQuantity) ===
                            Number(expected?.quantity)
                    ) {
                        matches.push({
                            listing,
                            merged: false,
                            baseline: null,
                        });
                    }
                    continue;
                }
                if (!baseline) continue;
                const baselineOrderQuantity = Number(
                    baseline.orderQuantity
                );
                const baselineFilledQuantity = Number(
                    baseline.filledQuantity
                );
                if (
                    baseline.status !== MARKET_ACTIVE_STATUS ||
                    baseline.isSell !== expected?.isSell ||
                    baseline.itemHrid !== expected?.itemHrid ||
                    Number(baseline.enhancementLevel) !==
                        Number(expected?.enhancementLevel) ||
                    Number(baseline.price) !== Number(expected?.price) ||
                    !Number.isSafeInteger(baselineOrderQuantity) ||
                    baselineOrderQuantity <= 0 ||
                    !Number.isSafeInteger(baselineFilledQuantity) ||
                    baselineFilledQuantity < 0 ||
                    baselineFilledQuantity >=
                        baselineOrderQuantity ||
                    Number(listing.orderQuantity) !==
                        baselineOrderQuantity +
                            Number(expected?.quantity) ||
                    Number(listing.filledQuantity) <
                        baselineFilledQuantity
                ) {
                    continue;
                }
                matches.push({
                    listing,
                    merged: true,
                    baseline,
                });
            }
            if (matches.length > 1) {
                return {
                    status: 'unknown',
                    reason:
                        '同一回执出现多条可能对应本次发单的市场记录，'
                        + '无法唯一确认结果',
                };
            }
            if (matches.length === 0) return {status: 'pending'};
            const matched = matches[0];
            const matchedListing = matched.listing;
            if (
                matchedListing.status !== MARKET_ACTIVE_STATUS &&
                matchedListing.status !==
                    '/market_listing_status/filled'
            ) {
                return {
                    status: 'unknown',
                    reason:
                        '精确匹配的市场发单首个状态不是 Active 或 Filled',
                };
            }
            const orderQuantity = Number(
                matchedListing.orderQuantity
            );
            const filledQuantity = Number(
                matchedListing.filledQuantity
            );
            const unclaimedItemCount = Number(
                matchedListing.unclaimedItemCount
            );
            const unclaimedCoinCount = Number(
                matchedListing.unclaimedCoinCount
            );
            const expectedOrderQuantity = matched.merged
                ? Number(matched.baseline.orderQuantity) +
                    Number(expected.quantity)
                : Number(expected.quantity);
            if (
                !Number.isSafeInteger(orderQuantity) ||
                orderQuantity !== expectedOrderQuantity ||
                !Number.isSafeInteger(filledQuantity) ||
                filledQuantity < 0 ||
                filledQuantity > orderQuantity ||
                !Number.isSafeInteger(unclaimedItemCount) ||
                unclaimedItemCount < 0 ||
                !Number.isSafeInteger(unclaimedCoinCount) ||
                unclaimedCoinCount < 0 ||
                (
                    matchedListing.status ===
                        MARKET_ACTIVE_STATUS &&
                    (
                        filledQuantity >= orderQuantity ||
                        unclaimedItemCount !== 0
                    )
                ) ||
                (
                    matchedListing.status ===
                        '/market_listing_status/filled' &&
                    (
                        filledQuantity !== orderQuantity ||
                        unclaimedItemCount !== 0
                    )
                )
            ) {
                return {
                    status: 'unknown',
                    reason:
                        '市场发单回执的成交或未领取字段不完整',
                };
            }
            return {
                status: 'confirmed',
                listingId: matchedListing.id,
                listing: matchedListing,
                merged: matched.merged,
                postedQuantity: Number(expected.quantity),
                filled:
                    matchedListing.status ===
                        '/market_listing_status/filled',
            };
        },

        createPostPayload({
            itemId,
            level = CONFIG.TARGET_LEVEL,
            quantity,
            price,
        }) {
            const normalizedQuantity = Number(quantity);
            const normalizedPrice = Number(price);
            if (
                !Number.isSafeInteger(normalizedQuantity) ||
                normalizedQuantity <= 0 ||
                normalizedQuantity >
                    CONFIG.MARKET_MAX_POST_QUANTITY ||
                !Number.isSafeInteger(normalizedPrice) ||
                normalizedPrice <= 0 ||
                normalizedPrice > CONFIG.MARKET_MAX_POST_PRICE
            ) {
                throw new MarketAutomationError(
                    '挂单数量或价格超出游戏允许范围'
                );
            }
            return {
                type: 'post_market_order',
                postMarketOrderData: {
                    isSell: true,
                    itemHrid: fullItemHrid(itemId),
                    enhancementLevel: Number(level),
                    quantity: normalizedQuantity,
                    price: normalizedPrice,
                    isInstantOrder: false,
                    confirmedMisprice: false,
                },
            };
        },

        applyMispriceWarning(state, warning) {
            return {
                state: {
                    ...(state || {}),
                    enabled: false,
                    status: 'disabled',
                    warning,
                    pendingPost: null,
                },
                outboundPayload: null,
            };
        },

        replaceMyListings(listings) {
            State.myMarketListings.clear();
            State.myMarketListingsReady = Array.isArray(listings);
            if (Array.isArray(listings)) {
                for (const listing of listings) {
                    const listingId = normalizeMarketListingId(
                        listing?.id
                    );
                    if (!listingId) continue;
                    if (
                        listing.status === MARKET_ACTIVE_STATUS ||
                        Number(listing.unclaimedItemCount || 0) > 0 ||
                        Number(listing.unclaimedCoinCount || 0) > 0
                    ) {
                        State.myMarketListings.set(listingId, listing);
                    }
                }
            }
            State.marketRevision++;
        },

        applyMyListingDeltas(listings) {
            if (!Array.isArray(listings)) return;
            for (const listing of listings) {
                const listingId = normalizeMarketListingId(listing?.id);
                if (!listingId) continue;
                if (
                    listing.status === MARKET_ACTIVE_STATUS ||
                    Number(listing.unclaimedItemCount || 0) > 0 ||
                    Number(listing.unclaimedCoinCount || 0) > 0
                ) {
                    State.myMarketListings.set(listingId, listing);
                } else {
                    State.myMarketListings.delete(listingId);
                    State.marketListingPriceAnchors.delete(listingId);
                    const run = State.run;
                    if (
                        run?.marketAutomationListingIds?.get(
                            normalizeShortItemId(listing.itemHrid)
                        ) === listingId
                    ) {
                        run.marketAutomationListingIds.delete(
                            normalizeShortItemId(listing.itemHrid)
                        );
                    }
                    if (
                        State.marketAutomationListingIds.get(
                            normalizeShortItemId(listing.itemHrid)
                        ) === listingId
                    ) {
                        State.marketAutomationListingIds.delete(
                            normalizeShortItemId(listing.itemHrid)
                        );
                    }
                }
            }
            State.marketRevision++;
        },

        getOutstandingOrderBookReadCount(itemId) {
            return Math.max(
                0,
                Number(
                    State.marketOutstandingOrderBookReads.get(itemId) ||
                    0
                )
            );
        },

        recordOrderBookRequest(itemId, isExternal = false) {
            const normalizedItemId = normalizeShortItemId(itemId);
            if (!normalizedItemId) return false;
            const outstanding =
                MarketMaintenance.getOutstandingOrderBookReadCount(
                    normalizedItemId
                );
            State.marketOutstandingOrderBookReads.set(
                normalizedItemId,
                outstanding + 1
            );
            if (isExternal) {
                const generation = Number(
                    State.marketExternalOrderBookGeneration.get(
                        normalizedItemId
                    ) || 0
                ) + 1;
                State.marketExternalOrderBookGeneration.set(
                    normalizedItemId,
                    generation
                );
                const op = State.marketOp;
                if (
                    op?.kind === 'order_book' &&
                    op.itemId === normalizedItemId
                ) {
                    op.orderBookContaminated = true;
                }
            }
            return true;
        },

        discardOrderBookRequest(itemId) {
            const normalizedItemId = normalizeShortItemId(itemId);
            if (!normalizedItemId) return;
            const outstanding =
                MarketMaintenance.getOutstandingOrderBookReadCount(
                    normalizedItemId
                );
            if (outstanding <= 1) {
                State.marketOutstandingOrderBookReads.delete(
                    normalizedItemId
                );
            } else {
                State.marketOutstandingOrderBookReads.set(
                    normalizedItemId,
                    outstanding - 1
                );
            }
        },

        applyOrderBook(snapshot) {
            const itemId = normalizeShortItemId(snapshot?.itemHrid);
            if (!itemId || !snapshot?.orderBooks) return;
            MarketMaintenance.discardOrderBookRequest(itemId);
            const recentExternal =
                State.recentAllowedExternalRequest;
            if (
                MarketMaintenance.getOutstandingOrderBookReadCount(
                    itemId
                ) === 0 &&
                recentExternal?.type ===
                    'get_market_item_order_books' &&
                recentExternal.itemId === itemId &&
                recentExternal.epoch === State.connectionEpoch
            ) {
                State.recentAllowedExternalRequest = null;
            }
            const sequence = ++State.marketOrderBookSequence;
            State.marketOrderBooks.set(itemId, {
                ...snapshot,
                receivedAt: Date.now(),
                sequence,
            });
            State.marketRevision++;
        },

        setItemStatus(itemId, nextStatus) {
            const previous = State.marketItemStatus.get(itemId);
            const next = {
                ...(previous || {}),
                ...nextStatus,
                itemId,
                updatedAt: Date.now(),
            };
            const previousKey = previous
                ? JSON.stringify([
                    previous.kind,
                    previous.leftOnePrice,
                    previous.ownPrice,
                    previous.ownQuantity,
                    previous.inventoryCount,
                    previous.excessQuantity,
                    previous.reason,
                ])
                : '';
            const nextKey = JSON.stringify([
                next.kind,
                next.leftOnePrice,
                next.ownPrice,
                next.ownQuantity,
                next.inventoryCount,
                next.excessQuantity,
                next.reason,
            ]);
            State.marketItemStatus.set(itemId, next);
            if (previousKey !== nextKey) State.marketRevision++;
            scheduleUiRefresh();
            return previousKey !== nextKey;
        },

        isMonitoringRun(run = State.run) {
            return Boolean(
                run &&
                State.run?.id === run.id &&
                run.marketMaintenanceEnabled === true &&
                !run.stopRequested &&
                !run.integrityFailure &&
                !State.blockedReason &&
                State.socket?.readyState === WebSocket.OPEN &&
                (
                    run.active ||
                    run.ownedActionIds?.size > 0 ||
                    run.marketFinalSweepPending === true ||
                    run.marketSteadyMonitoring === true
                )
            );
        },

        start(run) {
            if (!run) return;
            State.marketRoundRobinIndex = 0;
            run.marketAutomationListingIds ||= new Map();
            run.marketQuoteConfirmations ||= new Map();
            run.marketPostInventoryBarriers ||= new Map();
            run.marketPriorityItemId ||= null;
            run.marketFinalSweepPending = false;
            run.marketSteadyMonitoring = false;
            run.marketFinalSweepPhase ||= 'idle';
            run.marketFinalSweepRemaining ||= new Set();
            run.marketFinalSweepAttempts ||= new Map();
            for (const itemId of run.itemIds || []) {
                const rememberedAutomationId =
                    normalizeMarketListingId(
                        State.marketAutomationListingIds.get(itemId)
                    );
                if (rememberedAutomationId) {
                    const rememberedListing =
                        State.myMarketListings.get(
                            rememberedAutomationId
                        );
                    if (
                        rememberedListing &&
                        (
                            rememberedListing.status ===
                                MARKET_ACTIVE_STATUS ||
                            (
                                MARKET_TERMINAL_STATUSES.has(
                                    rememberedListing.status
                                ) &&
                                (
                                    Number(
                                        rememberedListing
                                            .unclaimedItemCount || 0
                                    ) > 0 ||
                                    Number(
                                        rememberedListing
                                            .unclaimedCoinCount || 0
                                    ) > 0
                                )
                            )
                        ) &&
                        rememberedListing.isSell === true &&
                        rememberedListing.itemHrid ===
                            fullItemHrid(itemId) &&
                        Number(
                            rememberedListing.enhancementLevel
                        ) === CONFIG.TARGET_LEVEL
                    ) {
                        run.marketAutomationListingIds.set(
                            itemId,
                            rememberedAutomationId
                        );
                    } else {
                        State.marketAutomationListingIds.delete(
                            itemId
                        );
                    }
                }
                const activeListings =
                    MarketMaintenance.getOwnActiveSellListings(
                        State.myMarketListings,
                        itemId
                    );
                for (const listing of activeListings) {
                    const listingId = normalizeMarketListingId(
                        listing.id
                    );
                    const price = Number(listing.price);
                    if (
                        listingId &&
                        Number.isSafeInteger(price) &&
                        price > 0 &&
                        !State.marketListingPriceAnchors.has(listingId)
                    ) {
                        State.marketListingPriceAnchors.set(
                            listingId,
                            price
                        );
                    }
                }
            }
            MarketMaintenance.scheduleNext(250);
        },

        beginFinalSweep(run) {
            if (
                run?.marketFinalSweepPhase === 'running'
            ) {
                return true;
            }
            if (
                run?.marketFinalSweepPhase === 'completed' ||
                run?.marketFinalSweepPhase === 'aborted'
            ) {
                return false;
            }
            if (
                !run ||
                State.run?.id !== run.id ||
                run.active ||
                run.ownedActionIds?.size > 0 ||
                !['completed', 'queued'].includes(run.status) ||
                !run.marketMaintenanceEnabled ||
                !State.settings.marketMaintenanceEnabled ||
                run.stopRequested ||
                run.integrityFailure ||
                State.blockedReason ||
                State.marketWriteBlockedReason
            ) {
                MarketMaintenance.stopScheduling();
                return false;
            }
            run.marketFinalSweepPending = true;
            run.marketSteadyMonitoring = false;
            run.marketFinalSweepPhase = 'running';
            run.marketFinalSweepRemaining = new Set(
                run.itemIds || []
            );
            run.marketFinalSweepAttempts = new Map();
            run.marketQuoteConfirmations?.clear();
            State.marketRoundRobinIndex = 0;
            run.currentStage =
                '强化已结束，检查 +20 库存并完成市场最终扫尾';
            log(
                '开始市场最终扫尾：每种 +20 实体库存保留 1 件，'
                + '其余按当前价格规则处理',
                'success'
            );
            State.ui?.setLocked(true);
            MarketMaintenance.scheduleNext(0);
            scheduleUiRefresh();
            return true;
        },

        abortFinalSweep(run, reason = '市场最终扫尾已停止') {
            if (
                !run ||
                (
                    run.marketFinalSweepPhase !== 'waiting_inventory' &&
                    run.marketFinalSweepPhase !== 'running'
                )
            ) {
                return false;
            }
            run.marketFinalSweepPending = false;
            run.marketSteadyMonitoring = false;
            run.marketFinalSweepPhase = 'aborted';
            run.marketFinalSweepRemaining?.clear();
            run.marketQuoteConfirmations?.clear();
            if (run.marketFinalSweepInventoryTimer) {
                window.clearTimeout(
                    run.marketFinalSweepInventoryTimer
                );
                run.marketFinalSweepInventoryTimer = null;
            }
            if (!run.active) {
                run.currentStage = reason;
                State.ui?.setLocked(false);
            }
            MarketMaintenance.stopScheduling();
            scheduleUiRefresh();
            return true;
        },

        finishFinalSweepItem(run, itemId, reason = '') {
            if (
                !run?.marketFinalSweepPending ||
                !run.marketFinalSweepRemaining?.has(itemId)
            ) {
                return;
            }
            run.marketFinalSweepRemaining.delete(itemId);
            if (reason) {
                log(
                    `${getItemName(itemId)} +20 最终扫尾结束：${reason}`,
                    /无法|异常|拦截|保持不动/.test(reason)
                        ? 'warn'
                        : 'success'
                );
            }
            if (run.marketFinalSweepRemaining.size > 0) return;
            run.marketFinalSweepPending = false;
            run.marketFinalSweepPhase = 'completed';
            run.marketSteadyMonitoring = true;
            run.currentStage =
                '已结束；市场最终扫尾完成，持续监控左一与成交';
            log(
                '市场最终扫尾完成；页面保持打开且自动出售开启时，'
                + '将继续低频检查左一、跟价和领取成交款',
                'success'
            );
            State.ui?.setLocked(false);
            MarketMaintenance.scheduleNext();
            scheduleUiRefresh();
        },

        noteFinalSweepReadFailure(run, itemId, reason) {
            if (!run?.marketFinalSweepPending) return false;
            const attempts = Number(
                run.marketFinalSweepAttempts?.get(itemId) || 0
            ) + 1;
            run.marketFinalSweepAttempts.set(itemId, attempts);
            if (
                attempts <
                    CONFIG.MARKET_FINAL_SWEEP_MAX_ATTEMPTS
            ) {
                return true;
            }
            MarketMaintenance.finishFinalSweepItem(
                run,
                itemId,
                `连续 ${attempts} 次无法取得可信盘口，`
                    + `多余库存保持不动（${reason}）`
            );
            return false;
        },

        clearPostInventoryBarrier(run, itemId, barrier = null) {
            const current = run?.marketPostInventoryBarriers?.get(
                itemId
            );
            if (!current || (barrier && current !== barrier)) {
                return false;
            }
            if (current.guardTimer) {
                window.clearTimeout(current.guardTimer);
                current.guardTimer = null;
            }
            run.marketPostInventoryBarriers.delete(itemId);
            return true;
        },

        expirePostInventoryBarrier(run, itemId, barrier) {
            if (
                !run ||
                State.run?.id !== run.id ||
                run.marketPostInventoryBarriers?.get(itemId) !==
                    barrier
            ) {
                return false;
            }
            MarketMaintenance.maybeClearPostInventoryBarrier(
                run,
                itemId
            );
            if (
                run.marketPostInventoryBarriers?.get(itemId) !==
                    barrier
            ) {
                return false;
            }
            if (barrier.guardTimer) {
                window.clearTimeout(barrier.guardTimer);
                barrier.guardTimer = null;
            }
            const expected = Number(
                barrier.currentExpectedInventory ??
                barrier.expectedAfterPost
            );
            const current = getItemCount(
                itemId,
                CONFIG.TARGET_LEVEL
            );
            const reason =
                `${getItemName(itemId)} +20 卖单已确认，但库存绝对值`
                + `未在宽限期内收束到可证明的 ${expected}`
                + `（当前 ${current}）；为防止把旧库存基线带入新批次，`
                + '必须完整刷新页面';
            State.blockedReason = State.blockedReason || reason;
            run.stopRequested = true;
            run.currentStage =
                '挂单库存回执未收束，已锁定到完整刷新';
            MarketMaintenance.disableWrites(reason, itemId);
            scheduleUiRefresh();
            return true;
        },

        armPostInventoryBarrierGuard(run, itemId, barrier) {
            if (
                !barrier?.postConfirmed ||
                run?.marketPostInventoryBarriers?.get(itemId) !==
                    barrier
            ) {
                return;
            }
            if (barrier.guardTimer) {
                window.clearTimeout(barrier.guardTimer);
            }
            const confirmedAt = Number(barrier.confirmedAt || Date.now());
            const delay = Math.max(
                0,
                confirmedAt +
                    CONFIG.INVENTORY_COMMIT_GRACE_MS -
                    Date.now()
            ) + 25;
            barrier.guardTimer = window.setTimeout(() => {
                barrier.guardTimer = null;
                MarketMaintenance.expirePostInventoryBarrier(
                    run,
                    itemId,
                    barrier
                );
            }, delay);
        },

        maybeClearPostInventoryBarrier(run, itemId) {
            const barrier = run?.marketPostInventoryBarriers?.get(
                itemId
            );
            if (!barrier) return false;
            const expectedInventory = barrier.expectedAfterPost;
            barrier.currentExpectedInventory = expectedInventory;
            const observationIsCausallySafe = Boolean(
                barrier.allowPreReceiptInventory ||
                (
                    Number(barrier.postReceiptSequence) > 0 &&
                    Number(barrier.lastObservedSequence) >=
                        Number(barrier.postReceiptSequence)
                )
            );
            barrier.inventoryMatched =
                observationIsCausallySafe &&
                Number(barrier.lastObservedInventoryCount) ===
                    expectedInventory;
            if (
                barrier.postConfirmed &&
                barrier.inventoryMatched
            ) {
                MarketMaintenance.clearPostInventoryBarrier(
                    run,
                    itemId,
                    barrier
                );
                if (run.marketFinalSweepPending) {
                    MarketMaintenance.scheduleNext(0);
                }
                return true;
            }
            return false;
        },

        observeInventoryUpdate(itemId, level) {
            if (Number(level) !== CONFIG.TARGET_LEVEL) return;
            const run = State.run;
            const barrier = run?.marketPostInventoryBarriers?.get(
                itemId
            );
            if (!barrier) return;
            barrier.lastObservedInventoryCount = getItemCount(
                itemId,
                CONFIG.TARGET_LEVEL
            );
            barrier.lastObservedSequence = State.incomingSequence;
            MarketMaintenance.maybeClearPostInventoryBarrier(
                run,
                itemId
            );
        },

        getAutomationListingIds(run, itemId) {
            const listingId = normalizeMarketListingId(
                run?.marketAutomationListingIds?.get(itemId) ||
                State.marketAutomationListingIds.get(itemId)
            );
            if (!listingId) return new Set();
            const listing = State.myMarketListings.get(listingId);
            if (
                !listing ||
                listing.status !== MARKET_ACTIVE_STATUS ||
                listing.isSell !== true ||
                listing.itemHrid !== fullItemHrid(itemId) ||
                Number(listing.enhancementLevel) !==
                    CONFIG.TARGET_LEVEL
            ) {
                run?.marketAutomationListingIds?.delete(itemId);
                State.marketAutomationListingIds.delete(itemId);
                return new Set();
            }
            run?.marketAutomationListingIds?.set(itemId, listingId);
            return new Set([listingId]);
        },

        async claimFilledAutomationListing(run, itemId) {
            const listingId = normalizeMarketListingId(
                run?.marketAutomationListingIds?.get(itemId) ||
                State.marketAutomationListingIds.get(itemId)
            );
            if (!listingId) return null;
            const listing = State.myMarketListings.get(listingId);
            if (!listing) {
                run?.marketAutomationListingIds?.delete(itemId);
                State.marketAutomationListingIds.delete(itemId);
                return null;
            }
            if (listing.status === MARKET_ACTIVE_STATUS) return null;
            if (
                !MARKET_TERMINAL_STATUSES.has(listing.status)
            ) {
                MarketMaintenance.disableWrites(
                    `${getItemName(itemId)} +20 脚本卖单出现`
                    + `未知终态 ${String(listing.status)}`,
                    itemId
                );
                return {
                    claimed: false,
                    reason: '脚本卖单终态未知',
                };
            }
            const unclaimedItems = Number(
                listing.unclaimedItemCount || 0
            );
            const unclaimedCoins = Number(
                listing.unclaimedCoinCount || 0
            );
            const isFilled = listing.status ===
                '/market_listing_status/filled';
            const validationError =
                validateCancelledListing(listing, listing) ||
                (
                    isFilled && unclaimedItems !== 0
                        ? '已成交卖单不应含有未领取物品'
                        : ''
                );
            if (
                !Number.isSafeInteger(unclaimedItems) ||
                unclaimedItems < 0 ||
                !Number.isSafeInteger(unclaimedCoins) ||
                unclaimedCoins < 0 ||
                validationError
            ) {
                MarketMaintenance.disableWrites(
                    `${getItemName(itemId)} +20 脚本卖单的`
                    + `终态字段异常${validationError
                        ? `：${validationError}`
                        : ''}`,
                    itemId
                );
                return {
                    claimed: false,
                    reason: '已成交卖单字段异常',
                };
            }
            if (unclaimedItems === 0 && unclaimedCoins === 0) {
                run?.marketAutomationListingIds?.delete(itemId);
                State.marketAutomationListingIds.delete(itemId);
                return null;
            }
            if (
                unclaimedItems > 0 &&
                !isQuickItemMarketWriteSafe(run, itemId)
            ) {
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'deferred_terminal_claim',
                    inventoryCount: getItemCount(
                        itemId,
                        CONFIG.TARGET_LEVEL
                    ),
                    excessQuantity: getMarketExcessInventory(itemId),
                    reason:
                        '等本批动作全部完成后再领取到期/撤销余货',
                });
                return {
                    claimed: false,
                    reason: '余货领取延后到强化结束',
                };
            }
            const accessIssue =
                MarketMaintenance.getMarketWriteAccessIssue(
                    run,
                    itemId,
                    false
                );
            if (accessIssue) {
                MarketMaintenance.disableWrites(
                    `${getItemName(itemId)} +20 终态卖单领取前：`
                        + accessIssue.reason,
                    itemId
                );
                return {
                    claimed: false,
                    reason: accessIssue.reason,
                };
            }
            const inventory = getItemCount(
                itemId,
                CONFIG.TARGET_LEVEL
            );
            MarketMaintenance.setItemStatus(itemId, {
                kind: unclaimedItems > 0
                    ? 'claiming_terminal_listing'
                    : 'claiming_sale_coins',
                inventoryCount: inventory,
                excessQuantity: getMarketExcessInventory(itemId),
                reason:
                    `领取脚本卖单 ${listingId} 的`
                    + (
                        unclaimedItems > 0
                            ? `余货 ${unclaimedItems} 件及成交款`
                            : '成交款'
                    ),
            });
            await MarketMaintenance.requireMarketOutcome(
                MarketTransactions.begin(run, {
                    kind: 'claim',
                    itemId,
                    listingId,
                    expectedListing: listing,
                    quantity: unclaimedItems,
                    baselineInventory: inventory,
                    expectedInventory:
                        inventory + unclaimedItems,
                    timeoutMs: CONFIG.MARKET_WRITE_TIMEOUT_MS,
                    timeoutMessage:
                        `领取终态脚本卖单 ${listingId} 超时`,
                    payload: {
                        type: 'claim_market_listing',
                        claimMarketListingData: {
                            marketListingId: listing.id,
                        },
                    },
                }),
                {
                    mutationMayHaveApplied: true,
                    itemId,
                }
            );
            if (unclaimedItems > 0) {
                adjustRunMarketInventoryOffset(
                    run,
                    itemId,
                    unclaimedItems
                );
            }
            run?.marketAutomationListingIds?.delete(itemId);
            State.marketAutomationListingIds.delete(itemId);
            MarketMaintenance.setItemStatus(itemId, {
                kind: unclaimedItems > 0
                    ? 'claimed_terminal_listing'
                    : 'claimed_sale_coins',
                inventoryCount: getItemCount(
                    itemId,
                    CONFIG.TARGET_LEVEL
                ),
                excessQuantity: getMarketExcessInventory(itemId),
                reason: unclaimedItems > 0
                    ? `脚本卖单 ${listingId} 的余货与成交款已领取`
                    : `脚本卖单 ${listingId} 的成交款已领取`,
            });
            return {
                claimed: true,
                needsAnotherPoll: true,
                reason: '已领取成交款',
            };
        },

        scheduleNext(delay = CONFIG.MARKET_POLL_MS) {
            if (State.marketTimer) {
                window.clearTimeout(State.marketTimer);
                State.marketTimer = null;
            }
            if (
                !State.settings.marketMaintenanceEnabled ||
                State.marketWriteBlockedReason ||
                !MarketMaintenance.isMonitoringRun()
            ) {
                return;
            }
            State.marketTimer = window.setTimeout(() => {
                State.marketTimer = null;
                MarketMaintenance.tick().catch((error) => {
                    log(
                        `市场维护调度异常：${error.message || error}`,
                        'error'
                    );
                });
            }, Math.max(0, delay));
        },

        stopScheduling() {
            if (State.marketTimer) {
                window.clearTimeout(State.marketTimer);
                State.marketTimer = null;
            }
            scheduleUiRefresh();
        },

        async waitUntilIdle() {
            while (State.marketBusy || State.marketOp) {
                await new Promise((resolve) => {
                    window.setTimeout(resolve, 25);
                });
            }
        },

        disableWrites(reason, itemId = '') {
            const normalizedReason = String(
                reason || '市场写操作结果不明确'
            );
            State.marketWriteBlockedReason =
                State.marketWriteBlockedReason || normalizedReason;
            State.settings.marketMaintenanceEnabled = false;
            State.settings.marketAutoSellExcessEnabled = false;
            if (State.run) {
                State.run.marketSteadyMonitoring = false;
            }
            saveSettings();
            MarketMaintenance.abortFinalSweep(
                State.run,
                `市场最终扫尾已停止：${normalizedReason}`
            );
            MarketMaintenance.stopScheduling();
            if (itemId) {
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'disabled',
                    reason: normalizedReason,
                });
            }
            log(
                `市场自动维护已停用：${normalizedReason}。`
                + '不会再发送新的市场写请求；验证慢排若无法继续'
                + '精确解释 +20 库存，也会停止后续强化',
                'error'
            );
        },

        settingChanged() {
            State.settings.marketAutoSellExcessEnabled =
                State.settings.marketMaintenanceEnabled === true;
            saveSettings();
            if (!State.settings.marketMaintenanceEnabled) {
                if (State.run) {
                    State.run.marketSteadyMonitoring = false;
                }
                MarketMaintenance.abortFinalSweep(
                    State.run,
                    '你已关闭市场自动出售；最终扫尾停止'
                );
                MarketMaintenance.stopScheduling();
                return;
            }
            if (State.marketWriteBlockedReason) {
                State.settings.marketMaintenanceEnabled = false;
                saveSettings();
                window.alert(
                    '本页曾出现结果不明确的市场写操作或错价警告。'
                    + '为防止重复撤挂，必须完整刷新页面后才能重新启用。'
                );
                scheduleUiRefresh();
                return;
            }
            MarketMaintenance.scheduleNext(0);
        },

        describeDecision(decision) {
            return {
                leftOnePrice: decision.leftOne?.price ?? null,
                ownPrice: Number.isFinite(
                    Number(decision.ownListing?.price)
                ) ? Number(decision.ownListing.price) : null,
                ownQuantity: decision.ownListing
                    ? Math.max(
                        0,
                        Number(decision.ownListing.orderQuantity || 0) -
                            Number(decision.ownListing.filledQuantity || 0)
                    )
                    : 0,
                inventoryCount: Number(
                    decision.inventoryCount ?? 0
                ),
                excessQuantity: Number(
                    decision.excessQuantity ?? 0
                ),
            };
        },

        async requireMarketOutcome(
            promise,
            {mutationMayHaveApplied = false, itemId = ''}
        ) {
            const outcome = await promise;
            if (outcome.status === 'confirmed') return outcome;
            if (outcome.status === 'misprice') {
                MarketMaintenance.disableWrites(
                    `${getItemName(itemId)} +20 重挂触发服务器错价警告；`
                    + '脚本没有自动确认，也没有重发',
                    itemId
                );
                throw new MarketAutomationError(
                    outcome.reason || '服务器错价警告',
                    false
                );
            }
            throw new MarketAutomationError(
                outcome.reason || '市场请求没有得到精确回执',
                mutationMayHaveApplied
            );
        },

        async refreshOrderBook(
            run,
            itemId,
            mustCompleteReprice = false
        ) {
            const drainStartedAt = Date.now();
            while (
                MarketMaintenance.getOutstandingOrderBookReadCount(
                    itemId
                ) > 0
            ) {
                if (
                    Date.now() - drainStartedAt >=
                        CONFIG.MARKET_READ_TIMEOUT_MS
                ) {
                    throw new MarketAutomationError(
                        `${getItemName(itemId)} +20 仍有外部或迟到的`
                        + '盘口响应未收束；本轮只读跳过'
                    );
                }
                if (
                    run.integrityFailure ||
                    State.blockedReason ||
                    State.marketWriteBlockedReason ||
                    State.run?.id !== run.id
                ) {
                    throw new MarketAutomationError(
                        '等待盘口响应收束时运行状态已失效'
                    );
                }
                await new Promise((resolve) => {
                    window.setTimeout(resolve, 25);
                });
            }
            const previousRequestAt = Number(
                State.marketLastOrderBookRequestAt.get(itemId) || 0
            );
            const minimumGap = runtimeTestMode
                ? 0
                : CONFIG.MARKET_POLL_MS;
            const waitMilliseconds = Math.max(
                0,
                previousRequestAt + minimumGap - Date.now()
            );
            if (waitMilliseconds > 0) {
                await new Promise((resolve) => {
                    window.setTimeout(resolve, waitMilliseconds);
                });
            }
            if (
                run.integrityFailure ||
                State.blockedReason ||
                State.marketWriteBlockedReason ||
                !State.socket ||
                State.socket.readyState !== WebSocket.OPEN ||
                State.run?.id !== run.id ||
                run.characterId !== State.characterId ||
                run.characterId !== getCharacterId() ||
                run.syncEpoch !== State.syncEpoch
            ) {
                throw new MarketAutomationError(
                    '市场收尾前角色、连接或完整性状态已失效'
                );
            }
            if (
                !mustCompleteReprice &&
                (
                    !State.settings.marketMaintenanceEnabled ||
                    !MarketMaintenance.isMonitoringRun(run)
                )
            ) {
                throw new MarketAutomationError(
                    '市场轮询已停止'
                );
            }
            if (
                MarketMaintenance.getOutstandingOrderBookReadCount(
                    itemId
                ) > 0
            ) {
                throw new MarketAutomationError(
                    `${getItemName(itemId)} +20 刚收到新的外部盘口请求；`
                    + '等待其响应后再读取'
                );
            }
            State.marketLastOrderBookRequestAt.set(
                itemId,
                Date.now()
            );
            return MarketMaintenance.requireMarketOutcome(
                MarketTransactions.begin(run, {
                    kind: 'order_book',
                    itemId,
                    timeoutMs: CONFIG.MARKET_READ_TIMEOUT_MS,
                    timeoutMessage:
                        `${getItemName(itemId)} +20 盘口读取超时`,
                    payload: {
                        type: 'get_market_item_order_books',
                        getMarketItemOrderBooksData: {
                            itemHrid: fullItemHrid(itemId),
                        },
                    },
                }),
                {itemId}
            );
        },

        getMarketWriteAccessIssue(run, itemId, requireSlot = true) {
            if (
                !State.clientMarketDataReady ||
                !State.characterMarketAccessReady
            ) {
                return {
                    kind: 'access',
                    reason: '市场物品规则或角色交易权限尚未完整同步',
                };
            }
            if (!State.hasAcceptedTradingRules) {
                return {
                    kind: 'access',
                    reason: '角色尚未在游戏内接受市场交易规则',
                };
            }
            const restricted = isCharacterMarketRestricted();
            if (restricted !== false) {
                return {
                    kind: 'access',
                    reason: restricted === true
                        ? '当前游戏模式禁止市场交易'
                        : '无法确认当前游戏模式的市场权限',
                };
            }
            const currentRule = getMarketItemRule(itemId);
            const frozenRule = run?.marketItemRules?.get(itemId);
            if (
                !currentRule ||
                currentRule.isTradable !== true ||
                !Number.isSafeInteger(currentRule.sellPrice) ||
                currentRule.sellPrice < 0 ||
                !frozenRule ||
                frozenRule.isTradable !== currentRule.isTradable ||
                frozenRule.sellPrice !== currentRule.sellPrice
            ) {
                return {
                    kind: 'access',
                    reason: '物品交易规则缺失、不可交易或运行中发生变化',
                };
            }
            if (
                !Number.isSafeInteger(State.marketListingCap) ||
                State.marketListingCap < 0
            ) {
                return {
                    kind: 'access',
                    reason: '本人市场挂单容量尚未同步',
                };
            }
            if (
                requireSlot &&
                State.myMarketListings.size >=
                    State.marketListingCap
            ) {
                return {
                    kind: 'capacity',
                    reason:
                        `挂单槽已满 ${State.myMarketListings.size}/`
                        + `${State.marketListingCap}`,
                };
            }
            return null;
        },

        async postExcessInventory(
            run,
            itemId,
            {
                price,
                anchorPrice,
                leftOnePrice = null,
                successKind = 'listed',
                atomicCleanup = false,
            } = {}
        ) {
            if (
                !atomicCleanup &&
                (
                    !State.settings.marketMaintenanceEnabled ||
                    !MarketMaintenance.isMonitoringRun(run)
                )
            ) {
                return {
                    posted: false,
                    reason: '市场轮询已停止',
                };
            }
            if (
                run?.marketPostInventoryBarriers?.has(itemId)
            ) {
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'waiting_inventory_sync',
                    inventoryCount: getItemCount(
                        itemId,
                        CONFIG.TARGET_LEVEL
                    ),
                    excessQuantity: getMarketExcessInventory(itemId),
                    reason: '等待上一张卖单的库存绝对值回执',
                });
                return {
                    posted: false,
                    needsAnotherPoll: true,
                    reason: '等待库存同步',
                };
            }

            const accessIssue =
                MarketMaintenance.getMarketWriteAccessIssue(
                    run,
                    itemId,
                    true
                );
            if (accessIssue) {
                MarketMaintenance.setItemStatus(itemId, {
                    kind: accessIssue.kind === 'capacity'
                        ? 'listing_cap'
                        : 'market_access_blocked',
                    inventoryCount: getItemCount(
                        itemId,
                        CONFIG.TARGET_LEVEL
                    ),
                    excessQuantity: getMarketExcessInventory(itemId),
                    reason: accessIssue.reason,
                });
                if (accessIssue.kind === 'access') {
                    MarketMaintenance.disableWrites(
                        `${getItemName(itemId)} +20：`
                            + accessIssue.reason,
                        itemId
                    );
                }
                return {
                    posted: false,
                    reason: accessIssue.reason,
                };
            }

            const inventoryBeforePost = Number(
                getItemCount(itemId, CONFIG.TARGET_LEVEL)
            );
            const quantity = Math.max(
                0,
                inventoryBeforePost -
                    CONFIG.MARKET_RESERVED_INVENTORY
            );
            if (
                !Number.isSafeInteger(inventoryBeforePost) ||
                inventoryBeforePost < 0 ||
                !Number.isSafeInteger(quantity) ||
                quantity > CONFIG.MARKET_MAX_POST_QUANTITY
            ) {
                throw new MarketAutomationError(
                    '挂单前 +20 库存数量无效'
                );
            }
            if (quantity <= 0) {
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'reserve_only',
                    leftOnePrice,
                    inventoryCount: inventoryBeforePost,
                    excessQuantity: 0,
                    reason: '库存仅够保留 1 件自用，不挂单',
                });
                return {
                    posted: false,
                    reason: '没有可出售库存',
                };
            }
            if (
                quantity >
                    inventoryBeforePost -
                        CONFIG.MARKET_RESERVED_INVENTORY
            ) {
                throw new MarketAutomationError(
                    '内部错误：拟挂数量会侵占保留库存'
                );
            }
            const itemRule = run.marketItemRules.get(itemId);
            const normalizedPrice = Number(price);
            if (
                !Number.isSafeInteger(normalizedPrice) ||
                normalizedPrice < itemRule.sellPrice ||
                normalizedPrice <= 0 ||
                normalizedPrice > CONFIG.MARKET_MAX_POST_PRICE
            ) {
                throw new MarketAutomationError(
                    '拟挂价格不符合物品商店底价或游戏价格上限'
                );
            }
            const prospectiveAnchors = [
                Number(anchorPrice),
                Number(State.marketItemPriceAnchors.get(itemId)),
            ];
            for (
                const listing of
                MarketMaintenance.getOwnActiveSellListings(
                    State.myMarketListings,
                    itemId
                )
            ) {
                if (Number(listing.price) !== normalizedPrice) {
                    continue;
                }
                prospectiveAnchors.push(
                    Number(
                        State.marketListingPriceAnchors.get(
                            normalizeMarketListingId(listing.id)
                        )
                    ),
                    Number(listing.price)
                );
            }
            const prospectiveAnchor = Math.max(
                normalizedPrice,
                ...prospectiveAnchors.filter(
                    (candidate) => (
                        Number.isSafeInteger(candidate) &&
                        candidate > 0
                    )
                )
            );
            const effectiveMaxDropPercent = (
                Number.isFinite(Number(run.marketMaxDropPercent))
            )
                ? Math.min(
                    Math.max(
                        Number(run.marketMaxDropPercent),
                        CONFIG.MARKET_MIN_DROP_PERCENT
                    ),
                    CONFIG.MARKET_MAX_DROP_PERCENT
                )
                : CONFIG.MARKET_DEFAULT_MAX_DROP_PERCENT;
            const minimumAllowedPrice = Math.ceil(
                prospectiveAnchor *
                    (1 - effectiveMaxDropPercent / 100)
            );
            if (normalizedPrice < minimumAllowedPrice) {
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'guarded',
                    leftOnePrice,
                    inventoryCount: inventoryBeforePost,
                    excessQuantity: quantity,
                    reason:
                        `发送前复核：拟挂价 ${normalizedPrice} 低于`
                        + `价格谱系保护底价 ${minimumAllowedPrice}`,
                });
                return {
                    posted: false,
                    reason: '累计跌价保护在发送前拦截',
                };
            }

            const postPayload = MarketMaintenance.createPostPayload({
                itemId,
                quantity,
                price: normalizedPrice,
            });
            const expectedPost = {
                ...postPayload.postMarketOrderData,
            };
            delete expectedPost.confirmedMisprice;
            const baselineListings = new Map(
                [...State.myMarketListings.entries()].map(
                    ([listingId, listing]) => [
                        listingId,
                        {...listing},
                    ]
                )
            );
            const barrier = {
                postConfirmed: false,
                inventoryBeforePost,
                expectedAfterPost:
                    inventoryBeforePost - quantity,
                lastObservedInventoryCount: null,
                lastObservedSequence: 0,
                inventoryMatched: false,
                confirmedAt: null,
                postReceiptSequence: 0,
                allowPreReceiptInventory:
                    isQuickItemMarketWriteSafe(run, itemId),
            };
            run.marketPostInventoryBarriers.set(itemId, barrier);
            MarketMaintenance.setItemStatus(itemId, {
                kind: 'posting',
                leftOnePrice,
                ownPrice: normalizedPrice,
                ownQuantity: quantity,
                inventoryCount: inventoryBeforePost,
                excessQuantity: quantity,
                reason: `保留 ${CONFIG.MARKET_RESERVED_INVENTORY} 件`,
            });

            let postOutcome;
            try {
                postOutcome =
                    await MarketMaintenance.requireMarketOutcome(
                        MarketTransactions.begin(run, {
                            kind: 'post',
                            itemId,
                            expectedPost,
                            baselineListings,
                            baselineListingIds: new Set(
                                baselineListings.keys()
                            ),
                            timeoutMs:
                                CONFIG.MARKET_WRITE_TIMEOUT_MS,
                            timeoutMessage:
                                `${getItemName(itemId)} +20 挂出超时；`
                                + '不知道卖单是否已创建或合并',
                            payload: postPayload,
                        }),
                        {
                            mutationMayHaveApplied: true,
                            itemId,
                        }
                    );
            } catch (error) {
                if (!error?.mutationMayHaveApplied) {
                    MarketMaintenance.clearPostInventoryBarrier(
                        run,
                        itemId,
                        barrier
                    );
                }
                throw error;
            }

            barrier.postConfirmed = true;
            barrier.confirmedAt = Date.now();
            barrier.postReceiptSequence = State.incomingSequence;
            MarketMaintenance.maybeClearPostInventoryBarrier(
                run,
                itemId
            );
            MarketMaintenance.armPostInventoryBarrierGuard(
                run,
                itemId,
                barrier
            );
            if (run.mode === 'verified') {
                const startedAt = Date.now();
                while (
                    getItemCount(itemId, CONFIG.TARGET_LEVEL) !==
                        barrier.expectedAfterPost &&
                    Date.now() - startedAt <
                        CONFIG.INVENTORY_COMMIT_GRACE_MS
                ) {
                    await new Promise((resolve) => {
                        window.setTimeout(resolve, 25);
                    });
                }
                if (
                    getItemCount(itemId, CONFIG.TARGET_LEVEL) !==
                        barrier.expectedAfterPost
                ) {
                    MarketMaintenance.disableWrites(
                        `${getItemName(itemId)} +20 卖单已确认，但`
                        + '库存扣除没有在宽限期内精确收束；'
                        + '已停止本次验证慢排继续发送',
                        itemId
                    );
                    run.stopRequested = true;
                    run.currentStage =
                        '市场挂单库存回执不完整，停止验证慢排';
                    throw new MarketAutomationError(
                        '市场挂单库存回执不完整',
                        true
                    );
                }
                MarketMaintenance.clearPostInventoryBarrier(
                    run,
                    itemId,
                    barrier
                );
            }

            adjustRunMarketInventoryOffset(
                run,
                itemId,
                -quantity
            );
            const newListingId = normalizeMarketListingId(
                postOutcome.listingId
            );
            const normalizedAnchor = prospectiveAnchor;
            const existingListingAnchor = Number(
                State.marketListingPriceAnchors.get(newListingId)
            );
            const existingItemAnchor = Number(
                State.marketItemPriceAnchors.get(itemId)
            );
            const effectiveAnchor = Math.max(
                Number.isSafeInteger(normalizedAnchor) &&
                    normalizedAnchor > 0
                    ? normalizedAnchor
                    : normalizedPrice,
                Number.isSafeInteger(existingListingAnchor) &&
                    existingListingAnchor > 0
                    ? existingListingAnchor
                    : 0,
                Number.isSafeInteger(existingItemAnchor) &&
                    existingItemAnchor > 0
                    ? existingItemAnchor
                    : 0
            );
            State.marketItemPriceAnchors.set(
                itemId,
                effectiveAnchor
            );
            if (newListingId && !postOutcome.filled) {
                State.marketListingPriceAnchors.set(
                    newListingId,
                    effectiveAnchor
                );
                run.marketAutomationListingIds.set(
                    itemId,
                    newListingId
                );
                State.marketAutomationListingIds.set(
                    itemId,
                    newListingId
                );
            } else {
                run.marketAutomationListingIds.delete(itemId);
                State.marketAutomationListingIds.delete(itemId);
            }

            if (postOutcome.filled) {
                const unclaimedCoinCount = Number(
                    postOutcome.listing?.unclaimedCoinCount || 0
                );
                if (unclaimedCoinCount > 0) {
                    const filledInventoryBaseline = getItemCount(
                        itemId,
                        CONFIG.TARGET_LEVEL
                    );
                    await MarketMaintenance.requireMarketOutcome(
                        MarketTransactions.begin(run, {
                            kind: 'claim',
                            itemId,
                            listingId: newListingId,
                            expectedListing:
                                postOutcome.listing,
                            quantity: 0,
                            baselineInventory:
                                filledInventoryBaseline,
                            expectedInventory:
                                filledInventoryBaseline,
                            timeoutMs:
                                CONFIG.MARKET_WRITE_TIMEOUT_MS,
                            timeoutMessage:
                                `领取已立即成交挂单 ${newListingId} `
                                + '的出售款超时',
                            payload: {
                                type: 'claim_market_listing',
                                claimMarketListingData: {
                                    marketListingId:
                                        postOutcome.listing.id,
                                },
                            },
                        }),
                        {
                            mutationMayHaveApplied: true,
                            itemId,
                        }
                    );
                }
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'sold_during_post',
                    leftOnePrice: normalizedPrice,
                    ownPrice: null,
                    ownQuantity: 0,
                    inventoryCount: getItemCount(
                        itemId,
                        CONFIG.TARGET_LEVEL
                    ),
                    excessQuantity: 0,
                    reason: unclaimedCoinCount > 0
                        ? `本次 ${formatInt(quantity)} 件立即售完；`
                            + '出售款已领取'
                        : `本次 ${formatInt(quantity)} 件立即售完`,
                });
                log(
                    `${getItemName(itemId)} +20：`
                    + `${formatInt(quantity)} 件按 `
                    + `${formatInt(normalizedPrice)} 挂出后立即售完`
                    + (
                        unclaimedCoinCount > 0
                            ? '，出售款已领取'
                            : ''
                    ),
                    'success'
                );
                return {
                    posted: true,
                    quantity,
                    price: normalizedPrice,
                    filled: true,
                    listingId: newListingId,
                    needsAnotherPoll:
                        run.marketPostInventoryBarriers.has(itemId),
                };
            }

            const activeRemaining = Math.max(
                0,
                Number(postOutcome.listing.orderQuantity || 0) -
                    Number(postOutcome.listing.filledQuantity || 0)
            );
            MarketMaintenance.setItemStatus(itemId, {
                kind: successKind,
                leftOnePrice: normalizedPrice,
                ownPrice: normalizedPrice,
                ownQuantity: activeRemaining,
                inventoryCount: getItemCount(
                    itemId,
                    CONFIG.TARGET_LEVEL
                ),
                excessQuantity: 0,
                reason:
                    `本次挂出 ${formatInt(quantity)} 件；`
                    + `实体库存固定保留 `
                    + `${CONFIG.MARKET_RESERVED_INVENTORY} 件`,
            });
            log(
                `${getItemName(itemId)} +20：本次 `
                + `${formatInt(quantity)} 件已按 `
                + `${formatInt(normalizedPrice)} 挂出，`
                + `实体库存保留 `
                + `${CONFIG.MARKET_RESERVED_INVENTORY} 件`,
                'success'
            );
            return {
                posted: true,
                quantity,
                price: normalizedPrice,
                filled: false,
                listingId: newListingId,
                merged: postOutcome.merged === true,
                needsAnotherPoll:
                    run.marketPostInventoryBarriers.has(itemId),
            };
        },

        async repriceListing(run, itemId, decision) {
            if (
                !State.settings.marketMaintenanceEnabled ||
                !MarketMaintenance.isMonitoringRun(run)
            ) {
                return;
            }
            const listing = decision.ownListing;
            const listingId = normalizeMarketListingId(listing?.id);
            if (!listingId) {
                throw new MarketAutomationError(
                    '待撤挂单缺少有效 listing.id'
                );
            }
            const accessIssue =
                MarketMaintenance.getMarketWriteAccessIssue(
                    run,
                    itemId,
                    false
                );
            if (accessIssue) {
                MarketMaintenance.setItemStatus(itemId, {
                    ...MarketMaintenance.describeDecision(decision),
                    kind: 'market_access_blocked',
                    reason:
                        `撤单前复核未通过：${accessIssue.reason}`,
                });
                if (accessIssue.kind === 'access') {
                    MarketMaintenance.disableWrites(
                        `${getItemName(itemId)} +20 撤单前复核：`
                            + accessIssue.reason,
                        itemId
                    );
                }
                return {
                    posted: false,
                    reason: accessIssue.reason,
                };
            }
            const currentListing =
                State.myMarketListings.get(listingId);
            if (
                !currentListing ||
                currentListing.status !== MARKET_ACTIVE_STATUS
            ) {
                return {
                    posted: false,
                    needsAnotherPoll: true,
                    reason: '待撤卖单状态已变化，重新读取后再决定',
                };
            }
            const activeRemaining = Math.max(
                0,
                Number(currentListing.orderQuantity || 0) -
                    Number(currentListing.filledQuantity || 0)
            );
            const predictedInventoryAfterClaim =
                getItemCount(itemId, CONFIG.TARGET_LEVEL) +
                activeRemaining;
            const willNeedRepost =
                predictedInventoryAfterClaim >
                    CONFIG.MARKET_RESERVED_INVENTORY;
            const predictedListingCountAfterClaim = Math.max(
                0,
                State.myMarketListings.size - 1
            );
            if (
                willNeedRepost &&
                predictedListingCountAfterClaim >=
                    State.marketListingCap
            ) {
                const reason =
                    `撤单并领取后仍无法证明有重挂槽位 `
                    + `${predictedListingCountAfterClaim}/`
                    + `${State.marketListingCap}；原卖单保持不动`;
                MarketMaintenance.setItemStatus(itemId, {
                    ...MarketMaintenance.describeDecision(decision),
                    kind: 'listing_cap',
                    reason,
                });
                return {
                    posted: false,
                    reason,
                };
            }
            const anchorPrice = decision.anchorPrice || decision.oldPrice;
            MarketMaintenance.setItemStatus(itemId, {
                ...MarketMaintenance.describeDecision(decision),
                kind: 'cancelling',
                inventoryCount: getItemCount(
                    itemId,
                    CONFIG.TARGET_LEVEL
                ),
                excessQuantity: getMarketExcessInventory(itemId),
                reason: decision.kind === 'consolidate'
                    ? '最终扫尾：合并脚本管理卖单与新增库存'
                    : decision.kind === 'reserve_reclaim'
                        ? '实体 +20 库存不足 1 件，从本人卖单收回保留件'
                        : '',
            });
            log(
                `${getItemName(itemId)} +20：开始安全撤挂 listing `
                + `${listingId}；撤单后会重新读取库存并固定留 1 件`
            );

            const cancelOutcome =
                await MarketMaintenance.requireMarketOutcome(
                    MarketTransactions.begin(run, {
                        kind: 'cancel',
                        itemId,
                        listingId,
                        expectedListing: listing,
                        timeoutMs:
                            CONFIG.MARKET_WRITE_TIMEOUT_MS,
                        timeoutMessage:
                            `撤销市场挂单 ${listingId} 超时；`
                            + '不知道撤单是否已生效',
                        payload: {
                            type: 'cancel_market_listing',
                            cancelMarketListingData: {
                                marketListingId: listing.id,
                            },
                        },
                    }),
                    {mutationMayHaveApplied: true, itemId}
                );
            const finalListing = cancelOutcome.listing;
            const claimedItemCount =
                MarketMaintenance.getFinalRepostQuantity(finalListing);
            const unclaimedCoinCount = Math.max(
                0,
                Number(finalListing?.unclaimedCoinCount || 0)
            );

            if (
                claimedItemCount > 0 ||
                unclaimedCoinCount > 0
            ) {
                const baselineInventory = getItemCount(
                    itemId,
                    CONFIG.TARGET_LEVEL
                );
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'claiming',
                    ownQuantity: claimedItemCount,
                    inventoryCount: baselineInventory,
                    excessQuantity:
                        getMarketExcessInventory(itemId),
                });
                await MarketMaintenance.requireMarketOutcome(
                    MarketTransactions.begin(run, {
                        kind: 'claim',
                        itemId,
                        listingId,
                        expectedListing: finalListing,
                        quantity: claimedItemCount,
                        baselineInventory,
                        expectedInventory:
                            baselineInventory + claimedItemCount,
                        timeoutMs:
                            CONFIG.MARKET_WRITE_TIMEOUT_MS,
                        timeoutMessage:
                            `领取已撤挂单 ${listingId} 超时；`
                            + '不知道余货或出售款是否已领取',
                        payload: {
                            type: 'claim_market_listing',
                            claimMarketListingData: {
                                marketListingId: finalListing.id,
                            },
                        },
                    }),
                    {mutationMayHaveApplied: true, itemId}
                );
                adjustRunMarketInventoryOffset(
                    run,
                    itemId,
                    claimedItemCount
                );
            }

            State.marketListingPriceAnchors.delete(listingId);
            if (
                run.marketAutomationListingIds.get(itemId) ===
                    listingId
            ) {
                run.marketAutomationListingIds.delete(itemId);
            }
            if (
                State.marketAutomationListingIds.get(itemId) ===
                    listingId
            ) {
                State.marketAutomationListingIds.delete(itemId);
            }
            const existingItemAnchor = Number(
                State.marketItemPriceAnchors.get(itemId)
            );
            State.marketItemPriceAnchors.set(
                itemId,
                Math.max(
                    Number.isSafeInteger(existingItemAnchor) &&
                        existingItemAnchor > 0
                        ? existingItemAnchor
                        : 0,
                    Number(anchorPrice)
                )
            );

            let refreshed;
            try {
                refreshed = await MarketMaintenance.refreshOrderBook(
                    run,
                    itemId,
                    true
                );
            } catch (error) {
                MarketMaintenance.disableWrites(
                    `${getItemName(itemId)} +20 已撤单并领取，但重挂前`
                    + `无法取得新盘口：${error.message}`,
                    itemId
                );
                throw error;
            }
            const currentLeftOne = MarketMaintenance.getLeftOne(
                refreshed.snapshot
            );
            const currentInventory = getItemCount(
                itemId,
                CONFIG.TARGET_LEVEL
            );
            if (currentInventory <= CONFIG.MARKET_RESERVED_INVENTORY) {
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'reserve_only',
                    leftOnePrice:
                        currentLeftOne?.price ?? null,
                    inventoryCount: currentInventory,
                    excessQuantity: 0,
                    reason: claimedItemCount > 0
                        ? '撤回余货后固定保留 1 件自用，不再重挂'
                        : '撤单期间已成交；库存仅保留自用数量',
                });
                return {
                    posted: false,
                    reason: '库存仅够保留',
                };
            }
            const currentOwnListings =
                MarketMaintenance.getOwnActiveSellListings(
                    State.myMarketListings,
                    itemId
                );
            const repricedDecision =
                MarketMaintenance.planReprice({
                    ownListings: currentOwnListings,
                    orderBookSnapshot: refreshed.snapshot,
                    itemId,
                    maxDropPercent: run.marketMaxDropPercent,
                    priceAnchors:
                        State.marketListingPriceAnchors,
                    itemPriceAnchor:
                        State.marketItemPriceAnchors.get(itemId),
                    inventoryCount: currentInventory,
                    vendorPrice:
                        run.marketItemRules.get(itemId).sellPrice,
                    confirmedQuotePrice:
                        currentLeftOne?.price ?? null,
                    automationListingIds: new Set(),
                    isFinalSweep: false,
                });
            let proposedPrice = null;
            if (
                [
                    'post_new',
                    'post_extra',
                    'reprice',
                    'consolidate',
                ].includes(repricedDecision.kind)
            ) {
                proposedPrice = Number(repricedDecision.newPrice);
            } else if (
                repricedDecision.kind === 'no_quote' &&
                Number.isSafeInteger(Number(decision.oldPrice))
            ) {
                proposedPrice = Number(decision.oldPrice);
            }
            const minimumAllowedPrice = Math.ceil(
                Number(anchorPrice) *
                    (1 - run.marketMaxDropPercent / 100)
            );
            if (
                repricedDecision.kind === 'guarded' ||
                !Number.isSafeInteger(proposedPrice) ||
                proposedPrice <= 0 ||
                proposedPrice < minimumAllowedPrice
            ) {
                MarketMaintenance.disableWrites(
                    `${getItemName(itemId)} +20 已撤单并领取；`
                    + (
                        proposedPrice
                            ? `最新可挂价格 ${proposedPrice} 低于`
                                + `保护底价 ${minimumAllowedPrice}`
                            : '最新盘口没有可安全使用的“左一-”价格档位'
                    )
                    + `。库存 ${currentInventory} 件保持不动`,
                    itemId
                );
                return {
                    posted: false,
                    reason: '撤单后价格保护阻止重挂',
                };
            }
            return MarketMaintenance.postExcessInventory(
                run,
                itemId,
                {
                    price: proposedPrice,
                    anchorPrice,
                    leftOnePrice:
                        currentLeftOne?.price ?? proposedPrice,
                    successKind: 'repriced',
                    atomicCleanup: true,
                }
            );
        },

        async pollAndMaintain(run, itemId) {
            const coinClaim =
                await MarketMaintenance
                    .claimFilledAutomationListing(run, itemId);
            if (coinClaim) return coinClaim;
            const pendingBarrier =
                run.marketPostInventoryBarriers?.get(itemId);
            if (pendingBarrier) {
                const confirmedAt = Number(
                    pendingBarrier.confirmedAt || 0
                );
                if (
                    pendingBarrier.postConfirmed &&
                    confirmedAt > 0 &&
                    Date.now() - confirmedAt >=
                        CONFIG.INVENTORY_COMMIT_GRACE_MS
                ) {
                    MarketMaintenance.expirePostInventoryBarrier(
                        run,
                        itemId,
                        pendingBarrier
                    );
                    return {
                        reason: '挂单库存回执未精确收束',
                    };
                }
                MarketMaintenance.setItemStatus(itemId, {
                    kind: 'waiting_inventory_sync',
                    inventoryCount: getItemCount(
                        itemId,
                        CONFIG.TARGET_LEVEL
                    ),
                    excessQuantity: getMarketExcessInventory(itemId),
                    reason: '等待上一张卖单对应的库存绝对值回执',
                });
                return {
                    needsAnotherPoll: true,
                    reason: '等待库存同步',
                };
            }
            const outcome = await MarketMaintenance.refreshOrderBook(
                run,
                itemId
            );
            if (
                !State.settings.marketMaintenanceEnabled ||
                !MarketMaintenance.isMonitoringRun(run)
            ) {
                return;
            }
            const ownListings =
                MarketMaintenance.getOwnActiveSellListings(
                    State.myMarketListings,
                    itemId
                );
            const inventoryCount = getItemCount(
                itemId,
                CONFIG.TARGET_LEVEL
            );
            for (const listing of ownListings) {
                const listingId = normalizeMarketListingId(listing.id);
                const price = Number(listing.price);
                if (
                    listingId &&
                    Number.isSafeInteger(price) &&
                    price > 0 &&
                    !State.marketListingPriceAnchors.has(listingId)
                ) {
                    State.marketListingPriceAnchors.set(
                        listingId,
                        price
                    );
                }
            }
            const confirmedQuote =
                run.marketQuoteConfirmations?.get(itemId);
            const currentBookSequence = Number(
                State.marketOrderBooks.get(itemId)?.sequence || 0
            );
            const confirmedQuoteIsFresh = Boolean(
                confirmedQuote &&
                Number.isSafeInteger(
                    Number(confirmedQuote.bookSequence)
                ) &&
                currentBookSequence >
                    Number(confirmedQuote.bookSequence) &&
                Date.now() - Number(confirmedQuote.at) <=
                    CONFIG.MARKET_QUOTE_CONFIRM_TTL_MS
            );
            const automationListingIds =
                MarketMaintenance.getAutomationListingIds(
                    run,
                    itemId
                );
            const decision = MarketMaintenance.planReprice({
                ownListings,
                orderBookSnapshot: outcome.snapshot,
                itemId,
                maxDropPercent: run.marketMaxDropPercent,
                priceAnchors: State.marketListingPriceAnchors,
                itemPriceAnchor:
                    State.marketItemPriceAnchors.get(itemId),
                inventoryCount,
                vendorPrice:
                    run.marketItemRules.get(itemId).sellPrice,
                confirmedQuotePrice: confirmedQuoteIsFresh
                    ? confirmedQuote.price
                    : null,
                automationListingIds,
                isFinalSweep:
                    run.marketFinalSweepPending === true ||
                    run.marketSteadyMonitoring === true,
                listingSlotAvailable:
                    State.myMarketListings.size <
                        State.marketListingCap,
            });
            decision.inventoryCount = inventoryCount;
            const description =
                MarketMaintenance.describeDecision(decision);
            if (
                decision.kind === 'reprice' ||
                decision.kind === 'consolidate' ||
                decision.kind === 'reserve_reclaim'
            ) {
                if (
                    !isQuickItemMarketWriteSafe(run, itemId)
                ) {
                    MarketMaintenance.setItemStatus(itemId, {
                        ...description,
                        kind: 'deferred_reprice',
                        reason:
                            '为避免强化产出与撤单领取库存回执串线，'
                            + '等本批已排动作完成后再撤挂',
                    });
                    return {
                        reason: '撤挂延后到本批动作全部完成',
                    };
                }
                run.marketQuoteConfirmations.delete(itemId);
                const result =
                    await MarketMaintenance.repriceListing(
                        run,
                        itemId,
                        decision
                    );
                return {
                    ...result,
                    reason: decision.kind === 'consolidate'
                        ? '已合并脚本卖单与最终多余库存'
                        : decision.kind === 'reserve_reclaim'
                            ? '已从本人卖单收回实体自用保留件'
                            : '已按左一-完成撤挂',
                };
            }
            if (
                decision.kind === 'post_new' ||
                decision.kind === 'post_extra'
            ) {
                if (!isQuickItemMarketWriteSafe(run, itemId)) {
                    MarketMaintenance.setItemStatus(itemId, {
                        ...description,
                        kind: 'deferred_inventory_write',
                        reason:
                            '本装备仍有待完成的 +20 动作或最后库存回执；'
                            + '收束后再挂售',
                    });
                    return {
                        reason: '挂售延后到本装备产出库存收束',
                    };
                }
                run.marketQuoteConfirmations.delete(itemId);
                const result =
                    await MarketMaintenance.postExcessInventory(
                        run,
                        itemId,
                        {
                            price: decision.newPrice,
                            anchorPrice:
                                decision.anchorPrice,
                            leftOnePrice:
                                decision.leftOne?.price ?? null,
                            successKind:
                                decision.kind === 'post_new'
                                    ? 'listed_new'
                                    : 'listed_extra',
                        }
                    );
                return {
                    ...result,
                    reason: result.reason ||
                        (
                            decision.kind === 'post_new'
                                ? '已自动创建 +20 卖单'
                                : '已按本人左一补挂多余库存'
                        ),
                };
            }
            if (decision.kind === 'confirming_quote') {
                const completedIndependentReread = Boolean(
                    confirmedQuote &&
                    currentBookSequence >
                        Number(confirmedQuote.bookSequence)
                );
                let priorityRetry = true;
                let priorityDeferred = false;
                if (completedIndependentReread) {
                    const restartingAfterYield =
                        confirmedQuote.priorityDeferred === true;
                    priorityRetry = restartingAfterYield;
                    priorityDeferred = !restartingAfterYield;
                    if (
                        !restartingAfterYield &&
                        run.marketFinalSweepPending
                    ) {
                        const retry =
                            MarketMaintenance
                                .noteFinalSweepReadFailure(
                                    run,
                                    itemId,
                                    '首次挂售的两次独立盘口读数持续变化'
                                );
                        if (!retry) {
                            run.marketQuoteConfirmations.delete(
                                itemId
                            );
                            MarketMaintenance.setItemStatus(itemId, {
                                ...description,
                                kind: 'volatile_quote',
                                reason:
                                    '盘口连续变化，最终扫尾不猜价；'
                                    + '多余库存保持不动',
                            });
                            return {
                                needsAnotherPoll: false,
                                reason:
                                    '盘口连续变化，库存保持不动',
                            };
                        }
                    }
                }
                run.marketQuoteConfirmations.set(itemId, {
                    price: Number(decision.leftOne?.price),
                    at: Date.now(),
                    bookSequence: currentBookSequence,
                    priorityDeferred,
                });
                MarketMaintenance.setItemStatus(itemId, {
                    ...description,
                    kind: 'confirming_quote',
                    reason:
                        `首次自动挂售前等待第二次独立盘口确认；`
                        + `候选左一- ${decision.proposedPrice}`,
                });
                return {
                    needsAnotherPoll: true,
                    priorityRetry,
                    reason: '等待第二次独立盘口确认',
                };
            }
            run.marketQuoteConfirmations.delete(itemId);
            if (
                decision.kind === 'market_data_invalid' &&
                run.marketFinalSweepPending
            ) {
                const retry =
                    MarketMaintenance.noteFinalSweepReadFailure(
                        run,
                        itemId,
                        '盘口缺少有效左一或卖价顺序异常'
                    );
                MarketMaintenance.setItemStatus(itemId, {
                    ...description,
                    kind: 'market_data_invalid',
                    reason: retry
                        ? '最终扫尾将重新读取可信盘口'
                        : '连续读取异常，多余库存保持不动',
                });
                return {
                    needsAnotherPoll: retry,
                    reason: retry
                        ? '等待重新读取盘口'
                        : '连续盘口异常，库存保持不动',
                };
            }
            if (decision.kind === 'guarded') {
                const changed = MarketMaintenance.setItemStatus(
                    itemId,
                    {
                        ...description,
                        kind: 'guarded',
                        reason:
                            `拟挂价 ${decision.proposedPrice} 低于`
                            + `保护底价 `
                            + `${decision.minimumAllowedPrice}`,
                    }
                );
                if (changed) {
                    log(
                        `${getItemName(itemId)} +20：候选售价 `
                        + `${decision.proposedPrice} 触发累计跌价保护，`
                        + `市场写操作未执行（底价 `
                        + `${decision.minimumAllowedPrice}）`,
                        'warn'
                    );
                }
                return {
                    reason: '累计跌价保护拦截，多余库存保留',
                };
            }
            const reasons = {
                reserve_only:
                    '实体库存固定保留 1 件，没有可出售余量',
                no_quote:
                    '当前没有卖盘左一，不猜测首次挂售价',
                price_floor:
                    '商店底价附近不存在更低的合法价格档位',
                market_data_invalid:
                    '盘口缺少有效左一或卖价顺序异常，不执行市场写操作',
                market_access_blocked:
                    '本人卖单价格字段无效，不执行市场写操作',
                already_lowest:
                    '本人卖单已是最低售价，库存没有可补挂余量',
                accumulating:
                    '已有一张脚本管理卖单；新增 +20 暂存到最终扫尾'
                    + '或该单售完后再合并',
            };
            MarketMaintenance.setItemStatus(itemId, {
                ...description,
                kind: decision.kind,
                reason: reasons[decision.kind] || '',
            });
            return {
                reason: reasons[decision.kind] || decision.kind,
            };
        },

        async tick() {
            const run = State.run;
            if (
                !State.settings.marketMaintenanceEnabled ||
                State.marketWriteBlockedReason ||
                !MarketMaintenance.isMonitoringRun(run)
            ) {
                MarketMaintenance.stopScheduling();
                return;
            }
            if (
                State.pendingOp ||
                State.marketBusy ||
                State.starting
            ) {
                MarketMaintenance.scheduleNext(500);
                return;
            }
            const itemIds = run.marketFinalSweepPending
                ? (run.itemIds || []).filter(
                    (itemId) => (
                        run.marketFinalSweepRemaining?.has(itemId)
                    )
                )
                : (run.itemIds || []);
            if (itemIds.length === 0) {
                if (run.marketFinalSweepPending) {
                    run.marketFinalSweepPending = false;
                    run.marketFinalSweepPhase = 'completed';
                    run.marketSteadyMonitoring = true;
                    run.currentStage =
                        '已结束；市场最终扫尾完成，持续监控左一与成交';
                    State.ui?.setLocked(false);
                    MarketMaintenance.scheduleNext();
                    scheduleUiRefresh();
                    return;
                }
                run.marketSteadyMonitoring = false;
                MarketMaintenance.stopScheduling();
                scheduleUiRefresh();
                return;
            }
            const priorityItemId = itemIds.includes(
                run.marketPriorityItemId
            )
                ? run.marketPriorityItemId
                : null;
            const itemId = priorityItemId || itemIds[
                State.marketRoundRobinIndex % itemIds.length
            ];
            run.marketPriorityItemId = null;
            if (!priorityItemId) State.marketRoundRobinIndex++;
            State.marketBusy = true;
            scheduleUiRefresh();
            let pollResult = null;
            try {
                pollResult = await MarketMaintenance.pollAndMaintain(
                    run,
                    itemId
                );
                if (
                    pollResult?.needsAnotherPoll === true &&
                    pollResult?.priorityRetry !== false
                ) {
                    run.marketPriorityItemId = itemId;
                }
                if (
                    run.marketFinalSweepPending &&
                    pollResult?.needsAnotherPoll !== true
                ) {
                    MarketMaintenance.finishFinalSweepItem(
                        run,
                        itemId,
                        pollResult?.reason || ''
                    );
                }
            } catch (error) {
                const mutationMayHaveApplied = Boolean(
                    error?.mutationMayHaveApplied
                );
                if (mutationMayHaveApplied) {
                    MarketMaintenance.disableWrites(
                        `${getItemName(itemId)} +20：`
                        + `${error.message || error}`,
                        itemId
                    );
                    if (run.mode === 'verified' && run.active) {
                        run.stopRequested = true;
                        run.currentStage =
                            '市场写操作结果未知，停止验证慢排';
                        log(
                            '验证慢排依赖精确的 +20 库存变化；'
                            + '市场写操作结果未知时不能安全继续发送',
                            'error'
                        );
                    }
                } else if (
                    State.settings.marketMaintenanceEnabled &&
                    !State.marketWriteBlockedReason
                ) {
                    if (run.marketFinalSweepPending) {
                        const retry =
                            MarketMaintenance
                                .noteFinalSweepReadFailure(
                                    run,
                                    itemId,
                                    error.message || String(error)
                                );
                        if (retry) {
                            run.marketPriorityItemId = itemId;
                        }
                    }
                    const changed =
                        MarketMaintenance.setItemStatus(itemId, {
                            kind: 'read_error',
                            inventoryCount: getItemCount(
                                itemId,
                                CONFIG.TARGET_LEVEL
                            ),
                            excessQuantity:
                                getMarketExcessInventory(itemId),
                            reason: error.message || String(error),
                        });
                    if (changed) {
                        log(
                            `${getItemName(itemId)} +20 市场读取暂时失败：`
                            + `${error.message || error}；稍后只读重试`,
                            'warn'
                        );
                    }
                }
            } finally {
                State.marketBusy = false;
                scheduleUiRefresh();
                MarketMaintenance.scheduleNext();
            }
        },
    };

    function marketWarningMatchesExpected(message, expected) {
        const warning = message?.mispriceWarningData || message;
        if (!warning || !expected) return false;
        return (
            warning.isSell === expected.isSell &&
            warning.itemHrid === expected.itemHrid &&
            Number(warning.enhancementLevel) ===
                Number(expected.enhancementLevel) &&
            Number(warning.quantity) === Number(expected.quantity) &&
            Number(warning.listingPrice ?? warning.price) ===
                Number(expected.price) &&
            warning.isInstantOrder === expected.isInstantOrder
        );
    }

    function validateCancelledListing(finalListing, expectedListing) {
        if (!finalListing || !expectedListing) {
            return '撤单终态缺少原挂单或最终挂单记录';
        }
        if (
            normalizeMarketListingId(finalListing.id) !==
                normalizeMarketListingId(expectedListing.id) ||
            finalListing.isSell !== true ||
            finalListing.itemHrid !== expectedListing.itemHrid ||
            Number(finalListing.enhancementLevel) !==
                Number(expectedListing.enhancementLevel) ||
            Number(finalListing.price) !== Number(expectedListing.price) ||
            Number(finalListing.orderQuantity) !==
                Number(expectedListing.orderQuantity)
        ) {
            return '撤单终态与发送前冻结的原卖单不一致';
        }
        const orderQuantity = Number(finalListing.orderQuantity);
        const filledQuantity = Number(finalListing.filledQuantity);
        const unclaimedItemCount = Number(
            finalListing.unclaimedItemCount
        );
        const unclaimedCoinCount = Number(
            finalListing.unclaimedCoinCount
        );
        if (
            !Number.isSafeInteger(orderQuantity) ||
            orderQuantity <= 0 ||
            !Number.isSafeInteger(filledQuantity) ||
            filledQuantity < 0 ||
            filledQuantity > orderQuantity ||
            !Number.isSafeInteger(unclaimedItemCount) ||
            unclaimedItemCount < 0 ||
            !Number.isSafeInteger(unclaimedCoinCount) ||
            unclaimedCoinCount < 0 ||
            filledQuantity + unclaimedItemCount !== orderQuantity
        ) {
            return '撤单终态的成交、余货或待领取金币字段不完整';
        }
        return '';
    }

    function marketListingIdentityMatches(listing, expectedListing) {
        return Boolean(
            listing &&
            expectedListing &&
            normalizeMarketListingId(listing.id) ===
                normalizeMarketListingId(expectedListing.id) &&
            listing.isSell === expectedListing.isSell &&
            listing.itemHrid === expectedListing.itemHrid &&
            Number(listing.enhancementLevel) ===
                Number(expectedListing.enhancementLevel) &&
            Number(listing.price) === Number(expectedListing.price) &&
            Number(listing.orderQuantity) ===
                Number(expectedListing.orderQuantity)
        );
    }

    const MarketTransactions = {
        resetTimer(op, milliseconds, timeoutMessage) {
            if (op.timer) window.clearTimeout(op.timer);
            op.timer = window.setTimeout(() => {
                MarketTransactions.settle(op, {
                    status: 'unknown',
                    reason: timeoutMessage,
                });
            }, milliseconds);
        },

        settle(op, outcome) {
            if (
                !op ||
                State.marketOp !== op ||
                op.settled
            ) {
                return false;
            }
            op.settled = true;
            if (op.timer) window.clearTimeout(op.timer);
            State.marketOp = null;
            const unresolvedOwnedOrderBookRead = Boolean(
                op.kind === 'order_book' &&
                outcome?.status === 'unknown'
            );
            if (unresolvedOwnedOrderBookRead) {
                MarketMaintenance.discardOrderBookRequest(
                    op.itemId
                );
                MarketMaintenance.disableWrites(
                    `${getItemName(op.itemId)} +20 的脚本盘口请求`
                    + '未收到可唯一归属的响应；迟到响应可能污染下一次'
                    + '报价，因此市场自动出售已锁定，必须完整刷新页面',
                    op.itemId
                );
            }
            op.resolve(outcome);
            scheduleUiRefresh();
            return true;
        },

        begin(run, options) {
            if (!State.marketBusy) {
                throw new MarketAutomationError(
                    '内部错误：市场事务没有持有串行发送通道'
                );
            }
            if (State.marketOp || State.pendingOp) {
                throw new MarketAutomationError(
                    '内部错误：已有请求正在等待回执'
                );
            }
            if (!State.socket || State.socket.readyState !== WebSocket.OPEN) {
                throw new MarketAutomationError('WebSocket 未连接');
            }
            if (
                !run ||
                State.run?.id !== run.id ||
                run.characterId !== State.characterId ||
                run.characterId !== getCharacterId() ||
                run.syncEpoch !== State.syncEpoch ||
                run.integrityFailure ||
                State.blockedReason ||
                State.marketWriteBlockedReason
            ) {
                throw new MarketAutomationError(
                    '市场维护角色、同步世代或完整性状态已变化'
                );
            }
            const inheritedExternalOverlap =
                hasExternalErrorFence();
            const op = {
                id: ++State.nextMarketOpId,
                runId: run.id,
                epoch: State.connectionEpoch,
                syncEpoch: State.syncEpoch,
                kind: options.kind,
                itemId: options.itemId,
                listingId: normalizeMarketListingId(
                    options.listingId
                ),
                quantity: options.quantity,
                baselineInventory: options.baselineInventory,
                expectedInventory: options.expectedInventory,
                baselineListingIds:
                    options.baselineListingIds || new Set(),
                baselineListings:
                    options.baselineListings || new Map(),
                expectedPost: options.expectedPost || null,
                expectedListing: options.expectedListing || null,
                listingClearedSeen: false,
                orderBookContaminated: false,
                externalOrderBookGeneration: Number(
                    State.marketExternalOrderBookGeneration.get(
                        options.itemId
                    ) || 0
                ),
                externalOverlapEver:
                    inheritedExternalOverlap,
                lastUnattributedError: '',
                settled: false,
                timer: null,
                resolve: null,
            };
            const promise = new Promise((resolve) => {
                op.resolve = resolve;
            });
            State.marketOp = op;
            MarketTransactions.resetTimer(
                op,
                options.timeoutMs,
                options.timeoutMessage
            );
            if (op.kind === 'order_book') {
                MarketMaintenance.recordOrderBookRequest(
                    op.itemId,
                    false
                );
            }
            try {
                Network.sendOwned(
                    options.payload,
                    'legacy_market_runtime_test'
                );
            } catch (error) {
                if (op.kind === 'order_book') {
                    MarketMaintenance.discardOrderBookRequest(
                        op.itemId
                    );
                }
                MarketTransactions.settle(op, {
                    status: 'send_failed',
                    reason: error.message || String(error),
                });
            }
            return promise;
        },

        handleIncoming(message) {
            const op = State.marketOp;
            if (!op || op.settled) return;
            if (
                op.runId !== State.run?.id ||
                op.epoch !== State.connectionEpoch ||
                op.syncEpoch !== State.syncEpoch
            ) {
                return;
            }

            if (
                op.kind === 'order_book' &&
                message.type === 'market_item_order_books_updated' &&
                normalizeShortItemId(
                    message.marketItemOrderBooks?.itemHrid
                ) === op.itemId
            ) {
                const outstanding =
                    MarketMaintenance
                        .getOutstandingOrderBookReadCount(
                            op.itemId
                        );
                const contaminated = Boolean(
                    op.orderBookContaminated ||
                    Number(
                        State.marketExternalOrderBookGeneration.get(
                            op.itemId
                        ) || 0
                    ) !== op.externalOrderBookGeneration
                );
                if (contaminated) {
                    if (outstanding === 0) {
                        MarketTransactions.settle(op, {
                            status: 'read_contaminated',
                            reason:
                                `${getItemName(op.itemId)} +20 的脚本盘口`
                                + '读取期间出现同物品外部读取；'
                                + '本次结果作废并稍后重读',
                        });
                    }
                    return;
                }
                if (outstanding > 0) return;
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
                if (op.kind === 'cancel') {
                    const exact = message.endMarketListings.filter(
                        (listing) => (
                            normalizeMarketListingId(listing?.id) ===
                                op.listingId
                        )
                    );
                    if (exact.length > 1) {
                        MarketTransactions.settle(op, {
                            status: 'unknown',
                            reason:
                                `撤单回执中 listing ${op.listingId} `
                                + '出现多条互相冲突的记录',
                        });
                        return;
                    }
                    if (
                        exact.length === 1 &&
                        MARKET_TERMINAL_STATUSES.has(exact[0].status)
                    ) {
                        const validationError =
                            validateCancelledListing(
                                exact[0],
                                op.expectedListing
                            );
                        if (validationError) {
                            MarketTransactions.settle(op, {
                                status: 'unknown',
                                reason: validationError,
                            });
                            return;
                        }
                        MarketTransactions.settle(op, {
                            status: 'confirmed',
                            listing: exact[0],
                        });
                        return;
                    }
                }

                if (op.kind === 'claim') {
                    const exact = message.endMarketListings.filter(
                        (listing) => (
                            normalizeMarketListingId(listing?.id) ===
                                op.listingId
                        )
                    );
                    if (exact.length > 1) {
                        MarketTransactions.settle(op, {
                            status: 'unknown',
                            reason:
                                `领取回执中 listing ${op.listingId} `
                                + '出现多条互相冲突的记录',
                        });
                        return;
                    }
                    if (
                        exact.length === 1 &&
                        MARKET_TERMINAL_STATUSES.has(
                            exact[0].status
                        ) &&
                        marketListingIdentityMatches(
                            exact[0],
                            op.expectedListing
                        ) &&
                        Number(exact[0].unclaimedItemCount || 0) === 0 &&
                        Number(exact[0].unclaimedCoinCount || 0) === 0
                    ) {
                        op.listingClearedSeen = true;
                    }
                }

                if (op.kind === 'post') {
                    const matched =
                        MarketMaintenance.matchNewActiveListing({
                            baselineListingIds:
                                op.baselineListingIds,
                            baselineListings:
                                op.baselineListings,
                            endMarketListings:
                                message.endMarketListings,
                            expected: op.expectedPost,
                        });
                    if (matched.status === 'unknown') {
                        MarketTransactions.settle(op, matched);
                        return;
                    }
                    if (matched.status === 'confirmed') {
                        MarketTransactions.settle(op, matched);
                        return;
                    }
                }
            }

            if (
                op.kind === 'claim' &&
                op.listingClearedSeen &&
                (
                    Number(op.quantity) === 0 ||
                    getItemCount(op.itemId, CONFIG.TARGET_LEVEL) ===
                        op.expectedInventory
                )
            ) {
                MarketTransactions.settle(op, {
                    status: 'confirmed',
                    currentInventory: getItemCount(
                        op.itemId,
                        CONFIG.TARGET_LEVEL
                    ),
                });
                return;
            }

            if (
                op.kind === 'post' &&
                message.type === 'misprice_warning' &&
                marketWarningMatchesExpected(
                    message,
                    op.expectedPost
                )
            ) {
                MarketTransactions.settle(op, {
                    status: 'misprice',
                    reason:
                        '服务器要求人工确认错价；自动维护已拒绝确认',
                });
                return;
            }

            if (message.type === 'error') {
                const recentExternal =
                    State.recentAllowedExternalRequest;
                if (
                    recentExternal &&
                    recentExternal.epoch === State.connectionEpoch &&
                    recentExternal.marketOpId === op.id &&
                    Date.now() - recentExternal.at <=
                        CONFIG.ALLOWED_EXTERNAL_ERROR_GRACE_MS
                ) {
                    State.recentAllowedExternalRequest = null;
                    return;
                }
                if (op.externalOverlapEver) {
                    op.lastUnattributedError = String(
                        message.message || '游戏服务器返回错误'
                    );
                    log(
                        '市场请求等待期间有外部请求重叠；忽略这条无法'
                        + '关联 request id 的错误，继续只等待精确市场回执',
                        'warn'
                    );
                    return;
                }
                MarketTransactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '等待市场请求时收到无法关联 request id 的服务器错误：'
                        + String(
                            message.message || '游戏服务器返回错误'
                        ),
                });
            }
        },

        abortAsUnknown(reason) {
            const op = State.marketOp;
            if (!op) return;
            MarketTransactions.settle(op, {
                status: 'unknown',
                reason,
            });
        },
    };

    function clearMarketConnectionSnapshot(
        reason = '',
        resetOrderBookRequestTracking = true
    ) {
        if (reason) MarketTransactions.abortAsUnknown(reason);
        MarketMaintenance.stopScheduling();
        State.myMarketListingsReady = false;
        State.myMarketListings.clear();
        State.marketOrderBooks.clear();
        State.marketLastOrderBookRequestAt.clear();
        if (resetOrderBookRequestTracking) {
            State.marketOutstandingOrderBookReads.clear();
            State.marketExternalOrderBookGeneration.clear();
        }
        State.marketItemStatus.clear();
        State.marketListingPriceAnchors.clear();
        State.marketItemPriceAnchors.clear();
        State.marketAutomationListingIds.clear();
        State.marketRevision++;
    }

    const Transactions = {
        resetTimer(op, milliseconds, timeoutMessage) {
            if (op.timer) window.clearTimeout(op.timer);
            op.timer = window.setTimeout(() => {
                if (
                    op.kind === 'queue' &&
                    op.phase !== 'reconciling'
                ) {
                    const possibleExternalError =
                        String(op.lastUnattributedError || '');
                    Transactions.enterQueueReconciliation(
                        op,
                        possibleExternalError
                            ? (
                                '外部请求重叠后只收到无法关联 request id '
                                + `的服务器错误：${possibleExternalError}`
                            )
                            : timeoutMessage,
                        possibleExternalError ||
                            'QUEUE_ACK_TIMEOUT'
                    );
                    return;
                }
                Transactions.settle(op, {
                    status: 'unknown',
                    reason: timeoutMessage,
                });
            }, milliseconds);
        },

        persistInFlightState(op, patch) {
            const run = State.run;
            const journal = run?.recoveryJournal;
            if (!journal) return true;
            if (
                journal.jobId !== op.recoveryJobId ||
                journal.inFlight?.type !== 'action' ||
                journal.inFlight.commandKey !== op.commandKey
            ) {
                throw new BatchError(
                    '最后一条强化请求与持久任务账本不一致',
                    'RECOVERY_INVALID'
                );
            }
            const previous = {...journal.inFlight};
            Object.assign(journal.inFlight, patch);
            try {
                saveRecoveryJournalCritical(journal);
            } catch (error) {
                journal.inFlight = previous;
                throw error;
            }
            return true;
        },

        enterQueueReconciliation(op, reason, errorCode = '') {
            if (
                !op ||
                State.pendingOp !== op ||
                op.settled ||
                op.kind !== 'queue'
            ) {
                return false;
            }
            if (op.phase === 'reconciling') return true;

            const deadline =
                Date.now() + CONFIG.QUEUE_RECONCILE_GRACE_MS;
            const spamRetryEvidenceSafe = Boolean(
                String(errorCode || '') ===
                    'errorNotification.requestSpamProtection' &&
                    State.run?.interferenceDetected !== true &&
                    op.observedActionIds.size === 0 &&
                    op.externalOverlapEver !== true &&
                op.externalMatchingQueueAddSeen !== true &&
                op.recoveryRetryAttempt !== true
            );
            try {
                Transactions.persistInFlightState(op, {
                    phase: 'reconciling',
                    errorCode: String(errorCode || ''),
                    errorReason: String(reason || ''),
                    reconcileDeadline: deadline,
                    externalOverlapEver:
                        op.externalOverlapEver === true,
                    externalMatchingQueueAddSeen:
                        op.externalMatchingQueueAddSeen === true,
                    spamRetryEvidenceSafe,
                    exclusiveSpamRejection:
                        spamRetryEvidenceSafe &&
                        op.externalOverlapEver !== true,
                });
            } catch (error) {
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '无法把强化请求核对状态写入本地任务账本：'
                        + `${error.message || String(error)}`,
                });
                return false;
            }

            op.phase = 'reconciling';
            op.reconcileDeadline = deadline;
            op.reconcileReason = String(reason || '');
            op.reconcileErrorCode = String(errorCode || '');
            op.spamRetryEvidenceSafe =
                spamRetryEvidenceSafe;
            if (op.timer) window.clearTimeout(op.timer);
            op.timer = window.setTimeout(() => {
                if (Transactions.authorizeQueueRetry(op)) {
                    return;
                }
                try {
                    Transactions.persistInFlightState(op, {
                        phase: 'ambiguous',
                        errorReason: op.reconcileReason,
                        observedActionIds: [
                            ...op.observedActionIds,
                        ],
                    });
                } catch (error) {
                    op.reconcileReason +=
                        `；任务账本状态更新失败：`
                        + `${error.message || String(error)}`;
                }
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        `${op.reconcileReason}；额外核对 `
                        + `${formatDuration(
                            CONFIG.QUEUE_RECONCILE_GRACE_MS
                        )} 后仍没有唯一 action.id。`
                        + '任务账本已保留，脚本没有重发',
                });
            }, CONFIG.QUEUE_RECONCILE_GRACE_MS);

            if (State.run?.id === op.runId) {
                State.run.currentStage =
                    '最后一条强化请求进入 48 秒回执核对期；'
                    + '期间不会发送新的写请求';
            }
            log(
                '最后一条强化请求暂时无法唯一确认，进入 48 秒观察期；'
                + '若迟到的精确 action.id 到达会自动继续',
                'warn'
            );
            scheduleUiRefresh();
            return true;
        },

        authorizeQueueRetry(op) {
            if (
                !op ||
                State.pendingOp !== op ||
                op.settled ||
                op.kind !== 'queue' ||
                op.phase !== 'reconciling' ||
                op.recoveryRetryAttempt ||
                op.observedActionIds.size > 0 ||
                op.externalMatchingQueueAddSeen ||
                Date.now() <
                    Number(op.reconcileDeadline || 0)
            ) {
                return false;
            }
            const run = State.run;
            const journal = run?.recoveryJournal;
            if (
                !journal ||
                journal.jobId !== op.recoveryJobId ||
                journal.inFlight?.type !== 'action' ||
                journal.inFlight.commandKey !== op.commandKey
            ) {
                return false;
            }

            const matchingCandidates = getEnhancingActions().filter(
                (candidate) => {
                    const candidateId =
                        normalizeActionId(candidate?.id);
                    return Boolean(
                        candidateId &&
                        !op.baselineActionIds.has(candidateId) &&
                        progressSingleEnhanceActionMatches(
                            candidate,
                            op.fingerprint
                        )
                    );
                }
            );
            const candidateIds = [
                ...new Set(
                    matchingCandidates
                        .map((candidate) =>
                            normalizeActionId(candidate.id)
                        )
                        .filter(Boolean)
                ),
            ];
            if (candidateIds.length > 1) {
                for (const candidateId of candidateIds) {
                    op.observedActionIds.add(candidateId);
                }
                try {
                    Transactions.persistInFlightState(op, {
                        phase: 'ambiguous',
                        errorReason:
                            '回执核对期结束时发现多条完全匹配'
                            + '的新增强化动作',
                        observedActionIds: candidateIds,
                    });
                } catch {
                    // Keep the original durable reconciliation record.
                }
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '回执核对期结束时发现多条完全匹配的新增'
                        + '强化动作，无法唯一认领 action.id',
                });
                return true;
            }
            if (candidateIds.length === 1) {
                return Transactions.confirmQueueCandidate(
                    op,
                    matchingCandidates[0],
                    false,
                    true
                );
            }

            const previousInFlight =
                cloneJsonValue(journal.inFlight);
            const previousRetryCount =
                Number(journal.recoveryRetryCount || 0);
            journal.inFlight = {
                ...journal.inFlight,
                phase: 'retry_authorized',
                retryAuthorizedAt: Date.now(),
                retrySequence: previousRetryCount + 1,
                observedActionIds: [],
            };
            journal.recoveryRetryCount =
                previousRetryCount + 1;
            try {
                saveRecoveryJournalCritical(journal);
            } catch (error) {
                journal.inFlight = previousInFlight;
                journal.recoveryRetryCount =
                    previousRetryCount;
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '回执核对期结束，但无法把恢复重发'
                        + '授权写入本地任务账本：'
                        + `${error.message || String(error)}`,
                });
                return true;
            }

            op.phase = 'retry_authorized';
            log(
                '回执核对期内没有发现候选动作；已从持久账本授权'
                + '重发当前计划位置，后续依赖指令继续等待',
                'warn'
            );
            Transactions.settle(op, {
                status: 'retry_authorized',
            });
            return true;
        },

        commitQueueAcknowledgement(op, actionIdValue) {
            const actionId = normalizeActionId(actionIdValue);
            if (!actionId) {
                throw new BatchError(
                    '强化动作回执缺少有效 action.id',
                    'UNKNOWN'
                );
            }
            const run = State.run;
            const journal = run?.recoveryJournal;
            if (!journal) return;
            if (
                journal.jobId !== op.recoveryJobId ||
                journal.inFlight?.type !== 'action' ||
                journal.inFlight.commandKey !== op.commandKey ||
                JSON.stringify(journal.inFlight.fingerprint) !==
                    JSON.stringify(op.fingerprint)
            ) {
                throw new BatchError(
                    '强化动作回执与持久任务账本不一致',
                    'RECOVERY_INVALID'
                );
            }
            const commands = enumeratePlanCommands(
                journal.itemPlans,
                journal.mode
            );
            const expected = commands[journal.acked.length];
            if (
                !expected ||
                expected.commandKey !== op.commandKey ||
                Number(expected.commandIndex) !==
                    Number(op.commandIndex)
            ) {
                throw new BatchError(
                    '强化动作回执不是冻结计划中的下一条指令',
                    'RECOVERY_INVALID'
                );
            }
            const actionIdAlreadyRecorded = [
                ...(journal.adoptedActions || []),
                ...(journal.acked || []),
            ].some(
                (record) => (
                    normalizeActionId(record?.actionId) === actionId
                )
            );
            if (actionIdAlreadyRecorded) {
                throw new BatchError(
                    `强化动作 action.id ${actionId} 已被任务账本中的`
                    + '其他计划位置使用；拒绝把同一动作重复记账',
                    'RECOVERY_INVALID'
                );
            }
            const previousInFlight = journal.inFlight;
            journal.acked.push({
                commandKey: op.commandKey,
                actionId,
                fingerprint: cloneJsonValue(op.fingerprint),
            });
            journal.inFlight = null;
            try {
                saveRecoveryJournalCritical(journal);
            } catch (error) {
                journal.acked.pop();
                journal.inFlight = previousInFlight;
                throw error;
            }
        },

        confirmQueueCandidate(
            op,
            action,
            terminal = false,
            allowProgress = false,
            allowPartial = false
        ) {
            const actionId = normalizeActionId(action?.id);
            const matches = allowPartial
                ? actionCompletionMatches(
                    action,
                    op.fingerprint
                )
                : allowProgress
                    ? progressSingleEnhanceActionMatches(
                        action,
                        op.fingerprint
                    )
                    : strictSingleEnhanceActionMatches(
                        action,
                        op.fingerprint
                    );
            if (
                !actionId ||
                op.baselineActionIds.has(actionId) ||
                !matches
            ) {
                return false;
            }
            op.observedActionIds.add(actionId);
            if (op.externalMatchingQueueAddSeen) {
                try {
                    Transactions.persistInFlightState(op, {
                        phase: 'ambiguous',
                        errorReason:
                            '待确认期间放行过一条完全相同的外部'
                            + '强化请求，无法区分 action.id 归属',
                        observedActionIds: [
                            ...op.observedActionIds,
                        ],
                        externalMatchingQueueAddSeen: true,
                        spamRetryEvidenceSafe: false,
                        exclusiveSpamRejection: false,
                    });
                } catch {
                    // Preserve the original write-ahead record.
                }
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '已放行的外部队列请求与本计划位置完全相同；'
                        + `新动作 ${actionId} 没有 request id，无法安全`
                        + '判断属于哪次发送。脚本不会冒认或重发',
                });
                return true;
            }
            if (op.observedActionIds.size > 1) {
                try {
                    Transactions.persistInFlightState(op, {
                        phase: 'ambiguous',
                        errorReason:
                            '发现多条完全匹配的新强化动作',
                        observedActionIds: [
                            ...op.observedActionIds,
                        ],
                    });
                } catch {
                    // The original write-ahead record remains safer than
                    // clearing it when local storage is unavailable.
                }
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '发现多条完全匹配的新强化动作，'
                        + '无法唯一认领 action.id；脚本不会重发',
                });
                return true;
            }

            if (op.recoveryRetryAttempt) {
                op.retryCandidateAction =
                    cloneJsonValue(action);
                op.retryCandidateTerminal =
                    op.retryCandidateTerminal || terminal;
                if (op.phase !== 'retry_candidate_observed') {
                    const candidateObservationDeadline =
                        Date.now() +
                        CONFIG.QUEUE_RECONCILE_GRACE_MS;
                    try {
                        Transactions.persistInFlightState(op, {
                            phase: 'retry_candidate_observed',
                            observedActionIds: [actionId],
                            candidateObservationDeadline,
                        });
                    } catch (error) {
                        Transactions.settle(op, {
                            status: 'unknown',
                            reason:
                                '受控重试已看到唯一 action.id，但无法'
                                + '把候选写入任务账本：'
                                + `${error.message || String(error)}`,
                        });
                        return true;
                    }
                    op.phase = 'retry_candidate_observed';
                    op.retryCandidateDeadline =
                        candidateObservationDeadline;
                    if (op.timer) window.clearTimeout(op.timer);
                    op.timer = window.setTimeout(() => {
                        Transactions.commitObservedRetryCandidate(
                            op
                        );
                    }, CONFIG.QUEUE_RECONCILE_GRACE_MS);
                    if (State.run?.id === op.runId) {
                        State.run.currentStage =
                            '受控重试已收到一个 action.id；'
                            + '继续核对 48 秒是否还有第二个迟到候选';
                    }
                    scheduleUiRefresh();
                }
                return true;
            }

            try {
                Transactions.commitQueueAcknowledgement(
                    op,
                    actionId
                );
            } catch (error) {
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '强化已得到 action.id，但确认结果无法安全写入'
                        + `本地任务账本：${error.message || String(error)}。`
                        + '刷新后可由发送前记录继续核对，当前不会重发',
                });
                return true;
            }
            op.actionId = actionId;
            Transactions.settle(op, {
                status: 'confirmed',
                actionId,
                terminal,
                completedAction: terminal
                    ? cloneJsonValue(action)
                    : null,
            });
            return true;
        },

        commitObservedRetryCandidate(op) {
            if (
                !op ||
                State.pendingOp !== op ||
                op.settled ||
                !op.recoveryRetryAttempt ||
                op.phase !== 'retry_candidate_observed' ||
                op.observedActionIds.size !== 1
            ) {
                return false;
            }
            const [actionId] = op.observedActionIds;
            if (
                op.removalSeen &&
                op.retryCandidateTerminal !== true
            ) {
                try {
                    Transactions.persistInFlightState(op, {
                        phase:
                            'retry_candidate_removed_unconfirmed',
                        errorReason:
                            '受控重试候选已从队列移除，但尚未收到'
                            + '对应 action_completed',
                        observedActionIds: [actionId],
                    });
                } catch {
                    // Retain the earlier durable candidate observation.
                }
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '受控重试候选已从队列移除，但完成回执尚未'
                        + '收束；刷新后继续核对，脚本不会重发',
                });
                return true;
            }
            try {
                Transactions.commitQueueAcknowledgement(
                    op,
                    actionId
                );
            } catch (error) {
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        '受控重试的唯一 action.id 已稳定，但确认结果'
                        + '无法安全写入任务账本：'
                        + `${error.message || String(error)}`,
                });
                return true;
            }
            op.actionId = actionId;
            Transactions.settle(op, {
                status: 'confirmed',
                actionId,
                terminal: op.retryCandidateTerminal === true,
                completedAction:
                    op.retryCandidateTerminal === true
                        ? cloneJsonValue(
                            op.retryCandidateAction
                        )
                        : null,
            });
            return true;
        },

        settle(op, outcome) {
            if (!op || State.pendingOp !== op || op.settled) return false;
            if (op.runId !== State.run?.id) return false;
            op.settled = true;
            if (op.timer) window.clearTimeout(op.timer);
            if (op.projectionTimer) {
                window.clearTimeout(op.projectionTimer);
            }
            op.projectionTimer = null;
            op.projectionDueAt = null;
            op.projectionSignature = '';
            op.projectionCheckToken = (op.projectionCheckToken || 0) + 1;
            State.pendingOp = null;

            op.resolve(outcome);
            scheduleUiRefresh();
            return true;
        },

        isCurrentProjectedPurchase(op) {
            return Boolean(
                op && State.pendingOp === op && !op.settled &&
                op.kind === 'purchase' &&
                op.runId === State.run?.id &&
                op.epoch === State.connectionEpoch &&
                op.syncEpoch === State.syncEpoch &&
                State.inventoryReady && State.queueReady &&
                Number.isFinite(op.expectedProjectedInventory) &&
                op.purchaseInventoryEvidenceSeen === true
            );
        },

        projectedPurchaseSignature(op) {
            const itemHrid = fullItemHrid(op.itemId);
            const actions = getEnhancingActions()
                .filter(action => (
                    parseItemHash(action.primaryItemHash)?.itemHrid === itemHrid
                ))
                .map(action => [
                    normalizeActionId(action.id),
                    action.actionHrid,
                    action.primaryItemHash,
                    action.secondaryItemHash,
                    action.enhancingMaxLevel,
                    action.difficultyTier ?? null,
                    action.hasMaxCount ?? null,
                    action.maxCount ?? null,
                ])
                .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
            // Projection consumes all levels of this item. Unrelated actions
            // and ordinal shifts do not change its inventory calculation.
            return JSON.stringify([getItemCounts(op.itemId), actions]);
        },

        armProjectedPurchaseCheck(op) {
            if (!Transactions.isCurrentProjectedPurchase(op) ||
                !Number.isFinite(op.projectionDueAt) || op.projectionTimer) {
                return;
            }
            const token = op.projectionCheckToken;
            op.projectionTimer = window.setTimeout(() => {
                if (token !== op.projectionCheckToken) return;
                op.projectionTimer = null;
                Transactions.checkProjectedPurchase(op, token);
            }, Math.max(0, op.projectionDueAt - Date.now()));
        },

        scheduleProjectedPurchaseCheck(op) {
            if (!Transactions.isCurrentProjectedPurchase(op)) return false;
            const signature = Transactions.projectedPurchaseSignature(op);
            if (signature === op.projectionSignature &&
                Number.isFinite(op.projectionDueAt)) {
                return Transactions.checkProjectedPurchase(op);
            }
            if (op.projectionTimer) window.clearTimeout(op.projectionTimer);
            op.projectionTimer = null;
            op.projectionSignature = signature;
            op.projectionCheckToken = (op.projectionCheckToken || 0) + 1;
            op.projectionDueAt = Date.now() + CONFIG.PURCHASE_PROJECTION_QUIET_MS;
            op.projectionError = '';
            Transactions.armProjectedPurchaseCheck(op);
            return false;
        },

        checkProjectedPurchase(op, token = op?.projectionCheckToken) {
            if (!Transactions.isCurrentProjectedPurchase(op) ||
                token !== op.projectionCheckToken ||
                !Number.isFinite(op.projectionDueAt)) {
                return false;
            }
            if (Transactions.projectedPurchaseSignature(op) !== op.projectionSignature) {
                Transactions.scheduleProjectedPurchaseCheck(op);
                return false;
            }
            if (Date.now() < op.projectionDueAt) {
                Transactions.armProjectedPurchaseCheck(op);
                return false;
            }
            let currentProjectedInventory;
            try {
                currentProjectedInventory = getProjectedQueueTailInventoryCount(
                    op.itemId, op.level
                );
            } catch (error) {
                op.projectionError = error?.message || String(error);
                return false;
            }
            op.currentProjectedInventory = currentProjectedInventory;
            if (currentProjectedInventory !== op.expectedProjectedInventory) return false;
            return Transactions.settle(op, {
                status: 'confirmed',
                currentCount: getItemCount(op.itemId, op.level),
                currentProjectedInventory,
            });
        },

        begin(run, options) {
            if (State.pendingOp || State.marketOp || State.marketBusy) {
                throw new BatchError('内部错误：已有请求正在等待回执');
            }
            if (!State.socket || State.socket.readyState !== WebSocket.OPEN) {
                throw new BatchError('WebSocket 未连接', 'DISCONNECTED');
            }
            if (State.blockedReason) {
                throw new BatchError(
                    `当前状态被锁定：${State.blockedReason}`,
                    'UNKNOWN'
                );
            }
            if (
                run.characterId !== State.characterId ||
                run.characterId !== getCharacterId()
            ) {
                throw new BatchError(
                    '运行角色与当前页面角色不一致，已拒绝发送',
                    'CHARACTER_CHANGED'
                );
            }
            if (run.syncEpoch !== State.syncEpoch) {
                throw new BatchError(
                    '角色数据已重新同步，旧计划已失效',
                    'STATE_CHANGED'
                );
            }

            const purchaseProjection = (
                options.kind === 'purchase' &&
                !Number.isFinite(
                    options.expectedProjectedInventory
                )
            )
                ? getPurchaseQueueProjection(
                    options.itemId,
                    options.level,
                    options.count
                )
                : null;
            const inheritedExternalOverlap =
                hasExternalErrorFence();
            const inheritedMatchingQueueAdd =
                hasUnsettledExternalQueueAddMatching(
                    options.fingerprint
                );
            const op = {
                id: ++State.nextOpId,
                runId: run.id,
                epoch: State.connectionEpoch,
                syncEpoch: State.syncEpoch,
                kind: options.kind,
                itemId: options.itemId,
                level: options.level,
                count: options.count,
                fingerprint: options.fingerprint || null,
                baselineActionIds: options.baselineActionIds
                    ? new Set(options.baselineActionIds)
                    : new Set(State.actions.keys()),
                baselineInventory: options.baselineInventory,
                expectedInventory: options.expectedInventory,
                baselineProjectedInventory:
                    options.baselineProjectedInventory ??
                    purchaseProjection?.baselineProjectedInventory,
                expectedProjectedInventory:
                    options.expectedProjectedInventory ??
                    purchaseProjection?.expectedProjectedInventory,
                baselineTargetCount: options.baselineTargetCount,
                commandKey: options.commandKey || '',
                commandIndex: options.commandIndex,
                recoveryJobId: options.recoveryJobId || '',
                recoveryRetryAttempt:
                    options.recoveryRetryAttempt === true,
                predecessorId: normalizeActionId(
                    options.predecessorId
                ),
                actionId: null,
                observedActionIds: new Set(),
                retryCandidateAction: null,
                retryCandidateTerminal: false,
                retryCandidateDeadline: null,
                completionSeen: false,
                compatibleCompletionSeen: false,
                removalSeen: false,
                externalOverlapEver:
                    inheritedExternalOverlap,
                externalMatchingQueueAddSeen:
                    inheritedMatchingQueueAdd,
                lastUnattributedError: '',
                reconcileErrorCode: '',
                spamRetryEvidenceSafe: false,
                phase: 'prepared',
                settled: false,
                timer: null,
                projectionTimer: null,
                projectionDueAt: null,
                projectionSignature: '',
                projectionCheckToken: 0,
                projectionError: '',
                purchaseInventoryEvidenceSeen: false,
                resolve: null,
            };

            const promise = new Promise((resolve) => {
                op.resolve = resolve;
            });
            State.pendingOp = op;
            if (
                op.kind === 'queue' &&
                run.recoveryJournal &&
                (
                    inheritedExternalOverlap ||
                    inheritedMatchingQueueAdd
                )
            ) {
                try {
                    Transactions.persistInFlightState(op, {
                        externalOverlapEver:
                            inheritedExternalOverlap,
                        externalMatchingQueueAddSeen:
                            inheritedMatchingQueueAdd,
                        spamRetryEvidenceSafe: false,
                        exclusiveSpamRejection: false,
                    });
                } catch (error) {
                    Transactions.settle(op, {
                        status: 'send_failed',
                        reason:
                            '无法在发送前把外部队列并发标记写入'
                            + `任务账本：${error.message || String(error)}`,
                    });
                    return promise;
                }
            }
            Transactions.resetTimer(
                op,
                options.timeoutMs,
                options.timeoutMessage
            );

            try {
                op.phase = 'sent';
                Network.sendOwned(options.payload);
            } catch (error) {
                Transactions.settle(op, {
                    status: 'send_failed',
                    reason: error.message || String(error),
                });
            }
            return promise;
        },

        verifiedEffectCommitted(op) {
            return Boolean(
                op?.completionSeen &&
                op.removalSeen &&
                op.actionId != null &&
                getRunAdjustedOutputCount(
                    State.run,
                    op.itemId,
                    op.fingerprint.enhancingMaxLevel
                ) === op.baselineTargetCount + 1
            );
        },

        handleIncoming(message) {
            const op = State.pendingOp;
            if (!op || op.settled) return;
            if (
                op.runId !== State.run?.id ||
                op.epoch !== State.connectionEpoch ||
                op.syncEpoch !== State.syncEpoch
            ) {
                return;
            }

            if (op.kind === 'purchase') {
                if (
                    Number.isFinite(
                        op.expectedProjectedInventory
                    )
                ) {
                    if (messageUpdatesInventoryItem(
                        message,
                        op.itemId,
                        op.level
                    )) {
                        op.purchaseInventoryEvidenceSeen = true;
                    }
                    if (Transactions.scheduleProjectedPurchaseCheck(op)) return;
                } else {
                    const currentCount = getItemCount(
                        op.itemId,
                        op.level
                    );
                    if (currentCount === op.expectedInventory) {
                        Transactions.settle(op, {
                            status: 'confirmed',
                            currentCount,
                        });
                        return;
                    }
                    if (currentCount > op.expectedInventory) {
                        Transactions.settle(op, {
                            status: 'unknown',
                            reason:
                                `采购等待期间 +${op.level} 库存增加超过预期：`
                                + `${currentCount} > ${op.expectedInventory}`,
                        });
                        return;
                    }
                }
            }

            if (
                (op.kind === 'queue' || op.kind === 'verified') &&
                op.actionId == null &&
                message.type === 'actions_updated' &&
                Array.isArray(message.endCharacterActions)
            ) {
                const matchingNewActions = [
                    ...new Map(
                        [
                            ...message.endCharacterActions,
                            ...State.actions.values(),
                        ]
                            .filter((action) => {
                        const actionId = normalizeActionId(action?.id);
                        if (!actionId || action.isDone) return false;
                        if (op.baselineActionIds.has(actionId)) return false;
                        return (
                            strictSingleEnhanceActionMatches(
                                action,
                                op.fingerprint
                            ) ||
                            (
                                op.observedActionIds.has(actionId) &&
                                progressSingleEnhanceActionMatches(
                                    action,
                                    op.fingerprint
                                )
                            )
                        );
                            })
                            .map((action) => [
                                normalizeActionId(action.id),
                                action,
                            ])
                    ).values(),
                ];

                if (matchingNewActions.length > 1) {
                    for (const action of matchingNewActions) {
                        op.observedActionIds.add(
                            normalizeActionId(action.id)
                        );
                    }
                    try {
                        Transactions.persistInFlightState(op, {
                            phase: 'ambiguous',
                            errorReason:
                                '同一核对窗口发现多条完全匹配的'
                                + '新增强化动作',
                            observedActionIds: [
                                ...op.observedActionIds,
                            ],
                        });
                    } catch {
                        // Keep the original write-ahead record if storage
                        // cannot accept the stronger ambiguity evidence.
                    }
                    Transactions.settle(op, {
                        status: 'unknown',
                        reason:
                            '同一回执中出现多条完全相同的新增强化动作，'
                            + '无法唯一认领 action.id',
                    });
                    return;
                }

                const [newAction] = matchingNewActions;
                if (newAction) {
                    if (
                        op.kind === 'queue' &&
                        Transactions.confirmQueueCandidate(
                            op,
                            newAction,
                            false,
                            true
                        )
                    ) {
                        return;
                    }
                    op.actionId = normalizeActionId(newAction.id);
                    op.phase = 'waiting_completion';
                    Transactions.resetTimer(
                        op,
                        CONFIG.ACTION_TIMEOUT_MS,
                        `动作 ${newAction.id} 等待完成超时`
                    );
                }
            }

            if (
                op.kind === 'queue' &&
                op.recoveryRetryAttempt &&
                op.phase === 'retry_candidate_observed' &&
                message.type === 'actions_updated' &&
                Array.isArray(message.endCharacterActions) &&
                message.endCharacterActions.some(
                    (action) => (
                        action.isDone &&
                        op.observedActionIds.has(
                            normalizeActionId(action?.id)
                        )
                    )
                )
            ) {
                op.removalSeen = true;
            }

            if (
                op.kind === 'verified' &&
                op.actionId != null &&
                message.type === 'actions_updated' &&
                Array.isArray(message.endCharacterActions) &&
                message.endCharacterActions.some(
                    (action) => (
                        normalizeActionId(action?.id) === op.actionId &&
                        action.isDone
                    )
                )
            ) {
                op.removalSeen = true;
            }

            if (
                op.kind === 'queue' &&
                op.actionId == null &&
                message.type === 'action_completed' &&
                message.endCharacterAction
            ) {
                const completed = message.endCharacterAction;
                const completedId = normalizeActionId(completed.id);
                const isObservedRetryCandidate = Boolean(
                    op.recoveryRetryAttempt &&
                    op.phase === 'retry_candidate_observed' &&
                    op.observedActionIds.has(completedId)
                );
                const liveCandidate = completedId
                    ? State.actions.get(completedId)
                    : null;
                const isCompatibleLiveCandidate = Boolean(
                    completedId &&
                    !op.baselineActionIds.has(completedId) &&
                    progressSingleEnhanceActionMatches(
                        liveCandidate,
                        op.fingerprint
                    )
                );
                const isIdentifiedCompletedCandidate = Boolean(
                    completedId &&
                    !liveCandidate &&
                    !op.baselineActionIds.has(completedId) &&
                    completionCarriesIdentifyingFields(completed) &&
                    actionCompletionMatches(
                        completed,
                        op.fingerprint
                    )
                );
                const terminal = completionHasTerminalEvidence(
                    completed,
                    op.fingerprint,
                    op.removalSeen
                );
                if (
                    isIdentifiedCompletedCandidate &&
                    !terminal &&
                    !isObservedRetryCandidate &&
                    !isCompatibleLiveCandidate
                ) {
                    op.observedActionIds.add(completedId);
                    op.spamRetryEvidenceSafe = false;
                    op.exclusiveSpamRejection = false;
                    try {
                        Transactions.persistInFlightState(op, {
                            phase: 'candidate_completion_observed',
                            observedActionIds: [
                                ...op.observedActionIds,
                            ],
                            spamRetryEvidenceSafe: false,
                            exclusiveSpamRejection: false,
                        });
                    } catch (error) {
                        Transactions.settle(op, {
                            status: 'unknown',
                            reason:
                                '已看到可识别的强化进度回执，但无法写入'
                                + `任务账本：${error.message || String(error)}`,
                        });
                    }
                    return;
                }
                if (
                    completedId &&
                    (
                        isObservedRetryCandidate ||
                        isCompatibleLiveCandidate ||
                        (
                            isIdentifiedCompletedCandidate &&
                            terminal
                        )
                    ) &&
                    Transactions.confirmQueueCandidate(
                        op,
                        completed,
                        terminal,
                        true,
                        true
                    )
                ) {
                    return;
                }
            }

            if (
                op.kind === 'verified' &&
                message.type === 'action_completed' &&
                message.endCharacterAction
            ) {
                const completed = message.endCharacterAction;
                const completedId = normalizeActionId(completed.id);
                const compatible = actionCompletionMatches(
                    completed,
                    op.fingerprint
                );
                const idMatches = op.actionId != null
                    ? completedId === op.actionId && compatible
                    : (
                        completedId &&
                        !op.baselineActionIds.has(completedId) &&
                        compatible
                    );

                if (
                    op.actionId != null &&
                    completedId === op.actionId &&
                    !compatible
                ) {
                    Transactions.settle(op, {
                        status: 'unknown',
                        reason:
                            `动作 ${completedId} 的完成回执与冻结的`
                            + '装备、目标或配装语义冲突',
                    });
                    return;
                }

                if (idMatches) {
                    op.actionId = completedId;
                    op.compatibleCompletionSeen = true;
                    const terminal = completionHasTerminalEvidence(
                        completed,
                        op.fingerprint,
                        op.removalSeen
                    );
                    if (!terminal) {
                        op.phase = 'waiting_completion';
                        return;
                    }
                    op.completionSeen = true;
                    op.phase = 'waiting_inventory';
                    if (Transactions.verifiedEffectCommitted(op)) {
                        Transactions.settle(op, {
                            status: 'confirmed',
                            actionId: completedId,
                            currentTargetCount:
                                getRunAdjustedOutputCount(
                                    State.run,
                                    op.itemId,
                                    op.fingerprint.enhancingMaxLevel
                            ),
                        });
                        return;
                    }
                    Transactions.resetTimer(
                        op,
                        CONFIG.INVENTORY_COMMIT_GRACE_MS,
                        `动作 ${completedId} 已完成，但库存或队列收尾未确认`
                    );
                }
            }

            if (
                op.kind === 'verified' &&
                Transactions.verifiedEffectCommitted(op)
            ) {
                    Transactions.settle(op, {
                        status: 'confirmed',
                        actionId: op.actionId,
                        currentTargetCount:
                            getRunAdjustedOutputCount(
                                State.run,
                                op.itemId,
                                op.fingerprint.enhancingMaxLevel
                        ),
                    });
                    return;
            }

            if (message.type === 'error') {
                const recentExternal =
                    State.recentAllowedExternalRequest;
                if (
                    recentExternal &&
                    recentExternal.epoch === State.connectionEpoch &&
                    recentExternal.pendingOpId === op.id &&
                    Date.now() - recentExternal.at <=
                        CONFIG.ALLOWED_EXTERNAL_ERROR_GRACE_MS
                ) {
                    State.recentAllowedExternalRequest = null;
                    op.lastUnattributedError = String(
                        message.message || '游戏服务器返回错误'
                    );
                    log(
                        `忽略紧随已放行外部请求 ${recentExternal.type} `
                        + '返回的无 request id '
                        + '错误；本脚本请求仍等待精确库存/队列回执',
                        'warn'
                    );
                    return;
                }
                const reason = String(message.message || '游戏服务器返回错误');
                if (op.externalOverlapEver) {
                    op.lastUnattributedError = reason;
                    log(
                        '本脚本请求等待期间有外部请求重叠；这条服务器'
                        + '错误没有 request id，暂不归给任何一方，'
                        + '继续等待精确库存或 action.id 回执',
                        'warn'
                    );
                    return;
                }
                if (op.kind === 'queue') {
                    if (
                        op.recoveryRetryAttempt &&
                        op.phase ===
                            'retry_candidate_observed' &&
                        op.observedActionIds.size === 1
                    ) {
                        log(
                            '受控重试已经收到唯一精确 action.id；'
                            + '忽略随后无法关联 request id 的错误，'
                            + '继续完成 48 秒双候选核对',
                            'warn'
                        );
                        return;
                    }
                    Transactions.enterQueueReconciliation(
                        op,
                        `等待本次请求时收到无法关联 request id 的服务器错误：`
                            + `${reason}`,
                        reason
                    );
                    return;
                }
                Transactions.settle(op, {
                    status: 'unknown',
                    reason:
                        `等待本次请求时收到无法关联 request id 的服务器错误：${reason}。`
                        + '为防止重复操作，脚本不会重发',
                });
            }
        },

        abortAsUnknown(reason) {
            const op = State.pendingOp;
            if (!op) return;
            Transactions.settle(op, {
                status: 'unknown',
                reason,
            });
        },
    };

    const READ_ONLY_OUTGOING_TYPES = new Set([
        'get_leaderboard',
        'get_loot_log',
        'get_collections',
        'get_monsters',
        'get_social_info',
        'get_guild_info',
        'get_guild_item_donations',
        'view_profile',
        'view_guild_profile',
        'get_my_market_listings',
        'get_market_item_order_books',
        'view_party_list',
        'view_party_link',
        'view_battle_unit',
    ]);

    const QUEUE_MUTATION_OUTGOING_TYPES = new Set([
        'new_character_action',
        'move_character_action_to_front',
        'move_character_action',
        'cancel_character_action',
        'cancel_all_queued_character_actions',
    ]);

    // Production hard boundary for the standalone queue helper. The legacy
    // market state machine remains below temporarily so old protocol tests can
    // exercise its parsers, but a real page can never send through it.
    const ENHANCER_OWNED_OUTGOING_TYPES = new Set([
        'buy_from_shop',
        'new_character_action',
    ]);

    const MARKET_WRITE_OUTGOING_TYPES = new Set([
        'post_market_order',
        'cancel_market_listing',
        'claim_market_listing',
        'claim_all_market_listings',
        'update_market_misprice_warning',
    ]);

    const LOADOUT_DEFINITION_MUTATION_OUTGOING_TYPES = new Set([
        'copy_setup_to_loadout',
        'delete_loadout',
        'update_loadout',
        'update_loadout_slot',
    ]);

    const LOADOUT_SAVE_OUTGOING_TYPES = new Set([
        'copy_setup_to_loadout',
        'update_loadout',
        'update_loadout_slot',
    ]);

    function getSavedLoadoutId(outgoing) {
        const message = outgoing.message;
        if (outgoing.type === 'copy_setup_to_loadout') {
            return normalizeLoadoutId(
                message?.copySetupToLoadoutData?.characterLoadoutId
            );
        }
        if (outgoing.type === 'update_loadout') {
            return normalizeLoadoutId(
                message?.updateLoadoutData?.characterLoadoutUpdate?.id
            );
        }
        if (outgoing.type === 'update_loadout_slot') {
            return normalizeLoadoutId(
                message?.updateLoadoutSlotData?.characterLoadoutSlotUpdate?.id
            );
        }
        return null;
    }

    function savedLoadoutPatchIsVisible(outgoing) {
        const id = getSavedLoadoutId(outgoing);
        const row = State.loadouts.get(String(id));
        if (!row || normalizeCharacterId(row.characterID ?? row.characterId) !==
            State.characterId) return false;
        if (outgoing.type === 'update_loadout') {
            const patch = outgoing.message.updateLoadoutData.characterLoadoutUpdate;
            return ['name', 'isDefault', 'suppressValidation', 'useExactEnhancement']
                .every(key => Object.prototype.hasOwnProperty.call(patch, key) &&
                    row[key] === patch[key]);
        }
        if (outgoing.type === 'update_loadout_slot') {
            const patch = outgoing.message.updateLoadoutSlotData.characterLoadoutSlotUpdate;
            let saved;
            if (patch.slotType === 'equipment') {
                // Slot names come from the game, including future new slots.
                saved = row.wearableMap?.[patch.slotKey];
            } else if (patch.slotType === 'food' || patch.slotType === 'drink') {
                const index = Number(patch.slotKey);
                if (!Number.isInteger(index) || index < 0 || index > 2) return false;
                saved = (patch.slotType === 'food'
                    ? row.foodItemHrids : row.drinkItemHrids)?.[index];
            } else if (patch.slotType === 'ability') {
                saved = row.abilityMap?.[patch.slotKey];
            } else {
                return false;
            }
            return typeof patch.itemIdentifier === 'string' &&
                (saved ?? '') === patch.itemIdentifier;
        }
        // copy_setup_to_loadout does not describe the resulting contents.
        // Without a correlated receipt, only a new full sync ends its barrier.
        return false;
    }

    const LOADOUT_NON_DEFINITION_OUTGOING_TYPES = new Set([
        'create_loadout',
        'load_loadout',
        'move_loadout',
    ]);

    const ITEM_TARGETED_MUTATION_OUTGOING_TYPES = new Set([
        'add_consumable',
        'buy_from_shop',
        'equip_item',
        'force_add_remove_item',
        'learn_ability_book',
        'open_loot',
        'sell_to_shop',
    ]);

    function classifyExternalOutgoing(raw) {
        if (typeof raw !== 'string') {
            return {kind: 'malformed', type: '', message: null};
        }

        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            return {kind: 'malformed', type: '', message: null};
        }

        if (
            !message ||
            typeof message !== 'object' ||
            Array.isArray(message) ||
            typeof message.type !== 'string' ||
            !/^[a-z][a-z0-9_]*$/.test(message.type)
        ) {
            return {kind: 'malformed', type: '', message: null};
        }

        if (
            message.type === 'ping' &&
            message.pingData?.hash === 1
        ) {
            return {kind: 'heartbeat', type: message.type, message};
        }
        if (READ_ONLY_OUTGOING_TYPES.has(message.type)) {
            return {kind: 'read_only', type: message.type, message};
        }
        if (QUEUE_MUTATION_OUTGOING_TYPES.has(message.type)) {
            return {kind: 'queue_mutation', type: message.type, message};
        }
        return {
            kind: 'state_changing_or_unknown',
            type: message.type,
            message,
        };
    }

    function normalizeActionId(value) {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) && numeric > 0
            ? String(numeric)
            : '';
    }

    function isRunOwnedActionId(value) {
        const actionId = normalizeActionId(value);
        if (!actionId) return true;
        if (
            normalizeActionId(State.pendingOp?.actionId) === actionId
        ) {
            return true;
        }
        if (State.run?.ownedActionIds?.has(actionId)) {
            return true;
        }
        return Boolean(
            [
                ...(State.recoveryJournal?.adoptedActions || []),
                ...(State.recoveryJournal?.acked || []),
            ].some(
                (record) => (
                    normalizeActionId(record?.actionId) === actionId
                )
            )
        );
    }

    function hasUnsettledRunTail(run = State.run) {
        return Boolean(
            run &&
            (
                run.ownedActionIds?.size > 0 ||
                run.ownedRemovalPending?.size > 0 ||
                run.ownedOrderValidationPending === true ||
                run.ownedOrderValidationTimer ||
                run.marketPostInventoryBarriers?.size > 0
            )
        );
    }

    function isProtectedRunLifecycle(run = State.run) {
        return Boolean(
            run &&
            (
                run.active ||
                hasUnsettledRunTail(run) ||
                run.marketFinalSweepPending ||
                run.marketFinalSweepPhase === 'waiting_inventory' ||
                run.marketFinalSweepPhase === 'running' ||
                run.marketSteadyMonitoring === true
            )
        );
    }

    function getAuthoritativeActionById(value) {
        const actionId = normalizeActionId(value);
        return actionId ? State.actions.get(actionId) || null : null;
    }

    function collectReferencedItemHrids(value, result = new Set(), depth = 0) {
        if (depth > 8 || value == null) return result;
        if (typeof value === 'string') {
            for (const match of value.matchAll(/\/items\/[a-z0-9_]+/g)) {
                result.add(match[0]);
            }
            for (
                const match of value.matchAll(
                    /\/shop_items\/(?:test\/)?([a-z0-9_]+)/g
                )
            ) {
                result.add(`/items/${match[1]}`);
            }
            return result;
        }
        if (Array.isArray(value)) {
            for (const entry of value) {
                collectReferencedItemHrids(entry, result, depth + 1);
            }
            return result;
        }
        if (typeof value === 'object') {
            for (const entry of Object.values(value)) {
                collectReferencedItemHrids(entry, result, depth + 1);
            }
        }
        return result;
    }

    function collectReferencedLoadoutIds(
        value,
        result = new Set(),
        depth = 0
    ) {
        if (
            depth > 8 ||
            value == null ||
            typeof value !== 'object'
        ) {
            return result;
        }
        if (Array.isArray(value)) {
            for (const entry of value) {
                collectReferencedLoadoutIds(
                    entry,
                    result,
                    depth + 1
                );
            }
            return result;
        }
        for (const [key, entry] of Object.entries(value)) {
            if (
                /loadoutid$/i.test(key)
            ) {
                const loadoutId = normalizeLoadoutId(entry);
                if (loadoutId != null) result.add(loadoutId);
            }
            collectReferencedLoadoutIds(
                entry,
                result,
                depth + 1
            );
        }
        return result;
    }

    function isExternalQueueLike(outgoing) {
        if (outgoing.kind === 'queue_mutation') return true;
        return Boolean(
            /(?:character_action|queued_character_action|queue)/.test(
                outgoing.type || ''
            )
        );
    }

    function fingerprintExternalEnhanceData(data) {
        if (
            !data ||
            typeof data !== 'object' ||
            data.actionHrid !== ENHANCE_ACTION_HRID
        ) {
            return null;
        }
        return {
            primaryItemHash: String(data.primaryItemHash || ''),
            secondaryItemHash: String(data.secondaryItemHash || ''),
            enhancingMaxLevel:
                Number(data.enhancingMaxLevel),
            enhancingProtectionMinLevel:
                Number(data.enhancingProtectionMinLevel),
            characterLoadoutId:
                getActionLoadoutId(data),
        };
    }

    function enhancementFingerprintsEqual(left, right) {
        return Boolean(
            left &&
            right &&
            left.primaryItemHash === right.primaryItemHash &&
            left.secondaryItemHash === right.secondaryItemHash &&
            Number(left.enhancingMaxLevel) ===
                Number(right.enhancingMaxLevel) &&
            Number(left.enhancingProtectionMinLevel) ===
                Number(right.enhancingProtectionMinLevel) &&
            normalizeLoadoutId(left.characterLoadoutId) ===
                normalizeLoadoutId(right.characterLoadoutId)
        );
    }

    function hasUnsettledExternalQueueAddMatching(
        fingerprint
    ) {
        if (!fingerprint) return false;
        pruneExternalQueueReservations();
        return State.pendingExternalQueueAdds.some(
            (reservation) => (
                enhancementFingerprintsEqual(
                    reservation.enhanceFingerprint,
                    fingerprint
                )
            )
        );
    }

    function hasExternalErrorFence() {
        pruneExternalQueueReservations();
        return Boolean(
            Date.now() <=
                Number(State.externalErrorFenceUntil || 0) ||
            State.pendingExternalQueueAdds.length > 0
        );
    }

    function rememberAllowedExternalRequest(
        outgoing,
        extra = {}
    ) {
        const pendingOp = State.pendingOp;
        const marketOp = State.marketOp;
        State.externalErrorFenceUntil = Math.max(
            Number(State.externalErrorFenceUntil || 0),
            Date.now() + CONFIG.EXTERNAL_UNATTRIBUTED_FENCE_MS
        );
        if (pendingOp) {
            const firstOverlap =
                pendingOp.externalOverlapEver !== true;
            pendingOp.externalOverlapEver = true;
            pendingOp.spamRetryEvidenceSafe = false;
            let matchingQueueAdd = false;
            if (
                outgoing.type === 'new_character_action' &&
                pendingOp.fingerprint &&
                strictSingleEnhanceActionMatches(
                    outgoing.message?.newCharacterActionData,
                    pendingOp.fingerprint
                )
            ) {
                pendingOp.externalMatchingQueueAddSeen = true;
                matchingQueueAdd = true;
            }
            if (
                (firstOverlap || matchingQueueAdd) &&
                State.run?.recoveryJournal?.inFlight?.type ===
                    'action' &&
                State.run.recoveryJournal.inFlight.commandKey ===
                    pendingOp.commandKey
            ) {
                try {
                    Transactions.persistInFlightState(
                        pendingOp,
                        {
                            externalOverlapEver: true,
                            externalMatchingQueueAddSeen:
                                pendingOp
                                    .externalMatchingQueueAddSeen ===
                                    true,
                            spamRetryEvidenceSafe: false,
                            exclusiveSpamRejection: false,
                        }
                    );
                } catch (error) {
                    log(
                        '已放行一条与待确认动作完全相同的外部队列'
                        + '请求，但无法把并发标记写入任务账本；'
                        + '本页仍会禁用自动重试：'
                        + `${error.message || String(error)}`,
                        'warn'
                    );
                }
            }
        }
        if (marketOp) {
            marketOp.externalOverlapEver = true;
        }
        State.recentAllowedExternalRequest = {
            type: outgoing.type,
            at: Date.now(),
            epoch: State.connectionEpoch,
            pendingOpId: pendingOp?.id ?? null,
            marketOpId: marketOp?.id ?? null,
            ...extra,
        };
    }

    function getProtectedEnhancingLoadoutId() {
        const direct = normalizeLoadoutId(
            State.run?.enhancingLoadoutId ??
                State.recoveryJournal?.enhancingLoadout?.id
        );
        if (direct != null) return direct;
        if (!State.starting) return null;
        try {
            return getEnhancingLoadoutBinding().id;
        } catch {
            return null;
        }
    }

    function externalRequestTouchesProtectedState(outgoing) {
        const message = outgoing.message;
        if (!message || typeof message !== 'object') return true;

        if (MARKET_WRITE_OUTGOING_TYPES.has(outgoing.type)) {
            return true;
        }

        if (
            LOADOUT_NON_DEFINITION_OUTGOING_TYPES.has(
                outgoing.type
            )
        ) {
            return false;
        }

        const protectedLoadoutId =
            getProtectedEnhancingLoadoutId();
        const referencedLoadoutIds =
            collectReferencedLoadoutIds(message);
        if (
            protectedLoadoutId != null &&
            referencedLoadoutIds.has(protectedLoadoutId)
        ) {
            return true;
        }
        if (
            LOADOUT_DEFINITION_MUTATION_OUTGOING_TYPES.has(
                outgoing.type
            ) &&
            referencedLoadoutIds.size === 0
        ) {
            return true;
        }

        if (externalActionTouchesReservedResources(message)) {
            return true;
        }
        return Boolean(
            ITEM_TARGETED_MUTATION_OUTGOING_TYPES.has(
                outgoing.type
            ) &&
            collectReferencedItemHrids(message).size === 0
        );
    }

    function externalActionTouchesReservedResources(data) {
        const itemIds = [
            ...new Set([
                ...(State.run?.itemIds || []),
                ...(State.recoveryJournal?.itemIds || []),
                ...State.selected,
            ]),
        ];
        let loadoutItemHrids =
            State.run?.enhancingLoadoutReservedItemHrids ||
            State.recoveryJournal?.enhancingLoadout
                ?.reservedItemHrids ||
            [];
        if (!State.run?.active && State.starting) {
            try {
                loadoutItemHrids =
                    getEnhancingLoadoutBinding().reservedItemHrids;
            } catch {
                return true;
            }
        }
        const protectedItemHrids = new Set([
            ...itemIds.map((itemId) => fullItemHrid(itemId)),
            fullItemHrid(PHILOSOPHERS_MIRROR),
            GRANDMASTER_ENHANCING_CHARM_HRID,
            ...loadoutItemHrids,
        ]);
        const referencedItemHrids = collectReferencedItemHrids(data);
        if ([...referencedItemHrids].some(
            (itemHrid) => protectedItemHrids.has(itemHrid)
        )) {
            return true;
        }
        const protectedShortIds = [...protectedItemHrids].map(
            normalizeShortItemId
        );
        return (
            typeof data?.actionHrid === 'string' &&
            protectedShortIds.some(
                (itemId) => data.actionHrid.endsWith(`/${itemId}`)
            )
        );
    }

    function isSafeExternalQueueMutation(message) {
        const effectiveMode = (
            isProtectedRunLifecycle(State.run)
        )
            ? State.run.mode
            : State.settings.mode;
        if (effectiveMode !== 'quick') return false;

        if (message.type === 'new_character_action') {
            const data = message.newCharacterActionData;
            return Boolean(
                data &&
                typeof data === 'object' &&
                !Array.isArray(data) &&
                typeof data.actionHrid === 'string' &&
                data.actionHrid.startsWith('/actions/') &&
                data.actionHrid !== ENHANCE_ACTION_HRID &&
                data.isStartNow === false &&
                data.shouldClearQueue !== true &&
                !externalActionTouchesReservedResources(data)
            );
        }

        if (message.type === 'move_character_action_to_front') {
            const actionId =
                message.moveCharacterActionToFrontData?.characterActionId;
            const action = getAuthoritativeActionById(actionId);
            return Boolean(
                action &&
                !isRunOwnedActionId(actionId) &&
                !externalActionTouchesReservedResources(action)
            );
        }

        if (message.type === 'move_character_action') {
            const data = message.moveCharacterActionData;
            const actionId = data?.characterActionId;
            const afterActionId = data?.afterCharacterActionId;
            const action = getAuthoritativeActionById(actionId);
            const validAfterAction = (
                afterActionId === 0 ||
                (
                    normalizeActionId(afterActionId) &&
                    getAuthoritativeActionById(afterActionId)
                )
            );
            return Boolean(
                data &&
                Object.prototype.hasOwnProperty.call(
                    data,
                    'afterCharacterActionId'
                ) &&
                action &&
                validAfterAction &&
                !isRunOwnedActionId(actionId) &&
                !externalActionTouchesReservedResources(action)
            );
        }

        if (message.type === 'cancel_character_action') {
            const actionId =
                message.cancelCharacterActionData?.characterActionId;
            const action = getAuthoritativeActionById(actionId);
            return Boolean(
                action &&
                !isRunOwnedActionId(actionId) &&
                !externalActionTouchesReservedResources(action)
            );
        }

        return false;
    }

    function pruneExternalQueueReservations() {
        const now = Date.now();
        const previousLength = State.pendingExternalQueueAdds.length;
        State.pendingExternalQueueAdds =
            State.pendingExternalQueueAdds.filter(
                (reservation) => reservation.expiresAt > now
            );
        if (State.pendingExternalQueueAdds.length !== previousLength) {
            State.queueRevision++;
        }
    }

    function reserveExternalQueueAdd(message) {
        if (message.type !== 'new_character_action') return;
        const data = message.newCharacterActionData;
        const actionHrid = data?.actionHrid;
        if (
            typeof actionHrid !== 'string' ||
            !actionHrid.startsWith('/actions/')
        ) {
            return;
        }
        pruneExternalQueueReservations();
        State.pendingExternalQueueAdds.push({
            actionHrid,
            enhanceFingerprint:
                fingerprintExternalEnhanceData(data),
            baselineActionIds: new Set(State.actions.keys()),
            expiresAt:
                Date.now() + CONFIG.EXTERNAL_QUEUE_RESERVATION_MS,
        });
        State.queueRevision++;
    }

    function reconcileExternalQueueReservations(actions) {
        if (
            !Array.isArray(actions) ||
            State.pendingExternalQueueAdds.length === 0
        ) {
            return;
        }
        pruneExternalQueueReservations();
        for (const action of actions) {
            const actionId = normalizeActionId(action?.id);
            if (!actionId || action.isDone || State.actions.has(actionId)) {
                continue;
            }
            const reservationIndex =
                State.pendingExternalQueueAdds.findIndex(
                    (reservation) => (
                        reservation.actionHrid === action.actionHrid &&
                        (
                            reservation.actionHrid !==
                                ENHANCE_ACTION_HRID ||
                            enhancementFingerprintsEqual(
                                reservation.enhanceFingerprint,
                                actionFingerprintFromQueueAction(
                                    action
                                )
                            )
                        ) &&
                        !reservation.baselineActionIds.has(actionId)
                    )
                );
            if (reservationIndex >= 0) {
                State.pendingExternalQueueAdds.splice(
                    reservationIndex,
                    1
                );
                State.queueRevision++;
            }
        }
    }

    function getReservedExternalQueueSlots() {
        pruneExternalQueueReservations();
        return State.pendingExternalQueueAdds.length;
    }

    function clearCharacterItemSnapshot() {
        State.characterItemsReady = false;
        State.characterItemSlots.clear();
        State.characterItemsRevision++;
    }

    function replaceCharacterItemSnapshot(items) {
        State.characterItemSlots.clear();
        State.characterItemsReady = Array.isArray(items);
        if (State.characterItemsReady) {
            for (const item of items) {
                const normalized = normalizeCharacterItem(item);
                if (normalized && normalized.count > 0) {
                    State.characterItemSlots.set(
                        normalized.key,
                        normalized
                    );
                }
            }
        }
        State.characterItemsRevision++;
    }

    function updateCharacterItemSnapshot(item) {
        const normalized = normalizeCharacterItem(item);
        if (!normalized || !State.characterItemsReady) return;
        const previous =
            State.characterItemSlots.get(normalized.key) || null;
        if (normalized.count === 0) {
            if (previous) {
                State.characterItemSlots.delete(normalized.key);
                State.characterItemsRevision++;
            }
            return;
        }
        if (
            previous &&
            previous.count === normalized.count
        ) {
            return;
        }
        State.characterItemSlots.set(normalized.key, normalized);
        State.characterItemsRevision++;
    }

    function failRunQueueIntegrity(run, reason) {
        if (!run || run.integrityFailure) return;
        WorkSignals.notify();
        run.integrityFailure = reason;
        run.interferenceDetected = true;
        run.queueWarning = reason;
        run.stopRequested = true;
        if (run.active) {
            run.currentStage = '队列完整性异常，停止继续发送';
        } else {
            run.status = 'unknown';
            run.currentStage = '已入队动作监控异常';
        }
        State.blockedReason = State.blockedReason ||
            `${reason}；请刷新页面取得可信队列状态`;
        Transactions.abortAsUnknown(reason);
        MarketTransactions.abortAsUnknown(reason);
        MarketMaintenance.abortFinalSweep(run, reason);
        MarketMaintenance.stopScheduling();
        log(reason, 'error');
        scheduleUiRefresh();
    }

    function clearOwnedRemovalPending(run, actionId) {
        const pending = run?.ownedRemovalPending?.get(actionId);
        if (pending?.timer) window.clearTimeout(pending.timer);
        run?.ownedRemovalPending?.delete(actionId);
    }

    function scheduleFinalSweepReadinessCheck(run, delay = 50) {
        if (
            !run ||
            State.run?.id !== run.id ||
            run.marketFinalSweepInventoryTimer ||
            run.marketFinalSweepPhase === 'running' ||
            run.marketFinalSweepPhase === 'completed' ||
            run.marketFinalSweepPhase === 'aborted'
        ) {
            return;
        }
        run.marketFinalSweepInventoryTimer =
            window.setTimeout(() => {
                run.marketFinalSweepInventoryTimer = null;
                tryBeginFinalSweep(run);
            }, Math.max(0, delay));
    }

    function tryBeginFinalSweep(run) {
        if (
            !run ||
            State.run?.id !== run.id ||
            run.active ||
            run.ownedActionIds?.size > 0 ||
            run.marketFinalSweepPhase === 'running' ||
            run.marketFinalSweepPhase === 'completed' ||
            run.marketFinalSweepPhase === 'aborted'
        ) {
            return false;
        }
        if (
            run.stopRequested ||
            run.integrityFailure ||
            State.blockedReason ||
            !['completed', 'queued'].includes(run.status)
        ) {
            run.marketFinalSweepPhase = 'aborted';
            MarketMaintenance.stopScheduling();
            State.ui?.setLocked(false);
            return false;
        }

        run.marketFinalSweepPhase = 'waiting_inventory';
        const pendingBarriers = [
            ...(run.marketPostInventoryBarriers?.entries() || []),
        ];
        if (pendingBarriers.length > 0) {
            const expired = pendingBarriers.find(([, barrier]) => (
                barrier.postConfirmed &&
                Number(barrier.confirmedAt) > 0 &&
                Date.now() - Number(barrier.confirmedAt) >=
                    CONFIG.INVENTORY_COMMIT_GRACE_MS
            ));
            if (expired) {
                const [itemId, barrier] = expired;
                MarketMaintenance.expirePostInventoryBarrier(
                    run,
                    itemId,
                    barrier
                );
                return false;
            }
            run.currentStage =
                '本批动作已结束，等待当前挂单的库存绝对值回执';
            State.ui?.setLocked(true);
            scheduleFinalSweepReadinessCheck(run);
            scheduleUiRefresh();
            return false;
        }
        if (State.pendingOp || State.marketBusy || State.marketOp) {
            run.currentStage =
                '本批动作已结束，等待当前事务安全收束';
            State.ui?.setLocked(true);
            scheduleFinalSweepReadinessCheck(run);
            scheduleUiRefresh();
            return false;
        }
        if (!run.marketFinalSweepInventoryDeadline) {
            run.marketFinalSweepInventoryDeadline =
                Date.now() + CONFIG.INVENTORY_COMMIT_GRACE_MS;
        }
        const mismatches = [];
        for (const result of run.results || []) {
            const expected =
                Number(result.baselineOutputCount) +
                Number(result.targetOutputs);
            const actual = getRunAdjustedOutputCount(
                run,
                result.itemId
            );
            if (actual !== expected) {
                mismatches.push({
                    itemId: result.itemId,
                    expected,
                    actual,
                });
            }
        }
        const impossibleIncrease = mismatches.find(
            ({actual, expected}) => actual > expected
        );
        if (
            impossibleIncrease ||
            (
                mismatches.length > 0 &&
                Date.now() >=
                    run.marketFinalSweepInventoryDeadline
            )
        ) {
            const detail = (impossibleIncrease || mismatches[0]);
            failRunQueueIntegrity(
                run,
                `${getItemName(detail.itemId)} 最后一件动作结束后，`
                + `校正后的 +20 库存为 ${detail.actual}，`
                + `预期 ${detail.expected}；不执行自动出售`
            );
            run.marketFinalSweepPhase = 'aborted';
            return false;
        }
        if (
            mismatches.length > 0
        ) {
            run.currentStage =
                '本批动作已结束，等待最后 +20 库存绝对值回执';
            State.ui?.setLocked(true);
            scheduleFinalSweepReadinessCheck(run);
            scheduleUiRefresh();
            return false;
        }

        if (run.recoveryJournal) {
            try {
                clearRecoveryJournalCritical(
                    run.recoveryJournal.jobId,
                    run.recoveryJournal.revision
                );
                run.recoveryJournal = null;
                log(
                    '本批全部动作和最终 +20 库存已精确收束，'
                    + '持久任务账本已安全清除',
                    'success'
                );
            } catch (error) {
                failRunQueueIntegrity(
                    run,
                    '最终状态已匹配，但无法安全清除持久任务账本：'
                    + `${error.message || String(error)}`
                );
                run.marketFinalSweepPhase = 'aborted';
                return false;
            }
        }

        if (
            State.marketWriteBlockedReason ||
            !run.marketMaintenanceEnabled ||
            !State.settings.marketMaintenanceEnabled
        ) {
            run.marketFinalSweepPhase =
                State.marketWriteBlockedReason
                    ? 'aborted'
                    : 'completed';
            run.currentStage = State.marketWriteBlockedReason
                ? '已结束；市场自动出售已安全停用'
                : '已结束';
            MarketMaintenance.stopScheduling();
            State.ui?.setLocked(false);
            scheduleUiRefresh();
            return false;
        }
        return MarketMaintenance.beginFinalSweep(run);
    }

    function finishOwnedActionMonitoring(run, actionId) {
        clearOwnedRemovalPending(run, actionId);
        run?.ownedActionIds?.delete(actionId);
        run?.ownedActionFingerprints?.delete(actionId);
        run?.ownedActionProgressLevels?.delete(actionId);
        run?.ownedCompatibleCompletions?.delete(actionId);
        run?.completedOwnedActionIds?.delete(actionId);
        if (
            run &&
            !run.active &&
            run.ownedActionIds?.size === 0 &&
            !run.allOwnedActionsFinishedLogged
        ) {
            run.allOwnedActionsFinishedLogged = true;
            log('本批已入队强化动作均已收到完成与移除回执', 'success');
            tryBeginFinalSweep(run);
        }
    }

    function recordOwnedActionProgress(run, actionId, action) {
        const level = actionProgressLevel(action);
        if (!Number.isSafeInteger(level)) return;
        run.ownedActionProgressLevels ||= new Map();
        const previous = Number(
            run.ownedActionProgressLevels.get(actionId)
        );
        if (!Number.isSafeInteger(previous) || level > previous) {
            run.ownedActionProgressLevels.set(actionId, level);
        }
    }

    function noteOwnedActionCompleted(action) {
        const run = State.run;
        const actionId = normalizeActionId(action?.id);
        if (!run || !actionId || !run.ownedActionIds?.has(actionId)) {
            return;
        }
        const fingerprint = run.ownedActionFingerprints?.get(actionId);
        if (fingerprint && !actionCompletionMatches(action, fingerprint)) {
            failRunQueueIntegrity(
                run,
                `本批动作 ${actionId} 的完成回执与冻结的装备、`
                + '目标或配装语义冲突'
            );
            return;
        }
        recordOwnedActionProgress(run, actionId, action);
        run.ownedCompatibleCompletions ||= new Map();
        const previousCompletion =
            run.ownedCompatibleCompletions.get(actionId) || {};
        run.ownedCompatibleCompletions.set(
            actionId,
            {
                ...previousCompletion,
                ...action,
                ...(
                    action.primaryItemHash == null &&
                    previousCompletion.primaryItemHash != null
                        ? {
                            primaryItemHash:
                                previousCompletion.primaryItemHash,
                        }
                        : {}
                ),
            }
        );
        if (!completionHasTerminalEvidence(
            action,
            fingerprint,
            run.ownedRemovalPending.has(actionId)
        )) {
            return;
        }
        if (!run.completedOwnedActionIds.has(actionId)) {
            if (
                Number(fingerprint?.enhancingMaxLevel) ===
                    CONFIG.TARGET_LEVEL
            ) {
                const completedItemId = normalizeShortItemId(
                    parseItemHash(
                        fingerprint.primaryItemHash
                    )?.itemHrid
                );
                if (completedItemId) {
                    run.completedOwnedOutputActionIds ||= new Set();
                    run.completedOwnedOutputCounts ||= new Map();
                    if (
                        !run.completedOwnedOutputActionIds.has(
                            actionId
                        )
                    ) {
                        run.completedOwnedOutputActionIds.add(
                            actionId
                        );
                        run.completedOwnedOutputCounts.set(
                            completedItemId,
                            Number(
                                run.completedOwnedOutputCounts.get(
                                    completedItemId
                                ) || 0
                            ) + 1
                        );
                    }
                }
            }
            run.completedOwnedActionIds.add(actionId);
        }
        if (run.ownedRemovalPending.has(actionId)) {
            finishOwnedActionMonitoring(run, actionId);
        }
    }

    function noteOwnedActionDelta(action) {
        const run = State.run;
        const actionId = normalizeActionId(action?.id);
        if (!run || !actionId || !run.ownedActionIds?.has(actionId)) {
            return;
        }

        if (!action.isDone) {
            const fingerprint = run.ownedActionFingerprints.get(actionId);
            if (
                fingerprint &&
                !progressSingleEnhanceActionMatches(
                    action,
                    fingerprint
                )
            ) {
                failRunQueueIntegrity(
                    run,
                    `本批动作 ${actionId} 在权威队列中被替换或内容发生变化`
                );
                return;
            }
            recordOwnedActionProgress(run, actionId, action);
            return;
        }

        if (run.completedOwnedActionIds.has(actionId)) {
            finishOwnedActionMonitoring(run, actionId);
            return;
        }
        if (run.ownedRemovalPending.has(actionId)) return;

        const compatibleCompletion =
            run.ownedCompatibleCompletions?.get(actionId);
        const fingerprint =
            run.ownedActionFingerprints?.get(actionId);
        if (
            compatibleCompletion &&
            compatibleCompletionCanPairWithRemoval(
                compatibleCompletion,
                fingerprint
            )
        ) {
            // Record the authoritative removal first so the compatible
            // completion can be promoted to terminal without inventing an
            // isDone field. noteOwnedActionCompleted will immediately clear
            // this marker after the two halves are paired.
            run.ownedRemovalPending.set(actionId, {
                since: Date.now(),
                timer: null,
            });
            noteOwnedActionCompleted(compatibleCompletion);
            return;
        }

        const timer = window.setTimeout(() => {
            if (
                run.ownedActionIds.has(actionId) &&
                run.ownedRemovalPending.has(actionId) &&
                !run.completedOwnedActionIds.has(actionId)
            ) {
                failRunQueueIntegrity(
                    run,
                    `本批动作 ${actionId} 从队列移除，但未收到对应完成回执`
                );
            }
        }, CONFIG.OWNED_REMOVAL_GRACE_MS);
        run.ownedRemovalPending.set(actionId, {
            since: Date.now(),
            timer,
        });
    }

    function validateOwnedActionOrder(run = State.run) {
        if (!run || run.integrityFailure) return;
        const activeOwnedIds = run.ownedActionOrder.filter(
            (actionId) => (
                run.ownedActionIds.has(actionId) &&
                State.actions.has(actionId)
            )
        );
        const ordinals = activeOwnedIds.map((actionId) => {
            const ordinal = Number(State.actions.get(actionId)?.ordinal);
            return Number.isFinite(ordinal) ? ordinal : null;
        });
        if (
            ordinals.length >= 2 &&
            ordinals.every((ordinal) => ordinal != null)
        ) {
            for (let index = 1; index < ordinals.length; index++) {
                if (ordinals[index] <= ordinals[index - 1]) {
                    failRunQueueIntegrity(
                        run,
                        '本批强化动作在权威队列中的相对顺序发生变化'
                    );
                    return;
                }
            }
        }
    }

    function scheduleOwnedActionOrderValidation(run = State.run) {
        if (!run?.ownedActionOrder || run.integrityFailure ||
            run.monitoringReleased || State.run !== run) return;
        const activeIds = run.ownedActionOrder.filter(id =>
            run.ownedActionIds.has(id) && State.actions.has(id));
        const ordinals = activeIds.map(id => {
            const ordinal = Number(State.actions.get(id)?.ordinal);
            return Number.isFinite(ordinal) ? ordinal : null;
        });
        // Uniform ordinal shifts from other tasks do not change owned order.
        const signature = JSON.stringify([
            activeIds, ordinals.map(value => value != null),
            ordinals.slice(1).map((value, index) =>
                value == null || ordinals[index] == null
                    ? null : Math.sign(value - ordinals[index])),
        ]);
        if (activeIds.length < 2) {
            // There is no relative order to validate. In particular, an
            // unrelated task freeing a queue slot must not start a new wait.
            const wasPending = run.ownedOrderValidationPending;
            if (run.ownedOrderValidationTimer) {
                window.clearTimeout(run.ownedOrderValidationTimer);
            }
            run.ownedOrderValidationTimer = null;
            run.ownedOrderValidationPending = false;
            run.ownedOrderValidationDueAt = null;
            run.ownedOrderValidationSignature = signature;
            if (wasPending) WorkSignals.notify();
            return;
        }
        if (run.ownedOrderValidationSignature === signature) return;
        run.ownedOrderValidationSignature = signature;
        if (run.ownedOrderValidationTimer) {
            window.clearTimeout(run.ownedOrderValidationTimer);
        }
        run.ownedOrderValidationPending = true;
        run.ownedOrderValidationDueAt = Date.now() + CONFIG.OWNED_ORDER_SETTLE_MS;
        run.ownedOrderValidationTimer = window.setTimeout(() => {
            checkOwnedActionOrderDue(run);
            WorkSignals.notify();
        }, CONFIG.OWNED_ORDER_SETTLE_MS);
    }

    function checkOwnedActionOrderDue(run) {
        if (!run || State.run !== run || !run.ownedOrderValidationPending ||
            run.monitoringReleased || run.integrityFailure ||
            !(Date.now() >= run.ownedOrderValidationDueAt)) return;
        if (run.ownedOrderValidationTimer) {
            window.clearTimeout(run.ownedOrderValidationTimer);
        }
        run.ownedOrderValidationTimer = null;
        run.ownedOrderValidationPending = false;
        run.ownedOrderValidationDueAt = null;
        validateOwnedActionOrder(run);
    }

    function registerOwnedAction(
        run,
        actionIdValue,
        fingerprint,
        allowProgress = false
    ) {
        const actionId = normalizeActionId(actionIdValue);
        if (!actionId || !fingerprint) {
            throw new BatchError(
                '强化动作缺少可冻结的 action.id 或指纹',
                'UNKNOWN'
            );
        }
        const action = State.actions.get(actionId);
        const matches = progressSingleEnhanceActionMatches(
            action,
            fingerprint
        );
        if (!action || !matches) {
            throw new BatchError(
                `动作 ${actionId} 的权威队列记录与入队回执不一致`,
                'UNKNOWN'
            );
        }
        if (!run.ownedActionIds.has(actionId)) {
            run.ownedActionIds.add(actionId);
            run.ownedActionOrder.push(actionId);
        }
        run.ownedActionFingerprints.set(actionId, fingerprint);
        recordOwnedActionProgress(run, actionId, action);
        scheduleOwnedActionOrderValidation(run);
        if (
            allowProgress &&
            completionHasTerminalEvidence(
                action,
                fingerprint
            )
        ) {
            // A refresh can occur after the final cycle but before the
            // authoritative isDone removal. The persisted exact action.id
            // plus a live primary level at the frozen target is enough to
            // restore the already-seen terminal state without resending.
            noteOwnedActionCompleted(action);
        }
        return actionId;
    }

    async function waitForOwnedQueueIntegrity(run) {
        while (
            run.ownedRemovalPending?.size > 0 ||
            run.ownedOrderValidationPending
        ) {
            if (run.integrityFailure || run.stopRequested) break;
            await WorkSignals.wait(1000, run);
        }
        if (run.integrityFailure) {
            throw new BatchError(run.integrityFailure, 'UNKNOWN');
        }
    }

    const Network = {
        nativeWebSocket: null,
        patchedWebSocket: null,
        originalSend: null,
        patchedSend: null,
        hookMarker: Symbol.for('MWI_SAFE_ENHANCER_SEND_HOOK_V1'),

        isGameSocket(socket) {
            const nativeWebSocket =
                Network.nativeWebSocket || window.WebSocket;
            if (
                typeof nativeWebSocket !== 'function' ||
                !(socket instanceof nativeWebSocket) ||
                typeof socket.url !== 'string'
            ) {
                return false;
            }
            try {
                const url = new URL(socket.url);
                const expectedHostname =
                    window.location.hostname.endsWith(
                        'milkywayidlecn.com'
                    )
                        ? 'api-test.milkywayidlecn.com'
                        : 'api-test.milkywayidle.com';
                const currentCharacterId = getCharacterId();
                const socketCharacterId = normalizeCharacterId(
                    url.searchParams.get('characterId')
                );
                return (
                    url.protocol === 'wss:' &&
                    url.hostname === expectedHostname &&
                    url.port === '' &&
                    url.pathname === '/ws' &&
                    currentCharacterId !== '' &&
                    socketCharacterId === currentCharacterId
                );
            } catch {
                return false;
            }
        },

        install() {
            const nativeWebSocket = window.WebSocket;
            if (
                typeof nativeWebSocket !== 'function' ||
                !nativeWebSocket.prototype
            ) {
                throw new Error('页面没有可用的原生 WebSocket 构造器');
            }
            const prototype = nativeWebSocket.prototype;
            if (prototype[Network.hookMarker]) {
                throw new Error(
                    '检测到另一份安全强化助手网络钩子，请刷新页面并只保留一份'
                );
            }

            Network.nativeWebSocket = nativeWebSocket;
            const previousSend = prototype.send;
            Network.originalSend = previousSend;
            Network.patchedWebSocket = new Proxy(nativeWebSocket, {
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
                    try {
                        if (Network.isGameSocket(socket)) {
                            Network.attach(socket);
                        }
                    } catch (error) {
                        console.warn(
                            '[安全强化助手] WebSocket 创建时挂接失败:',
                            error
                        );
                    }
                    return socket;
                },
            });

            Network.patchedSend = function patchedSafeEnhancerSend(data) {
                try {
                    if (Network.isGameSocket(this)) {
                        Network.attach(this);
                        Network.observeOutgoing(
                            data,
                            State.ownedSendDepth > 0
                        );
                    }
                } catch (error) {
                    console.warn('[安全强化助手] 观察发送消息失败:', error);
                    if (
                        State.ownedSendDepth === 0 &&
                        (
                            State.starting ||
                            isProtectedRunLifecycle(State.run) ||
                            State.marketBusy ||
                            State.marketOp
                        )
                    ) {
                        Network.failClosedForOutgoingObservation(
                            '运行中无法可靠检查一条外部请求'
                        );
                    }
                }
                return previousSend.apply(this, arguments);
            };

            try {
                Object.defineProperty(prototype, Network.hookMarker, {
                    value: true,
                    configurable: true,
                });
                prototype.send = Network.patchedSend;
                window.WebSocket = Network.patchedWebSocket;
                if (window.WebSocket !== Network.patchedWebSocket) {
                    throw new Error('无法替换页面 WebSocket 构造器');
                }
            } catch (error) {
                try {
                    prototype.send = previousSend;
                    delete prototype[Network.hookMarker];
                    window.WebSocket = nativeWebSocket;
                } catch {
                    // Preserve the original installation error below.
                }
                Network.nativeWebSocket = null;
                Network.patchedWebSocket = null;
                Network.originalSend = null;
                Network.patchedSend = null;
                throw error;
            }
        },

        assertHookIntegrity() {
            if (
                !Network.nativeWebSocket ||
                !Network.patchedWebSocket ||
                !Network.patchedSend ||
                Network.nativeWebSocket.prototype.send !==
                    Network.patchedSend ||
                (
                    State.socket &&
                    Object.prototype.hasOwnProperty.call(
                        State.socket,
                        'send'
                    )
                )
            ) {
                throw new BatchError(
                    'WebSocket send 观察器已被不兼容脚本覆盖。'
                    + '请停用其他强化脚本并刷新页面；独立市场守价脚本可以共存',
                    'HOOK_REPLACED'
                );
            }
        },

        attach(socket) {
            const alreadyAttached = State.attachedSockets.has(socket);

            if (
                State.socket !== socket &&
                socket.readyState === WebSocket.OPEN
            ) {
                const replacingLiveSocket = State.socket !== null;
                if (State.pendingOp) {
                    Transactions.abortAsUnknown(
                        '游戏 WebSocket 在等待回执时被新连接替换；'
                        + '最后一条请求可能已生效'
                    );
                }
                clearMarketConnectionSnapshot(
                    '游戏 WebSocket 在等待市场回执时被新连接替换；'
                    + '最后一条市场请求可能已生效'
                );
                clearClientMarketData();
                clearCharacterMarketAccess();
                if (isProtectedRunLifecycle(State.run)) {
                    State.run.stopRequested = true;
                    MarketMaintenance.abortFinalSweep(
                        State.run,
                        'WebSocket 已切换，市场最终扫尾停止'
                    );
                    log(
                        '运行中检测到游戏 WebSocket 切换，已停止继续发送',
                        'error'
                    );
                }

                State.socket = socket;
                SharedAutomation.publishSocket(socket);
                State.connectionEpoch++;
                restoreClientMarketDataFromCache(socket);
                State.inventoryReady = false;
                State.queueReady = false;
                State.loadoutsReady = false;
                clearCharacterItemSnapshot();
                State.inventory.clear();
                State.actions.clear();
                State.loadouts.clear();
                State.pendingExternalQueueAdds = [];
                State.recentAllowedExternalRequest = null;
                State.externalErrorFenceUntil = 0;
                State.actionQueueCap = null;
                State.inventoryRevision++;
                State.equipmentInventoryRevision++;
                State.queueRevision++;
                State.loadoutRevision++;
                log(
                    replacingLiveSocket
                        ? '已切换到新的游戏 WebSocket，等待角色数据同步'
                        : '已捕获游戏 WebSocket，等待角色数据同步'
                );
                WorkSignals.notify();
            }

            if (alreadyAttached) {
                scheduleUiRefresh();
                return;
            }
            State.attachedSockets.add(socket);

            socket.addEventListener('open', () => {
                if (!Network.isGameSocket(socket)) return;
                Network.attach(socket);
            });

            socket.addEventListener('message', (event) => {
                if (State.socket !== socket) return;
                const message = safeJsonParse(event.data);
                if (
                    !message ||
                    typeof message !== 'object' ||
                    Array.isArray(message) ||
                    typeof message.type !== 'string'
                ) {
                    if (
                        State.starting ||
                        isProtectedRunLifecycle(State.run) ||
                        State.marketBusy ||
                        State.marketOp
                    ) {
                        Network.failClosedForIncomingObservation(
                            '监控期间收到无法解析或缺少 type 的服务器消息'
                        );
                    }
                    return;
                }
                Network.handleIncoming(message);
            });

            socket.addEventListener('close', () => {
                if (State.socket !== socket) return;
                const reason =
                    'WebSocket 在等待回执时断开；最后一条请求可能已生效';
                clearMarketConnectionSnapshot(reason);
                clearClientMarketData();
                clearCharacterMarketAccess();
                State.socket = null;
                if (SharedAutomation.socket === socket) {
                    SharedAutomation.publishSocket(null);
                }
                State.connectionEpoch++;
                State.inventoryReady = false;
                State.queueReady = false;
                State.loadoutsReady = false;
                clearCharacterItemSnapshot();
                State.inventory.clear();
                State.actions.clear();
                State.loadouts.clear();
                State.pendingExternalQueueAdds = [];
                State.recentAllowedExternalRequest = null;
                State.externalErrorFenceUntil = 0;
                State.actionQueueCap = null;
                State.inventoryRevision++;
                State.equipmentInventoryRevision++;
                State.queueRevision++;
                State.loadoutRevision++;
                Transactions.abortAsUnknown(reason);
                if (isProtectedRunLifecycle(State.run)) {
                    State.run.stopRequested = true;
                    MarketMaintenance.abortFinalSweep(
                        State.run,
                        'WebSocket 已断开，市场最终扫尾停止'
                    );
                }
                log('游戏 WebSocket 已断开', 'error');
                WorkSignals.notify();
                scheduleUiRefresh();
            });

            socket.addEventListener('error', () => {
                if (State.socket !== socket) return;
                const reason =
                    '游戏 WebSocket 报告连接错误；最后状态可能不完整，请刷新页面';
                clearMarketConnectionSnapshot(reason);
                clearClientMarketData();
                clearCharacterMarketAccess();
                State.inventoryReady = false;
                State.queueReady = false;
                State.loadoutsReady = false;
                clearCharacterItemSnapshot();
                State.inventory.clear();
                State.actions.clear();
                State.loadouts.clear();
                State.pendingExternalQueueAdds = [];
                State.recentAllowedExternalRequest = null;
                State.externalErrorFenceUntil = 0;
                State.actionQueueCap = null;
                State.inventoryRevision++;
                State.equipmentInventoryRevision++;
                State.queueRevision++;
                State.loadoutRevision++;
                State.blockedReason = reason;
                Transactions.abortAsUnknown(reason);
                if (isProtectedRunLifecycle(State.run)) {
                    State.run.stopRequested = true;
                    State.run.currentStage = 'WebSocket 连接错误';
                    MarketMaintenance.abortFinalSweep(
                        State.run,
                        'WebSocket 连接错误，市场最终扫尾停止'
                    );
                }
                log(reason, 'error');
                WorkSignals.notify();
                scheduleUiRefresh();
            });
            scheduleUiRefresh();
        },

        failClosedForOutgoingObservation(reason) {
            if (isProtectedRunLifecycle(State.run)) {
                failRunQueueIntegrity(State.run, reason);
                return;
            }
            State.blockedReason = State.blockedReason ||
                `${reason}；请刷新页面获得可信的全量状态`;
            Transactions.abortAsUnknown(reason);
            MarketTransactions.abortAsUnknown(reason);
            MarketMaintenance.stopScheduling();
            log(reason, 'error');
            scheduleUiRefresh();
        },

        failClosedForIncomingObservation(reason) {
            if (State.run) {
                failRunQueueIntegrity(State.run, reason);
                return;
            }
            State.blockedReason = State.blockedReason ||
                `${reason}；请刷新页面获得可信的全量状态`;
            Transactions.abortAsUnknown(reason);
            MarketTransactions.abortAsUnknown(reason);
            MarketMaintenance.stopScheduling();
            log(reason, 'error');
            scheduleUiRefresh();
        },

        observeOutgoing(raw, isOwned) {
            if (isOwned) return;
            WorkSignals.notify();
            const outgoing = classifyExternalOutgoing(raw);
            let externalOrderBookItemId = '';
            if (
                outgoing.type ===
                    'get_market_item_order_books'
            ) {
                externalOrderBookItemId = normalizeShortItemId(
                    outgoing.message
                        ?.getMarketItemOrderBooksData?.itemHrid
                );
                if (externalOrderBookItemId) {
                    MarketMaintenance.recordOrderBookRequest(
                        externalOrderBookItemId,
                        true
                    );
                    rememberAllowedExternalRequest(outgoing, {
                        itemId: externalOrderBookItemId,
                        orderBookOutstandingCleared: false,
                    });
                }
            }
            if (LOADOUT_SAVE_OUTGOING_TYPES.has(outgoing.type)) {
                const savedId = getSavedLoadoutId(outgoing);
                const namedLoadouts = [...State.loadouts.values()].filter(
                    row => row?.name === ENHANCING_LOADOUT_NAME
                );
                const protectedId = getProtectedEnhancingLoadoutId() ?? (
                    namedLoadouts.length === 1
                        ? normalizeLoadoutId(namedLoadouts[0].id) : null
                );
                if (protectedId != null && savedId === protectedId) {
                    State.pendingEnhancingLoadoutSaveChecks.push(outgoing);
                    State.pendingEnhancingLoadoutSaves =
                        State.pendingEnhancingLoadoutSaveChecks.length;
                    State.loadoutRevision++;
                    rememberAllowedExternalRequest(outgoing);
                    log(outgoing.type === 'copy_setup_to_loadout'
                        ? '正在覆盖保存 Enhancing 配装；请完整刷新后按保存的套装续排'
                        : '正在保存 Enhancing 配装；后续采购和入队等待游戏确认');
                    scheduleUiRefresh();
                    return;
                }
            }

            if (
                !State.starting &&
                !isProtectedRunLifecycle(State.run) &&
                !State.marketBusy &&
                !State.marketOp
            ) {
                return;
            }

            if (outgoing.kind === 'heartbeat') return;

            if (outgoing.kind === 'read_only') {
                rememberAllowedExternalRequest(outgoing, {
                    itemId: externalOrderBookItemId,
                    orderBookOutstandingCleared: false,
                });
                if (isProtectedRunLifecycle(State.run)) {
                    State.run.allowedExternalTypes ||= new Set();
                    if (!State.run.allowedExternalTypes.has(outgoing.type)) {
                        State.run.allowedExternalTypes.add(outgoing.type);
                        log(`运行中放行只读请求 ${outgoing.type}`);
                    }
                }
                return;
            }

            if (isExternalQueueLike(outgoing)) {
                State.outgoingQueueMutationRevision++;
                if (outgoing.kind === 'queue_mutation') {
                    reserveExternalQueueAdd(outgoing.message);
                }
                rememberAllowedExternalRequest(outgoing);
                if (isProtectedRunLifecycle(State.run)) {
                    State.run.allowedExternalTypes ||= new Set();
                    if (!State.run.allowedExternalTypes.has(outgoing.type)) {
                        State.run.allowedExternalTypes.add(outgoing.type);
                        log(
                            `运行中放行外部队列请求 ${outgoing.type}；`
                            + '助手将按服务器最新队列容量继续滚动补队'
                        );
                    }
                }
                scheduleUiRefresh();
                return;
            }

            if (MARKET_WRITE_OUTGOING_TYPES.has(outgoing.type)) {
                // Marketplace ownership belongs to the independent keeper.
                // Its request is serialized through SharedAutomation and can
                // never invalidate a frozen enhancement command plan.
                rememberAllowedExternalRequest(outgoing);
                if (isProtectedRunLifecycle(State.run)) {
                    State.run.allowedExternalTypes ||= new Set();
                    if (!State.run.allowedExternalTypes.has(outgoing.type)) {
                        State.run.allowedExternalTypes.add(outgoing.type);
                        log(
                            `运行中放行独立市场请求 ${outgoing.type}；`
                            + '不会用 +20 库存或卖单反推强化结果'
                        );
                    }
                }
                return;
            }

            if (
                outgoing.kind !== 'malformed' &&
                !externalRequestTouchesProtectedState(outgoing)
            ) {
                rememberAllowedExternalRequest(outgoing);
                if (isProtectedRunLifecycle(State.run)) {
                    State.run.allowedExternalTypes ||= new Set();
                    if (!State.run.allowedExternalTypes.has(outgoing.type)) {
                        State.run.allowedExternalTypes.add(outgoing.type);
                        log(
                            `运行中放行与本批资源无关的外部请求 `
                            + outgoing.type
                        );
                    }
                }
                return;
            }

            let reason;
            if (outgoing.kind === 'malformed') {
                reason =
                    '运行中检测到非 JSON、缺少 type 或格式异常的外部请求，'
                    + '无法确认它是否只读，已停止强化助手继续发送';
            } else {
                reason =
                    `运行中检测到确实触碰本批装备、Enhancing 配装`
                    + `或市场事务的外部请求 `
                    + `${outgoing.type || '未知请求'}，游戏请求仍会照常`
                    + '发送，强化助手已停止';
            }
            Network.failClosedForOutgoingObservation(reason);
        },

        updateInventoryItem(item) {
            if (
                !item ||
                item.itemLocationHrid !== INVENTORY_LOCATION_HRID
            ) {
                return;
            }
            const itemId = normalizeShortItemId(item.itemHrid);
            if (!itemId) return;
            const level = Number(item.enhancementLevel || 0);
            if (!Number.isInteger(level) || level < 0) return;
            const count = Math.max(0, Number(item.count || 0));
            const normalizedCount = Number.isFinite(count) ? count : 0;
            const hadItem = State.inventory.has(itemId);
            const existing = State.inventory.get(itemId)
                || new Array(Math.max(CONFIG.TARGET_LEVEL + 1, level + 1)).fill(0);
            while (existing.length <= level) existing.push(0);
            if (!hadItem || existing[level] !== normalizedCount) {
                existing[level] = normalizedCount;
                State.inventory.set(itemId, existing);
                State.inventoryRevision++;
                if (EQUIPMENT_ID_SET.has(itemId)) {
                    State.equipmentInventoryRevision++;
                }
            }
            MarketMaintenance.observeInventoryUpdate(itemId, level);
            if (
                Number(level) === CONFIG.TARGET_LEVEL &&
                State.run?.marketFinalSweepPhase ===
                    'waiting_inventory'
            ) {
                tryBeginFinalSweep(State.run);
            }
        },

        applyActionDelta(actions) {
            if (!Array.isArray(actions)) return;
            reconcileExternalQueueReservations(actions);
            for (const action of actions) {
                const actionId = normalizeActionId(action?.id);
                if (!actionId) continue;
                noteOwnedActionDelta(action);
                if (action.isDone) State.actions.delete(actionId);
                else State.actions.set(actionId, action);
                State.queueRevision++;
            }
            scheduleOwnedActionOrderValidation();
        },

        replaceLoadouts(loadoutMap) {
            State.loadouts.clear();
            State.loadoutRevision++;
            State.loadoutsReady = Boolean(
                loadoutMap &&
                typeof loadoutMap === 'object' &&
                !Array.isArray(loadoutMap)
            );
            if (!State.loadoutsReady) return;

            for (const [key, value] of Object.entries(loadoutMap)) {
                if (
                    !value ||
                    typeof value !== 'object' ||
                    Array.isArray(value)
                ) {
                    continue;
                }
                State.loadouts.set(String(key), {
                    ...value,
                    id: value.id ?? key,
                });
            }
        },

        verifyMonitoredLoadoutBinding() {
            const run = State.run;
            if (
                !run ||
                (
                    !run.active &&
                    !(run.ownedActionIds?.size > 0)
                )
            ) {
                return;
            }

            // A save may overlap an already-sent request. Preserve that
            // request's ACK; the send lane waits for the saved definition.
            if (State.pendingEnhancingLoadoutSaves > 0) return;

            let bindingIssue = '';
            try {
                refreshRunEnhancingLoadout(run);
                return;
            } catch (error) {
                bindingIssue = error?.message || '';
            }

            failRunQueueIntegrity(
                run,
                run.active
                    ? (
                        bindingIssue ||
                        'Enhancing 配装被删除、改名、改动或所需物品已不可用，'
                            + '已停止继续发送'
                    )
                    : 'Enhancing 配装在本批已入队动作全部完成前发生变化，'
                        + '队列中的动作可能不再使用预检时的护符内容'
            );
        },

        handleIncoming(message) {
            try {
            State.incomingSequence++;
            if (message.type === 'error') {
                const recentExternal =
                    State.recentAllowedExternalRequest;
                if (
                    recentExternal?.type ===
                        'get_market_item_order_books' &&
                    recentExternal.itemId &&
                    recentExternal.epoch ===
                        State.connectionEpoch &&
                    Date.now() - recentExternal.at <=
                        CONFIG.ALLOWED_EXTERNAL_ERROR_GRACE_MS &&
                    !recentExternal.orderBookOutstandingCleared
                ) {
                    MarketMaintenance.discardOrderBookRequest(
                        recentExternal.itemId
                    );
                    recentExternal.orderBookOutstandingCleared = true;
                }
            }
            if (message.type === 'close_session') {
                const reason =
                    '服务器已关闭当前游戏会话；最后状态可能不完整，请刷新页面';
                clearMarketConnectionSnapshot(reason);
                clearClientMarketData();
                clearCharacterMarketAccess();
                State.inventoryReady = false;
                State.queueReady = false;
                State.loadoutsReady = false;
                clearCharacterItemSnapshot();
                State.inventory.clear();
                State.actions.clear();
                State.loadouts.clear();
                State.pendingExternalQueueAdds = [];
                State.recentAllowedExternalRequest = null;
                State.externalErrorFenceUntil = 0;
                State.actionQueueCap = null;
                State.inventoryRevision++;
                State.equipmentInventoryRevision++;
                State.queueRevision++;
                State.loadoutRevision++;
                State.blockedReason = reason;
                Transactions.abortAsUnknown(reason);
                if (isProtectedRunLifecycle(State.run)) {
                    State.run.stopRequested = true;
                    State.run.currentStage = '游戏会话已关闭';
                    MarketMaintenance.abortFinalSweep(
                        State.run,
                        '游戏会话已关闭，市场最终扫尾停止'
                    );
                }
                log(reason, 'error');
                scheduleUiRefresh();
                return;
            }

            if (message.type === 'init_client_data') {
                replaceClientMarketData(message, 'network');
                State.clientMarketDataCacheStatus =
                    State.clientMarketDataReady
                        ? 'network_received'
                        : 'network_invalid';
                State.clientMarketDataCacheDetail =
                    State.clientMarketDataReady
                        ? '服务器已下发完整 init_client_data'
                        : '服务器 init_client_data 缺少完整市场规则';
            }

            if (message.type === 'init_character_data') {
                clearMarketConnectionSnapshot(
                    '收到角色全量重同步，旧市场事务已失效',
                    false
                );
                clearCharacterMarketAccess();
                if (isProtectedRunLifecycle(State.run)) {
                    const reason = State.pendingOp
                        ? '运行中收到角色全量重同步；最后一条请求的结果可能已变化'
                        : '监控期间收到角色全量重同步，旧计划已失效';
                    if (State.pendingOp) {
                        Transactions.abortAsUnknown(reason);
                    }
                    failRunQueueIntegrity(State.run, reason);
                }

                State.syncEpoch++;
                State.pendingEnhancingLoadoutSaves = 0;
                State.pendingEnhancingLoadoutSaveChecks = [];
                State.inventory.clear();
                State.actions.clear();
                State.pendingExternalQueueAdds = [];
                State.recentAllowedExternalRequest = null;
                State.externalErrorFenceUntil = 0;
                State.inventoryRevision++;
                State.equipmentInventoryRevision++;
                State.queueRevision++;
                State.inventoryReady = Array.isArray(
                    message.characterItems
                );
                replaceCharacterItemSnapshot(message.characterItems);
                State.queueReady = Array.isArray(
                    message.characterActions
                );
                Network.replaceLoadouts(message.characterLoadoutMap);
                MarketMaintenance.replaceMyListings(
                    message.myMarketListings
                );
                replaceCharacterMarketAccess(message);
                State.actionQueueCap = null;

                const urlCharacterId = getCharacterId();
                const messageCharacterId = normalizeCharacterId(
                    message.character?.id
                );
                State.characterId =
                    messageCharacterId ||
                    urlCharacterId ||
                    State.characterId;

                if (Array.isArray(message.characterActions)) {
                    for (const action of message.characterActions) {
                        const actionId = normalizeActionId(action?.id);
                        if (actionId && !action.isDone) {
                            State.actions.set(actionId, action);
                        }
                    }
                }
                if (message.characterInfo?.actionQueueCap != null) {
                    State.actionQueueCap = Number(
                        message.characterInfo.actionQueueCap
                    );
                }
                State.lastInitAt = Date.now();

                if (
                    urlCharacterId &&
                    messageCharacterId &&
                    urlCharacterId !== messageCharacterId
                ) {
                    State.inventoryReady = false;
                    State.queueReady = false;
                    State.loadoutsReady = false;
                    State.characterItemsReady = false;
                    log(
                        `URL 角色 ${urlCharacterId} 与服务器角色 `
                        + `${messageCharacterId} 不一致，已拒绝启用`,
                        'error'
                    );
                } else if (!messageCharacterId) {
                    State.inventoryReady = false;
                    State.queueReady = false;
                    State.loadoutsReady = false;
                    State.characterItemsReady = false;
                    log(
                        '角色初始化数据缺少可验证的服务器角色 ID，已保持禁用',
                        'error'
                    );
                } else if (
                    !State.inventoryReady ||
                    !State.queueReady ||
                    !State.loadoutsReady ||
                    !State.characterItemsReady
                ) {
                    log(
                        '角色初始化数据缺少完整库存、动作队列或配装，已保持禁用',
                        'error'
                    );
                }
            }

            if (
                message.type === 'character_info_updated' &&
                message.characterInfo
            ) {
                const rawListingCap =
                    message.characterInfo.marketListingCap;
                const listingCap = Number(rawListingCap);
                State.marketListingCap = (
                    rawListingCap != null &&
                    Number.isSafeInteger(listingCap) &&
                    listingCap >= 0
                ) ? listingCap : null;
                refreshCharacterMarketAccessReady();
                State.marketRevision++;
            }
            if (
                message.type === 'setting_updated' &&
                message.characterSetting
            ) {
                State.hasAcceptedTradingRules =
                    message.characterSetting
                        .hasAcceptedTradingRules === true;
                State.tradingRulesKnown =
                    typeof message.characterSetting
                        .hasAcceptedTradingRules === 'boolean';
                refreshCharacterMarketAccessReady();
                State.marketRevision++;
            }
            if (
                message.type === 'character_updated' &&
                message.character
            ) {
                State.characterGameMode = String(
                    message.character.gameMode || ''
                );
                refreshCharacterMarketAccessReady();
                State.marketRevision++;
            }

            if (message.type === 'loadouts_updated') {
                Network.replaceLoadouts(message.characterLoadoutMap);
                if (State.loadoutsReady &&
                    State.pendingEnhancingLoadoutSaveChecks.length > 0 &&
                    savedLoadoutPatchIsVisible(State.pendingEnhancingLoadoutSaveChecks[0])) {
                    State.pendingEnhancingLoadoutSaveChecks.shift();
                    State.pendingEnhancingLoadoutSaves =
                        State.pendingEnhancingLoadoutSaveChecks.length;
                }
            }

            for (const field of [
                'characterItems',
                'endCharacterItems',
                'updatedCharacterItems',
            ]) {
                if (!Array.isArray(message[field])) continue;
                for (const item of message[field]) {
                    if (field !== 'characterItems') {
                        updateCharacterItemSnapshot(item);
                    }
                    Network.updateInventoryItem(item);
                }
            }

            if (
                message.type === 'market_listings_updated' &&
                Array.isArray(message.endMarketListings)
            ) {
                MarketMaintenance.applyMyListingDeltas(
                    message.endMarketListings
                );
            }
            if (
                message.type === 'market_item_order_books_updated'
            ) {
                MarketMaintenance.applyOrderBook(
                    message.marketItemOrderBooks
                );
            }

            if (
                message.type === 'actions_updated' &&
                Array.isArray(message.endCharacterActions)
            ) {
                Network.applyActionDelta(message.endCharacterActions);
            }

            if (
                message.type === 'action_completed' &&
                message.endCharacterAction?.id != null
            ) {
                const completed = message.endCharacterAction;
                const completedId = normalizeActionId(completed.id);
                noteOwnedActionCompleted(completed);
                // action_completed updates the object but does not authoritatively
                // remove it. Only actions_updated(isDone) frees a queue slot.
                // If the removal delta arrived first, do not resurrect it.
                if (completedId && State.actions.has(completedId)) {
                    State.actions.set(completedId, {
                        ...State.actions.get(completedId),
                        ...completed,
                    });
                    State.queueRevision++;
                }
            }

            if (
                message.type === 'loadouts_updated' ||
                Array.isArray(message.characterItems) ||
                Array.isArray(message.endCharacterItems) ||
                Array.isArray(message.updatedCharacterItems)
            ) {
                Network.verifyMonitoredLoadoutBinding();
            }

            MarketTransactions.handleIncoming(message);
            Transactions.handleIncoming(message);
            scheduleUiRefresh();
            } finally {
                WorkSignals.notify();
            }
        },

        sendOwned(payload, capability = 'enhancer') {
            const payloadType = String(payload?.type || '');
            const legacyMarketRuntimeTest = Boolean(
                runtimeTestMode &&
                capability === 'legacy_market_runtime_test'
            );
            if (
                !ENHANCER_OWNED_OUTGOING_TYPES.has(payloadType) &&
                !legacyMarketRuntimeTest
            ) {
                throw new BatchError(
                    `独立队列强化脚本拒绝发送非采购/强化请求：`
                    + `${payloadType || '未知类型'}`,
                    'OUTBOUND_NOT_ALLOWED'
                );
            }
            Network.assertHookIntegrity();
            if (!State.socket || State.socket.readyState !== WebSocket.OPEN) {
                throw new Error('WebSocket 未连接');
            }
            const message = {
                ...payload,
                ts: Date.now(),
            };
            State.ownedSendDepth++;
            try {
                State.socket.send(JSON.stringify(message));
            } finally {
                State.ownedSendDepth--;
            }
        },
    };

    async function waitForEnhancingLoadoutSave(run) {
        const startedAt = Date.now();
        while (State.pendingEnhancingLoadoutSaves > 0) {
            if (run.stopRequested) {
                throw new BatchError('用户要求停止继续发送', 'STOPPED');
            }
            if (State.socket?.readyState !== WebSocket.OPEN ||
                run.syncEpoch !== State.syncEpoch) {
                throw new BatchError('等待保存配装时连接或角色同步已变化', 'STATE_CHANGED');
            }
            if (Date.now() - startedAt >= CONFIG.QUEUE_ACK_TIMEOUT_MS) {
                throw new BatchError(
                    '尚未收到保存 Enhancing 配装的完整回执；'
                    + '旧批次保留，请完整刷新后再核对续排',
                    'LOADOUT_SAVE_PENDING'
                );
            }
            await WorkSignals.wait(
                Math.max(1, CONFIG.QUEUE_ACK_TIMEOUT_MS - (Date.now() - startedAt)),
                run
            );
        }
    }

    async function runOperationSafely(run, createOperation) {
        if (run.stopRequested) {
            throw new BatchError('用户要求停止继续发送', 'STOPPED');
        }
        let releaseSharedLane;
        do {
            await waitForEnhancingLoadoutSave(run);
            releaseSharedLane = await SharedAutomation.acquire(
                `enhancer:${run.id}`
            );
            if (State.pendingEnhancingLoadoutSaves > 0) {
                releaseSharedLane();
                releaseSharedLane = null;
            }
        } while (!releaseSharedLane);
        if (run.stopRequested) {
            releaseSharedLane();
            throw new BatchError('用户要求停止继续发送', 'STOPPED');
        }

        let outcome;
        try {
            assertBeltEnhancementRules(run.itemIds || []);
            refreshRunEnhancingLoadout(run);
            outcome = await createOperation();
        } finally {
            releaseSharedLane();
        }
        if (
            outcome.status === 'confirmed' ||
            outcome.status === 'retry_authorized'
        ) {
            return outcome;
        }

        if (outcome.status === 'unknown') {
            State.blockedReason = State.blockedReason ||
                outcome.reason ||
                '最后一条请求结果未知';
            scheduleUiRefresh();
            throw new BatchError(
                outcome.reason || '请求结果未知，请刷新页面后再运行',
                'UNKNOWN'
            );
        }
        throw new BatchError(
            outcome.reason || '游戏服务器拒绝了请求',
            outcome.status === 'send_failed' ? 'SEND_FAILED' : 'REJECTED'
        );
    }

    async function waitForQuickQueueSlot(
        run,
        maximumWaitMs = CONFIG.QUEUE_SPACE_TIMEOUT_MS
    ) {
        if (!Number.isFinite(maximumWaitMs) || maximumWaitMs < 1) {
            throw new BatchError(
                '队列空位等待上限无效',
                'INVALID_STATE'
            );
        }
        const startedAt = Date.now();
        let waitLogged = false;

        while (true) {
            if (run.stopRequested) return false;
            await waitForOwnedQueueIntegrity(run);
            if (run.stopRequested) return false;
            Network.assertHookIntegrity();

            if (State.blockedReason) {
                throw new BatchError(
                    `当前状态被锁定：${State.blockedReason}`,
                    'UNKNOWN'
                );
            }
            if (!State.socket || State.socket.readyState !== WebSocket.OPEN) {
                throw new BatchError('WebSocket 已断开', 'DISCONNECTED');
            }
            if (!State.queueReady) {
                throw new BatchError(
                    '动作队列已失去完整同步',
                    'STATE_CHANGED'
                );
            }
            if (
                State.run?.id !== run.id ||
                run.characterId !== State.characterId ||
                run.characterId !== getCharacterId()
            ) {
                throw new BatchError(
                    '运行角色与当前页面角色不一致',
                    'CHARACTER_CHANGED'
                );
            }
            if (run.syncEpoch !== State.syncEpoch) {
                throw new BatchError(
                    '角色数据已重新同步，旧计划已失效',
                    'STATE_CHANGED'
                );
            }
            if (
                !Number.isFinite(State.actionQueueCap) ||
                State.actionQueueCap <= 0
            ) {
                throw new BatchError(
                    '动作队列容量已失去可信同步',
                    'STATE_CHANGED'
                );
            }

            const reservedExternalSlots =
                getReservedExternalQueueSlots();
            const effectiveQueueSize =
                State.actions.size + reservedExternalSlots;
            const freeSlots = Math.max(
                0,
                State.actionQueueCap - effectiveQueueSize
            );
            const requiredHeadroom = Math.min(
                CONFIG.QUEUE_HEADROOM,
                Math.max(0, State.actionQueueCap - 1)
            );
            if (freeSlots > requiredHeadroom) {
                if (waitLogged) {
                    log(
                        `动作队列已有空位（${freeSlots}/`
                        + `${State.actionQueueCap}，固定保留 `
                        + `${requiredHeadroom} 格），继续逐件发送`,
                        'success'
                    );
                }
                return true;
            }

            if (!waitLogged) {
                waitLogged = true;
                log(
                    `动作队列已达到安全水位或有待确认的外部队尾动作（`
                    + `${effectiveQueueSize}/`
                    + `${State.actionQueueCap}，固定保留 `
                    + `${requiredHeadroom} 格），暂停发包并等待服务器确认空位`,
                    'warn'
                );
            }
            run.currentStage =
                `有效队列占用 ${effectiveQueueSize}/`
                + `${State.actionQueueCap}，`
                + '等待空位';
            scheduleUiRefresh();

            const elapsed = Date.now() - startedAt;
            if (elapsed >= maximumWaitMs) {
                throw new BatchError(
                    `动作队列连续 ${formatDuration(elapsed)} 没有空位；`
                    + '已停止继续发送，现有队列不会被清除',
                    'QUEUE_WAIT_TIMEOUT'
                );
            }
            const nextReservationExpiry = Math.min(
                ...State.pendingExternalQueueAdds.map(entry => entry.expiresAt)
                    .filter(Number.isFinite)
            );
            const continued = await WorkSignals.wait(Math.max(1, Math.min(
                maximumWaitMs - elapsed,
                nextReservationExpiry - Date.now()
            )), run);
            if (!continued) return false;
        }
    }

    async function purchaseAndConfirm(run, itemId, level, count) {
        const purchaseKey = `${itemId}:${level}`;
        const journal = run?.recoveryJournal;
        const purchase = journal?.purchases?.[purchaseKey];
        const recheckStock = purchase?.recoveryStock === true;
        if (count <= 0 && !recheckStock) return null;
        if (!recheckStock && ['confirmed', 'satisfied'].includes(purchase?.status)) {
            return {
                status: 'confirmed',
                recovered: true,
                purchasedCount: 0,
            };
        }
        return runOperationSafely(run, async () => {
            if (run.syncEpoch !== State.syncEpoch) {
                throw new BatchError('角色数据已重新同步，请重新预检后继续', 'STATE_CHANGED');
            }
            // Another helper may have held the shared lane. Recompute after
            // acquiring it, immediately before persisting and sending intent.
            if (recheckStock) {
                count = getRecoveryPurchaseRequirements(journal, itemId)
                    .shortages[level];
                if (!count) {
                    const previousPurchase = journal.purchases[purchaseKey];
                    journal.purchases[purchaseKey] = {
                        ...purchase, status: 'satisfied', recoveryStock: true,
                    };
                    try { saveRecoveryJournalCritical(journal); }
                    catch (error) {
                        journal.purchases[purchaseKey] = previousPurchase;
                        throw error;
                    }
                    log(`${getItemName(itemId)}：当前 +${level} 库存已满足未入队计划，无需补购`);
                    return {status: 'confirmed', recovered: true, purchasedCount: 0};
                }
            }
            if (journal?.inFlight) {
                throw new BatchError(
                    '上一条采购或强化指令仍待核对，不能用新的补料覆盖其恢复记录；请刷新后继续',
                    'RECOVERY_PENDING'
                );
            }
            const shopItemHrid = getTesterPurchaseHrid(itemId);
            const baseline = getItemCount(itemId, level);
            const expected = baseline + count;
            const purchaseProjection = getPurchaseQueueProjection(itemId, level, count);
            if (journal) {
                journal.inFlight = {
                    type: 'purchase', purchaseKey, itemId, level, count,
                    baselineInventory: baseline,
                    expectedInventory: expected,
                    baselineProjectedInventory: purchaseProjection?.baselineProjectedInventory,
                    expectedProjectedInventory: purchaseProjection?.expectedProjectedInventory,
                    syncMarker: `${RECOVERY_SESSION_ID}:${State.syncEpoch}`,
                    recoveryStock: recheckStock,
                    sentAt: Date.now(), errorCode: '',
                };
                try { saveRecoveryJournalCritical(journal); }
                catch (error) {
                    journal.inFlight = null;
                    throw error;
                }
            }
            log(`${getItemName(itemId)}：${recheckStock ? '按当前缺口补购' : '采购'} +${level} ×${formatInt(count)}，等待库存确认`);
            const outcome = await Transactions.begin(run, {
                kind: 'purchase',
                itemId,
                level,
                count,
                baselineInventory: baseline,
                expectedInventory: expected,
                baselineProjectedInventory:
                    purchaseProjection?.baselineProjectedInventory,
                expectedProjectedInventory:
                    purchaseProjection?.expectedProjectedInventory,
                timeoutMs: CONFIG.PURCHASE_TIMEOUT_MS,
                timeoutMessage:
                    `采购 +${level} ×${count} 超时；不知道商店是否已扣款/发货`,
                payload: {
                    type: 'buy_from_shop',
                    buyFromShopData: {
                        shopItemHrid,
                        enhancementLevel: level,
                        count,
                    },
                },
            });
            if (journal && outcome.status === 'confirmed') {
                const previousPurchase = journal.purchases[purchaseKey];
                const confirmedIntent = journal.inFlight;
                journal.purchases[purchaseKey] = {
                    status: 'confirmed', count, recoveryStock: recheckStock,
                };
                journal.inFlight = null;
                try { saveRecoveryJournalCritical(journal); }
                catch (error) {
                    journal.purchases[purchaseKey] = previousPurchase;
                    journal.inFlight = confirmedIntent;
                    throw error;
                }
            }
            return {...outcome, purchasedCount: outcome.status === 'confirmed' ? count : 0};
        });
    }

    function cloneJsonValue(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function enumeratePlanCommands(itemPlans, mode = 'quick') {
        const commands = [];
        for (
            let itemIndex = 0;
            itemIndex < itemPlans.length;
            itemIndex++
        ) {
            const entry = itemPlans[itemIndex];
            const segments = mode === 'verified'
                ? entry.plan.rawOutputSegments
                : entry.plan.compressedOutputSegments;
            for (
                let outputIndex = 0;
                outputIndex < segments.length;
                outputIndex++
            ) {
                for (
                    let actionIndex = 0;
                    actionIndex < segments[outputIndex].length;
                    actionIndex++
                ) {
                    commands.push({
                        commandKey:
                            `${itemIndex}:${outputIndex}:${actionIndex}`,
                        commandIndex: commands.length,
                        itemIndex,
                        itemId: entry.itemId,
                        outputIndex,
                        actionIndex,
                        action: segments[outputIndex][actionIndex],
                    });
                }
            }
        }
        return commands;
    }

    function recoveryFingerprintForCommand(journal, command) {
        return createEnhancePayload(
            {
                characterId: journal.characterId,
                enhancingLoadoutId:
                    journal.enhancingLoadout.id,
            },
            command.itemId,
            command.action,
            'quick'
        ).fingerprint;
    }

    function saveRecoveryJournalCritical(journal) {
        if (!journal || journal.schema !== RECOVERY_SCHEMA) {
            throw new BatchError(
                '内部错误：任务账本格式无效',
                'RECOVERY_INVALID'
            );
        }
        let persisted = null;
        try {
            const raw = window.localStorage.getItem(
                STORAGE_KEYS.RECOVERY
            );
            persisted = raw ? JSON.parse(raw) : null;
        } catch (error) {
            throw new BatchError(
                `无法核对本地任务账本版本：`
                + `${error.message || String(error)}`,
                'RECOVERY_STORAGE_FAILED'
            );
        }
        if (
            persisted &&
            (
                persisted.jobId !== journal.jobId ||
                Number(persisted.revision || 0) !==
                    Number(journal.revision || 0)
            )
        ) {
            State.recoveryJournal = persisted;
            throw new BatchError(
                '另一个页面已经更新或替换了持久任务账本；'
                + '当前页面不会覆盖它，请只保留一个游戏标签页并刷新',
                'RECOVERY_CONFLICT'
            );
        }
        if (
            !persisted &&
            Number(journal.revision || 0) !== 0
        ) {
            State.recoveryJournal = null;
            throw new BatchError(
                '持久任务账本已被另一个页面清除；'
                + '当前旧页面不会把过期任务重新写回，请刷新',
                'RECOVERY_CONFLICT'
            );
        }
        const previousRevision = Number(journal.revision || 0);
        journal.revision = previousRevision + 1;
        journal.updatedAt = Date.now();
        try {
            writeJsonStorageCritical(
                STORAGE_KEYS.RECOVERY,
                journal
            );
        } catch (error) {
            journal.revision = previousRevision;
            State.recoveryJournal = persisted;
            throw error;
        }
        State.recoveryJournal = journal;
    }

    function clearRecoveryJournalCritical(
        expectedJobId = '',
        expectedRevision = null,
        expectedStatus = ''
    ) {
        let persisted = null;
        try {
            const raw = window.localStorage.getItem(
                STORAGE_KEYS.RECOVERY
            );
            persisted = raw ? JSON.parse(raw) : null;
        } catch (error) {
            throw new BatchError(
                `无法核对待清除任务账本：`
                + `${error.message || String(error)}`,
                'RECOVERY_STORAGE_FAILED'
            );
        }
        const current = State.recoveryJournal;
        if (
            expectedJobId &&
            (
                (
                    current?.jobId &&
                    current.jobId !== expectedJobId
                ) ||
                (
                    persisted?.jobId &&
                    persisted.jobId !== expectedJobId
                )
            )
        ) {
            State.recoveryJournal = persisted || current;
            throw new BatchError(
                '任务账本身份已变化，拒绝清除',
                'RECOVERY_INVALID'
            );
        }
        if (
            expectedJobId &&
            persisted &&
            expectedRevision != null &&
            Number(persisted.revision || 0) !==
                Number(expectedRevision)
        ) {
            State.recoveryJournal = persisted;
            throw new BatchError(
                '任务账本已被另一个页面推进到更新版本，拒绝清除',
                'RECOVERY_CONFLICT'
            );
        }
        if (
            expectedJobId &&
            expectedStatus &&
            persisted &&
            persisted.status !== expectedStatus
        ) {
            State.recoveryJournal = persisted;
            throw new BatchError(
                `任务账本已从 ${expectedStatus} 进入 `
                + `${persisted.status || '未知状态'}，拒绝清除`,
                'RECOVERY_CONFLICT'
            );
        }
        removeJsonStorageCritical(STORAGE_KEYS.RECOVERY);
        State.recoveryJournal = null;
    }

    function isCompletelyAcknowledgedQueueJournal(journal) {
        if (journal?.inFlight != null) return false;
        const commands = enumeratePlanCommands(
            journal.itemPlans,
            journal.mode
        );
        if (journal.acked.length !== commands.length) return false;
        const seenActionIds = new Set(
            (journal.adoptedActions || [])
                .map((record) => normalizeActionId(record?.actionId))
                .filter(Boolean)
        );
        for (let index = 0; index < commands.length; index++) {
            const record = journal.acked[index];
            const command = commands[index];
            const actionId = normalizeActionId(record?.actionId);
            if (
                record?.commandKey !== command.commandKey ||
                !actionId ||
                seenActionIds.has(actionId) ||
                JSON.stringify(record.fingerprint) !== JSON.stringify(
                    recoveryFingerprintForCommand(journal, command)
                )
            ) {
                throw new BatchError(
                    `已完成任务账本的第 ${index + 1} 条入队记录损坏`,
                    'RECOVERY_INVALID'
                );
            }
            seenActionIds.add(actionId);
        }
        return true;
    }

    function loadRecoveryJournal(characterId) {
        const raw = State.recoveryJournal ||
            readJsonStorage(STORAGE_KEYS.RECOVERY, null);
        if (!raw) return null;
        if (
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            raw.schema !== RECOVERY_SCHEMA ||
            typeof raw.jobId !== 'string' ||
            !Array.isArray(raw.itemPlans) ||
            !Array.isArray(raw.acked) ||
            !Array.isArray(raw.adoptedActions)
        ) {
            throw new BatchError(
                '本地任务账本损坏或版本不兼容；请先导出日志，'
                + '不要继续发送',
                'RECOVERY_INVALID'
            );
        }
        if (
            raw.host !== window.location.hostname ||
            raw.characterId !== characterId
        ) {
            throw new BatchError(
                `检测到另一个站点或角色 ${raw.characterId || '未知'} `
                + '仍有未完成的持久任务账本。请先回到该角色完成或'
                + '核对任务，脚本不会用当前角色的新任务覆盖它',
                'RECOVERY_CHARACTER_MISMATCH'
            );
        }
        State.recoveryJournal = raw;
        if (isCompletelyAcknowledgedQueueJournal(raw)) {
            clearRecoveryJournalCritical(
                raw.jobId,
                raw.revision
            );
            log(
                '检测到旧批次的全部计划指令均已取得唯一 action.id；'
                + '已按队列完成语义清除任务账本，不再等待 '
                + '+20 库存或市场状态',
                'success'
            );
            return null;
        }
        return raw;
    }

    function createRecoveryJournal(batchPlan, status = 'confirmed') {
        const purchases = {};
        for (const entry of batchPlan.itemPlans) {
            for (const level of [
                CONFIG.BASE_HIGH,
                CONFIG.BASE_LOW,
            ]) {
                const count = Number(entry.plan.purchases[level] || 0);
                purchases[`${entry.itemId}:${level}`] = {
                    status: count > 0 ? 'pending' : 'confirmed',
                    count,
                };
            }
        }
        return {
            schema: RECOVERY_SCHEMA,
            scriptVersion: VERSION,
            revision: 0,
            jobId:
                `${batchPlan.characterId}:${Date.now()}:`
                + `${Math.random().toString(36).slice(2, 10)}`,
            host: window.location.hostname,
            characterId: batchPlan.characterId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status,
            mode: batchPlan.mode,
            useExistingInventory:
                batchPlan.useExistingInventory,
            targetCount: batchPlan.targetCount,
            itemIds: [...batchPlan.itemIds],
            marketMaintenanceEnabled:
                batchPlan.marketMaintenanceEnabled,
            marketMaxDropPercent:
                batchPlan.marketMaxDropPercent,
            marketItemRules: [
                ...batchPlan.marketItemRules.entries(),
            ].map(([itemId, rule]) => [
                itemId,
                cloneJsonValue(rule),
            ]),
            enhancingLoadout:
                cloneJsonValue(batchPlan.enhancingLoadout),
            itemPlans: cloneJsonValue(batchPlan.itemPlans),
            summary: cloneJsonValue(batchPlan.summary),
            adoptedActions: cloneJsonValue(
                batchPlan.legacyAdoption?.actions || []
            ),
            legacyAdoption: batchPlan.legacyAdoption
                ? cloneJsonValue(batchPlan.legacyAdoption)
                : null,
            purchases,
            acked: [],
            inFlight: null,
            marketInventoryOffsets: {},
            recoveryRetryCount: 0,
            planSignature: batchPlan.signature,
        };
    }

    function getSortedActiveActions() {
        return [...State.actions.values()]
            .filter((action) => action && !action.isDone)
            .sort((left, right) => (
                Number(left.ordinal) - Number(right.ordinal) ||
                Number(left.id) - Number(right.id)
            ));
    }

    function actionFingerprintFromQueueAction(action) {
        const primary = parseItemHash(action?.primaryItemHash);
        const secondary = parseItemHash(action?.secondaryItemHash);
        const loadoutId = getActionLoadoutId(action);
        if (!primary || !secondary || loadoutId == null) {
            return null;
        }
        return {
            primaryItemHash: action.primaryItemHash,
            secondaryItemHash: action.secondaryItemHash,
            enhancingMaxLevel:
                Number(action.enhancingMaxLevel),
            enhancingProtectionMinLevel:
                Number(action.enhancingProtectionMinLevel),
            characterLoadoutId: loadoutId,
        };
    }

    function enhancementStepCountFromFingerprint(fingerprint) {
        const primary = parseItemHash(
            fingerprint?.primaryItemHash
        );
        const startLevel = Number(primary?.enhancementLevel);
        const targetLevel = Number(
            fingerprint?.enhancingMaxLevel
        );
        return (
            Number.isSafeInteger(startLevel) &&
            Number.isSafeInteger(targetLevel) &&
            targetLevel > startLevel
        )
            ? targetLevel - startLevel
            : 0;
    }

    function remainingEnhancementStepCount(action, fingerprint) {
        const frozenSteps = enhancementStepCountFromFingerprint(
            fingerprint
        );
        const currentLevel = actionProgressLevel(action);
        const targetLevel = Number(
            fingerprint?.enhancingMaxLevel
        );
        if (
            !Number.isSafeInteger(currentLevel) ||
            !Number.isSafeInteger(targetLevel) ||
            currentLevel > targetLevel
        ) {
            return frozenSteps;
        }
        return Math.max(0, targetLevel - currentLevel);
    }

    function getQueuedEnhancingMirrorCommitment(actions) {
        return (actions || []).reduce((sum, action) => {
            const targetLevel = Number(action?.enhancingMaxLevel);
            const currentLevel = actionProgressLevel(action);
            if (
                !Number.isSafeInteger(targetLevel) ||
                !Number.isSafeInteger(currentLevel) ||
                targetLevel <= currentLevel
            ) {
                return sum;
            }
            return sum + targetLevel - currentLevel;
        }, 0);
    }

    function projectInventoryThroughEnhancingQueue(
        itemId,
        actions = getEnhancingActions()
    ) {
        const normalizedItemId = normalizeShortItemId(itemId);
        const itemHrid = fullItemHrid(normalizedItemId);
        const counts = getItemCounts(normalizedItemId);
        let actionCount = 0;

        for (const action of actions || []) {
            const primary = parseItemHash(action?.primaryItemHash);
            if (primary?.itemHrid !== itemHrid) continue;
            actionCount++;

            const secondary = parseItemHash(
                action?.secondaryItemHash
            );
            const currentLevel = Number(primary.enhancementLevel);
            const targetLevel = Number(action?.enhancingMaxLevel);
            const invalid = (
                action?.actionHrid !== ENHANCE_ACTION_HRID ||
                action?.isDone === true ||
                primary.characterId !== State.characterId ||
                primary.itemLocationHrid !==
                    INVENTORY_LOCATION_HRID ||
                !secondary ||
                secondary.characterId !== State.characterId ||
                secondary.itemLocationHrid !==
                    INVENTORY_LOCATION_HRID ||
                secondary.itemHrid !==
                    fullItemHrid(PHILOSOPHERS_MIRROR) ||
                secondary.enhancementLevel !== 0 ||
                !Number.isSafeInteger(currentLevel) ||
                currentLevel < 1 ||
                !Number.isSafeInteger(targetLevel) ||
                targetLevel < currentLevel ||
                targetLevel > CONFIG.TARGET_LEVEL ||
                (
                    action.difficultyTier != null &&
                    Number(action.difficultyTier) !== 0
                ) ||
                (
                    action.hasMaxCount != null &&
                    action.hasMaxCount !== false
                ) ||
                (
                    action.maxCount != null &&
                    Number(action.maxCount) !== 0
                )
            );
            if (invalid) {
                throw new BatchError(
                    `${getItemName(normalizedItemId)} 的既有强化动作无法`
                    + '按单件队列语义投影库存；本次不会在其后续排',
                    'QUEUE_PROJECTION_INVALID'
                );
            }

            while (counts.length <= targetLevel) counts.push(0);
            for (
                let sourceLevel = currentLevel;
                sourceLevel < targetLevel;
                sourceLevel++
            ) {
                counts[sourceLevel] =
                    Number(counts[sourceLevel] || 0) - 1;
                counts[sourceLevel - 1] =
                    Number(counts[sourceLevel - 1] || 0) - 1;
                counts[sourceLevel + 1] =
                    Number(counts[sourceLevel + 1] || 0) + 1;
            }
        }

        return {counts, actionCount};
    }

    function getProjectedQueueTailInventoryCount(
        itemId,
        level,
        actions = getEnhancingActions()
    ) {
        const projection = projectInventoryThroughEnhancingQueue(
            itemId,
            actions
        );
        return Number(projection.counts[level] || 0);
    }

    function getPurchaseQueueProjection(itemId, level, count) {
        const projection = projectInventoryThroughEnhancingQueue(
            itemId
        );
        if (projection.actionCount < 1) return null;
        const baselineProjectedInventory = Number(
            projection.counts[level] || 0
        );
        return {
            baselineProjectedInventory,
            expectedProjectedInventory:
                baselineProjectedInventory + Number(count),
        };
    }

    function getRecoveryPurchaseRequirements(journal, itemId) {
        if (!State.inventoryReady || !State.queueReady ||
            journal.characterId !== State.characterId) {
            throw new BatchError('请等待当前角色的完整库存和队列同步后核对补料', 'STATE_NOT_READY');
        }
        const commands = enumeratePlanCommands(journal.itemPlans, journal.mode);
        if (journal.mode !== 'quick' || !Array.isArray(journal.acked) ||
            journal.acked.length > commands.length ||
            !journal.itemPlans.some(entry => entry.itemId === itemId)) {
            throw new BatchError('采购恢复的冻结计划无效', 'RECOVERY_INVALID');
        }
        const required = new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
        const net = [...required];
        // Minimum starting stock for the unsent suffix. Track each input
        // before its output is produced; final net balances alone are unsafe.
        for (const command of commands.slice(journal.acked.length)) {
            if (command.itemId !== itemId) continue;
            const start = Number(command.action.startLevel);
            const target = Number(command.action.targetLevel);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(target) ||
                start < CONFIG.BASE_HIGH || target <= start || target > CONFIG.TARGET_LEVEL) {
                throw new BatchError('采购恢复遇到无效的冻结强化步骤', 'RECOVERY_INVALID');
            }
            for (let level = start; level < target; level++) {
                for (const input of [level, level - 1]) {
                    net[input]--;
                    required[input] = Math.max(required[input], -net[input]);
                }
                net[level + 1]++;
            }
        }
        const projected = projectInventoryThroughEnhancingQueue(itemId).counts;
        const shortages = required.map((needed, level) => {
            const available = Number(projected[level] || 0);
            if (!Number.isSafeInteger(available)) {
                throw new BatchError('采购恢复遇到无效的库存数量', 'RECOVERY_INVALID');
            }
            const shortage = Math.max(0, needed - available);
            if (shortage && ![CONFIG.BASE_LOW, CONFIG.BASE_HIGH].includes(level)) {
                throw new BatchError(
                    `${getItemName(itemId)} 的未入队计划缺少 +${level} 中间件 ×${shortage}；`
                    + '无法仅补 +9/+10 继续，请核对库存和既有队列',
                    'RECOVERY_MATERIALS_MISSING'
                );
            }
            return shortage;
        });
        if (shortages[CONFIG.BASE_LOW] + shortages[CONFIG.BASE_HIGH] > CONFIG.MAX_PURCHASE_ITEMS) {
            throw new BatchError('恢复补料缺口超过单批采购上限，请核对库存和队列', 'RECOVERY_INVALID');
        }
        return {required, projected, shortages};
    }

    function createEmptyEnhancePlan() {
        return {
            targetCount: 0,
            purchases: {
                [CONFIG.BASE_LOW]: 0,
                [CONFIG.BASE_HIGH]: 0,
            },
            purchaseItemCount: 0,
            mirrorCount: 0,
            rawActions: [],
            compressedActions: [],
            rawOutputSegments: [],
            compressedOutputSegments: [],
            rawActionsPerOutput: [],
            compressedActionsPerOutput: [],
            linkCount: 0,
            demand:
                new Array(CONFIG.TARGET_LEVEL + 1).fill(0),
            craftCounts:
                new Array(CONFIG.TARGET_LEVEL + 1).fill(0),
            consumedExisting:
                new Array(CONFIG.TARGET_LEVEL + 1).fill(0),
            remainingInventory:
                new Array(CONFIG.TARGET_LEVEL + 1).fill(0),
        };
    }

    function analyzeLegacyEnhancingQueue({
        enhancingActions,
        itemIds,
        targetCount,
        useExistingInventory,
        characterId,
        enhancingLoadout,
        mode,
    }) {
        if (!Array.isArray(enhancingActions) ||
            enhancingActions.length === 0) {
            return null;
        }
        if (mode !== 'quick') {
            throw new BatchError(
                '只有队尾快排可以接管刷新前留下的强化队列；'
                + '验证慢排仍要求空队列'
            );
        }

        const selected = new Set(itemIds);
        const projected = new Map(
            itemIds.map((itemId) => [
                itemId,
                [...getItemCounts(itemId)],
            ])
        );
        const queuedOutputs = new Map(
            itemIds.map((itemId) => [itemId, 0])
        );
        const queuedCommands = new Map(
            itemIds.map((itemId) => [itemId, 0])
        );
        const commandsSinceOutput = new Map(
            itemIds.map((itemId) => [itemId, 0])
        );
        const adoptedActions = [];
        let queuedMirrorCount = 0;
        let previousOrdinal = -Infinity;
        const seenIds = new Set();

        const sorted = [...enhancingActions].sort(
            (left, right) => (
                Number(left.ordinal) - Number(right.ordinal) ||
                Number(left.id) - Number(right.id)
            )
        );
        for (
            let sortedIndex = 0;
            sortedIndex < sorted.length;
            sortedIndex++
        ) {
            const action = sorted[sortedIndex];
            const actionId = normalizeActionId(action?.id);
            const ordinal = Number(action?.ordinal);
            const primary = parseItemHash(
                action?.primaryItemHash
            );
            const secondary = parseItemHash(
                action?.secondaryItemHash
            );
            const itemId = normalizeShortItemId(
                primary?.itemHrid
            );
            const startLevel = Number(
                primary?.enhancementLevel
            );
            const targetLevel = Number(
                action?.enhancingMaxLevel
            );
            const fingerprint =
                actionFingerprintFromQueueAction(action);
            if (
                !actionId ||
                seenIds.has(actionId) ||
                !Number.isFinite(ordinal) ||
                ordinal <= previousOrdinal ||
                !primary ||
                primary.characterId !== characterId ||
                primary.itemLocationHrid !==
                    INVENTORY_LOCATION_HRID ||
                !selected.has(itemId) ||
                !secondary ||
                secondary.characterId !== characterId ||
                secondary.itemLocationHrid !==
                    INVENTORY_LOCATION_HRID ||
                secondary.itemHrid !==
                    fullItemHrid(PHILOSOPHERS_MIRROR) ||
                secondary.enhancementLevel !== 0 ||
                !Number.isSafeInteger(startLevel) ||
                startLevel < CONFIG.BASE_LOW ||
                !Number.isSafeInteger(targetLevel) ||
                targetLevel <= startLevel ||
                targetLevel > CONFIG.TARGET_LEVEL ||
                !fingerprint ||
                normalizeLoadoutId(
                    fingerprint.characterLoadoutId
                ) !== enhancingLoadout.id ||
                Number(
                    fingerprint.enhancingProtectionMinLevel
                ) !== CONFIG.PROTECTION_MIN_LEVEL ||
                !strictSingleEnhanceActionMatches(
                    action,
                    fingerprint
                )
            ) {
                throw new BatchError(
                    '现有强化队列中含有无法安全接管的动作：'
                    + '角色、装备、贤者镜、Enhancing 配装、保护等级、'
                    + '批量字段或队列顺序不符合本脚本单件动作语义'
                );
            }
            previousOrdinal = ordinal;
            seenIds.add(actionId);

            const counts = projected.get(itemId);
            while (counts.length <= targetLevel) counts.push(0);
            for (
                let sourceLevel = startLevel;
                sourceLevel < targetLevel;
                sourceLevel++
            ) {
                while (counts.length <= sourceLevel + 1) {
                    counts.push(0);
                }
                if (
                    Number(counts[sourceLevel] || 0) <= 0 ||
                    Number(counts[sourceLevel - 1] || 0) <= 0
                ) {
                    throw new BatchError(
                        `${getItemName(itemId)} 的现有强化动作 `
                        + `+${startLevel}→+${targetLevel} 无法从当前库存`
                        + `逐级投影到 +${sourceLevel + 1}；`
                        + '当前动作可能已经在执行、材料已被其他操作'
                        + '消耗，或旧队列不是同一批计划。'
                        + '为避免错误补排，本次不会自动接管'
                    );
                }
                counts[sourceLevel]--;
                counts[sourceLevel - 1]--;
                counts[sourceLevel + 1] =
                    Number(counts[sourceLevel + 1] || 0) + 1;
            }
            queuedCommands.set(
                itemId,
                queuedCommands.get(itemId) + 1
            );
            commandsSinceOutput.set(
                itemId,
                commandsSinceOutput.get(itemId) + 1
            );
            if (targetLevel === CONFIG.TARGET_LEVEL) {
                queuedOutputs.set(
                    itemId,
                    queuedOutputs.get(itemId) + 1
                );
                commandsSinceOutput.set(itemId, 0);
            }
            queuedMirrorCount += targetLevel - startLevel;
            adoptedActions.push({
                actionId,
                itemId,
                startLevel,
                targetLevel,
                ordinal,
                fingerprint,
                isTargetOutput:
                    targetLevel === CONFIG.TARGET_LEVEL,
            });
        }

        const itemPlans = itemIds.map((itemId) => {
            const adoptedOutputCount =
                queuedOutputs.get(itemId) || 0;
            if (adoptedOutputCount > targetCount) {
                throw new BatchError(
                    `${getItemName(itemId)} 现有队列已经包含 `
                    + `${adoptedOutputCount} 个 +20 收束动作，`
                    + `超过本次填写的 ${targetCount}`
                );
            }
            const remainingTarget =
                targetCount - adoptedOutputCount;
            const plan = remainingTarget > 0
                ? Planner.planTo20(
                    projected.get(itemId),
                    remainingTarget,
                    true
                )
                : createEmptyEnhancePlan();
            if (plan.purchaseItemCount > 0) {
                throw new BatchError(
                    `${getItemName(itemId)} 接管现有队列后的库存投影`
                    + `仍缺少 ${plan.purchaseItemCount} 件 +9/+10 基底。`
                    + '为避免队列执行与采购库存回执互相抵消，本次不自动'
                    + '采购；请先在游戏中补足基底后重新核对'
                );
            }
            return {
                itemId,
                baselineOutputCount: getItemCount(
                    itemId,
                    CONFIG.TARGET_LEVEL
                ),
                targetOutputs: targetCount,
                adoptedOutputCount,
                adoptedCommandCount:
                    queuedCommands.get(itemId) || 0,
                adoptedPartialCommandCount:
                    commandsSinceOutput.get(itemId) || 0,
                projectedInventory:
                    [...projected.get(itemId)],
                plan,
            };
        });

        const summary = Planner.summarize(itemPlans, mode);
        summary.outputs = itemIds.length * targetCount;
        summary.sendCommands += adoptedActions.length;
        summary.mirrorCount += queuedMirrorCount;
        Planner.validateSummary(summary);

        return {
            itemPlans,
            summary,
            legacyAdoption: {
                requiresExplicitConfirmation: true,
                actions: adoptedActions,
                actionCount: adoptedActions.length,
                outputCount: [...queuedOutputs.values()]
                    .reduce((sum, count) => sum + count, 0),
                queuedMirrorCount,
                warning:
                    '这是旧版无任务账本队列的一次性显式接管。'
                    + '刷新前已经完成并从队列消失的动作无法反推；'
                    + '本次数量表示从当前库存状态起、包含现有队列'
                    + '尚未产出的 +20 在内的目标数量。'
                    + '为延续队尾半成品，接管模式会利用投影后的'
                    + '现有 +9～+19 库存。',
            },
        };
    }

    function reconcileRecoveryJournal(journal) {
        if (journal.mode !== 'quick') {
            throw new BatchError(
                '当前任务账本不是可续排的队尾快排任务',
                'RECOVERY_INVALID'
            );
        }
        const commands = enumeratePlanCommands(
            journal.itemPlans,
            journal.mode
        );
        const knownIds = new Set();
        const presentOwned = [];
        const orderedRecords = [];

        for (
            let index = 0;
            index < journal.adoptedActions.length;
            index++
        ) {
            const record = journal.adoptedActions[index];
            const actionId = normalizeActionId(record?.actionId);
            if (!actionId || knownIds.has(actionId)) {
                throw new BatchError(
                    '任务账本中的接管 action.id 重复或无效',
                    'RECOVERY_INVALID'
                );
            }
            knownIds.add(actionId);
            orderedRecords.push({
                actionId,
                fingerprint: record.fingerprint,
                itemId: record.itemId,
                targetLevel: record.targetLevel,
                planOrder: orderedRecords.length,
                kind: 'adopted',
            });
        }

        if (journal.acked.length > commands.length) {
            throw new BatchError(
                '任务账本确认指令数超过冻结计划',
                'RECOVERY_INVALID'
            );
        }
        for (let index = 0; index < journal.acked.length; index++) {
            const record = journal.acked[index];
            const command = commands[index];
            const actionId = normalizeActionId(record?.actionId);
            const expectedFingerprint =
                recoveryFingerprintForCommand(journal, command);
            if (
                record?.commandKey !== command.commandKey ||
                !actionId ||
                knownIds.has(actionId) ||
                JSON.stringify(record.fingerprint) !==
                    JSON.stringify(expectedFingerprint)
            ) {
                throw new BatchError(
                    `任务账本第 ${index + 1} 条指令身份损坏`,
                    'RECOVERY_INVALID'
                );
            }
            knownIds.add(actionId);
            orderedRecords.push({
                actionId,
                fingerprint: expectedFingerprint,
                itemId: command.itemId,
                targetLevel:
                    command.action.targetLevel,
                planOrder: orderedRecords.length,
                kind: 'planned',
                commandKey: command.commandKey,
            });
        }

        let journalChanged = false;
        const pendingPurchase = journal.inFlight?.type === 'purchase'
            ? journal.inFlight : null;

        if (journal.inFlight?.type === 'action') {
            const pending = journal.inFlight;
            const previouslyObservedIds = [
                ...new Set(
                    (pending.observedActionIds || [])
                        .map(normalizeActionId)
                        .filter(Boolean)
                ),
            ];
            if (previouslyObservedIds.length > 1) {
                throw new BatchError(
                    '刷新前已经观察到多条都可能对应最后一次发送'
                    + '的强化动作；即使现在只剩一条，也不能把'
                    + '历史歧义降级为唯一结果',
                    'RECOVERY_AMBIGUOUS'
                );
            }
            // If a retry had already persisted one exact candidate ID before
            // refresh, that is sufficient queue evidence for this dependency
            // position. Reuse the durable ID below instead of blocking the
            // entire suffix or sending the same position a third time.
            const command = commands[journal.acked.length];
            if (
                !command ||
                command.commandKey !== pending.commandKey
            ) {
                throw new BatchError(
                    '任务账本待确认指令位置与冻结计划不一致',
                    'RECOVERY_INVALID'
                );
            }
            const expectedFingerprint =
                recoveryFingerprintForCommand(journal, command);
            if (
                JSON.stringify(expectedFingerprint) !==
                    JSON.stringify(pending.fingerprint)
            ) {
                throw new BatchError(
                    '任务账本待确认指纹与冻结计划不一致',
                    'RECOVERY_INVALID'
                );
            }
            const baselineIds = new Set(
                (pending.baselineActionIds || [])
                    .map(normalizeActionId)
                    .filter(Boolean)
            );
            const candidates = getEnhancingActions().filter(
                (action) => (
                    !baselineIds.has(
                        normalizeActionId(action.id)
                    ) &&
                    progressSingleEnhanceActionMatches(
                        action,
                        expectedFingerprint
                    )
                )
            );
            const candidateIds = candidates
                .map((action) => normalizeActionId(action.id))
                .filter(Boolean);
            const observedIds = [
                ...new Set([
                    ...previouslyObservedIds,
                    ...candidateIds,
                ]),
            ];
            if (observedIds.length > 1) {
                const previousPending =
                    cloneJsonValue(pending);
                journal.inFlight = {
                    ...pending,
                    phase: 'ambiguous',
                    errorReason:
                        '刷新核对时发现多条都可能对应最后一次发送'
                        + '的强化动作',
                    observedActionIds: observedIds,
                };
                try {
                    saveRecoveryJournalCritical(journal);
                } catch (error) {
                    journal.inFlight = previousPending;
                    throw new BatchError(
                        '发现多条候选动作，且无法把历史歧义安全写入'
                        + `任务账本：${error.message || String(error)}`,
                        'RECOVERY_AMBIGUOUS'
                    );
                }
                throw new BatchError(
                    '刷新后发现多条都可能对应最后一次发送的强化动作；'
                    + '无法唯一接管，也不会重发',
                    'RECOVERY_AMBIGUOUS'
                );
            }
            // A durable, fingerprint-matched action.id proves that this plan
            // position entered the queue. It does not need to remain in the
            // refreshed active suffix in order to resume later dependencies.
            const candidateId =
                candidateIds[0] || previouslyObservedIds[0] || '';
            if (candidateId) {
                if (
                    baselineIds.has(candidateId) ||
                    knownIds.has(candidateId)
                ) {
                    throw new BatchError(
                        '任务账本记录的最后一条候选 action.id '
                        + '与既有动作身份冲突',
                        'RECOVERY_INVALID'
                    );
                }
                journal.acked.push({
                    commandKey: command.commandKey,
                    actionId: candidateId,
                    fingerprint: expectedFingerprint,
                });
                journal.inFlight = null;
                journalChanged = true;
                knownIds.add(candidateId);
                orderedRecords.push({
                    actionId: candidateId,
                    fingerprint: expectedFingerprint,
                    itemId: command.itemId,
                    targetLevel:
                        command.action.targetLevel,
                    planOrder: orderedRecords.length,
                    kind: 'planned',
                    commandKey: command.commandKey,
                });
            } else {
                if (
                    pending.phase === 'retry_authorized' &&
                    Number(
                        pending.retrySequence ||
                        journal.recoveryRetryCount || 0
                    ) ===
                        Number(journal.recoveryRetryCount || 0) &&
                    Number(journal.recoveryRetryCount || 0) > 0
                ) {
                    // Keep the original write-ahead record and baseline until
                    // the exact synchronous send boundary. A late receipt may
                    // still arrive between this refresh reconciliation and
                    // the controller reaching the missing command.
                } else {
                    const retrySequence =
                        Number(journal.recoveryRetryCount || 0) + 1;
                    journal.inFlight = {
                        ...pending,
                        phase: 'retry_authorized',
                        retryAuthorizedAt: Date.now(),
                        retrySequence,
                        observedActionIds: [],
                    };
                    journal.recoveryRetryCount = retrySequence;
                    journalChanged = true;
                    log(
                        `断点恢复：前 ${journal.acked.length} 条已有`
                        + '唯一 action.id，均不会重发；'
                        + `第 ${journal.acked.length + 1} 条没有唯一回执，`
                        + `已持久授权第 ${retrySequence} 次恢复重发。`
                        + '取得 action.id 后才会发送下一条',
                        'warn'
                    );
                }
            }
        }

        const presentIndexes = [];
        for (let index = 0; index < orderedRecords.length; index++) {
            const record = orderedRecords[index];
            const live = State.actions.get(record.actionId);
            if (!live) continue;
            if (
                !progressSingleEnhanceActionMatches(
                    live,
                    record.fingerprint
                )
            ) {
                throw new BatchError(
                    `任务账本 action ${record.actionId} 与当前队列`
                    + '内容不一致；不会续排',
                    'RECOVERY_INVALID'
                );
            }
            presentIndexes.push(index);
            presentOwned.push({
                ...record,
                action: live,
            });
        }
        if (presentIndexes.length > 0) {
            for (let index = 1; index < presentOwned.length; index++) {
                if (
                    Number(presentOwned[index].action.ordinal) <=
                    Number(
                        presentOwned[index - 1].action.ordinal
                    )
                ) {
                    throw new BatchError(
                        '任务账本动作在当前队列中的相对顺序已改变',
                        'RECOVERY_INVALID'
                    );
                }
            }
        }

        const previousPurchases = journal.purchases;
        if (pendingPurchase) {
            const pending = pendingPurchase;
            if (![CONFIG.BASE_LOW, CONFIG.BASE_HIGH].includes(pending.level) ||
                pending.purchaseKey !== `${pending.itemId}:${pending.level}` ||
                !Number.isSafeInteger(pending.count) || pending.count <= 0 ||
                !journal.purchases?.[pending.purchaseKey] ||
                !journal.itemPlans.some(entry => entry.itemId === pending.itemId)) {
                throw new BatchError('待核对采购记录无效，不能据此补料', 'RECOVERY_INVALID');
            }
            const usesQueueProjection = pending.expectedProjectedInventory != null &&
                Number.isFinite(Number(pending.expectedProjectedInventory));
            const current = usesQueueProjection
                ? getProjectedQueueTailInventoryCount(pending.itemId, pending.level)
                : getItemCount(pending.itemId, pending.level);
            const expected = Number(usesQueueProjection
                ? pending.expectedProjectedInventory : pending.expectedInventory);
            if (current === expected) {
                journal.purchases = {...journal.purchases, [pending.purchaseKey]: {
                    status: 'confirmed', count: pending.count,
                    recoveryStock: pending.recoveryStock === true,
                }};
            } else {
                if (pending.syncMarker === `${RECOVERY_SESSION_ID}:${State.syncEpoch}`) {
                    throw new BatchError(
                        '最后一笔采购结果未确认；请完整刷新游戏取得新库存和队列，'
                        + '新版将按未入队计划的实际缺口恢复，不重发旧采购数量',
                        'RECOVERY_NEEDS_SYNC'
                    );
                }
                const needs = getRecoveryPurchaseRequirements(journal, pending.itemId);
                journal.purchases = {...journal.purchases};
                for (const level of [CONFIG.BASE_HIGH, CONFIG.BASE_LOW]) {
                    const key = `${pending.itemId}:${level}`;
                    journal.purchases[key] = {
                        ...journal.purchases[key], status: 'recheck', recoveryStock: true,
                    };
                }
                log(`${getItemName(pending.itemId)}：旧采购结果不再按历史库存猜测；`
                    + `按当前队尾和未入队计划核算，需补 +10 ×${needs.shortages[10]}、`
                    + `+9 ×${needs.shortages[9]}，已确认动作不重发`, 'warn');
            }
            journal.inFlight = null;
            journalChanged = true;
        }
        if (journalChanged) {
            try { saveRecoveryJournalCritical(journal); }
            catch (error) {
                if (pendingPurchase) {
                    journal.inFlight = pendingPurchase;
                    journal.purchases = previousPurchases;
                }
                throw error;
            }
        }

        return {
            commands,
            presentOwned,
            orderedRecords,
        };
    }

    function hydrateRecoveryBatchPlan(journal) {
        const characterId = getCharacterId();
        const loadout = getEnhancingLoadoutBinding();
        if (
            journal.characterId !== characterId ||
            journal.enhancingLoadout.id !== loadout.id
        ) {
            throw new BatchError(
                '当前角色或 Enhancing 配装 ID 与未完成任务账本不一致；'
                + '若不再继续旧目标，请点击“结束旧批次记录”，'
                + '再按当前配装重新预检',
                'RECOVERY_INVALID'
            );
        }
        assertBeltEnhancementRules(journal.itemIds);
        const loadoutTargetReservations =
            getLoadoutTargetReservations(
                journal.itemIds,
                loadout
            );
        assertPlansPreserveLoadoutTargetReservations(
            journal.itemPlans,
            loadoutTargetReservations
        );
        // v1.5 journals may say marketplace automation was enabled. v1.6
        // resumes only their unsent queue commands; market rules, listings
        // and +20 inventory are deliberately outside the recovery contract.
        const marketItemRules = new Map();
        const recovery = reconcileRecoveryJournal(journal);
        const queuedMirrorCount =
            recovery.presentOwned.reduce(
                (sum, record) => (
                    sum +
                    remainingEnhancementStepCount(
                        record.action,
                        record.fingerprint
                    )
                ),
                0
            );
        const unsentMirrorCount = recovery.commands
            .slice(journal.acked.length)
            .reduce(
                (sum, command) => (
                    sum +
                    Number(command.action.targetLevel) -
                    Number(command.action.startLevel)
                ),
                0
            );
        const remainingMirrorCount =
            queuedMirrorCount + unsentMirrorCount;
        const mirrorAvailable =
            getItemCount(PHILOSOPHERS_MIRROR, 0);
        if (mirrorAvailable < remainingMirrorCount) {
            throw new BatchError(
                `恢复任务所需的剩余贤者镜不足：库存 `
                + `${formatInt(mirrorAvailable)}，`
                + `未发送计划需要 ${formatInt(
                    remainingMirrorCount
                )}`
            );
        }
        const recoveryPurchases = [];
        const summary = cloneJsonValue(journal.summary);
        summary.purchaseHigh = 0;
        summary.purchaseLow = 0;
        for (const entry of journal.itemPlans) {
            let needs;
            for (const level of [CONFIG.BASE_HIGH, CONFIG.BASE_LOW]) {
                const record = journal.purchases[`${entry.itemId}:${level}`];
                let count = Number(entry.plan.purchases[level] || 0);
                if (record?.recoveryStock) {
                    needs ||= getRecoveryPurchaseRequirements(journal, entry.itemId);
                    count = needs.shortages[level];
                    recoveryPurchases.push({itemId: entry.itemId, level, count});
                } else if (['confirmed', 'satisfied'].includes(record?.status)) {
                    count = 0;
                }
                summary[level === CONFIG.BASE_HIGH ? 'purchaseHigh' : 'purchaseLow'] += count;
                if (count > 0) getTesterPurchaseHrid(entry.itemId);
            }
        }
        summary.purchaseItems = summary.purchaseHigh + summary.purchaseLow;
        if (summary.purchaseItems > CONFIG.MAX_PURCHASE_ITEMS) {
            throw new BatchError('恢复补料总数超过单批采购上限，请核对库存和队列', 'RECOVERY_INVALID');
        }
        return {
            characterId,
            itemIds: [...journal.itemIds],
            targetCount: journal.targetCount,
            mode: journal.mode,
            useExistingInventory:
                journal.useExistingInventory,
            marketMaintenanceEnabled: false,
            marketMaxDropPercent:
                journal.marketMaxDropPercent,
            marketItemRules,
            marketListingCap: State.marketListingCap,
            marketListingCount:
                State.myMarketListings.size,
            enhancingLoadout:
                cloneJsonValue(loadout),
            loadoutTargetReservations,
            itemPlans: cloneJsonValue(journal.itemPlans),
            summary,
            mirrorAvailable,
            queueCapacity: State.actionQueueCap,
            queueFreeSlots: Number.isFinite(
                State.actionQueueCap
            )
                ? Math.max(
                    0,
                    State.actionQueueCap -
                        State.actions.size -
                        getReservedExternalQueueSlots()
                )
                : null,
            signature: JSON.stringify([
                journal.planSignature, loadout.fingerprint,
                loadoutTargetReservations, recoveryPurchases,
            ]),
            recoveryPurchases,
            isRecovery: true,
            recoveryJournal: journal,
            recovery,
            legacyAdoption: journal.legacyAdoption,
        };
    }

    function createEnhancePayload(run, itemId, action, mode) {
        const characterId = run.characterId;
        if (!characterId) {
            throw new BatchError('批次没有固定 characterId', 'INVALID_STATE');
        }
        const loadoutId = normalizeLoadoutId(run.enhancingLoadoutId);
        if (loadoutId == null) {
            throw new BatchError(
                '批次没有固定 Enhancing 配装 ID',
                'INVALID_STATE'
            );
        }

        return {
            fingerprint: {
                primaryItemHash: buildItemHash(
                    characterId,
                    itemId,
                    action.startLevel
                ),
                secondaryItemHash: buildItemHash(
                    characterId,
                    PHILOSOPHERS_MIRROR,
                    0
                ),
                enhancingMaxLevel: action.targetLevel,
                enhancingProtectionMinLevel: CONFIG.PROTECTION_MIN_LEVEL,
                characterLoadoutId: loadoutId,
            },
            payload: {
                type: 'new_character_action',
                newCharacterActionData: {
                    actionHrid: ENHANCE_ACTION_HRID,
                    difficultyTier: 0,
                    hasMaxCount: false,
                    maxCount: 0,
                    primaryItemHash: buildItemHash(
                        characterId,
                        itemId,
                        action.startLevel
                    ),
                    secondaryItemHash: buildItemHash(
                        characterId,
                        PHILOSOPHERS_MIRROR,
                        0
                    ),
                    enhancingMaxLevel: action.targetLevel,
                    enhancingProtectionMinLevel:
                        CONFIG.PROTECTION_MIN_LEVEL,
                    characterLoadoutId: loadoutId,
                    isStartNow: mode === 'verified',
                    confirmedActionValueWarning: false,
                },
            },
        };
    }

    async function sendEnhanceAndConfirm(
        run,
        itemId,
        action,
        mode,
        command = null
    ) {
        const {fingerprint, payload} = createEnhancePayload(
            run,
            itemId,
            action,
            mode
        );
        let baselineTargetCount = null;
        const outcome = await runOperationSafely(
            run,
            () => {
                const journal = run.recoveryJournal;
                const authorizedRetry = (
                    journal?.inFlight?.type === 'action' &&
                    journal.inFlight.phase === 'retry_authorized'
                )
                    ? journal.inFlight
                    : null;
                if (authorizedRetry) {
                    const commands = enumeratePlanCommands(
                        journal.itemPlans,
                        journal.mode
                    );
                    const expected =
                        commands[journal.acked.length];
                    if (
                        !command ||
                        !expected ||
                        command.commandKey !== expected.commandKey ||
                        Number(command.commandIndex) !==
                            Number(expected.commandIndex) ||
                        authorizedRetry.commandKey !==
                            command.commandKey ||
                        JSON.stringify(
                            authorizedRetry.fingerprint
                        ) !== JSON.stringify(fingerprint) ||
                        Number(
                            journal.recoveryRetryCount || 0
                        ) !== Number(
                            authorizedRetry.retrySequence ||
                            journal.recoveryRetryCount || 0
                        ) ||
                        Number(
                            authorizedRetry.retrySequence ||
                            journal.recoveryRetryCount || 0
                        ) < 1
                    ) {
                        throw new BatchError(
                            '受控重试与持久任务账本中的下一条指令不一致',
                            'RECOVERY_INVALID'
                        );
                    }

                    const originalBaselineIds = new Set(
                        (
                            authorizedRetry.baselineActionIds || []
                        )
                            .map(normalizeActionId)
                            .filter(Boolean)
                    );
                    const matchingCandidates =
                        getEnhancingActions().filter(
                            (candidate) => {
                                const candidateId =
                                    normalizeActionId(
                                        candidate?.id
                                    );
                                return (
                                    candidateId &&
                                    !originalBaselineIds.has(
                                        candidateId
                                    ) &&
                                    progressSingleEnhanceActionMatches(
                                        candidate,
                                        fingerprint
                                    )
                                );
                            }
                        );
                    const candidateIds = [
                        ...new Set(
                            matchingCandidates
                                .map((candidate) => (
                                    normalizeActionId(
                                        candidate.id
                                    )
                                ))
                                .filter(Boolean)
                        ),
                    ];
                    if (candidateIds.length > 1) {
                        const previousInFlight =
                            cloneJsonValue(journal.inFlight);
                        journal.inFlight = {
                            ...journal.inFlight,
                            phase: 'ambiguous',
                            errorReason:
                                '受控重试发包前发现多条完全匹配'
                                + '的迟到动作',
                            observedActionIds: candidateIds,
                        };
                        try {
                            saveRecoveryJournalCritical(journal);
                        } catch (error) {
                            journal.inFlight = previousInFlight;
                            throw error;
                        }
                        throw new BatchError(
                            '受控重试发包前发现多条完全匹配的迟到动作；'
                            + '无法唯一接管，脚本不会重发',
                            'RECOVERY_AMBIGUOUS'
                        );
                    }
                    if (candidateIds.length === 1) {
                        const candidateId = candidateIds[0];
                        const knownIds = new Set([
                            ...(journal.adoptedActions || [])
                                .map((record) => record.actionId),
                            ...(journal.acked || [])
                                .map((record) => record.actionId),
                        ].map(normalizeActionId).filter(Boolean));
                        if (knownIds.has(candidateId)) {
                            throw new BatchError(
                                '迟到动作 action.id 与任务账本既有动作冲突',
                                'RECOVERY_INVALID'
                            );
                        }
                        const previousInFlight =
                            cloneJsonValue(journal.inFlight);
                        journal.acked.push({
                            commandKey: command.commandKey,
                            actionId: candidateId,
                            fingerprint:
                                cloneJsonValue(fingerprint),
                        });
                        journal.inFlight = null;
                        try {
                            saveRecoveryJournalCritical(journal);
                        } catch (error) {
                            journal.acked.pop();
                            journal.inFlight = previousInFlight;
                            throw error;
                        }
                        return Promise.resolve({
                            status: 'confirmed',
                            actionId: candidateId,
                            recoveredLateReceipt: true,
                        });
                    }

                    // The user selected dependency-first recovery: if the
                    // original predecessor already completed and no exact
                    // candidate is visible, the missing plan position is
                    // still resent before any dependent suffix command.
                }

                const baselineActionIds = authorizedRetry
                    ? new Set(
                        (
                            authorizedRetry.baselineActionIds || []
                        )
                            .map(normalizeActionId)
                            .filter(Boolean)
                    )
                    : new Set([
                        ...State.actions.keys(),
                        ...(journal?.adoptedActions || [])
                            .map((record) => record.actionId),
                        ...(journal?.acked || [])
                            .map((record) => record.actionId),
                    ].map(normalizeActionId).filter(Boolean));
                const sortedActions = getSortedActiveActions();
                const predecessorId = authorizedRetry
                    ? normalizeActionId(
                        authorizedRetry.predecessorId
                    )
                    : normalizeActionId(
                        sortedActions.at(-1)?.id
                    );
                if (journal) {
                    const commands = enumeratePlanCommands(
                        journal.itemPlans,
                        journal.mode
                    );
                    const expected =
                        commands[journal.acked.length];
                    if (
                        !command ||
                        !expected ||
                        command.commandKey !==
                            expected.commandKey ||
                        Number(command.commandIndex) !==
                            Number(expected.commandIndex) ||
                        (
                            authorizedRetry
                                ? journal.inFlight !==
                                    authorizedRetry
                                : journal.inFlight != null
                        )
                    ) {
                        throw new BatchError(
                            '即将发送的强化指令不是持久任务账本中的下一条',
                            'RECOVERY_INVALID'
                        );
                    }
                    const previousInFlight =
                        journal.inFlight == null
                            ? null
                            : cloneJsonValue(journal.inFlight);
                    journal.inFlight = {
                        type: 'action',
                        commandKey: command.commandKey,
                        commandIndex: command.commandIndex,
                        itemId,
                        fingerprint:
                            cloneJsonValue(fingerprint),
                        baselineActionIds: [
                            ...baselineActionIds,
                        ],
                        predecessorId,
                        phase: 'prepared',
                        sentAt: Date.now(),
                        errorCode: '',
                        errorReason: '',
                        externalOverlapEver: false,
                        externalMatchingQueueAddSeen: false,
                        spamRetryEvidenceSafe: false,
                        recoveryRetryAttempt:
                            Boolean(authorizedRetry),
                    };
                    try {
                        saveRecoveryJournalCritical(journal);
                    } catch (error) {
                        journal.inFlight = previousInFlight;
                        throw error;
                    }
                }
                baselineTargetCount = getRunAdjustedOutputCount(
                    run,
                    itemId,
                    action.targetLevel
                );
                const promise = Transactions.begin(run, {
                    kind: mode === 'verified' ? 'verified' : 'queue',
                    itemId,
                    fingerprint,
                    baselineTargetCount,
                    baselineActionIds,
                    predecessorId,
                    commandKey:
                        command?.commandKey || '',
                    commandIndex:
                        command?.commandIndex,
                    recoveryJobId:
                        run.recoveryJournal?.jobId || '',
                    recoveryRetryAttempt:
                        Boolean(authorizedRetry),
                    timeoutMs: CONFIG.QUEUE_ACK_TIMEOUT_MS,
                    timeoutMessage:
                        `+${action.startLevel}→+${action.targetLevel} 等待新 action.id 超时`,
                    payload,
                });
                return promise;
            }
        );
        if (outcome.status === 'retry_authorized') {
            const slotReady = await waitForQuickQueueSlot(run);
            if (!slotReady) {
                throw new BatchError(
                    '本次恢复重发已获授权，但用户已停止继续发送',
                    'STOPPED'
                );
            }
            return sendEnhanceAndConfirm(
                run,
                itemId,
                action,
                mode,
                command
            );
        }
        return {
            ...outcome,
            fingerprint,
        };
    }

    function buildBatchPlan({forceFreshBaseItemIds = []} = {}) {
        Network.assertHookIntegrity();
        if (
            document.querySelector(
                '#dnm-en-wrapper, .dnm-en-float-btn, #easy20-enhance-btn, .easy20-component'
            )
        ) {
            throw new BatchError(
                '检测到 DelayNoMore/easy20 等其他强化脚本。'
                + '请先在脚本管理器中停用它们并刷新页面，避免 WebSocket 回执互相干扰'
            );
        }
        if (State.blockedReason) {
            throw new BatchError(
                `上次请求结果未知：${State.blockedReason}。请刷新页面重新同步`,
                'UNKNOWN'
            );
        }
        if (
            State.run?.active ||
            hasUnsettledRunTail(State.run) ||
            State.run?.marketFinalSweepPending ||
            State.run?.marketFinalSweepPhase ===
                'waiting_inventory' ||
            State.run?.marketFinalSweepPhase === 'running'
        ) {
            throw new BatchError(
                '已有批次正在运行或等待最后的队列/库存回执收束'
            );
        }
        if (State.pendingOp) {
            throw new BatchError('仍有请求正在等待回执');
        }
        if (State.marketOp || State.marketBusy) {
            throw new BatchError('市场维护仍有请求正在等待回执');
        }
        if (!State.socket || State.socket.readyState !== WebSocket.OPEN) {
            throw new BatchError('尚未连接游戏 WebSocket，请刷新游戏页面');
        }
        const missingInitialization = getMissingInitializationParts(
            State.settings.marketMaintenanceEnabled
        );
        if (missingInitialization.length > 0) {
            const cacheDetail = (
                State.settings.marketMaintenanceEnabled &&
                !State.clientMarketDataReady &&
                State.clientMarketDataCacheDetail
            )
                ? `。规则缓存诊断：${State.clientMarketDataCacheDetail}`
                : '';
            throw new BatchError(
                `初始化仍缺少：${missingInitialization.join('、')}`
                + cacheDetail
                + `。当前脚本版本 ${VERSION}`
            );
        }

        const characterId = getCharacterId();
        if (!characterId) {
            throw new BatchError('当前 URL 中没有 characterId');
        }
        if (!State.characterId || characterId !== State.characterId) {
            throw new BatchError(
                `页面角色 ${characterId} 与已同步角色 `
                + `${State.characterId || '未知'} 不一致`
            );
        }
        const enhancingLoadout = getEnhancingLoadoutBinding();
        const recoveryJournal =
            loadRecoveryJournal(characterId);
        if (recoveryJournal) {
            return hydrateRecoveryBatchPlan(
                recoveryJournal
            );
        }

        const itemIds = [...State.selected];
        if (itemIds.length === 0) {
            throw new BatchError('请至少选择一种装备');
        }
        if (itemIds.some((itemId) => itemId.endsWith('_refined'))) {
            throw new BatchError('安全版不支持精炼装备');
        }
        assertBeltEnhancementRules(itemIds);
        const loadoutTargetReservations =
            getLoadoutTargetReservations(
                itemIds,
                enhancingLoadout
            );

        const targetCount = parsePositiveInteger(
            State.settings.targetCount,
            '每种逐件处理数量',
            CONFIG.MAX_COUNT_INPUT
        );
        const marketMaxDropPercent =
            CONFIG.MARKET_DEFAULT_MAX_DROP_PERCENT;
        const marketItemRules = new Map();
        const coarseOutputs = itemIds.length * targetCount;
        if (coarseOutputs > CONFIG.MAX_TOTAL_OUTPUTS) {
            throw new BatchError(
                `${itemIds.length} 种 × ${targetCount} 件 = ${coarseOutputs} 件，`
                + `超过单批安全上限 ${CONFIG.MAX_TOTAL_OUTPUTS}`
            );
        }

        const enhancingActions = getEnhancingActions();
        const selectedSet = new Set(itemIds);
        const selectedQueueActions = enhancingActions.filter((action) => {
            const primary = parseItemHash(action?.primaryItemHash);
            return selectedSet.has(
                normalizeShortItemId(primary?.itemHrid)
            );
        });
        const currentQueuedItemIds = new Set(
            selectedQueueActions.map((action) => (
                normalizeShortItemId(
                    parseItemHash(action?.primaryItemHash)?.itemHrid
                )
            )).filter(Boolean)
        );
        for (const itemId of currentQueuedItemIds) {
            const projection = projectInventoryThroughEnhancingQueue(
                itemId,
                selectedQueueActions
            );
            const negativeLevel = projection.counts.findIndex(
                (count, level) => (
                    level <= CONFIG.TARGET_LEVEL &&
                    Number(count || 0) < 0
                )
            );
            if (negativeLevel >= 0) {
                throw new BatchError(
                    `${getItemName(itemId)} 的既有队列投影到队尾后 `
                    + `+${negativeLevel} 库存为负数；当前动作可能正处于`
                    + '库存与队列回执尚未同时到达的瞬间，请稍后重新预检',
                    'QUEUE_PROJECTION_PENDING'
                );
            }
        }

        const legacyAnalysis = null;
        const effectiveUseExistingInventory =
            State.settings.useExistingInventory;
        const freshBaseItemIds = new Set([
            ...(Array.isArray(forceFreshBaseItemIds)
                ? forceFreshBaseItemIds
                : []),
            ...currentQueuedItemIds,
        ].map(normalizeShortItemId).filter(
            (itemId) => selectedSet.has(itemId)
        ));
        const itemPlans = itemIds.map((itemId) => {
            const forceFreshBases = freshBaseItemIds.has(itemId);
            return {
                itemId,
                forceFreshBases,
                useExistingInventory:
                    effectiveUseExistingInventory &&
                    !forceFreshBases,
                baselineOutputCount: getItemCount(
                    itemId,
                    CONFIG.TARGET_LEVEL
                ),
                targetOutputs: targetCount,
                adoptedOutputCount: 0,
                adoptedCommandCount: 0,
                adoptedPartialCommandCount: 0,
                plan: Planner.planTo20(
                    getItemCounts(itemId),
                    targetCount,
                    effectiveUseExistingInventory &&
                        !forceFreshBases
                ),
            };
        });
        assertPlansPreserveLoadoutTargetReservations(
            itemPlans,
            loadoutTargetReservations
        );
        const summary = Planner.summarize(
            itemPlans,
            'quick'
        );
        Planner.validateSummary(summary);
        for (const entry of itemPlans) {
            if (entry.plan.purchaseItemCount > 0) getTesterPurchaseHrid(entry.itemId);
        }

        const mirrorInventory = getItemCount(PHILOSOPHERS_MIRROR, 0);
        const queuedMirrorCommitment =
            getQueuedEnhancingMirrorCommitment(enhancingActions);
        const mirrorAvailable = Math.max(
            0,
            mirrorInventory - queuedMirrorCommitment
        );
        const remainingMirrorCount = itemPlans.reduce(
            (sum, entry) => (
                sum + Number(entry.plan.mirrorCount || 0)
            ),
            0
        );
        if (mirrorAvailable < remainingMirrorCount) {
            throw new BatchError(
                `贤者镜不足：实体库存 ${formatInt(mirrorInventory)}，`
                + `现有强化队列尚需 ${formatInt(queuedMirrorCommitment)}，`
                + `本批可用 ${formatInt(mirrorAvailable)}，计划需要 `
                + `${formatInt(remainingMirrorCount)}`
            );
        }

        if (State.settings.mode === 'quick') {
            if (
                !Number.isFinite(State.actionQueueCap) ||
                State.actionQueueCap <= 0
            ) {
                throw new BatchError(
                    '尚未同步有效的动作队列容量，快排已保持禁用'
                );
            }
            const effectiveQueueSize =
                State.actions.size + getReservedExternalQueueSlots();
            if (effectiveQueueSize > State.actionQueueCap) {
                throw new BatchError(
                    `动作队列状态异常：已有/待确认 ${effectiveQueueSize} 条，`
                    + `但容量只有 ${State.actionQueueCap}`
                );
            }
        }

        const signature = JSON.stringify({
            characterId,
            actionQueueCap: State.actionQueueCap,
            enhancingLoadoutId: enhancingLoadout.id,
            enhancingLoadoutFingerprint:
                enhancingLoadout.fingerprint,
            loadoutTargetReservations,
            mode: State.settings.mode,
            useExistingInventory: effectiveUseExistingInventory,
            itemIds,
            targetCount,
            mirrorAvailable,
            plans: itemPlans.map(({
                itemId,
                forceFreshBases,
                plan,
            }) => ({
                itemId,
                forceFreshBases,
                purchases: plan.purchases,
                raw: plan.rawActions.map(
                    (action) => [
                        action.outputIndex,
                        action.startLevel,
                        action.targetLevel,
                    ]
                ),
                compressed: plan.compressedActions.map(
                    (action) => [
                        action.outputIndex,
                        action.startLevel,
                        action.targetLevel,
                    ]
                ),
                rawSegments: plan.rawOutputSegments.map(
                    (segment) => segment.map(
                        (action) => [
                            action.startLevel,
                            action.targetLevel,
                        ]
                    )
                ),
                compressedSegments:
                    plan.compressedOutputSegments.map(
                        (segment) => segment.map(
                            (action) => [
                                action.startLevel,
                                action.targetLevel,
                            ]
                        )
                    ),
            })),
        });

        return {
            characterId,
            itemIds,
            targetCount,
            mode: 'quick',
            useExistingInventory: effectiveUseExistingInventory,
            marketMaintenanceEnabled: false,
            marketMaxDropPercent:
                marketMaxDropPercent,
            marketItemRules,
            marketListingCap: State.marketListingCap,
            marketListingCount: State.myMarketListings.size,
            enhancingLoadout,
            loadoutTargetReservations,
            forceFreshBaseItemIds: [...freshBaseItemIds],
            itemPlans,
            summary,
            mirrorAvailable,
            mirrorInventory,
            queuedMirrorCommitment,
            queueCapacity: State.actionQueueCap,
            queueFreeSlots: Number.isFinite(State.actionQueueCap)
                ? Math.max(
                    0,
                    State.actionQueueCap -
                        State.actions.size -
                        getReservedExternalQueueSlots()
                )
                : null,
            legacyAdoption:
                legacyAnalysis?.legacyAdoption || null,
            signature,
        };
    }

    function buildConfirmationText(batchPlan) {
        const {summary} = batchPlan;
        const freshBasePlans = batchPlan.itemPlans.filter(
            (entry) => entry.forceFreshBases === true
        );
        const modeText = batchPlan.mode === 'verified'
            ? '验证慢排：每件 +20 经库存确认后再处理下一件'
            : '队尾快排：每件动作组完整入队后再排下一件（不等待产出）';
        const stockText = batchPlan.useExistingInventory
            ? (
                freshBasePlans.length > 0
                    ? '无同名旧队列的装备利用现有 +9～+19；'
                        + '已有同名旧队列的装备固定采购完整新基底'
                    : '利用现有 +9～+19，只采购缺口'
            )
            : '忽略现有装备库存，固定采购完整基底';

        const averageQuickDelay = (
            CONFIG.QUICK_DELAY_MIN_MS
            + CONFIG.QUICK_DELAY_MAX_MS
        ) / 2;
        const estimatedWait = batchPlan.mode === 'quick'
            ? (
                Math.max(0, summary.sendCommands - summary.itemTypes)
                * averageQuickDelay
                + Math.max(0, summary.itemTypes - 1) * CONFIG.ITEM_COOLDOWN_MS
            )
            : null;
        const highLevelConsumption = batchPlan.itemPlans
            .map(({itemId, plan}) => {
                const parts = [];
                for (let level = 15; level < CONFIG.TARGET_LEVEL; level++) {
                    const count = plan.consumedExisting[level] || 0;
                    if (count > 0) {
                        parts.push(`+${level}×${formatInt(count)}`);
                    }
                }
                return parts.length > 0
                    ? `${getItemName(itemId)} (${itemId})：${parts.join('，')}`
                    : '';
            })
            .filter(Boolean);
        return [
            '请核对本批次计划：',
            '',
            ...(batchPlan.isRecovery
                ? [
                    '恢复方式：读取刷新前已经持久保存的任务账本，'
                        + '已记录的 action.id 不会重复发送；'
                        + '没有唯一回执的第一个位置会先重发，确认后才继续。',
                    `账本已确认强化指令：${formatInt(
                        batchPlan.recoveryJournal?.acked?.length || 0
                    )}`,
                    `当前仍在队列中的本任务动作：${formatInt(
                        batchPlan.recovery?.presentOwned?.length || 0
                    )}`,
                    ...(batchPlan.recoveryPurchases?.length ? [
                        '采购恢复：旧单结果不作猜测，按当前库存、队尾占用和未入队计划只补缺口；发送前再次核对。',
                    ] : []),
                ]
                : []),
            ...(batchPlan.legacyAdoption
                ? [
                    '旧队列接管：当前队列来自没有持久账本的旧版脚本，'
                        + '本次必须显式确认后才会建立新账本。',
                    `将接管 ${formatInt(
                        batchPlan.legacyAdoption.actionCount
                    )} 条现有动作，其中 ${formatInt(
                        batchPlan.legacyAdoption.outputCount
                    )} 条已形成完整的 +20 收束，`
                        + '队尾未收束部分会作为当前半成品继续利用。',
                    batchPlan.legacyAdoption.warning,
                ]
                : []),
            `装备种类：${summary.itemTypes}`,
            `每种逐件目标：+20 ×${batchPlan.targetCount}`,
            `执行单位：每次 1 件，共 ${summary.outputs} 件`,
            '固定顺序：第 1 件所需动作全部达到本模式确认状态后，'
                + '才开始第 2 件；之后依次类推。',
            `模式：${modeText}`,
            `强化配装：${batchPlan.enhancingLoadout.name} `
                + `(ID ${batchPlan.enhancingLoadout.id})；`
                + '每条强化动作在入队时绑定，且已核对包含 '
                + 'Grandmaster Enhancing Charm',
            ...(batchPlan.loadoutTargetReservations?.length > 0
                ? batchPlan.loadoutTargetReservations.map(
                    (reservation) => (
                        `配装保留件：${getItemName(reservation.itemId)} `
                        + `+${reservation.enhancementLevel} ×`
                        + `${reservation.count}；本批规划不会消耗 +20`
                    )
                )
                : []),
            ...(freshBasePlans.length > 0
                ? [
                    '队列续排隔离：'
                        + freshBasePlans.map(
                            (entry) => getItemName(entry.itemId)
                        ).join('、')
                        + ' 已有同名强化动作；本批不复用它们可能'
                        + '消耗的库存，并按队尾投影确认新采购。',
                ]
                : []),
            `采购策略：${stockText}`,
            '市场职责：本脚本不会读取盘口、挂单、撤单、领取或用 +20 '
                + '库存核验产量；请由独立“+20 市场守价助手”维护。',
            `预计采购：+10 ×${formatInt(summary.purchaseHigh)}，`
                + `+9 ×${formatInt(summary.purchaseLow)}`,
            `预计消耗现有强化装备：${formatExistingConsumption(summary)}`,
            ...(highLevelConsumption.length > 0
                ? [
                    '其中 +15～+19 逐装备明细：',
                    ...highLevelConsumption,
                ]
                : []),
            `预计消耗贤者镜：${formatInt(summary.mirrorCount)}`,
            ...(Number(batchPlan.queuedMirrorCommitment || 0) > 0
                ? [
                    `现有强化队列预留贤者镜：${formatInt(
                        batchPlan.queuedMirrorCommitment
                    )}；本批可用 ${formatInt(batchPlan.mirrorAvailable)}`,
                ]
                : []),
            `预计发送强化指令：${formatInt(summary.sendCommands)}`,
            ...(batchPlan.mode === 'quick'
                ? [
                    `当前队列空位：${batchPlan.queueFreeSlots}`
                        + ` / ${batchPlan.queueCapacity}`,
                    '滚动背压：计划总指令可多于当前空位；队列连续满时'
                        + '最多等待 10 分钟，超时停止且不清除现有队列。',
                ]
                : []),
            estimatedWait == null
                ? '脚本耗时：取决于每一步实际强化完成时间'
                : `预计基础发包等待：约 ${formatDuration(estimatedWait)}`
                    + '（不含队列满时的等待）',
            '',
            '脚本不会自动清除现有队列。',
            '停止只会阻止后续发送；已经采购和已经入队的动作无法撤销。',
            '+11～+19 是当前成品必需的中间材料动作，仍会出现；'
                + '但不同成品的动作不会交叉穿插。',
            '队列助手只在全部冻结指令取得唯一 action.id 后清除任务账本；'
                + '刷新前最后一条若无法唯一确认，会保留同一计划位置并先重发，'
                + '取得 action.id 后才继续后续依赖动作。',
            '结束只代表全部动作已确认入队，不代表 +20 已经产出。',
        ].join('\n');
    }

    function formatExistingConsumption(summary) {
        const parts = [];
        for (
            let level = CONFIG.BASE_LOW;
            level < CONFIG.TARGET_LEVEL;
            level++
        ) {
            const count = summary.consumedExisting[level] || 0;
            if (count > 0) parts.push(`+${level}×${formatInt(count)}`);
        }
        return parts.length > 0 ? parts.join('，') : '无';
    }

    function confirmBatchPlan(batchPlan) {
        if (!window.confirm(buildConfirmationText(batchPlan))) return false;
        if (
            batchPlan.legacyAdoption &&
            (
                !batchPlan.isRecovery ||
                batchPlan.recoveryJournal?.status ===
                    'awaiting_confirmation'
            )
        ) {
            const expected =
                `接管${batchPlan.legacyAdoption.actionCount}`;
            const typed = window.prompt(
                `这是一次性接管旧队列。请输入“${expected}”继续：`
            );
            if (typed !== expected) {
                window.alert('输入不匹配，已取消旧队列接管');
                return false;
            }
        }
        if (
            !batchPlan.isRecovery &&
            batchPlan.summary.sendCommands >=
            CONFIG.LARGE_BATCH_COMMANDS
        ) {
            const expected = `确认${batchPlan.summary.sendCommands}`;
            const typed = window.prompt(
                `这是大批量操作。请输入“${expected}”继续：`
            );
            if (typed !== expected) {
                window.alert('输入不匹配，已取消批次');
                return false;
            }
        }
        return true;
    }

    async function waitForStateQuiescence(
        quietMilliseconds = 120,
        maximumMilliseconds = 1000
    ) {
        const startedAt = Date.now();
        let quietSince = startedAt;
        let previousRevision =
            `${State.connectionEpoch}:${State.syncEpoch}:`
            + `${State.inventoryRevision}:${State.queueRevision}:`
            + `${State.loadoutRevision}:`
            + `${State.characterItemsRevision}:`
            + `${State.outgoingQueueMutationRevision}`;

        while (Date.now() - startedAt < maximumMilliseconds) {
            await WorkSignals.wait(Math.max(1, Math.min(
                quietMilliseconds - (Date.now() - quietSince),
                maximumMilliseconds - (Date.now() - startedAt)
            )));
            const currentRevision =
                `${State.connectionEpoch}:${State.syncEpoch}:`
                + `${State.inventoryRevision}:${State.queueRevision}:`
                + `${State.loadoutRevision}:`
                + `${State.characterItemsRevision}:`
                + `${State.outgoingQueueMutationRevision}`;
            if (currentRevision !== previousRevision) {
                previousRevision = currentRevision;
                quietSince = Date.now();
                continue;
            }
            if (Date.now() - quietSince >= quietMilliseconds) return;
        }
    }

    function releaseQueuedRunMonitoring(run) {
        if (!run) return;
        if (run.ownedOrderValidationTimer) {
            window.clearTimeout(run.ownedOrderValidationTimer);
        }
        for (const pending of run.ownedRemovalPending?.values() || []) {
            if (pending?.timer) window.clearTimeout(pending.timer);
        }
        if (run.marketFinalSweepInventoryTimer) {
            window.clearTimeout(run.marketFinalSweepInventoryTimer);
        }
        run.ownedActionIds?.clear();
        run.ownedActionFingerprints?.clear();
        run.ownedActionProgressLevels?.clear();
        run.ownedCompatibleCompletions?.clear();
        run.completedOwnedActionIds?.clear();
        run.completedOwnedOutputActionIds?.clear();
        run.ownedRemovalPending?.clear();
        run.marketPostInventoryBarriers?.clear();
        run.ownedActionOrder = [];
        run.ownedOrderValidationPending = false;
        run.ownedOrderValidationTimer = null;
        run.ownedOrderValidationDueAt = null;
        run.ownedOrderValidationSignature = '';
        run.marketFinalSweepInventoryTimer = null;
        run.active = false;
        run.monitoringReleased = true;
        run.allOwnedActionsFinishedLogged = true;
    }

    function finalizeCompletelyAcknowledgedQueueRun(run) {
        const journal = run?.recoveryJournal;
        if (!journal || !isCompletelyAcknowledgedQueueJournal(journal)) {
            return false;
        }
        journal.status = 'commands_queued';
        saveRecoveryJournalCritical(journal);
        clearRecoveryJournalCritical(
            journal.jobId,
            journal.revision,
            'commands_queued'
        );
        run.recoveryJournal = null;
        // A stop click that races with the final exact acknowledgement cannot
        // turn an already-complete queue job back into a partial one.
        run.stopRequested = false;
        run.status = 'queued';
        releaseQueuedRunMonitoring(run);
        for (const result of run.results) {
            result.status = 'queued';
            result.error = '';
        }
        log(
            '批次完成：所有计划动作均已确认入队；'
            + '任务账本已清除，不等待产出、库存或市场状态',
            'success'
        );
        return true;
    }

    function readOldBatchForEnding(allowMissing = false) {
        let raw;
        let journal;
        try {
            raw = window.localStorage.getItem(STORAGE_KEYS.RECOVERY);
            journal = raw ? JSON.parse(raw) : null;
        } catch (error) {
            throw new BatchError(
                `无法读取旧批次记录：${error.message || String(error)}`,
                'RECOVERY_STORAGE_FAILED'
            );
        }
        if (!journal) {
            if (allowMissing) return null;
            throw new BatchError(
                '没有需要结束的旧批次记录；游戏里已入队的动作需在游戏队列中取消',
                'RECOVERY_INVALID'
            );
        }
        if (
            typeof journal !== 'object' || Array.isArray(journal) ||
            journal.schema !== RECOVERY_SCHEMA ||
            typeof journal.jobId !== 'string' || !journal.jobId ||
            !Array.isArray(journal.itemPlans) ||
            !Array.isArray(journal.acked) ||
            !Array.isArray(journal.adoptedActions)
        ) {
            throw new BatchError(
                '旧批次记录损坏或版本不兼容，无法自动结束；请保留记录排查',
                'RECOVERY_INVALID'
            );
        }
        return {raw, journal};
    }

    function assertOldBatchEndingContext(journal) {
        if (
            State.socket?.readyState !== WebSocket.OPEN ||
            !State.inventoryReady || !State.queueReady ||
            !State.loadoutsReady || !State.characterItemsReady
        ) {
            throw new BatchError(
                '请完整刷新并等待库存、配装和队列同步后，再结束旧批次记录',
                'NOT_READY'
            );
        }
        const characterId = getCharacterId();
        if (
            !characterId || State.characterId !== characterId ||
            journal.characterId !== characterId ||
            journal.host !== window.location.hostname
        ) {
            throw new BatchError(
                '旧批次属于其他站点或角色，请回到原角色核对后结束记录',
                'RECOVERY_CHARACTER_MISMATCH'
            );
        }
        if (
            (State.recoveryJournal &&
                State.recoveryJournal.jobId !== journal.jobId) ||
            (State.run?.recoveryJournal &&
                State.run.recoveryJournal.jobId !== journal.jobId) ||
            (State.run?.active &&
                (State.run.characterId !== characterId ||
                    State.run.recoveryJournal?.jobId !== journal.jobId))
        ) {
            throw new BatchError(
                '当前页面与持久批次记录不一致，请完整刷新后再核对',
                'RECOVERY_CONFLICT'
            );
        }
    }

    function assertOldBatchCanEnd(journal) {
        assertOldBatchEndingContext(journal);
        if (getReservedExternalQueueSlots()) {
            throw new BatchError(
                '还有入队请求等待游戏确认，请等回执到达后再结束旧批次记录',
                'QUEUE_REQUEST_PENDING'
            );
        }
        if (
            State.starting || State.run?.active || State.pendingOp ||
            State.marketOp || State.marketBusy ||
            State.pendingEnhancingLoadoutSaves > 0
        ) {
            throw new BatchError(
                '仍有批次或请求正在处理，请等待停止并完成同步后重试',
                'BUSY'
            );
        }
        const pending = journal.inFlight;
        if (pending != null) {
            const sentAt = Number(pending.sentAt);
            const hasSendTime = Number.isFinite(sentAt) && sentAt > 0;
            const sameRunSync = State.run?.recoveryJournal?.jobId ===
                journal.jobId && State.run.syncEpoch === State.syncEpoch;
            if (
                !(State.lastInitAt > 0) ||
                pending.syncMarker ===
                    `${RECOVERY_SESSION_ID}:${State.syncEpoch}` ||
                (hasSendTime && sentAt >= State.lastInitAt) ||
                (!hasSendTime && sameRunSync)
            ) {
                throw new BatchError(
                    '旧批次最后一笔请求尚需新的完整同步；'
                    + '请完整刷新并等待同步后再结束记录',
                    'RECOVERY_NEEDS_SYNC'
                );
            }
        }
    }

    const Controller = {
        async endOldBatch() {
            if (State.endingOldBatch) {
                throw new BatchError('正在结束旧批次记录，请稍候', 'BUSY');
            }
            const initial = readOldBatchForEnding();
            assertOldBatchEndingContext(initial.journal);
            if (State.starting) {
                throw new BatchError('正在启动预检，请等本次预检结束后再结束旧记录', 'BUSY');
            }
            const connectionEpoch = State.connectionEpoch;
            const syncEpoch = State.syncEpoch;
            const stoppingRun = State.run?.active ? State.run : null;
            State.endingOldBatch = true;
            State.ui?.setLocked(true);
            scheduleUiRefresh();
            let releaseSharedLane;
            try {
                if (stoppingRun) {
                    Controller.stop();
                    const deadline = Date.now() + CONFIG.PURCHASE_TIMEOUT_MS
                        + CONFIG.QUEUE_ACK_TIMEOUT_MS + 1000;
                    while (stoppingRun.active) {
                        if (State.run !== stoppingRun ||
                            State.connectionEpoch !== connectionEpoch ||
                            State.syncEpoch !== syncEpoch) {
                            throw new BatchError(
                                '停止期间批次或连接发生变化；旧记录保留，请重新核对',
                                'RECOVERY_CONFLICT'
                            );
                        }
                        if (Date.now() >= deadline) {
                            throw new BatchError(
                                '已请求停止，但当前请求尚未结束；旧记录保留，'
                                + '请等待回执或完整刷新后再试',
                                'BUSY'
                            );
                        }
                        await WorkSignals.wait(Math.max(1, deadline - Date.now()));
                    }
                }
                if (State.connectionEpoch !== connectionEpoch ||
                    State.syncEpoch !== syncEpoch) {
                    throw new BatchError('停止期间连接或同步发生变化，请重新核对', 'RECOVERY_CONFLICT');
                }
                // A final exact ACK can finish the entire batch while stopping.
                // It may already have cleared the journal by normal completion.
                const snapshot = readOldBatchForEnding(true);
                if (!snapshot) {
                    if (stoppingRun?.status === 'queued' &&
                        !stoppingRun.recoveryJournal && !State.pendingOp) {
                        log('本批全部指令已确认入队，已无待续排记录；游戏队列保留', 'success');
                        return true;
                    }
                    throw new BatchError('旧批次记录已变化，请重新核对', 'RECOVERY_CONFLICT');
                }
                if (snapshot.journal.jobId !== initial.journal.jobId) {
                    throw new BatchError('停止期间已换成其他批次，拒绝结束新记录', 'RECOVERY_CONFLICT');
                }
                assertOldBatchCanEnd(snapshot.journal);
                await waitForStateQuiescence();
                releaseSharedLane = await SharedAutomation.acquire(
                    'enhancer:end-old-batch'
                );
                const current = readOldBatchForEnding();
                if (
                    State.connectionEpoch !== connectionEpoch ||
                    State.syncEpoch !== syncEpoch ||
                    current.raw !== snapshot.raw
                ) {
                    throw new BatchError(
                        '核对期间连接或旧批次记录发生变化，本次未结束记录，请重新核对',
                        'RECOVERY_CONFLICT'
                    );
                }
                assertOldBatchCanEnd(current.journal);
                // Archive first. Failed storage must never discard the active
                // journal. The shared lane serializes only this page's helpers.
                writeJsonStorageCritical(STORAGE_KEYS.RECOVERY_ARCHIVE, {
                    endedAt: Date.now(),
                    scriptVersion: VERSION,
                    journal: current.journal,
                });
                clearRecoveryJournalCritical(
                    current.journal.jobId,
                    current.journal.revision,
                    current.journal.status
                );
                const oldRun = State.run;
                releaseQueuedRunMonitoring(oldRun);
                if (oldRun) oldRun.recoveryJournal = null;
                State.run = null;
                UI.lastPlanPreviewKey = '';
                log(
                    '旧批次记录已备份并结束，不再续排；游戏中已有动作继续执行，'
                    + '库存、预设和设置保留。'
                    + '请核对本次新增目标数量，再按当前配装重新预检',
                    'success'
                );
                return true;
            } finally {
                releaseSharedLane?.();
                State.endingOldBatch = false;
                State.ui?.setLocked(Boolean(State.starting || State.run?.active));
                scheduleUiRefresh();
            }
        },

        async start() {
            if (State.starting || State.endingOldBatch) return;

            let preview;
            try {
                preview = buildBatchPlan();
            } catch (error) {
                window.alert(error.message || String(error));
                return;
            }
            let provisionalJournal = null;
            if (
                preview.mode === 'quick' &&
                preview.legacyAdoption &&
                !preview.recoveryJournal
            ) {
                try {
                    provisionalJournal = createRecoveryJournal(
                        preview,
                        'awaiting_confirmation'
                    );
                    saveRecoveryJournalCritical(
                        provisionalJournal
                    );
                } catch (error) {
                    window.alert(
                        '无法在确认前保存旧队列接管账本；'
                        + `本次不会发送：\n${error.message || String(error)}`
                    );
                    return;
                }
            }
            if (!confirmBatchPlan(preview)) {
                const cancellableJournal =
                    provisionalJournal ||
                    (
                        preview.recoveryJournal?.status ===
                            'awaiting_confirmation'
                            ? preview.recoveryJournal
                            : null
                    );
                if (cancellableJournal) {
                    try {
                        clearRecoveryJournalCritical(
                            cancellableJournal.jobId,
                            cancellableJournal.revision,
                            'awaiting_confirmation'
                        );
                    } catch (error) {
                        window.alert(
                            '取消成功，但临时接管账本无法删除：\n'
                            + `${error.message || String(error)}`
                        );
                    }
                }
                return;
            }

            State.starting = true;
            State.ui?.setLocked(true);
            scheduleUiRefresh();

            // Native modal dialogs block this JavaScript task while network
            // messages may queue up. Let those messages apply before the
            // second plan/signature check.
            let batchPlan;
            try {
                await waitForStateQuiescence();
                batchPlan = buildBatchPlan({
                    forceFreshBaseItemIds:
                        preview.forceFreshBaseItemIds || [],
                });
                if (batchPlan.signature !== preview.signature) {
                    throw new BatchError(
                        '确认期间与冻结计划有关的库存、配装或队列承诺'
                        + '发生变化。普通队列自然完成不会触发此检查',
                        'STATE_CHANGED'
                    );
                }
                if (batchPlan.mode === 'quick') {
                    let journal = batchPlan.recoveryJournal;
                    if (!journal) {
                        journal = createRecoveryJournal(
                            batchPlan,
                            'running'
                        );
                        saveRecoveryJournalCritical(journal);
                        batchPlan.recoveryJournal = journal;
                        batchPlan.recovery = {
                            commands: enumeratePlanCommands(
                                journal.itemPlans,
                                journal.mode
                            ),
                            presentOwned: [],
                            orderedRecords: [],
                        };
                    } else {
                        journal.status = 'running';
                        saveRecoveryJournalCritical(journal);
                    }
                }
            } catch (error) {
                window.alert(
                    `启动前安全核对未通过：\n${error.message}`
                    + (
                        provisionalJournal
                            ? '\n旧队列接管账本已经保留；刷新后可再次核对并续排。'
                            : ''
                    )
                );
                State.starting = false;
                State.ui?.setLocked(false);
                scheduleUiRefresh();
                return;
            }

            State.settings.targetCount = batchPlan.targetCount;
            saveSettings();

            const run = {
                id: ++State.nextRunId,
                active: true,
                status: 'running',
                mode: batchPlan.mode,
                useExistingInventory: batchPlan.useExistingInventory,
                marketMaintenanceEnabled:
                    batchPlan.marketMaintenanceEnabled,
                marketMaxDropPercent:
                    batchPlan.marketMaxDropPercent,
                marketItemRules: new Map(
                    [...batchPlan.marketItemRules.entries()].map(
                        ([itemId, rule]) => [
                            itemId,
                            {...rule},
                        ]
                    )
                ),
                characterId: batchPlan.characterId,
                itemIds: [...batchPlan.itemIds],
                enhancingLoadoutId:
                    batchPlan.enhancingLoadout.id,
                enhancingLoadoutFingerprint:
                    batchPlan.enhancingLoadout.fingerprint,
                enhancingLoadoutReservedItemHrids: [
                    ...batchPlan.enhancingLoadout.reservedItemHrids,
                ],
                loadoutTargetReservations: cloneJsonValue(
                    batchPlan.loadoutTargetReservations || []
                ),
                recoveryJournal:
                    batchPlan.recoveryJournal || null,
                syncEpoch: State.syncEpoch,
                startedAt: Date.now(),
                endedAt: null,
                stopRequested: false,
                interferenceDetected: false,
                ownedActionIds: new Set(),
                ownedActionFingerprints: new Map(),
                ownedActionProgressLevels: new Map(),
                ownedCompatibleCompletions: new Map(),
                ownedActionOrder: [],
                completedOwnedActionIds: new Set(),
                completedOwnedOutputActionIds: new Set(),
                completedOwnedOutputCounts: new Map(),
                ownedRemovalPending: new Map(),
                ownedOrderValidationPending: false,
                ownedOrderValidationTimer: null,
                integrityFailure: '',
                queueWarning: '',
                allOwnedActionsFinishedLogged: false,
                allowedExternalTypes: new Set(),
                marketInventoryOffsets: new Map(
                    Object.entries(
                        batchPlan.recoveryJournal
                            ?.marketInventoryOffsets || {}
                    ).map(([itemId, count]) => [
                        itemId,
                        Number(count),
                    ])
                ),
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
                summary: batchPlan.summary,
                confirmedCommands:
                    batchPlan.itemPlans.reduce(
                        (sum, entry) => (
                            sum +
                            Number(
                                entry.adoptedCommandCount || 0
                            )
                        ),
                        0
                    ),
                confirmedOutputs:
                    batchPlan.itemPlans.reduce(
                        (sum, entry) => (
                            sum +
                            Number(
                                entry.adoptedOutputCount || 0
                            )
                        ),
                        0
                    ),
                confirmedPurchases: 0,
                currentItemId: null,
                currentStage: '启动预检',
                currentCommand: 0,
                currentCommandTotal: 0,
                currentOutput: 0,
                currentOutputTotal: 0,
                currentOutputCommand: 0,
                currentOutputCommandTotal: 0,
                results: batchPlan.itemPlans.map((entry) => ({
                    itemId: entry.itemId,
                    status: 'pending',
                    confirmedCommands:
                        Number(
                            entry.adoptedCommandCount || 0
                        ),
                    baselineOutputCount: entry.baselineOutputCount,
                    targetOutputs: Number(
                        entry.targetOutputs ??
                            entry.plan.targetCount
                    ),
                    confirmedOutputs:
                        Number(
                            entry.adoptedOutputCount || 0
                        ),
                    error: '',
                })),
                error: '',
            };
            State.starting = false;
            State.run = run;
            const recoveryCommands =
                batchPlan.recovery?.commands ||
                enumeratePlanCommands(
                    batchPlan.itemPlans,
                    batchPlan.mode
                );
            run.recoveryCommands = recoveryCommands;
            run.recoveryCommandByKey = new Map(
                recoveryCommands.map((command) => [
                    command.commandKey,
                    command,
                ])
            );
            run.ackedCommandKeys = new Set(
                (run.recoveryJournal?.acked || []).map(
                    (record) => record.commandKey
                )
            );

            State.ui?.setLocked(true);
            scheduleUiRefresh();

            log(
                `批次启动：${batchPlan.summary.itemTypes} 种装备，`
                + `${batchPlan.summary.outputs} 件新 +20，`
                + `${batchPlan.summary.sendCommands} 条强化指令；`
                + '按成品逐件执行',
                'success'
            );

            try {
                for (
                    let itemIndex = 0;
                    itemIndex < batchPlan.itemPlans.length;
                    itemIndex++
                ) {
                    if (run.stopRequested) break;
                    const entry = batchPlan.itemPlans[itemIndex];
                    const result = run.results[itemIndex];
                    const {itemId, plan} = entry;
                    const adoptedCommandCount =
                        Number(entry.adoptedCommandCount || 0);
                    const adoptedOutputCount =
                        Number(entry.adoptedOutputCount || 0);
                    const totalTargetOutputs = Number(
                        entry.targetOutputs ?? plan.targetCount
                    );
                    run.currentItemId = itemId;
                    result.status = 'purchasing';
                    run.currentStage = '采购并核验基底';
                    run.currentCommand = adoptedCommandCount;
                    run.currentCommandTotal =
                        adoptedCommandCount +
                        (run.mode === 'verified'
                        ? plan.rawActions.length
                        : plan.compressedActions.length);
                    run.currentOutput = adoptedOutputCount;
                    run.currentOutputTotal = totalTargetOutputs;
                    scheduleUiRefresh();

                    const highPurchase = await purchaseAndConfirm(
                        run,
                        itemId,
                        CONFIG.BASE_HIGH,
                        plan.purchases[CONFIG.BASE_HIGH]
                    );
                    run.confirmedPurchases += highPurchase?.purchasedCount || 0;

                    if (
                        highPurchase?.purchasedCount > 0 &&
                        (plan.purchases[CONFIG.BASE_LOW] > 0 ||
                            run.recoveryJournal?.purchases[`${itemId}:${CONFIG.BASE_LOW}`]?.recoveryStock)
                    ) {
                        const continued = await sleepRandom(
                            CONFIG.PURCHASE_GAP_MIN_MS,
                            CONFIG.PURCHASE_GAP_MAX_MS,
                            run
                        );
                        if (!continued) break;
                    }

                    const lowPurchase = await purchaseAndConfirm(
                        run,
                        itemId,
                        CONFIG.BASE_LOW,
                        plan.purchases[CONFIG.BASE_LOW]
                    );
                    run.confirmedPurchases += lowPurchase?.purchasedCount || 0;
                    if (run.stopRequested) break;

                    const outputSegments = run.mode === 'verified'
                        ? plan.rawOutputSegments
                        : plan.compressedOutputSegments;
                    const actions = outputSegments.flat();
                    result.status = run.mode === 'verified'
                        ? 'executing'
                        : 'queueing';
                    run.currentStage = run.mode === 'verified'
                        ? '逐件执行：本件确认 +20 后再做下一件'
                        : '逐件入队：本件动作组入队后再排下一件';
                    scheduleUiRefresh();

                    let itemCommandIndex = adoptedCommandCount;
                    for (
                        let outputIndex = 0;
                        outputIndex < outputSegments.length;
                        outputIndex++
                    ) {
                        if (run.stopRequested) break;
                        const segment = outputSegments[outputIndex];
                        const segmentBaseline =
                            getRunAdjustedOutputCount(
                                run,
                                itemId
                        );
                        const displayedOutputIndex =
                            adoptedOutputCount +
                            outputIndex + 1;
                        run.currentOutput = displayedOutputIndex;
                        run.currentOutputCommand = 0;
                        run.currentOutputCommandTotal = segment.length;
                        scheduleUiRefresh();

                        let segmentConfirmedCommands = 0;
                        let segmentSentCommands = 0;
                        for (
                            let segmentActionIndex = 0;
                            segmentActionIndex < segment.length;
                            segmentActionIndex++
                        ) {
                            if (run.stopRequested) break;
                            const action = segment[segmentActionIndex];
                            const commandKey =
                                `${itemIndex}:${outputIndex}:`
                                + `${segmentActionIndex}`;
                            const command =
                                run.recoveryCommandByKey.get(
                                    commandKey
                                );
                            if (!command) {
                                throw new BatchError(
                                    `冻结计划缺少指令 ${commandKey}`,
                                    'RECOVERY_INVALID'
                                );
                            }
                            const alreadyAcknowledged =
                                run.ackedCommandKeys.has(
                                    commandKey
                                );
                            if (
                                run.mode === 'quick' &&
                                !alreadyAcknowledged
                            ) {
                                const slotReady =
                                    await waitForQuickQueueSlot(run);
                                if (!slotReady) break;
                                run.currentStage =
                                    '逐件入队：本件动作组入队后再排下一件';
                            }
                            itemCommandIndex++;
                            run.currentCommand = itemCommandIndex;
                            run.currentOutputCommand =
                                segmentActionIndex + 1;
                            scheduleUiRefresh();

                            if (!alreadyAcknowledged) {
                                const actionOutcome =
                                    await sendEnhanceAndConfirm(
                                        run,
                                        itemId,
                                        action,
                                        run.mode,
                                        command
                                    );
                                const ownedActionId = normalizeActionId(
                                    actionOutcome?.actionId
                                );
                                if (!ownedActionId) {
                                    throw new BatchError(
                                        '强化动作已确认但缺少可记录的 action.id',
                                        'UNKNOWN'
                                    );
                                }
                                run.ackedCommandKeys.add(
                                    commandKey
                                );
                                segmentSentCommands++;
                            }
                            run.confirmedCommands++;
                            result.confirmedCommands++;
                            segmentConfirmedCommands++;

                            if (
                                itemCommandIndex === 1 ||
                                itemCommandIndex % 10 === 0
                            ) {
                                log(
                                    `${getItemName(itemId)}：`
                                    + `第 ${displayedOutputIndex}/`
                                    + `${totalTargetOutputs} 件，`
                                    + `${alreadyAcknowledged
                                        ? '已从账本确认'
                                        : (
                                            run.mode === 'verified'
                                                ? '已验证'
                                                : '已入队'
                                        )} `
                                    + `${segmentActionIndex + 1}/${segment.length}，`
                                    + `+${action.startLevel}→+${action.targetLevel}`
                                );
                            }

                            if (
                                !alreadyAcknowledged &&
                                segmentActionIndex + 1 <
                                segment.length
                            ) {
                                const continued = await sleepRandom(
                                    run.mode === 'verified'
                                        ? CONFIG.VERIFIED_DELAY_MIN_MS
                                        : CONFIG.QUICK_DELAY_MIN_MS,
                                    run.mode === 'verified'
                                        ? CONFIG.VERIFIED_DELAY_MAX_MS
                                        : CONFIG.QUICK_DELAY_MAX_MS,
                                    run
                                );
                                if (!continued) break;
                            }
                        }

                        // A stop during a partial segment must not count as one
                        // completed output. If the final acknowledgement won
                        // the race with the stop click, the closed segment is
                        // still safe to count before stopping.
                        if (segmentConfirmedCommands !== segment.length) break;

                        const lastAction = segment[segment.length - 1];
                        if (
                            !lastAction ||
                            lastAction.outputIndex !== outputIndex ||
                            segment.some(
                                (action) => (
                                    action.outputIndex !== outputIndex
                                )
                            ) ||
                            lastAction.targetLevel !==
                                CONFIG.TARGET_LEVEL ||
                            segment.slice(0, -1).some(
                                (action) => (
                                    action.targetLevel ===
                                    CONFIG.TARGET_LEVEL
                                )
                            )
                        ) {
                            throw new BatchError(
                                `第 ${outputIndex + 1} 件动作组没有独立收束到 +20`,
                                'PLAN_ORDER_INVALID'
                            );
                        }

                        const currentOutputCount =
                            getRunAdjustedOutputCount(
                                run,
                                itemId
                        );
                        if (
                            run.mode === 'verified' &&
                            currentOutputCount !== segmentBaseline + 1
                        ) {
                            throw new BatchError(
                                `${getItemName(itemId)} 第 ${outputIndex + 1} 件`
                                + `完成后 +20 库存为 ${currentOutputCount}，`
                                + `预期 ${segmentBaseline + 1}`,
                                'VERIFY_FAILED'
                            );
                        }

                        result.confirmedOutputs++;
                        run.confirmedOutputs++;
                        log(
                            run.mode === 'verified'
                                ? `${getItemName(itemId)}：第 `
                                    + `${result.confirmedOutputs}/`
                                    + `${totalTargetOutputs} 件 `
                                    + `+20 已确认（库存 ${segmentBaseline}`
                                    + `→${currentOutputCount}）`
                                : `${getItemName(itemId)}：第 `
                                    + `${result.confirmedOutputs}/`
                                    + `${totalTargetOutputs} 件`
                                    + '所需动作已全部确认入队（尚未确认产出）',
                            'success'
                        );
                        scheduleUiRefresh();

                        if (run.stopRequested) break;
                        if (
                            segmentSentCommands > 0 &&
                            outputIndex + 1 < outputSegments.length
                        ) {
                            const continued = await sleepRandom(
                                run.mode === 'verified'
                                    ? CONFIG.VERIFIED_DELAY_MIN_MS
                                    : CONFIG.QUICK_DELAY_MIN_MS,
                                run.mode === 'verified'
                                    ? CONFIG.VERIFIED_DELAY_MAX_MS
                                    : CONFIG.QUICK_DELAY_MAX_MS,
                                run
                            );
                            if (!continued) break;
                        }
                    }

                    if (run.stopRequested) {
                        result.status = 'stopped';
                        break;
                    }

                    if (run.mode === 'verified') {
                        if (
                            result.confirmedOutputs !==
                                totalTargetOutputs
                        ) {
                            throw new BatchError(
                                `${getItemName(itemId)} 仅逐件确认 `
                                + `${result.confirmedOutputs}/`
                                + `${totalTargetOutputs} 件`,
                                'VERIFY_FAILED'
                            );
                        }
                        const expectedOutput =
                            entry.baselineOutputCount +
                            totalTargetOutputs;
                        const currentOutput =
                            getRunAdjustedOutputCount(
                                run,
                                itemId
                        );
                        if (currentOutput !== expectedOutput) {
                            throw new BatchError(
                                `${getItemName(itemId)} 的 +20 库存为 `
                                + `${currentOutput}，预期必须恰好为 ${expectedOutput}`,
                                'VERIFY_FAILED'
                            );
                        }
                        result.status = 'completed';
                        log(
                            `${getItemName(itemId)}：逐件完成 `
                            + `${result.confirmedOutputs}/`
                            + `${totalTargetOutputs} 件 +20`,
                            'success'
                        );
                    } else {
                        if (
                            result.confirmedOutputs !==
                                totalTargetOutputs
                        ) {
                            throw new BatchError(
                                `${getItemName(itemId)} 仅逐件入队 `
                                + `${result.confirmedOutputs}/`
                                + `${totalTargetOutputs} 件`,
                                'INCOMPLETE'
                            );
                        }
                        result.status = 'queued';
                        log(
                            `${getItemName(itemId)}：逐件动作组已入队 `
                            + `${result.confirmedOutputs}/`
                            + `${totalTargetOutputs} 件`
                            + `（本次计划 ${actions.length} 条，`
                            + `已接管 ${adoptedCommandCount} 条）`,
                            'success'
                        );
                    }

                    if (
                        itemIndex + 1 < batchPlan.itemPlans.length &&
                        !run.stopRequested
                    ) {
                        run.currentStage = '装备间冷却';
                        scheduleUiRefresh();
                        const continued = await sleepFor(
                            CONFIG.ITEM_COOLDOWN_MS,
                            run
                        );
                        if (!continued) break;
                    }
                }

                const queueJournalComplete = Boolean(
                    run.mode === 'quick' &&
                    run.recoveryJournal &&
                    isCompletelyAcknowledgedQueueJournal(
                        run.recoveryJournal
                    )
                );
                if (queueJournalComplete) {
                    finalizeCompletelyAcknowledgedQueueRun(run);
                } else if (run.stopRequested) {
                    run.status = 'stopped';
                    log(
                        '已停止继续发送；游戏中已入队的动作仍会继续执行',
                        'warn'
                    );
                } else {
                    const expectedStatus = run.mode === 'verified'
                        ? 'completed'
                        : 'queued';
                    const allConfirmed = run.results.every(
                        (result) => result.status === expectedStatus
                    );
                    if (!allConfirmed) {
                        throw new BatchError(
                            '并非所有装备都达到确认状态',
                            'INCOMPLETE'
                        );
                    }
                    if (run.recoveryJournal) {
                        if (!finalizeCompletelyAcknowledgedQueueRun(run)) {
                            throw new BatchError(
                                '持久任务账本尚有未处理的计划位置，'
                                + '不能结束本批次',
                                'INCOMPLETE'
                            );
                        }
                    } else {
                        run.status = 'queued';
                        releaseQueuedRunMonitoring(run);
                        log(
                            '批次完成：所有计划动作均已确认入队；'
                            + '不等待产出、库存或市场状态',
                            'success'
                        );
                    }
                }
            } catch (error) {
                run.error = error.message || String(error);
                run.stopRequested = true;
                run.status = error.code === 'UNKNOWN'
                    ? 'unknown'
                    : error.code === 'STOPPED'
                        ? 'stopped'
                        : 'failed';

                const currentResult = run.results.find(
                    (result) => result.itemId === run.currentItemId
                );
                if (currentResult) {
                    currentResult.status = run.status;
                    currentResult.error = run.error;
                }
                log(`批次停止：${run.error}`, 'error');
            } finally {
                run.active = false;
                WorkSignals.notify();
                run.endedAt = Date.now();
                if (
                    !run.stopRequested &&
                    !run.integrityFailure &&
                    ['completed', 'queued'].includes(run.status)
                ) {
                    run.currentStage =
                        '全部计划动作已确认入队；已释放，可选择其他装备开始新批次';
                    run.marketFinalSweepPhase = 'completed';
                    State.ui?.setLocked(false);
                } else {
                    run.currentStage = '已结束';
                    run.marketFinalSweepPhase = 'aborted';
                    State.ui?.setLocked(false);
                }
                scheduleUiRefresh();
            }
        },

        stop() {
            WorkSignals.notify();
            const run = State.run;
            if (
                !run ||
                !run.active ||
                run.stopRequested
            ) {
                return;
            }
            run.stopRequested = true;
            run.currentStage = State.pendingOp
                ? '停止已请求，等待当前强化请求取得确定回执'
                : '停止已请求';
            log(
                '收到停止请求：不会再发送新的采购或强化指令；'
                + '当前已发送请求仍会等待确定回执',
                'warn'
            );
            scheduleUiRefresh();
        },
    };

    const UI = {
        shadow: null,
        refs: {},
        visibleItemIds: [],
        locked: false,
        lastItemRenderKey: '',
        lastPlanPreviewKey: '',

        async init() {
            const body = await waitForDocumentBody();
            const host = document.createElement('div');
            host.id = 'mwi-safe-enhancer-host';
            const shadow = host.attachShadow({mode: 'open'});
            UI.shadow = shadow;
            shadow.innerHTML = `
                <style>
                    :host {
                        all: initial;
                        color-scheme: dark;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                            "PingFang SC", "Microsoft YaHei", sans-serif;
                    }
                    *, *::before, *::after { box-sizing: border-box; }
                    button, input, select { font: inherit; }
                    button { cursor: pointer; }
                    button:disabled, input:disabled, select:disabled {
                        cursor: not-allowed;
                        opacity: .55;
                    }
                    #fab {
                        position: fixed;
                        top: 76px;
                        right: 0;
                        z-index: 2147483000;
                        border: 1px solid #38bdf8;
                        border-right: 0;
                        border-radius: 22px 0 0 22px;
                        padding: 9px 14px;
                        color: #e0f2fe;
                        background: linear-gradient(135deg, #0f172a, #164e63);
                        box-shadow: 0 8px 24px rgba(0,0,0,.45);
                    }
                    #fab.running::after {
                        content: "";
                        display: inline-block;
                        width: 8px;
                        height: 8px;
                        margin-left: 7px;
                        border-radius: 50%;
                        background: #f43f5e;
                        box-shadow: 0 0 8px #f43f5e;
                    }
                    #panel {
                        position: fixed;
                        inset: 50% auto auto 50%;
                        transform: translate(-50%, -50%);
                        z-index: 2147483001;
                        width: min(1040px, 96vw);
                        height: min(880px, 94vh);
                        display: none;
                        overflow: auto;
                        color: #e2e8f0;
                        background: #08111f;
                        border: 1px solid #334155;
                        border-radius: 14px;
                        box-shadow: 0 24px 80px rgba(0,0,0,.72);
                    }
                    #panel.open { display: flex; flex-direction: column; }
                    .header {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 13px 16px;
                        background: #0f172a;
                        border-bottom: 1px solid #334155;
                    }
                    .header h2 {
                        margin: 0;
                        font-size: 18px;
                        color: #7dd3fc;
                    }
                    .header .version { color: #64748b; font-size: 12px; }
                    .spacer { flex: 1; }
                    .icon-btn {
                        width: 30px;
                        height: 30px;
                        border: 0;
                        border-radius: 7px;
                        color: #cbd5e1;
                        background: #1e293b;
                    }
                    .status-strip {
                        display: flex;
                        align-items: center;
                        flex-wrap: wrap;
                        gap: 8px;
                        padding: 9px 16px;
                        border-bottom: 1px solid #1e293b;
                        background: #0b1424;
                    }
                    .badge {
                        padding: 4px 8px;
                        border-radius: 999px;
                        font-size: 12px;
                        color: #cbd5e1;
                        background: #1e293b;
                        border: 1px solid #334155;
                    }
                    .badge.ok { color: #86efac; border-color: #166534; }
                    .badge.warn { color: #fde68a; border-color: #854d0e; }
                    .badge.error { color: #fda4af; border-color: #9f1239; }
                    #blocked {
                        display: none;
                        padding: 8px 16px;
                        color: #fecdd3;
                        background: #4c0519;
                        border-bottom: 1px solid #9f1239;
                        font-size: 13px;
                    }
                    #blocked.show { display: block; }
                    .layout {
                        flex: 1;
                        min-height: 0;
                        display: grid;
                        grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr);
                        gap: 12px;
                        padding: 12px;
                    }
                    .card {
                        min-height: 0;
                        padding: 12px;
                        border: 1px solid #263449;
                        border-radius: 10px;
                        background: #0f172a;
                    }
                    .left, .right {
                        min-height: 0;
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                    }
                    .section-title {
                        margin: 0;
                        font-size: 13px;
                        color: #94a3b8;
                        text-transform: uppercase;
                        letter-spacing: .05em;
                    }
                    .row {
                        display: flex;
                        align-items: center;
                        flex-wrap: wrap;
                        gap: 8px;
                    }
                    .control {
                        min-height: 34px;
                        border: 1px solid #334155;
                        border-radius: 7px;
                        color: #e2e8f0;
                        background: #111c2f;
                        padding: 7px 9px;
                    }
                    .control:focus { outline: 1px solid #38bdf8; }
                    .radio-card {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        padding: 7px 9px;
                        border: 1px solid #334155;
                        border-radius: 7px;
                        background: #111c2f;
                        font-size: 13px;
                    }
                    .hint {
                        color: #64748b;
                        font-size: 12px;
                        line-height: 1.45;
                    }
                    .btn {
                        min-height: 34px;
                        border: 1px solid #334155;
                        border-radius: 7px;
                        padding: 7px 10px;
                        color: #e2e8f0;
                        background: #1e293b;
                    }
                    .btn.primary {
                        color: white;
                        border-color: #0369a1;
                        background: #0369a1;
                    }
                    .btn.success {
                        color: white;
                        border-color: #047857;
                        background: #047857;
                    }
                    .btn.danger {
                        color: white;
                        border-color: #be123c;
                        background: #be123c;
                    }
                    .btn.small { min-height: 30px; padding: 5px 8px; font-size: 12px; }
                    .search { flex: 1; min-width: 180px; }
                    #item-list {
                        flex: 1;
                        min-height: 260px;
                        overflow: auto;
                        border: 1px solid #263449;
                        border-radius: 8px;
                        background: #08111f;
                    }
                    .item {
                        display: grid;
                        grid-template-columns: auto minmax(0, 1fr) auto;
                        gap: 9px;
                        align-items: center;
                        padding: 8px 10px;
                        border-bottom: 1px solid #17243a;
                        cursor: pointer;
                    }
                    .item:last-child { border-bottom: 0; }
                    .item:hover { background: #111c2f; }
                    .item.selected { background: #0c3045; }
                    .item input { width: 16px; height: 16px; accent-color: #0ea5e9; }
                    .item-name {
                        min-width: 0;
                        overflow: hidden;
                        white-space: nowrap;
                        text-overflow: ellipsis;
                        font-size: 13px;
                    }
                    .item-id {
                        display: block;
                        color: #64748b;
                        font-size: 10px;
                        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                    }
                    .counts {
                        color: #cbd5e1;
                        font-size: 11px;
                        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                        white-space: pre;
                        text-align: right;
                    }
                    #market-detail {
                        margin-top: 7px;
                        max-height: 92px;
                        overflow: auto;
                        padding: 7px 8px;
                        border: 1px solid #263449;
                        border-radius: 7px;
                        color: #94a3b8;
                        background: #08111f;
                        font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
                        white-space: pre-wrap;
                    }
                    #plan-preview {
                        padding: 9px 10px;
                        border-radius: 8px;
                        color: #bae6fd;
                        background: #0c2d42;
                        border: 1px solid #164e63;
                        font-size: 12px;
                        line-height: 1.55;
                        white-space: pre-wrap;
                    }
                    #plan-preview.error {
                        color: #fecdd3;
                        background: #3f0b18;
                        border-color: #881337;
                    }
                    .action-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
                    #run-box {
                        min-height: 142px;
                        padding: 10px;
                        border-radius: 8px;
                        background: #08111f;
                        border: 1px solid #263449;
                    }
                    .run-title {
                        display: flex;
                        justify-content: space-between;
                        gap: 8px;
                        margin-bottom: 7px;
                        font-size: 13px;
                    }
                    .progress {
                        height: 8px;
                        overflow: hidden;
                        border-radius: 999px;
                        background: #1e293b;
                    }
                    #progress-fill {
                        width: 0;
                        height: 100%;
                        background: linear-gradient(90deg, #0284c7, #22c55e);
                        transition: width .2s ease;
                    }
                    #run-detail, #run-results {
                        margin-top: 8px;
                        color: #94a3b8;
                        font-size: 12px;
                        line-height: 1.5;
                        white-space: pre-wrap;
                    }
                    #run-results {
                        max-height: 120px;
                        overflow: auto;
                        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                    }
                    .log-toolbar { display: flex; align-items: center; gap: 6px; }
                    #logs {
                        flex: 1;
                        min-height: 220px;
                        overflow: auto;
                        padding: 8px;
                        border: 1px solid #263449;
                        border-radius: 8px;
                        background: #050a12;
                        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
                    }
                    .log { margin-bottom: 4px; color: #94a3b8; word-break: break-word; }
                    .log.success { color: #86efac; }
                    .log.warn { color: #fde68a; }
                    .log.error { color: #fda4af; }
                    .log-time { color: #475569; margin-right: 6px; }
                    @media (max-width: 860px) {
                        #panel { overflow: auto; }
                        .layout { display: flex; flex-direction: column; }
                        .left, .right { min-height: 620px; }
                    }
                    @media (min-width: 861px) and (max-height: 840px) {
                        .header, .status-strip, #blocked { flex-shrink: 0; }
                        .layout {
                            flex: 0 0 700px;
                            height: 700px;
                            min-height: 0;
                        }
                    }
                </style>
                <button id="fab" type="button">🛡️ 队列强化</button>
                <section id="panel" aria-label="队列强化助手">
                    <div class="header">
                        <h2>+20 队列强化助手</h2>
                        <span class="version">v${VERSION}</span>
                        <span class="spacer"></span>
                        <button id="close" class="icon-btn" type="button" title="关闭面板">✕</button>
                    </div>
                    <div class="status-strip">
                        <span id="connection-badge" class="badge">WS 未连接</span>
                        <span id="queue-badge" class="badge">队列未知</span>
                        <span id="mirror-badge" class="badge">贤者镜 0</span>
                        <span id="loadout-badge" class="badge">Enhancing 未同步</span>
                        <span id="character-badge" class="badge">角色 -</span>
                    </div>
                    <div id="blocked"></div>
                    <div class="layout">
                        <div class="left">
                            <div class="card">
                                <p class="section-title">执行方式</p>
                                <div class="row" style="margin-top:8px">
                                    <label class="radio-card">
                                        <input data-lock name="mode" type="radio" value="quick" checked>
                                        队尾续排（只确认入队）
                                    </label>
                                </div>
                                <label class="radio-card" style="margin-top:8px">
                                    <input data-lock id="use-existing" type="checkbox">
                                    利用现有 +9～+19，只购买缺口
                                </label>
                                <div class="hint" style="margin-top:7px">
                                    固定使用贤者镜；每条强化动作入队时绑定游戏内名为
                                    Enhancing 的配装，并要求其中包含 Grandmaster Enhancing Charm。
                                    本脚本只按冻结计划确认入队，不等待 +20 入库，也不读取或
                                    修改市场；成品已挂出或已卖掉不会锁住下一批。安全版不支持精炼装备。
                                </div>
                            </div>

                            <div class="card" style="display:flex;flex-direction:column;flex:1">
                                <div class="row">
                                    <input id="search" class="control search" type="search"
                                        placeholder="搜索装备名称或 ID">
                                    <button data-lock id="select-visible" class="btn small" type="button">全选可见</button>
                                    <button data-lock id="clear-visible" class="btn small" type="button">清空可见</button>
                                </div>
                                <div class="row" style="margin-top:8px">
                                    <select data-lock id="preset" class="control" style="flex:1"></select>
                                    <button data-lock id="preset-load" class="btn small" type="button">载入</button>
                                    <button data-lock id="preset-save" class="btn small" type="button">保存当前</button>
                                    <button data-lock id="preset-delete" class="btn small" type="button">删除</button>
                                </div>
                                <div class="row" style="margin:9px 0 6px">
                                    <span id="selected-count" class="hint">已选 0 种</span>
                                    <span class="spacer"></span>
                                    <span class="hint">每种逐件处理数量：</span>
                                    <input data-lock id="target-count" class="control" type="number"
                                        min="1" max="${CONFIG.MAX_COUNT_INPUT}" step="1"
                                        style="width:76px;text-align:center">
                                </div>
                                <div id="item-list"></div>
                            </div>
                        </div>

                        <div class="right">
                            <div class="card">
                                <p class="section-title">启动预检</p>
                                <div id="plan-preview" style="margin-top:8px">请选择装备</div>
                                <div class="action-row" style="margin-top:9px">
                                    <button data-lock id="start" class="btn success" type="button">
                                        核对计划并启动
                                    </button>
                                    <button id="stop" class="btn danger" type="button" disabled>
                                        停止继续发送
                                    </button>
                                </div>
                                <div class="hint" style="margin-top:7px">
                                    已购买的材料保留；已入队动作可在游戏队列中取消。
                                    关闭面板不会停止批次。
                                    全部指令确认入队后会立即释放任务，可选择其他装备继续添加。
                                </div>
                                <div class="action-row" style="margin-top:9px">
                                    <button id="end-old-batch" class="btn" type="button">
                                        结束旧批次记录
                                    </button>
                                </div>
                                <div id="end-old-batch-hint" class="hint" style="margin-top:7px">
                                    结束旧目标的后续排队；游戏中已有动作继续执行。
                                    库存、预设和设置保留；之后请核对本次新增数量。
                                </div>
                            </div>

                            <div class="card">
                                <p class="section-title">批次状态</p>
                                <div id="run-box" style="margin-top:8px">
                                    <div class="run-title">
                                        <span id="run-status">暂无批次</span>
                                        <span id="run-count">0 / 0</span>
                                    </div>
                                    <div class="progress"><div id="progress-fill"></div></div>
                                    <div id="run-detail">等待启动</div>
                                    <div id="run-results"></div>
                                </div>
                            </div>

                            <div class="card" style="display:flex;flex-direction:column;flex:1">
                                <div class="log-toolbar">
                                    <p class="section-title">运行日志</p>
                                    <span class="spacer"></span>
                                    <button id="copy-logs" class="btn small" type="button">复制</button>
                                    <button id="clear-logs" class="btn small" type="button">清空</button>
                                </div>
                                <div id="logs" style="margin-top:8px"></div>
                            </div>
                        </div>
                    </div>
                </section>
            `;
            body.appendChild(host);

            const ids = [
                'fab', 'panel', 'close', 'connection-badge', 'queue-badge',
                'mirror-badge', 'loadout-badge',
                'character-badge', 'blocked', 'use-existing',
                'search', 'select-visible', 'clear-visible', 'preset',
                'preset-load', 'preset-save', 'preset-delete',
                'selected-count', 'target-count', 'item-list', 'plan-preview',
                'start', 'stop', 'end-old-batch', 'end-old-batch-hint',
                'run-status', 'run-count', 'progress-fill',
                'run-detail', 'run-results', 'copy-logs', 'clear-logs', 'logs',
            ];
            for (const id of ids) UI.refs[id] = shadow.getElementById(id);
            UI.refs.mode = [...shadow.querySelectorAll('input[name="mode"]')];

            UI.refs.fab.addEventListener('click', () => {
                UI.refs.panel.classList.add('open');
                UI.lastPlanPreviewKey = '';
                UI.updateStatus();
                UI.renderItems(true);
                UI.renderRun();
            });
            UI.refs.close.addEventListener('click', () => {
                UI.refs.panel.classList.remove('open');
            });
            UI.refs.search.addEventListener(
                'input',
                () => UI.renderItems(true)
            );
            UI.refs['select-visible'].addEventListener('click', () => {
                for (const itemId of UI.visibleItemIds) State.selected.add(itemId);
                saveSelection();
                UI.renderItems(true);
                UI.updateStatus();
            });
            UI.refs['clear-visible'].addEventListener('click', () => {
                for (const itemId of UI.visibleItemIds) State.selected.delete(itemId);
                saveSelection();
                UI.renderItems(true);
                UI.updateStatus();
            });

            for (const radio of UI.refs.mode) {
                radio.checked = true;
            }
            UI.refs['use-existing'].checked =
                State.settings.useExistingInventory;
            UI.refs['use-existing'].addEventListener('change', () => {
                State.settings.useExistingInventory =
                    UI.refs['use-existing'].checked;
                saveSettings();
                UI.updateStatus();
            });
            UI.refs['target-count'].value = String(
                State.settings.targetCount
            );
            UI.refs['target-count'].addEventListener('input', () => {
                State.settings.targetCount = UI.refs['target-count'].value;
                UI.updateStatus();
            });
            UI.refs['target-count'].addEventListener('change', () => {
                try {
                    State.settings.targetCount = parsePositiveInteger(
                        UI.refs['target-count'].value,
                        '每种逐件处理数量',
                        CONFIG.MAX_COUNT_INPUT
                    );
                    saveSettings();
                } catch {
                    // The preview displays the validation error.
                }
                UI.updateStatus();
            });

            UI.refs.start.addEventListener('click', () => Controller.start());
            UI.refs.stop.addEventListener('click', () => Controller.stop());
            UI.refs['end-old-batch'].addEventListener('click', async () => {
                try {
                    await Controller.endOldBatch();
                } catch (error) {
                    log(`结束旧批次记录未完成：${error.message || String(error)}`, 'warn');
                    window.alert(error.message || String(error));
                }
            });
            UI.refs['preset-load'].addEventListener(
                'click',
                () => UI.loadSelectedPreset()
            );
            UI.refs['preset-save'].addEventListener(
                'click',
                () => UI.saveCurrentPreset()
            );
            UI.refs['preset-delete'].addEventListener(
                'click',
                () => UI.deleteSelectedPreset()
            );
            UI.refs['copy-logs'].addEventListener(
                'click',
                () => UI.copyLogs()
            );
            UI.refs['clear-logs'].addEventListener('click', () => {
                State.logs.length = 0;
                UI.refs.logs.replaceChildren();
            });

            State.ui = UI;
            UI.renderPresets();
            UI.renderItems(true);
            UI.updateStatus();
            UI.renderRun();
            for (const entry of State.logs) UI.appendLog(entry);
                log(
                    '界面已就绪。运行前请停用其他强化脚本；'
                    + '市场自动出售会发送真实交易请求'
                );
        },

        setLocked(locked) {
            UI.locked = Boolean(locked || State.endingOldBatch);
            UI.updateEndOldBatchControl();
            if (!UI.shadow) return;
            for (const element of UI.shadow.querySelectorAll('[data-lock]')) {
                element.disabled = UI.locked;
            }
            UI.renderItems(true);
            UI.renderRun();
        },

        updateEndOldBatchControl() {
            const button = UI.refs['end-old-batch'];
            if (!button) return;
            // This is an exit action. Generic form locks and unrelated game
            // actions must never make it inaccessible; the controller checks
            // actual transaction readiness and reports the reason on click.
            button.disabled = State.endingOldBatch;
            button.textContent = State.endingOldBatch
                ? '正在结束旧批次…' : '结束旧批次记录';
            button.title = State.endingOldBatch
                ? '正在等待当前请求结束并备份记录'
                : '停止旧目标的后续排队并结束记录；游戏里已有的动作保留';
            const hint = UI.refs['end-old-batch-hint'];
            if (hint) {
                hint.textContent = State.endingOldBatch
                    ? '正在停止续排并等待当前请求结束；已有游戏队列继续执行。'
                    : '结束旧目标的后续排队；游戏中已有动作继续执行。'
                        + '库存、预设和设置保留；之后请核对本次新增数量。';
            }
        },

        renderPresets() {
            if (!UI.refs.preset) return;
            const selectedValue = UI.refs.preset.value;
            UI.refs.preset.replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = State.presets.length
                ? '选择已保存的装备组'
                : '暂无已保存装备组';
            UI.refs.preset.appendChild(placeholder);
            State.presets.forEach((preset, index) => {
                const option = document.createElement('option');
                option.value = String(index);
                option.textContent = `${preset.name}（${preset.items.length} 种）`;
                UI.refs.preset.appendChild(option);
            });
            if (
                selectedValue &&
                Number(selectedValue) < State.presets.length
            ) {
                UI.refs.preset.value = selectedValue;
            }
        },

        loadSelectedPreset() {
            const rawIndex = UI.refs.preset.value;
            const index = /^\d+$/.test(rawIndex)
                ? Number(rawIndex)
                : -1;
            if (!Number.isInteger(index) || !State.presets[index]) {
                window.alert('请先选择一个装备组');
                return;
            }
            State.selected = new Set(State.presets[index].items);
            saveSelection();
            UI.renderItems(true);
            UI.updateStatus();
        },

        saveCurrentPreset() {
            if (State.selected.size === 0) {
                window.alert('当前没有选中装备');
                return;
            }
            const rawName = window.prompt('装备组名称：');
            if (rawName == null) return;
            const name = rawName.trim().slice(0, 40);
            if (!name) {
                window.alert('名称不能为空');
                return;
            }
            const existingIndex = State.presets.findIndex(
                (preset) => preset.name === name
            );
            const value = {name, items: [...State.selected]};
            if (existingIndex >= 0) {
                if (!window.confirm(`覆盖已有装备组“${name}”？`)) return;
                State.presets[existingIndex] = value;
            } else {
                State.presets.push(value);
            }
            savePresets();
            UI.renderPresets();
        },

        deleteSelectedPreset() {
            const rawIndex = UI.refs.preset.value;
            const index = /^\d+$/.test(rawIndex)
                ? Number(rawIndex)
                : -1;
            if (!Number.isInteger(index) || !State.presets[index]) {
                window.alert('请先选择一个装备组');
                return;
            }
            const preset = State.presets[index];
            if (!window.confirm(`删除装备组“${preset.name}”？`)) return;
            State.presets.splice(index, 1);
            savePresets();
            UI.renderPresets();
        },

        getSortedVisibleItems() {
            const query = UI.refs.search.value.trim().toLocaleLowerCase();
            const items = EQUIPMENT_IDS
                .filter((itemId) => {
                    if (!query) return true;
                    return (
                        itemId.toLocaleLowerCase().includes(query) ||
                        getItemName(itemId).toLocaleLowerCase().includes(query)
                    );
                })
                .map((itemId) => {
                    const counts = getItemCounts(itemId);
                    const total = counts.reduce(
                        (sum, count) => sum + (Number(count) || 0),
                        0
                    );
                    return {
                        itemId,
                        name: getItemName(itemId),
                        counts,
                        total,
                        selected: State.selected.has(itemId),
                    };
                });

            items.sort((left, right) => {
                if (left.selected !== right.selected) {
                    return left.selected ? -1 : 1;
                }
                const leftHas20 = (left.counts[20] || 0) > 0;
                const rightHas20 = (right.counts[20] || 0) > 0;
                if (leftHas20 !== rightHas20) return leftHas20 ? 1 : -1;
                if (left.total !== right.total) return right.total - left.total;
                return left.name.localeCompare(right.name, 'zh-CN');
            });
            return items;
        },

        isOpen() {
            return Boolean(UI.refs.panel?.classList.contains('open'));
        },

        updateFab() {
            UI.refs.fab?.classList.toggle(
                'running',
                isProtectedRunLifecycle(State.run)
            );
        },

        renderItems(force = false) {
            if (!UI.refs['item-list']) return;
            if (!force && !UI.isOpen()) return;

            const renderKey = [
                State.equipmentInventoryRevision,
                State.marketRevision,
                State.namesRevision,
                State.selectionRevision,
                UI.locked ? 1 : 0,
                UI.refs.search.value,
            ].join(':');
            if (!force && renderKey === UI.lastItemRenderKey) return;
            UI.lastItemRenderKey = renderKey;

            const items = UI.getSortedVisibleItems();
            UI.visibleItemIds = items.map((item) => item.itemId);
            const fragment = document.createDocumentFragment();

            for (const item of items) {
                const row = document.createElement('label');
                row.className = `item${item.selected ? ' selected' : ''}`;

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = item.selected;
                checkbox.disabled = UI.locked;
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) State.selected.add(item.itemId);
                    else State.selected.delete(item.itemId);
                    saveSelection();
                    UI.renderItems(true);
                    UI.updateStatus();
                });

                const text = document.createElement('span');
                text.className = 'item-name';
                text.textContent = item.name;
                const id = document.createElement('span');
                id.className = 'item-id';
                id.textContent = item.itemId;
                text.appendChild(id);

                const counts = document.createElement('span');
                counts.className = 'counts';
                const marketStatus =
                    State.marketItemStatus.get(item.itemId);
                const marketLine = marketStatus
                    ? `\n左一:${
                        marketStatus.leftOnePrice == null
                            ? '-'
                            : formatInt(marketStatus.leftOnePrice)
                    } 我的:${
                        marketStatus.ownPrice == null
                            ? '-'
                            : formatInt(marketStatus.ownPrice)
                    }`
                    : '';
                counts.textContent =
                    `9:${formatInt(item.counts[9])} `
                    + `10:${formatInt(item.counts[10])} `
                    + `20:${formatInt(item.counts[20])}`
                    + marketLine;

                row.append(checkbox, text, counts);
                fragment.appendChild(row);
            }
            UI.refs['item-list'].replaceChildren(fragment);
            UI.refs['selected-count'].textContent =
                `已选 ${State.selected.size} 种｜当前显示 ${items.length} 种`;
        },

        renderMarket() {
            if (!UI.refs['market-badge']) return;
            UI.refs['market-maintenance'].checked =
                State.settings.marketMaintenanceEnabled;
            UI.refs['market-maintenance'].disabled =
                State.starting ||
                Boolean(State.marketWriteBlockedReason) ||
                Boolean(
                    State.run &&
                    !State.run.marketMaintenanceEnabled &&
                    isProtectedRunLifecycle(State.run)
                );
            UI.refs['market-max-drop'].disabled = Boolean(
                UI.locked ||
                (
                    State.run?.marketMaintenanceEnabled &&
                    isProtectedRunLifecycle(State.run)
                )
            );
            if (
                UI.shadow?.activeElement !==
                    UI.refs['market-max-drop']
            ) {
                UI.refs['market-max-drop'].value = String(
                    State.settings.marketMaxDropPercent
                );
            }

            const badge = UI.refs['market-badge'];
            if (State.marketWriteBlockedReason) {
                badge.textContent = '市场自动出售已安全停用';
                badge.className = 'badge error';
            } else if (
                State.settings.marketMaintenanceEnabled &&
                State.blockedReason
            ) {
                badge.textContent = '市场自动出售随完整性锁停止';
                badge.className = 'badge error';
            } else if (
                !State.settings.marketMaintenanceEnabled &&
                (State.marketBusy || State.marketOp)
            ) {
                badge.textContent = '市场安全收尾中';
                badge.className = 'badge warn';
            } else if (!State.settings.marketMaintenanceEnabled) {
                badge.textContent = '市场自动出售已关';
                badge.className = 'badge warn';
            } else if (!State.clientMarketDataReady) {
                badge.textContent =
                    `市场规则未同步（${State.clientMarketDataCacheStatus}）`;
                badge.className = 'badge error';
            } else if (!State.characterMarketAccessReady) {
                badge.textContent = '角色市场权限未同步';
                badge.className = 'badge error';
            } else if (!State.gameModeMarketRestrictions.has(
                State.characterGameMode
            )) {
                badge.textContent = '当前模式市场规则未同步';
                badge.className = 'badge error';
            } else if (!State.myMarketListingsReady) {
                badge.textContent = '本人挂单未同步';
                badge.className = 'badge error';
            } else if (State.marketBusy || State.marketOp) {
                badge.textContent = '市场自动出售处理中';
                badge.className = 'badge warn';
            } else if (State.run?.marketSteadyMonitoring) {
                badge.textContent = '市场持续守左一中';
                badge.className = 'badge ok';
            } else if (MarketMaintenance.isMonitoringRun()) {
                badge.textContent = '市场左一轮询中';
                badge.className = 'badge ok';
            } else {
                badge.textContent = '市场待批次';
                badge.className = 'badge';
            }

            const statusNames = {
                already_lowest: '已是最低售价',
                reserve_only: '库存仅留自用',
                no_quote: '无可信左一，暂不挂售',
                price_floor: '没有更低合法价格档',
                confirming_quote: '等待第二次盘口确认',
                volatile_quote: '盘口持续变化，库存保留',
                post_new: '准备首次挂售',
                post_extra: '准备补挂库存',
                accumulating: '暂存新增库存',
                consolidate: '最终合并卖单',
                reserve_reclaim: '从卖单收回自用保留件',
                deferred_reprice: '等待强化结束后撤挂',
                deferred_inventory_write: '等待本装备库存收束',
                listed_new: '已自动挂售',
                listed_extra: '已补挂库存',
                listing_cap: '挂单槽已满',
                market_data_invalid: '盘口数据异常',
                market_access_blocked: '市场权限或数据异常',
                waiting_inventory_sync: '等待挂单库存回执',
                guarded: '跌价保护拦截',
                cancelling: '正在撤单',
                claiming: '正在领取余货',
                claiming_sale_coins: '正在领取成交款',
                claimed_sale_coins: '成交款已领取',
                deferred_terminal_claim: '等待强化结束后领取余货',
                claiming_terminal_listing: '正在领取终态卖单',
                claimed_terminal_listing: '终态卖单已领取',
                posting: '正在挂单',
                repriced: '已按左一-重挂',
                sold_during_post: '挂出后已售完',
                filled_during_cancel: '撤单时已售完',
                read_error: '盘口读取暂时失败',
                disabled: '自动出售已停用',
            };
            const itemIds = State.run?.itemIds?.length
                ? State.run.itemIds
                : [...State.selected];
            const lines = [];
            for (const itemId of itemIds) {
                const status = State.marketItemStatus.get(itemId);
                if (!status) continue;
                const leftOne = status.leftOnePrice == null
                    ? '-'
                    : formatInt(status.leftOnePrice);
                const own = status.ownPrice == null
                    ? '无'
                    : `${formatInt(status.ownPrice)}`
                        + ` ×${formatInt(status.ownQuantity || 0)}`;
                const inventory = (
                    status.inventoryCount != null &&
                    Number.isFinite(Number(status.inventoryCount))
                )
                    ? formatInt(status.inventoryCount)
                    : formatInt(
                        getItemCount(itemId, CONFIG.TARGET_LEVEL)
                    );
                const excess = (
                    status.excessQuantity != null &&
                    Number.isFinite(Number(status.excessQuantity))
                )
                    ? formatInt(status.excessQuantity)
                    : formatInt(getMarketExcessInventory(itemId));
                lines.push(
                    `${getItemName(itemId)} +20｜左一 ${leftOne}`
                    + `｜我的 ${own}｜库存 ${inventory}`
                    + `｜可售 ${excess}｜`
                    + `${statusNames[status.kind] || status.kind}`
                    + (status.reason ? `｜${status.reason}` : '')
                );
            }
            if (State.marketWriteBlockedReason) {
                lines.unshift(
                    `已停用：${State.marketWriteBlockedReason}`
                );
            }
            UI.refs['market-detail'].textContent = lines.length > 0
                ? lines.join('\n')
                : (
                    State.settings.marketMaintenanceEnabled
                        ? '批次启动后轮询所选 +20；实体库存固定留 1，'
                            + '其余按当前左一价格规则自动挂售'
                        : '已关闭：不会读取盘口，也不会自动挂售或撤挂'
                );
        },

        updateStatus() {
            if (!UI.refs['connection-badge']) return;
            UI.renderMarket();
            const connection = UI.refs['connection-badge'];
            connection.textContent = getConnectionLabel();
            connection.className = 'badge ' + (
                State.socket?.readyState === WebSocket.OPEN &&
                State.inventoryReady &&
                State.queueReady &&
                State.loadoutsReady &&
                State.characterItemsReady
                    ? 'ok'
                    : 'warn'
            );

            const enhancingCount = getEnhancingActions().length;
            const queue = UI.refs['queue-badge'];
            if (!State.queueReady) {
                queue.textContent = '强化队列未知';
                queue.className = 'badge warn';
            } else {
                queue.textContent =
                    `强化动作 ${enhancingCount}｜总动作 ${State.actions.size}`;
                queue.className = `badge ${enhancingCount === 0 ? 'ok' : 'warn'}`;
            }

            UI.refs['mirror-badge'].textContent =
                `贤者镜 ${formatInt(getItemCount(PHILOSOPHERS_MIRROR, 0))}`;
            const loadoutBadge = UI.refs['loadout-badge'];
            try {
                const binding = getEnhancingLoadoutBinding();
                loadoutBadge.textContent =
                    `Enhancing #${binding.id}｜Grandmaster Charm`;
                loadoutBadge.className = 'badge ok';
            } catch {
                loadoutBadge.textContent = State.loadoutsReady
                    ? 'Enhancing 配装无效'
                    : 'Enhancing 未同步';
                loadoutBadge.className = 'badge error';
            }
            UI.refs['character-badge'].textContent =
                `角色 ${getCharacterId() || State.characterId || '-'}`;

            const blocked = UI.refs.blocked;
            blocked.textContent = State.blockedReason
                ? `结果未知锁定：${State.blockedReason}。刷新页面后才能开始新批次。`
                : '';
            blocked.classList.toggle('show', Boolean(State.blockedReason));

            const preview = UI.refs['plan-preview'];
            if (State.run?.active) {
                UI.lastPlanPreviewKey = '';
                preview.className = '';
                preview.textContent = [
                    State.run.mode === 'verified'
                        ? `逐件运行中：${State.run.confirmedOutputs}`
                            + ` / ${State.run.summary.outputs} 件 +20 已确认`
                        : `逐件快排中：${State.run.confirmedOutputs}`
                            + ` / ${State.run.summary.outputs} 件动作组已入队`,
                    `强化指令：${State.run.confirmedCommands}`
                        + ` / ${State.run.summary.sendCommands} 已确认`,
                ].join('\n');
            } else if (
                State.run?.marketFinalSweepPhase ===
                    'waiting_inventory' ||
                State.run?.marketFinalSweepPhase === 'running'
            ) {
                UI.lastPlanPreviewKey = '';
                preview.className = '';
                preview.textContent = State.run.currentStage;
            } else if (State.endingOldBatch) {
                UI.lastPlanPreviewKey = '';
                preview.className = '';
                preview.textContent = '正在停止续排并备份旧批次记录；游戏队列保留…';
            } else if (State.starting) {
                UI.lastPlanPreviewKey = '';
                preview.className = '';
                preview.textContent = '正在等待网络状态稳定并复核计划…';
            } else {
                const conflictPresent = Boolean(document.querySelector(
                    '#dnm-en-wrapper, .dnm-en-float-btn, '
                    + '#easy20-enhance-btn, .easy20-component'
                ));
                const previewKey = [
                    State.connectionEpoch,
                    State.syncEpoch,
                    State.equipmentInventoryRevision,
                    State.queueRevision,
                    State.loadoutRevision,
                    State.characterItemsRevision,
                    State.marketRevision,
                    State.outgoingQueueMutationRevision,
                    State.selectionRevision,
                    State.inventoryReady ? 1 : 0,
                    State.queueReady ? 1 : 0,
                    State.loadoutsReady ? 1 : 0,
                    State.characterItemsReady ? 1 : 0,
                    State.myMarketListingsReady ? 1 : 0,
                    State.clientMarketDataReady ? 1 : 0,
                    State.clientMarketDataSource,
                    State.clientMarketDataCacheStatus,
                    State.characterMarketAccessReady ? 1 : 0,
                    State.characterId || '',
                    State.actionQueueCap ?? '',
                    getItemCount(PHILOSOPHERS_MIRROR, 0),
                    State.settings.mode,
                    State.settings.useExistingInventory ? 1 : 0,
                    State.settings.marketMaintenanceEnabled ? 1 : 0,
                    State.settings.marketMaxDropPercent,
                    State.settings.targetCount,
                    State.blockedReason,
                    State.marketWriteBlockedReason,
                    State.run
                        ? `${State.run.id}:${State.run.status}`
                        : '',
                    conflictPresent ? 1 : 0,
                ].join(':');

                if (previewKey !== UI.lastPlanPreviewKey) {
                    UI.lastPlanPreviewKey = previewKey;
                    try {
                        const batchPlan = buildBatchPlan();
                        const summary = batchPlan.summary;
                        preview.className = '';
                        preview.textContent = [
                            ...(batchPlan.isRecovery
                                ? [
                                    `恢复持久任务：账本已确认 `
                                        + `${formatInt(
                                            batchPlan.recoveryJournal
                                                ?.acked?.length || 0
                                        )} 条，尚待确认 `
                                        + `${formatInt(
                                            batchPlan.recovery.commands.length -
                                            batchPlan.recoveryJournal.acked.length
                                        )} 条；不会重发已确认位置，`
                                        + '第一个无回执位置会先恢复重发',
                                ]
                                : []),
                            ...(
                                batchPlan.legacyAdoption &&
                                !batchPlan.isRecovery
                                    ? [
                                        `旧队列待显式接管：`
                                            + `${formatInt(
                                                batchPlan.legacyAdoption
                                                    .actionCount
                                            )} 条动作，`
                                            + `${formatInt(
                                                batchPlan.legacyAdoption
                                                    .outputCount
                                            )} 个 +20 收束`,
                                    ]
                                    : []
                            ),
                            `${summary.itemTypes} 种 × 每种 ${batchPlan.targetCount} 件`
                                + ` = 新增 ${summary.outputs} 件 +20`,
                            '顺序：每次仅处理 1 件；本件动作组收束到 +20 '
                                + '后才进入下一件',
                            `采购 +10×${formatInt(summary.purchaseHigh)}，`
                                + `+9×${formatInt(summary.purchaseLow)}`,
                            `消耗现有：${formatExistingConsumption(summary)}`,
                            `配装：Enhancing #${batchPlan.enhancingLoadout.id}`
                                + '（每条动作入队时绑定）',
                            '市场：由独立守价脚本负责；本脚本不读取也不锁市场',
                            `贤者镜 ${formatInt(summary.mirrorCount)} / `
                                + `${formatInt(CONFIG.MAX_MIRROR_CONSUMPTION)}｜`
                                + `强化指令 ${formatInt(summary.sendCommands)} / `
                                + `${CONFIG.MAX_ENHANCE_COMMANDS}`,
                            ...(batchPlan.mode === 'quick'
                                ? [
                                    `队列空位 ${batchPlan.queueFreeSlots}`
                                        + `/${batchPlan.queueCapacity}；`
                                        + '总指令可更多；连续满时最多等待'
                                        + '10分钟，超时停止且不清队列',
                                    '结果语义：逐件动作组确认入队，'
                                        + '不宣称已经产出',
                                ]
                                : [
                                    '结果语义：每件 +20 库存确认后'
                                        + '才处理下一件',
                                ]),
                        ].join('\n');
                    } catch (error) {
                        preview.className = 'error';
                        preview.textContent = error.message || String(error);
                    }
                }
            }

            UI.refs.start.disabled = (
                UI.locked ||
                State.starting ||
                State.endingOldBatch ||
                State.pendingEnhancingLoadoutSaves > 0 ||
                Boolean(State.blockedReason) ||
                hasUnsettledRunTail(State.run) ||
                State.socket?.readyState !== WebSocket.OPEN ||
                !State.inventoryReady ||
                !State.queueReady ||
                !State.loadoutsReady ||
                !State.characterItemsReady
            );
            UI.updateEndOldBatchControl();
        },

        renderRun() {
            if (!UI.refs['run-status']) return;
            const run = State.run;
            UI.refs.fab.classList.toggle(
                'running',
                isProtectedRunLifecycle(run)
            );

            if (!run) {
                UI.refs['run-status'].textContent = '暂无批次';
                UI.refs['run-count'].textContent = '0 / 0';
                UI.refs['progress-fill'].style.width = '0%';
                UI.refs['run-detail'].textContent = '等待启动';
                UI.refs['run-results'].replaceChildren();
                UI.refs.stop.disabled = true;
                UI.refs.stop.textContent = '停止继续发送';
                return;
            }

            const statusNames = {
                running: '运行中',
                queued: '全部确认入队',
                completed: '全部确认产出',
                stopped: '已停止后续发送',
                failed: '失败',
                unknown: '结果未知，已锁定',
            };
            UI.refs['run-status'].textContent =
                statusNames[run.status] || run.status;
            UI.refs['run-count'].textContent =
                `${formatInt(run.confirmedOutputs)} / `
                + `${formatInt(run.summary.outputs)} 件`;
            const percent = run.summary.outputs > 0
                ? Math.min(
                    100,
                    run.confirmedOutputs / run.summary.outputs * 100
                )
                : 0;
            UI.refs['progress-fill'].style.width = `${percent}%`;
            UI.refs['run-detail'].textContent = [
                `当前装备：${run.currentItemId
                    ? getItemName(run.currentItemId)
                    : '-'}`,
                `阶段：${run.currentStage}`,
                `当前件：${run.currentOutput} / ${run.currentOutputTotal}`,
                `本件指令：${run.currentOutputCommand} / `
                    + `${run.currentOutputCommandTotal}`,
                `当前装备指令：${run.currentCommand} / ${run.currentCommandTotal}`,
                `全批逐件确认：${run.confirmedOutputs} / ${run.summary.outputs}`,
                `全批指令确认：${run.confirmedCommands} / `
                    + `${run.summary.sendCommands}`,
                `已确认采购基底：${formatInt(run.confirmedPurchases)}`,
                run.error ? `错误：${run.error}` : '',
            ].filter(Boolean).join('\n');

            const resultStatusNames = {
                pending: '待处理',
                purchasing: '采购中',
                executing: '逐件确认产出中',
                queueing: '逐件入队中',
                completed: '已确认产出',
                queued: '已确认入队',
                stopped: '已停止',
                failed: '失败',
                unknown: '结果未知',
            };
            const resultFragment = document.createDocumentFragment();
            for (const result of run.results) {
                const line = document.createElement('div');
                const outputMeaning = run.mode === 'verified'
                    ? '件 +20'
                    : '件动作组';
                line.textContent =
                    `${getItemName(result.itemId)}：`
                    + `${resultStatusNames[result.status] || result.status}；`
                    + `${result.confirmedOutputs}/${result.targetOutputs} `
                    + `${outputMeaning}，${result.confirmedCommands} 条指令`
                    + (result.error ? ` — ${result.error}` : '');
                resultFragment.appendChild(line);
            }
            UI.refs['run-results'].replaceChildren(resultFragment);

            const finalSweepActive =
                run.marketFinalSweepPhase === 'waiting_inventory' ||
                run.marketFinalSweepPhase === 'running';
            UI.refs.stop.disabled =
                (!run.active && !finalSweepActive) ||
                run.stopRequested;
            UI.refs.stop.textContent = run.stopRequested
                ? '等待当前请求确认…'
                : finalSweepActive
                    ? '停止市场最终扫尾'
                    : '停止继续发送';
        },

        appendLog(entry) {
            if (!UI.refs.logs) return;
            const line = document.createElement('div');
            line.className = `log ${entry.type}`;
            const time = document.createElement('span');
            time.className = 'log-time';
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

        async copyLogs() {
            const text = State.logs.map((entry) => (
                `[${entry.time.toISOString()}] [${entry.type}] ${entry.message}`
            )).join('\n');
            try {
                await navigator.clipboard.writeText(text);
                log('日志已复制到剪贴板', 'success');
            } catch (error) {
                window.prompt('复制下面的日志：', text);
            }
        },
    };

    if (runtimeTestMode) {
        globalThis.__MWI_SAFE_ENHANCER_RUNTIME_TEST_EXPORTS__ = {
            CONFIG,
            Planner,
            State,
            WorkSignals,
            sleepFor,
            waitForStateQuiescence,
            waitForOwnedQueueIntegrity,
            waitForEnhancingLoadoutSave,
            Transactions,
            MarketTransactions,
            MarketMaintenance,
            Network,
            UI,
            Controller,
            BatchError,
            READ_ONLY_OUTGOING_TYPES,
            QUEUE_MUTATION_OUTGOING_TYPES,
            actionCompletionMatches,
            actionFingerprintMatches,
            actionProgressMatches,
            buildBatchPlan,
            buildConfirmationText,
            classifyExternalOutgoing,
            createRecoveryJournal,
            decompressLzStringUtf16,
            createEnhancePayload,
            enumeratePlanCommands,
            finalizeCompletelyAcknowledgedQueueRun,
            getEnhancingLoadoutBinding,
            getItemCount,
            getLoadoutTargetReservations,
            getRecoveryPurchaseRequirements,
            loadItemNames,
            isCompletelyAcknowledgedQueueJournal,
            isSafeExternalQueueMutation,
            parsePositiveInteger,
            purchaseAndConfirm,
            reconcileRecoveryJournal,
            runOperationSafely,
            assertLoadoutTargetReservationsAvailable,
            assertPlansPreserveLoadoutTargetReservations,
            sendEnhanceAndConfirm,
            progressSingleEnhanceActionMatches,
            registerOwnedAction,
            restoreClientMarketDataFromCache,
            strictSingleEnhanceActionMatches,
            waitForQuickQueueSlot,
        };
        return;
    }

    document.addEventListener('visibilitychange', () => WorkSignals.notify());
    document.addEventListener('resume', () => WorkSignals.notify());
    window.addEventListener('pageshow', () => WorkSignals.notify());

    try {
        Network.install();
    } catch (error) {
        State.blockedReason = error.message || String(error);
        log(State.blockedReason, 'error');
    }

    UI.init().catch((error) => {
        console.error('[安全强化助手] 初始化界面失败:', error);
    });
    loadItemNames().catch((error) => {
        log(`加载装备名称失败：${error.message}`, 'warn');
    });

    window.__MWI_SAFE_ENHANCER__ = {
        version: VERSION,
        preview: () => buildBatchPlan(),
        stop: () => Controller.stop(),
        getState: () => ({
            connected: State.socket?.readyState === WebSocket.OPEN,
            inventoryReady: State.inventoryReady,
            queueReady: State.queueReady,
            loadoutsReady: State.loadoutsReady,
            characterItemsReady: State.characterItemsReady,
            enhancingActions: getEnhancingActions().length,
            enhancingLoadout: (() => {
                try {
                    return getEnhancingLoadoutBinding();
                } catch {
                    return null;
                }
            })(),
            blockedReason: State.blockedReason,
            run: State.run
                ? {
                    id: State.run.id,
                    active: State.run.active,
                    status: State.run.status,
                    confirmedCommands: State.run.confirmedCommands,
                    confirmedOutputs: State.run.confirmedOutputs,
                }
                : null,
        }),
    };
})();
