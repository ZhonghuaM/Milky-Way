#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const userscriptPath = path.join(__dirname, 'mwi_safe_enhancer.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');
const context = {
    console,
    __MWI_SAFE_ENHANCER_TEST_MODE__: true,
};
vm.createContext(context);
vm.runInContext(source, context, {filename: userscriptPath});

const {CONFIG, Planner, EQUIPMENT_IDS} =
    context.__MWI_SAFE_ENHANCER_TEST_EXPORTS__;

function histogram(actions) {
    const result = {};
    for (const action of actions) {
        const key = `${action.startLevel}->${action.targetLevel}`;
        result[key] = (result[key] || 0) + 1;
    }
    return result;
}

function createSimulationCounts(plan) {
    const counts = new Array(CONFIG.TARGET_LEVEL + 1).fill(0);
    for (let level = CONFIG.BASE_LOW; level < CONFIG.TARGET_LEVEL; level++) {
        counts[level] =
            (plan.consumedExisting[level] || 0)
            + (plan.purchases[level] || 0);
    }
    return counts;
}

function applyAction(counts, action) {
    for (
        let sourceLevel = action.startLevel;
        sourceLevel < action.targetLevel;
        sourceLevel++
    ) {
        assert.ok(
            counts[sourceLevel] >= 1,
            `missing primary +${sourceLevel} for `
                + `${action.startLevel}->${action.targetLevel}`
        );
        assert.ok(
            counts[sourceLevel - 1] >= 1,
            `missing secondary +${sourceLevel - 1} for `
                + `${action.startLevel}->${action.targetLevel}`
        );
        counts[sourceLevel]--;
        counts[sourceLevel - 1]--;
        counts[sourceLevel + 1]++;
    }
}

function assertSegmentedPlan(plan, segmentKey, flatKey) {
    const segments = plan[segmentKey];
    const flatActions = plan[flatKey];
    assert.equal(
        segments.length,
        plan.targetCount,
        `${segmentKey} must have exactly one segment per output`
    );
    assert.deepEqual(
        Array.from(
            segments,
            (segment) => Array.from(
                segment,
                (action) => [
                    action.outputIndex,
                    action.startLevel,
                    action.targetLevel,
                ]
            )
        ).flat(),
        Array.from(
            flatActions,
            (action) => [
                action.outputIndex,
                action.startLevel,
                action.targetLevel,
            ]
        ),
        `${flatKey} must be the exact segment flattening`
    );

    const counts = createSimulationCounts(plan);
    segments.forEach((segment, outputIndex) => {
        assert.ok(segment.length > 0, `output ${outputIndex + 1} is empty`);
        assert.equal(
            segment.some(
                (action) => action.outputIndex !== outputIndex
            ),
            false,
            `output ${outputIndex + 1} contains another output's action`
        );
        assert.equal(
            segment.slice(0, -1).some(
                (action) => action.targetLevel === CONFIG.TARGET_LEVEL
            ),
            false,
            `output ${outputIndex + 1} reaches +20 before its last action`
        );
        assert.equal(
            segment[segment.length - 1].targetLevel,
            CONFIG.TARGET_LEVEL,
            `output ${outputIndex + 1} must end at +20`
        );

        const before = counts[CONFIG.TARGET_LEVEL];
        for (const action of segment) applyAction(counts, action);
        assert.equal(
            counts[CONFIG.TARGET_LEVEL],
            before + 1,
            `output ${outputIndex + 1} must independently add one +20`
        );
    });
    assert.equal(
        counts[CONFIG.TARGET_LEVEL],
        plan.targetCount,
        `${segmentKey} must produce the requested new +20 items`
    );
}

function simulatePlan(plan) {
    assertSegmentedPlan(
        plan,
        'compressedOutputSegments',
        'compressedActions'
    );
    assertSegmentedPlan(plan, 'rawOutputSegments', 'rawActions');
}

{
    const plan = Planner.planTo20({}, 1, false);
    assert.equal(plan.purchases[9], 55);
    assert.equal(plan.purchases[10], 89);
    assert.equal(plan.purchaseItemCount, 144);
    assert.equal(plan.rawActions.length, 143);
    assert.equal(plan.linkCount, 88);
    assert.equal(plan.compressedActions.length, 55);
    assert.deepEqual(
        histogram(plan.compressedActions),
        {
            '10->11': 21,
            '10->12': 13,
            '10->13': 8,
            '10->14': 5,
            '10->15': 3,
            '10->16': 2,
            '10->17': 1,
            '10->18': 1,
            '10->20': 1,
        }
    );
    simulatePlan(plan);
}

{
    const plan = Planner.planTo20({}, 2, false);
    assert.equal(plan.purchases[9], 110);
    assert.equal(plan.purchases[10], 178);
    assert.equal(plan.rawActions.length, 286);
    assert.equal(plan.compressedActions.length, 110);
    assert.deepEqual(
        Array.from(plan.compressedActionsPerOutput),
        [55, 55]
    );
    assert.deepEqual(Array.from(plan.rawActionsPerOutput), [143, 143]);
    simulatePlan(plan);
}

{
    const plan = Planner.planTo20({}, 50, false);
    assert.equal(plan.compressedOutputSegments.length, 50);
    assert.equal(plan.rawOutputSegments.length, 50);
    assert.equal(plan.compressedActions.length, 2750);
    assert.equal(plan.rawActions.length, 7150);
    assert.equal(
        plan.compressedActionsPerOutput.every((count) => count === 55),
        true
    );
    assert.equal(
        plan.rawActionsPerOutput.every((count) => count === 143),
        true
    );
    simulatePlan(plan);
}

{
    // Global inventory optimization must remain intact while output order is
    // segmented. Replanning one output at a time makes this case 65 commands.
    const inventory = new Array(21).fill(0);
    inventory[17] = 1;
    inventory[19] = 1;
    const plan = Planner.planTo20(inventory, 2, true);
    assert.equal(plan.compressedActions.length, 64);
    assert.deepEqual(
        Array.from(plan.compressedActionsPerOutput),
        [42, 22]
    );
    simulatePlan(plan);
}

{
    const first = Planner.planTo20({}, 1, false);
    const second = Planner.planTo20({}, 1, false);
    const summary = Planner.summarize(
        [
            {itemId: 'x', plan: first},
            {itemId: 'y', plan: second},
        ],
        'quick'
    );
    assert.equal(summary.itemTypes, 2);
    assert.equal(summary.outputs, 2);
    assert.equal(summary.purchaseLow, 110);
    assert.equal(summary.purchaseHigh, 178);
    assert.equal(summary.purchaseItems, 288);
    assert.equal(summary.mirrorCount, 286);
    assert.equal(summary.sendCommands, 110);
    Planner.validateSummary(summary);
}

{
    const inventory = new Array(21).fill(0);
    inventory[18] = 1;
    inventory[19] = 1;
    const original = [...inventory];
    const plan = Planner.planTo20(inventory, 1, true);
    assert.deepEqual(inventory, original, 'planner must not mutate input');
    assert.equal(plan.purchaseItemCount, 0);
    assert.equal(plan.rawActions.length, 1);
    assert.deepEqual(
        Array.from(plan.compressedActions, (action) => [
            action.startLevel,
            action.targetLevel,
        ]),
        [[19, 20]]
    );
    const summary = Planner.summarize(
        [{itemId: 'x', plan}],
        'quick'
    );
    assert.equal(summary.consumedExisting[18], 1);
    assert.equal(summary.consumedExisting[19], 1);
    simulatePlan(plan);
}

{
    const inventory = new Array(21).fill(0);
    inventory[20] = 7;
    const plan = Planner.planTo20(inventory, 1, true);
    assert.equal(plan.purchases[9], 55);
    assert.equal(plan.purchases[10], 89);
    assert.equal(plan.remainingInventory[20], 7);
    assert.equal(plan.targetCount, 1);
}

{
    const quick91 = Planner.planTo20({}, 91, false);
    const quickSummary91 = Planner.summarize(
        [{itemId: 'x', plan: quick91}],
        'quick'
    );
    assert.equal(quickSummary91.sendCommands, 5005);
    Planner.validateSummary(quickSummary91);

    const verified50 = Planner.planTo20({}, 50, false);
    const verifiedSummary50 = Planner.summarize(
        [{itemId: 'x', plan: verified50}],
        'verified'
    );
    assert.equal(verifiedSummary50.sendCommands, 7150);
    Planner.validateSummary(verifiedSummary50);

    const verified70 = Planner.planTo20({}, 70, false);
    const verifiedSummary70 = Planner.summarize(
        [{itemId: 'x', plan: verified70}],
        'verified'
    );
    assert.equal(verifiedSummary70.sendCommands, 10010);
    assert.throws(
        () => Planner.validateSummary(verifiedSummary70),
        /超过安全上限/
    );

    assert.throws(
        () => Planner.validateSummary({
            outputs: 1,
            sendCommands: 1,
            purchaseItems: 0,
            mirrorCount: CONFIG.MAX_MIRROR_CONSUMPTION + 1,
        }),
        /贤者镜/
    );

    Planner.validateSummary({
        outputs: CONFIG.MAX_TOTAL_OUTPUTS,
        sendCommands: CONFIG.MAX_ENHANCE_COMMANDS,
        purchaseItems: CONFIG.MAX_PURCHASE_ITEMS,
        mirrorCount: CONFIG.MAX_MIRROR_CONSUMPTION,
    });
    assert.throws(
        () => Planner.validateSummary({
            outputs: 1,
            sendCommands: CONFIG.MAX_ENHANCE_COMMANDS + 1,
            purchaseItems: 0,
            mirrorCount: 1,
        }),
        /强化指令/
    );
    assert.throws(
        () => Planner.validateSummary({
            outputs: CONFIG.MAX_TOTAL_OUTPUTS + 1,
            sendCommands: 0,
            purchaseItems: 0,
            mirrorCount: 0,
        }),
        /新增/
    );
    assert.throws(
        () => Planner.validateSummary({
            outputs: 1,
            sendCommands: 1,
            purchaseItems: CONFIG.MAX_PURCHASE_ITEMS + 1,
            mirrorCount: 1,
        }),
        /采购/
    );
}

{
    assert.throws(() => Planner.planTo20({}, 0, false), /大于 0 的整数/);
    assert.throws(() => Planner.planTo20({}, 1.5, false), /大于 0 的整数/);
    assert.equal(new Set(EQUIPMENT_IDS).size, EQUIPMENT_IDS.length);
    for (const itemId of [
        'small_talisman_belt',
        'medium_talisman_belt',
        'large_talisman_belt',
    ]) {
        assert.equal(
            EQUIPMENT_IDS.filter((candidate) => candidate === itemId).length,
            1,
            `${itemId} must appear once in the selectable equipment catalogue`
        );
    }
    assert.equal(
        EQUIPMENT_IDS.some((itemId) => itemId.endsWith('_refined')),
        false
    );
}

{
    // Deterministic randomized property test with a command-level inventory
    // simulation. A tiny LCG keeps the test reproducible.
    let seed = 0x5eed1234;
    const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 0x100000000;
    };

    for (let iteration = 0; iteration < 5000; iteration++) {
        const inventory = new Array(21).fill(0);
        for (let level = 9; level <= 19; level++) {
            inventory[level] = Math.floor(random() * 5);
        }
        inventory[20] = Math.floor(random() * 4);
        const quantity = 1 + Math.floor(random() * 5);
        const snapshot = [...inventory];
        const plan = Planner.planTo20(inventory, quantity, true);
        assert.deepEqual(inventory, snapshot);
        assert.equal(
            plan.compressedActions.length,
            plan.rawActions.length - plan.linkCount
        );
        simulatePlan(plan);
    }
}

console.log('mwi_safe_enhancer planner tests: PASS');
