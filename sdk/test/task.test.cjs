const assert = require('node:assert/strict');
const test = require('node:test');
const { Task } = require('../dist/core/task.js');
const { SchedulingType } = require('../dist/types/task-types.js');
const { TaskScheduler } = require('../dist/core/task-scheduler.js');
const { IntervalAccumulatorMap } = require('../dist/structures/interval-accumulator-map.js');
const { DeadlineHeap } = require('../dist/structures/deadline-heap.js');
const { ScheduleGroupMap } = require('../dist/structures/schedule-group-map.js');

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

const schedulerModes = [
    {
        name: 'GCD-tick mode',
        create: () => new TaskScheduler(10, SchedulingType.LeastCommonMultiple),
    },
    {
        name: 'timing-wheel mode',
        create: () => new TaskScheduler(10, SchedulingType.TimingWheel),
    },
    {
        name: 'deadline mode',
        create: () => new TaskScheduler(10, SchedulingType.Deadline),
    },
];

const schedulingTypes = [
    SchedulingType.LeastCommonMultiple,
    SchedulingType.TimingWheel,
    SchedulingType.Deadline,
];

test('default scheduling mode schedules by the nearest task deadline', async () => {
    const scheduler = new TaskScheduler(1000);
    const recorded = createRecordedTask('default-timing-wheel-mode');
    const startedAt = performance.now();

    try {
        scheduler.addTask(recorded.task, 30);
        scheduler.resume();
        await waitForCallCount(recorded.calls, 1, 200);
        assert.ok(recorded.calls[0] >= startedAt + 30);
    } finally {
        scheduler.kill();
    }
});

function createRecordedTask(name) {
    const calls = [];
    const task = new Task(name, `Record dispatches for ${name}`);
    task.bindSyncCallback(() => calls.push(performance.now()), { arguments: [] });
    return { task, calls };
}

async function waitForCallCount(calls, count, timeoutMs = 500) {
    const deadline = performance.now() + timeoutMs;
    while (calls.length < count && performance.now() < deadline) {
        await wait(2);
    }
    assert.ok(calls.length >= count, `expected ${count} dispatches, received ${calls.length}`);
}

test('Task deathTime defaults to infinity and can be read, reset, and validated', async () => {
    const task = new Task('death-time-api', 'Test mutable death time');
    assert.equal(task.deathTime, Infinity);

    task.deathTime = 200;
    const initialRemaining = task.deathTime;
    assert.ok(initialRemaining > 0 && initialRemaining <= 200);
    await wait(15);
    assert.ok(task.deathTime < initialRemaining);

    task.deathTime = 1000;
    assert.ok(task.deathTime > 900 && task.deathTime <= 1000);
    task.deathTime = Number.MAX_SAFE_INTEGER;
    assert.notEqual(task.deathTime, Infinity);
    task.deathTime = 0;
    assert.equal(task.deathTime, 0);
    task.deathTime = Infinity;
    assert.equal(task.deathTime, Infinity);

    for (const invalidDeathTime of [-1, 1.5, Number.MIN_VALUE, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => {
            task.deathTime = invalidDeathTime;
        }, RangeError);
    }
});

for (const mode of schedulerModes) {
    test(`${mode.name} removes expired tasks before their first periodic dispatch`, async () => {
        const scheduler = mode.create();
        const recorded = createRecordedTask('expire-before-first-dispatch');
        recorded.task.deathTime = 70;

        try {
            scheduler.addTask(recorded.task, 300);
            scheduler.addTask(recorded.task, 400);
            scheduler.resume();
            await wait(100);

            assert.equal(recorded.calls.length, 0);
            assert.equal(recorded.task.deathTime, 0);
            assert.equal(scheduler.deleteTaskById(recorded.task.id), false);
            assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(300)), -1);
            assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(400)), -1);
            assert.equal(scheduler.addTask(recorded.task, 300), null);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} does not dispatch a task after its death time when the event loop stalls`, async () => {
        const scheduler = mode.create();
        const recorded = createRecordedTask('death-time-event-loop-stall');
        recorded.task.deathTime = 30;

        try {
            scheduler.addTask(recorded.task, 30);
            scheduler.resume();
            const blockUntil = performance.now() + 80;
            while (performance.now() < blockUntil) {}
            await wait(5);

            assert.equal(recorded.calls.length, 0);
            assert.equal(scheduler.deleteTaskById(recorded.task.id), false);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} dispatches shared and distinct intervals periodically`, async () => {
        const scheduler = mode.create();
        const first = createRecordedTask('shared-first');
        const second = createRecordedTask('shared-second');
        const slower = createRecordedTask('slower');
        const startedAt = performance.now();

        try {
            scheduler.addTask(first.task, 30);
            scheduler.addTask(second.task, 30);
            scheduler.addTask(slower.task, 60);
            scheduler.resume();
            await waitForCallCount(first.calls, 3, 500);

            assert.equal(first.calls.length, second.calls.length);
            assert.ok(Math.abs(first.calls[0] - second.calls[0]) < 10);
            assert.ok(first.calls[0] - startedAt >= 20);
            assert.ok(first.calls[0] - startedAt < 150);
            assert.ok(first.calls[1] > first.calls[0]);
            assert.ok(first.calls[1] - first.calls[0] < 120);
            assert.ok(slower.calls.length >= 1);
            assert.ok(slower.calls.length <= first.calls.length);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} schedules a newly added interval after registration`, async () => {
        const scheduler = mode.create();
        const existing = createRecordedTask('existing-interval');
        const inserted = createRecordedTask('inserted-interval');

        try {
            scheduler.addTask(existing.task, 240);
            scheduler.resume();
            await wait(25);
            const insertedAt = performance.now();
            scheduler.addTask(inserted.task, 70);
            await waitForCallCount(inserted.calls, 1, 220);

            assert.ok(inserted.calls[0] - insertedAt >= 50);
            assert.ok(inserted.calls[0] - insertedAt < 180);
            assert.equal(existing.calls.length, 0);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} updates one task without shifting its interval peers`, async () => {
        const scheduler = mode.create();
        const updated = createRecordedTask('updated-task');
        const peer = createRecordedTask('unchanged-peer');
        const targetIntervalPeer = createRecordedTask('existing-target-interval-peer');

        try {
            scheduler.addTask(updated.task, 80);
            scheduler.addTask(peer.task, 80);
            scheduler.addTask(targetIntervalPeer.task, 160);
            scheduler.resume();
            await waitForCallCount(updated.calls, 1, 300);
            await wait(20);

            const updatedAt = performance.now();
            assert.equal(scheduler.updateTaskInterval(updated.task.id, 160, 80), true);
            assert.equal(scheduler.updateTaskInterval(updated.task.id, 0), false);
            assert.equal(
                scheduler.updateTaskInterval(updated.task.id, Number.MAX_SAFE_INTEGER + 1),
                false
            );
            assert.equal(
                scheduler.updateTaskInterval(updated.task.id, 100, Number.MAX_SAFE_INTEGER + 1),
                false
            );
            const missing = new Task('missing', 'Missing');
            assert.equal(scheduler.updateTaskInterval(missing.id, 100), false);

            await waitForCallCount(peer.calls, 2, 200);
            await waitForCallCount(targetIntervalPeer.calls, 1, 200);
            assert.equal(updated.calls.length, 1);
            assert.ok(peer.calls[1] - peer.calls[0] >= 55);
            await waitForCallCount(updated.calls, 2, 350);
            assert.ok(updated.calls[1] - updatedAt >= 150);
            assert.ok(updated.calls[1] - updatedAt < 300);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} deleting deadlines preserves remaining tasks and removes empty intervals`, async () => {
        const scheduler = mode.create();
        const removedById = createRecordedTask('removed-by-id');
        const removedByInterval = createRecordedTask('removed-by-interval');
        const survivor = createRecordedTask('survivor');
        const startedAt = performance.now();

        try {
            scheduler.addTask(removedById.task, 40);
            scheduler.addTask(removedByInterval.task, 60);
            scheduler.addTask(survivor.task, 160);
            scheduler.resume();
            await wait(20);

            assert.equal(scheduler.deleteTaskById(removedById.task.id), true);
            assert.equal(scheduler.deleteTasksByInterval(60), true);
            assert.equal(scheduler.deleteTaskById(removedById.task.id), false);
            assert.equal(scheduler.deleteTasksByInterval(60), false);

            await waitForCallCount(survivor.calls, 1, 400);
            assert.ok(survivor.calls[0] - startedAt >= 125);
            assert.equal(removedById.calls.length, 0);
            assert.equal(removedByInterval.calls.length, 0);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} pause freezes scheduling and resume continues the remaining interval`, async () => {
        const scheduler = mode.create();
        const recorded = createRecordedTask('pause-resume');

        try {
            scheduler.addTask(recorded.task, 50);
            scheduler.resume();
            await waitForCallCount(recorded.calls, 1, 300);
            scheduler.pause();
            await wait(70);
            assert.equal(recorded.calls.length, 1);

            const resumedAt = performance.now();
            scheduler.resume();
            await waitForCallCount(recorded.calls, 2, 200);
            assert.ok(recorded.calls[1] - resumedAt >= 20);
            assert.ok(recorded.calls[1] - resumedAt < 150);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} kill stops timers and resume restarts scheduling`, async () => {
        const scheduler = mode.create();
        const recorded = createRecordedTask('kill-resume');

        try {
            scheduler.addTask(recorded.task, 50);
            scheduler.resume();
            await waitForCallCount(recorded.calls, 1, 300);
            scheduler.kill();
            await wait(70);
            assert.equal(recorded.calls.length, 1);

            const resumedAt = performance.now();
            scheduler.resume();
            await waitForCallCount(recorded.calls, 2, 200);
            assert.ok(recorded.calls[1] - resumedAt >= 20);
            assert.ok(recorded.calls[1] - resumedAt < 150);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} validates intervals and supports targeted deletion fallback`, () => {
        const scheduler = mode.create();
        const recorded = createRecordedTask('validation');
        const invalidIntervals = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];

        try {
            invalidIntervals.forEach((intervalMs) => {
                assert.equal(scheduler.addTask(recorded.task, intervalMs), null);
                assert.equal(scheduler.deleteTasksByInterval(intervalMs), false);
            });

            const firstId = scheduler.addTask(recorded.task, 40);
            const secondId = scheduler.addTask(recorded.task, 60);
            assert.equal(firstId, recorded.task.id);
            assert.equal(secondId, recorded.task.id);
            assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(40)), 40);
            assert.equal(scheduler.deleteTaskById(recorded.task.id, 40), true);
            assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(40)), -1);
            assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(60)), 60);

            // A valid but non-matching interval falls back to searching all intervals.
            assert.equal(scheduler.deleteTaskById(recorded.task.id, 80), true);
            assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(60)), -1);
            assert.equal(scheduler.deleteTaskById(recorded.task.id), false);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} supports the smallest and largest safe positive intervals while paused`, () => {
        const scheduler = mode.create();
        const recorded = createRecordedTask('interval-boundaries');

        try {
            assert.equal(scheduler.addTask(recorded.task, 1), recorded.task.id);
            assert.equal(scheduler.deleteTasksByInterval(1), true);

            assert.equal(
                scheduler.addTask(recorded.task, Number.MAX_SAFE_INTEGER),
                recorded.task.id
            );
            assert.equal(scheduler.deleteTaskById(recorded.task.id), true);
            assert.equal(scheduler.addTask(recorded.task, Number.MIN_VALUE), null);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} can resume empty, add while running, and add while paused`, async () => {
        const scheduler = mode.create();
        const first = createRecordedTask('add-while-running');
        const second = createRecordedTask('add-while-paused');

        try {
            scheduler.resume();
            await wait(20);
            assert.equal(first.calls.length, 0);

            const firstAddedAt = performance.now();
            scheduler.addTask(first.task, 40);
            await waitForCallCount(first.calls, 1, 180);
            assert.ok(first.calls[0] - firstAddedAt >= 25);

            scheduler.pause();
            scheduler.addTask(second.task, 40);
            await wait(55);
            assert.equal(second.calls.length, 0);

            scheduler.resume();
            await waitForCallCount(second.calls, 1, 180);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} dispatches coincident deadlines together`, async () => {
        const scheduler = mode.create();
        const faster = createRecordedTask('coincident-faster');
        const slower = createRecordedTask('coincident-slower');

        try {
            scheduler.addTask(faster.task, 40);
            scheduler.addTask(slower.task, 80);
            scheduler.resume();
            await waitForCallCount(slower.calls, 1, 300);
            await waitForCallCount(faster.calls, 2, 100);

            assert.ok(
                faster.calls.some((callAt) => Math.abs(callAt - slower.calls[0]) < 10),
                'the shared 80 ms deadline must dispatch both intervals in one scheduler pass'
            );
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} repeated registrations dispatch independently and delete together`, async () => {
        const scheduler = mode.create();
        const repeated = createRecordedTask('repeated-registration');
        const peer = createRecordedTask('repeated-registration-peer');

        try {
            scheduler.addTask(repeated.task, 40);
            scheduler.addTask(repeated.task, 40);
            scheduler.addTask(peer.task, 40);
            scheduler.resume();
            await waitForCallCount(peer.calls, 1, 250);
            assert.equal(repeated.calls.length, 2);

            assert.equal(scheduler.deleteTaskById(repeated.task.id), true);
            await waitForCallCount(peer.calls, 2, 150);
            assert.equal(repeated.calls.length, 2);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} coalesces missed fixed-rate periods after a blocked callback`, async () => {
        const scheduler = mode.create();
        const calls = [];
        const task = new Task('coalesced-periods', 'Block once and skip missed periods');
        task.bindSyncCallback(() => {
            calls.push(performance.now());
            if (calls.length === 1) {
                const blockUntil = performance.now() + 250;
                while (performance.now() < blockUntil) {}
            }
        }, { arguments: [] });

        try {
            scheduler.addTask(task, 80);
            scheduler.resume();
            await waitForCallCount(calls, 2, 500);
            assert.ok(calls[1] - calls[0] >= 200);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} permits callbacks to add and remove tasks reentrantly`, async () => {
        const scheduler = mode.create();
        const inserted = createRecordedTask('reentrant-insertion');
        const selfRemoving = new Task('self-removing', 'Remove itself from its callback');
        const selfRemovingCalls = [];
        let removedItself;
        let insertedAt;

        selfRemoving.bindSyncCallback(() => {
            selfRemovingCalls.push(performance.now());
            if (selfRemovingCalls.length === 1) {
                removedItself = scheduler.deleteTaskById(selfRemoving.id);
                insertedAt = performance.now();
                scheduler.addTask(inserted.task, 50);
            }
        }, { arguments: [] });

        try {
            scheduler.addTask(selfRemoving, 30);
            scheduler.resume();
            await waitForCallCount(inserted.calls, 1, 250);
            await wait(50);

            assert.equal(removedItself, true);
            assert.equal(selfRemovingCalls.length, 1);
            assert.ok(inserted.calls[0] - insertedAt >= 35);
            assert.ok(inserted.calls[0] - insertedAt < 160);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} can update its own period from a callback`, async () => {
        const scheduler = mode.create();
        const calls = [];
        let updatedAt;
        let updateResult;
        const task = new Task('reentrant-update', 'Change period from its callback');
        task.bindSyncCallback(() => {
            calls.push(performance.now());
            if (calls.length === 1) {
                updatedAt = performance.now();
                updateResult = scheduler.updateTaskInterval(task.id, 80, 30);
            }
        }, { arguments: [] });

        try {
            scheduler.addTask(task, 30);
            scheduler.resume();
            await waitForCallCount(calls, 2, 300);
            assert.equal(updateResult, true);
            assert.ok(calls[1] - updatedAt >= 65);
            assert.ok(calls[1] - updatedAt < 200);
        } finally {
            scheduler.kill();
        }
    });

    test(`${mode.name} can update a task while paused without dispatching it`, async () => {
        const scheduler = mode.create();
        const recorded = createRecordedTask('paused-update');

        try {
            scheduler.addTask(recorded.task, 60);
            scheduler.resume();
            await wait(10);
            scheduler.pause();
            assert.equal(scheduler.updateTaskInterval(recorded.task.id, 90, 60), true);
            await wait(100);
            assert.equal(recorded.calls.length, 0);

            const resumedAt = performance.now();
            scheduler.resume();
            await waitForCallCount(recorded.calls, 1, 250);
            assert.ok(recorded.calls[0] - resumedAt >= 75);
        } finally {
            scheduler.kill();
        }
    });
}

test('updating a task without a source interval moves all its registrations together', async () => {
    const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    const repeated = createRecordedTask('move-all-registrations');

    try {
        scheduler.addTask(repeated.task, 40);
        scheduler.addTask(repeated.task, 40);
        scheduler.addTask(repeated.task, 60);
        assert.equal(scheduler.updateTaskInterval(repeated.task.id, 80), true);
        assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(40)), -1);
        assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(60)), -1);

        scheduler.resume();
        await waitForCallCount(repeated.calls, 3, 250);
        assert.equal(repeated.calls.length, 3);
    } finally {
        scheduler.kill();
    }
});

test('updating with a source interval isolates only that task registration', () => {
    const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    const repeated = createRecordedTask('scoped-update');
    const peer = createRecordedTask('scoped-update-peer');

    try {
        scheduler.addTask(repeated.task, 40);
        scheduler.addTask(repeated.task, 60);
        scheduler.addTask(peer.task, 40);
        assert.equal(scheduler.updateTaskInterval(repeated.task.id, 80, 40), true);
        assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(40)), 40);
        assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(60)), 60);
        assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(80)), 80);
        assert.equal(scheduler.updateTaskInterval(repeated.task.id, 90, 120), false);
        assert.equal(scheduler.findIntervalMs(scheduler.createIntervalId(60)), 60);
    } finally {
        scheduler.kill();
    }
});

test('Task expiration continues while its scheduler is paused or killed', async () => {
    for (const stopMethod of ['pause', 'kill']) {
        const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
        const recorded = createRecordedTask(`expire-while-${stopMethod}`);
        recorded.task.deathTime = 50;

        try {
            scheduler.addTask(recorded.task, 300);
            scheduler.resume();
            scheduler[stopMethod]();
            await wait(80);

            assert.equal(recorded.task.deathTime, 0);
            assert.equal(scheduler.deleteTaskById(recorded.task.id), false);
        } finally {
            scheduler.kill();
        }
    }
});

test('changing Task deathTime reschedules earlier and later deadlines and Infinity cancels expiry', async () => {
    const scheduler = new TaskScheduler(10, SchedulingType.Deadline);
    const shortened = createRecordedTask('shortened-death-time');
    const extended = createRecordedTask('extended-death-time');
    const immortal = createRecordedTask('immortal-task');

    try {
        shortened.task.deathTime = 200;
        scheduler.addTask(shortened.task, 500);
        scheduler.resume();
        await wait(10);
        shortened.task.deathTime = 30;
        await wait(50);
        assert.equal(scheduler.deleteTaskById(shortened.task.id), false);

        extended.task.deathTime = 30;
        scheduler.addTask(extended.task, 500);
        await wait(10);
        extended.task.deathTime = 100;
        await wait(40);
        assert.ok(extended.task.deathTime > 0);
        assert.equal(scheduler.deleteTaskById(extended.task.id), true);

        immortal.task.deathTime = 30;
        scheduler.addTask(immortal.task, 500);
        await wait(10);
        immortal.task.deathTime = Infinity;
        await wait(40);
        assert.equal(scheduler.deleteTaskById(immortal.task.id), true);

        const immediate = createRecordedTask('immediate-death-time');
        scheduler.addTask(immediate.task, 500);
        immediate.task.deathTime = 0;
        assert.equal(scheduler.deleteTaskById(immediate.task.id), false);
        assert.equal(scheduler.addTask(immediate.task, 500), null);
    } finally {
        scheduler.kill();
    }
});

test('Task expiration cleanup remains local to each scheduler registration', async () => {
    const firstScheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    const secondScheduler = new TaskScheduler(10, SchedulingType.Deadline);
    const task = createRecordedTask('scheduler-local-expiration');
    task.task.deathTime = 120;

    try {
        firstScheduler.addTask(task.task, 20);
        secondScheduler.addTask(task.task, 20);
        firstScheduler.resume();
        secondScheduler.resume();
        assert.equal(firstScheduler.deleteTaskById(task.task.id), true);

        await waitForCallCount(task.calls, 1, 80);
        assert.equal(task.calls.length, 1);
        assert.equal(firstScheduler.deleteTaskById(task.task.id), false);
        await wait(100);
        assert.equal(secondScheduler.deleteTaskById(task.task.id), false);
    } finally {
        firstScheduler.kill();
        secondScheduler.kill();
    }
});

const algorithmSwitches = [
    [SchedulingType.LeastCommonMultiple, SchedulingType.TimingWheel],
    [SchedulingType.LeastCommonMultiple, SchedulingType.Deadline],
    [SchedulingType.TimingWheel, SchedulingType.LeastCommonMultiple],
    [SchedulingType.TimingWheel, SchedulingType.Deadline],
    [SchedulingType.Deadline, SchedulingType.LeastCommonMultiple],
    [SchedulingType.Deadline, SchedulingType.TimingWheel],
];

for (const [initialType, nextType] of algorithmSwitches) {
    test(`switching from ${initialType} to ${nextType} preserves tasks and restarts their periods`, async () => {
        const scheduler = new TaskScheduler(10, initialType);
        const recorded = createRecordedTask('switch-strategy');

        try {
            scheduler.addTask(recorded.task, 70);
            scheduler.resume();
            await waitForCallCount(recorded.calls, 1, 300);
            await wait(20);

            const switchedAt = performance.now();
            scheduler.setSchedulingType(nextType);
            await waitForCallCount(recorded.calls, 2, 300);
            assert.ok(recorded.calls[1] - switchedAt >= 60);
            assert.ok(recorded.calls[1] - switchedAt < 200);
        } finally {
            scheduler.kill();
        }
    });
}

for (const initialType of schedulingTypes) {
    const nextType = schedulingTypes.find((type) => type !== initialType);
    test(`switching from ${initialType} to ${nextType} inside a callback is reentrant-safe`, async () => {
        const scheduler = new TaskScheduler(10, initialType);
        const calls = [];
        let switchedAt;
        const task = new Task('callback-switch', 'Switch scheduling strategy from callback');
        task.bindSyncCallback(() => {
            calls.push(performance.now());
            if (calls.length === 1) {
                switchedAt = performance.now();
                scheduler.setSchedulingType(nextType);
            }
        }, { arguments: [] });

        try {
            scheduler.addTask(task, 60);
            scheduler.resume();
            await waitForCallCount(calls, 2, 300);
            assert.ok(calls[1] - switchedAt >= 50);
            assert.ok(calls[1] - switchedAt < 200);
        } finally {
            scheduler.kill();
        }
    });
}

test('switching algorithms while paused preserves the pause and restarts on resume', async () => {
    const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    const recorded = createRecordedTask('switch-while-paused');

    try {
        scheduler.addTask(recorded.task, 60);
        scheduler.resume();
        await waitForCallCount(recorded.calls, 1, 250);
        scheduler.pause();
        scheduler.setSchedulingType(SchedulingType.Deadline);
        await wait(70);
        assert.equal(recorded.calls.length, 1);

        const resumedAt = performance.now();
        scheduler.resume();
        await waitForCallCount(recorded.calls, 2, 220);
        assert.ok(recorded.calls[1] - resumedAt >= 45);
    } finally {
        scheduler.kill();
    }
});

test('switching algorithms preserves independently phased groups with the same interval', async () => {
    const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    const updated = createRecordedTask('switch-independent-phase');
    const peer = createRecordedTask('switch-independent-phase-peer');

    try {
        scheduler.addTask(updated.task, 70);
        scheduler.addTask(peer.task, 70);
        scheduler.resume();
        await waitForCallCount(updated.calls, 1, 250);
        await wait(20);
        assert.equal(scheduler.updateTaskInterval(updated.task.id, 70, 70), true);

        const switchedAt = performance.now();
        scheduler.setSchedulingType(SchedulingType.Deadline);
        await waitForCallCount(updated.calls, 2, 250);
        await waitForCallCount(peer.calls, 2, 250);
        assert.ok(updated.calls[1] - switchedAt >= 60);
        assert.ok(peer.calls[1] - switchedAt >= 60);
    } finally {
        scheduler.kill();
    }
});

test('switching algorithms repeatedly while empty keeps later registrations schedulable', async () => {
    const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    const recorded = createRecordedTask('switch-empty-scheduler');

    try {
        scheduler.resume();
        scheduler.setSchedulingType(SchedulingType.Deadline);
        scheduler.setSchedulingType(SchedulingType.LeastCommonMultiple);
        scheduler.addTask(recorded.task, 30);
        await waitForCallCount(recorded.calls, 1, 200);
    } finally {
        scheduler.kill();
    }
});

test('invalid runtime algorithm changes leave the current scheduler operational', async () => {
    const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    const recorded = createRecordedTask('invalid-strategy-switch');

    try {
        scheduler.addTask(recorded.task, 30);
        scheduler.resume();
        assert.throws(() => scheduler.setSchedulingType('unknown'), RangeError);
        await waitForCallCount(recorded.calls, 1, 200);
    } finally {
        scheduler.kill();
    }
});

test('constructor rejects unsupported scheduling types', () => {
    assert.throws(() => new TaskScheduler(10, 'unknown'), RangeError);
});

test('scheduler utilities validate integer inputs and produce stable interval IDs', () => {
    const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    try {
        assert.equal(scheduler.greatestCommonDivisor(120, 45, 30), 15);
        assert.equal(scheduler.greatestCommonDivisor(-12, 8), 4);
        assert.throws(() => scheduler.greatestCommonDivisor(1.5), RangeError);
        assert.throws(() => scheduler.greatestCommonDivisor(Number.MAX_SAFE_INTEGER + 1), RangeError);
        assert.equal(scheduler.isPositiveInteger(1), true);
        assert.equal(scheduler.isPositiveInteger(0), false);
        assert.equal(scheduler.isPositiveInteger(1.5), false);
        assert.equal(scheduler.isPositiveInteger(Number.MAX_SAFE_INTEGER), true);
        assert.equal(scheduler.isPositiveInteger(Number.MAX_SAFE_INTEGER + 1), false);

        const intervalId = scheduler.createIntervalId(123);
        assert.equal(intervalId.length, 256);
        assert.equal(scheduler.createIntervalId(123), intervalId);
        assert.notEqual(scheduler.createIntervalId(124), intervalId);
    } finally {
        scheduler.kill();
    }
});

test('all strategies reject invalid base intervals and accept the largest safe interval', () => {
    const invalidIntervals = [0, -1, Number.MIN_VALUE, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
    const types = [undefined, ...schedulingTypes];

    for (const type of types) {
        for (const intervalMs of invalidIntervals) {
            assert.throws(() => new TaskScheduler(intervalMs, type), RangeError);
        }

        const scheduler = new TaskScheduler(Number.MAX_SAFE_INTEGER, type);
        try {
            const task = new Task('largest-base', 'Largest safe base interval');
            assert.equal(scheduler.addTask(task), task.id);
        } finally {
            scheduler.kill();
        }
    }
});

test('all strategies clamp oversized timer delays to the Node.js timeout limit', () => {
    const maximumTimerDelay = 2_147_483_647;
    const intervalsToTest = [maximumTimerDelay, maximumTimerDelay + 1];
    const timeoutDelays = [];
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    global.setTimeout = (_callback, delayMs) => {
        timeoutDelays.push(delayMs);
        return { fakeTimer: 'timeout' };
    };
    global.clearTimeout = () => {};

    try {
        for (const type of schedulingTypes) {
            for (const intervalMs of intervalsToTest) {
                const scheduler = new TaskScheduler(intervalMs, type);
                try {
                    scheduler.addTask(new Task('long-delay', 'Long timer boundary'), intervalMs);
                    scheduler.resume();
                    const actualDelay = timeoutDelays.at(-1);
                    assert.ok(actualDelay <= maximumTimerDelay);
                    if (intervalMs > maximumTimerDelay) {
                        assert.ok(actualDelay >= maximumTimerDelay - 2);
                        if (type !== SchedulingType.Deadline) {
                            assert.equal(actualDelay, maximumTimerDelay);
                        }
                    }
                } finally {
                    scheduler.kill();
                }
            }
        }
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});

test('GCD mode rechecks long periods at the remaining deadline instead of drifting a full timer step', () => {
    const maximumTimerDelay = 2_147_483_647;
    const intervalMs = 3_000_000_000;
    const originalNow = performance.now;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    let now = 100;
    let scheduledTimer;
    let dispatchCount = 0;
    performance.now = () => now;
    global.setTimeout = (callback, delayMs) => {
        scheduledTimer = { callback, delayMs };
        return { fakeTimer: true };
    };
    global.clearTimeout = () => {};

    const scheduler = new TaskScheduler(intervalMs, SchedulingType.LeastCommonMultiple);
    const task = new Task('gcd-long-period', 'Long GCD period');
    task.bindSyncCallback(() => dispatchCount++, { arguments: [] });

    try {
        scheduler.addTask(task, intervalMs);
        scheduler.resume();
        assert.equal(scheduledTimer.delayMs, maximumTimerDelay);

        now += maximumTimerDelay;
        scheduledTimer.callback();
        assert.equal(dispatchCount, 0);
        assert.equal(scheduledTimer.delayMs, intervalMs - maximumTimerDelay);

        now += scheduledTimer.delayMs;
        scheduledTimer.callback();
        assert.equal(dispatchCount, 1);
    } finally {
        scheduler.kill();
        performance.now = originalNow;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});

test('one-shot strategies recheck long periods using only the remaining delay', () => {
    const maximumTimerDelay = 2_147_483_647;
    const intervalMs = 3_000_000_000;
    const originalNow = performance.now;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    try {
        for (const type of [SchedulingType.TimingWheel, SchedulingType.Deadline]) {
            let now = 100;
            let scheduledTimer;
            let dispatchCount = 0;
            performance.now = () => now;
            global.setTimeout = (callback, delayMs) => {
                scheduledTimer = { callback, delayMs };
                return { fakeTimer: true };
            };
            global.clearTimeout = () => {};

            const scheduler = new TaskScheduler(intervalMs, type);
            const task = new Task('long-one-shot-period', 'Long one-shot period');
            task.bindSyncCallback(() => dispatchCount++, { arguments: [] });
            try {
                scheduler.addTask(task, intervalMs);
                scheduler.resume();
                assert.equal(scheduledTimer.delayMs, maximumTimerDelay);

                now += maximumTimerDelay;
                scheduledTimer.callback();
                assert.equal(dispatchCount, 0);
                const expectedRemainingDelay = intervalMs - maximumTimerDelay
                    - (type === SchedulingType.Deadline ? 1 : 0);
                assert.ok(scheduledTimer.delayMs <= expectedRemainingDelay);
                assert.ok(scheduledTimer.delayMs >= expectedRemainingDelay - 2);
            } finally {
                scheduler.kill();
            }
        }
    } finally {
        performance.now = originalNow;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});

test('Task death timers cap and recheck lifetimes beyond the Node.js timer limit', () => {
    const maximumTimerDelay = 2_147_483_647;
    const lifetimeMs = 3_000_000_000;
    const originalNow = performance.now;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    let now = 100;
    let scheduledTimer;
    performance.now = () => now;
    global.setTimeout = (callback, delayMs) => {
        scheduledTimer = { callback, delayMs };
        return { unref() {} };
    };
    global.clearTimeout = () => {};

    const scheduler = new TaskScheduler(10, SchedulingType.TimingWheel);
    const task = new Task('long-death-time', 'Long death time');

    try {
        task.deathTime = lifetimeMs;
        scheduler.addTask(task, 10);
        assert.equal(scheduledTimer.delayMs, maximumTimerDelay);

        now += maximumTimerDelay;
        scheduledTimer.callback();
        assert.equal(task.deathTime, lifetimeMs - maximumTimerDelay);
        assert.equal(scheduledTimer.delayMs, lifetimeMs - maximumTimerDelay);

        now += scheduledTimer.delayMs;
        scheduledTimer.callback();
        assert.equal(task.deathTime, 0);
        assert.equal(scheduler.deleteTaskById(task.id), false);
    } finally {
        scheduler.kill();
        performance.now = originalNow;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});

test('interval accumulator tracks exact and overdue timing-wheel deadlines', () => {
    const intervals = new IntervalAccumulatorMap();
    const firstIntervalId = 'a'.repeat(256);
    const secondIntervalId = 'b'.repeat(256);

    assert.equal(intervals.getMinDiffTime(), Infinity);
    intervals.setWithOriginalTime(60, firstIntervalId);
    intervals.setWithOriginalTime(100, secondIntervalId);
    assert.deepEqual(intervals.advanceOriginalTime(40), []);
    assert.equal(intervals.getMinDiffTime(), 20);
    assert.deepEqual(intervals.advanceOriginalTime(25), [60]);
    assert.equal(intervals.getMinDiffTime(), 35);
    assert.deepEqual(intervals.advanceOriginalTime(45), [100]);
    assert.equal(intervals.getMinDiffTime(), 10);
    assert.deepEqual(intervals.advanceOriginalTime(10), [60]);
    assert.equal(intervals.getMinDiffTime(), 60);
    assert.equal(intervals.deleteWithTotalTime(60), true);
    assert.equal(intervals.has(60), false);
    assert.equal(intervals.getMinDiffTime(), 80);
});

test('schedule group map handles empty state, equal intervals, and coalesced overdue periods', () => {
    const groups = new ScheduleGroupMap();
    assert.equal(groups.size, 0);
    assert.equal(groups.nextDueAt(), Infinity);
    assert.deepEqual(groups.advanceDue(100), []);

    groups.add(1, 10, 10);
    groups.add(2, 10, 15);
    assert.equal(groups.size, 2);
    assert.equal(groups.nextDueAt(), 10);
    assert.deepEqual(groups.advanceDue(9), []);
    assert.deepEqual(groups.advanceDue(10), [1]);
    assert.equal(groups.nextDueAt(), 15);
    assert.deepEqual(groups.advanceDue(45), [1, 2]);
    assert.equal(groups.nextDueAt(), 50);
    assert.deepEqual(groups.advanceDue(49), []);
    assert.deepEqual(groups.advanceDue(50), [1]);

    assert.equal(groups.delete(1), true);
    assert.equal(groups.delete(1), false);
    assert.equal(groups.delete(2), true);
    assert.equal(groups.nextDueAt(), Infinity);
});

test('interval accumulator handles multiple overdue periods without returning zero delay', () => {
    const intervals = new IntervalAccumulatorMap();
    intervals.setWithOriginalTime(10, 'a'.repeat(256));

    assert.deepEqual(intervals.advanceOriginalTime(35), [10]);
    assert.equal(intervals.getMinDiffTime(), 5);
    assert.deepEqual(intervals.advanceOriginalTime(5), [10]);
    assert.equal(intervals.getMinDiffTime(), 10);
});

test('deadline heap preserves ordering through updates, arbitrary removals, and pops', () => {
    const deadlines = new DeadlineHeap();
    deadlines.set(1, 10, 100);
    deadlines.set(2, 20, 200);
    deadlines.set(3, 30, 300);
    deadlines.set(4, 40, 400);

    deadlines.set(3, 30, 50);
    assert.deepEqual(deadlines.peek(), { groupId: 3, intervalMs: 30, dueAt: 50 });
    deadlines.set(3, 30, 500);
    assert.deepEqual(deadlines.peek(), { groupId: 1, intervalMs: 10, dueAt: 100 });

    assert.equal(deadlines.delete(2), true);
    assert.equal(deadlines.delete(2), false);
    assert.deepEqual(deadlines.pop(), { groupId: 1, intervalMs: 10, dueAt: 100 });
    assert.deepEqual(deadlines.pop(), { groupId: 4, intervalMs: 40, dueAt: 400 });
    assert.deepEqual(deadlines.pop(), { groupId: 3, intervalMs: 30, dueAt: 500 });
    assert.equal(deadlines.pop(), undefined);
    assert.equal(deadlines.size, 0);
});

test('deadline heap moves an updated equal-time deadline ahead when its interval decreases', () => {
    const deadlines = new DeadlineHeap();
    deadlines.set(1, 20, 100);
    deadlines.set(2, 30, 100);
    deadlines.set(3, 40, 100);

    deadlines.set(3, 10, 100);

    assert.deepEqual(deadlines.peek(), { groupId: 3, intervalMs: 10, dueAt: 100 });
});

test('deadline heap preserves its index and ordering across deterministic random operations', () => {
    const deadlines = new DeadlineHeap();
    const expected = new Map();
    let randomState = 0x12345678;
    const nextRandom = () => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState;
    };

    for (let operation = 0; operation < 1000; operation++) {
        const groupId = nextRandom() % 32;
        const action = nextRandom() % 3;
        if (action === 0) {
            const intervalMs = (nextRandom() % 8) + 1;
            const dueAt = nextRandom() % 17;
            deadlines.set(groupId, intervalMs, dueAt);
            expected.set(groupId, { groupId, intervalMs, dueAt });
        } else if (action === 1) {
            assert.equal(deadlines.delete(groupId), expected.delete(groupId));
        } else {
            const first = [...expected.values()].sort((left, right) =>
                left.dueAt - right.dueAt
                || left.intervalMs - right.intervalMs
                || left.groupId - right.groupId
            )[0];
            assert.deepEqual(deadlines.pop(), first);
            if (first !== undefined) expected.delete(first.groupId);
        }

        const expectedFirst = [...expected.values()].sort((left, right) =>
            left.dueAt - right.dueAt
            || left.intervalMs - right.intervalMs
            || left.groupId - right.groupId
        )[0];
        assert.equal(deadlines.size, expected.size);
        assert.deepEqual(deadlines.peek(), expectedFirst);
    }
});

test('deadline mode does not dispatch before the scheduled deadline', async () => {
    const targetBase = performance.now();
    const scheduler = new TaskScheduler(10, SchedulingType.Deadline);
    const recorded = createRecordedTask('deadline-no-early-dispatch');
    const intervalMs = 35;

    try {
        scheduler.addTask(recorded.task, intervalMs);
        scheduler.resume();
        await waitForCallCount(recorded.calls, 1, 200);
        assert.ok(recorded.calls[0] >= targetBase + intervalMs);
    } finally {
        scheduler.kill();
    }
});

test('deadline mode coalesces missed periods instead of catch-up dispatching', async () => {
    const scheduler = new TaskScheduler(10, SchedulingType.Deadline);
    const calls = [];
    const recorded = new Task('coalesced-overrun', 'Block once to skip missed periods');
    recorded.bindSyncCallback(() => {
        calls.push(performance.now());
        if (calls.length === 1) {
            const blockUntil = performance.now() + 200;
            while (performance.now() < blockUntil) {}
        }
    }, { arguments: [] });

    try {
        scheduler.addTask(recorded, 40);
        scheduler.resume();
        await waitForCallCount(calls, 2, 500);
        assert.ok(calls[1] - calls[0] >= 180);
        assert.equal(calls.length, 2);
    } finally {
        scheduler.kill();
    }
});

test('unreleased HighPrecision name is not retained as a compatibility alias', () => {
    assert.equal('HighPrecision' in SchedulingType, false);
    assert.throws(() => new TaskScheduler(10, 'HighPrecision'), RangeError);
});

test('timing-wheel insertion reschedules to the new earlier deadline', async () => {
    const scheduler = new TaskScheduler(1000, SchedulingType.TimingWheel);
    let firedAt;
    let resolveFired;
    const fired = new Promise((resolve) => {
        resolveFired = resolve;
    });

    scheduler.addTask(new Task('existing', 'Existing later deadline'), 260);
    scheduler.resume();
    try {
        await wait(25);
        const insertedAt = performance.now();
        const earlierTask = new Task('earlier', 'New earlier deadline');
        earlierTask.bindSyncCallback(() => {
            firedAt = performance.now();
            resolveFired();
        }, { arguments: [] });
        scheduler.addTask(earlierTask, 80);

        await Promise.race([
            fired,
            wait(220).then(() => {
                throw new Error('new earlier deadline was not scheduled in time');
            }),
        ]);
        assert.ok(firedAt - insertedAt >= 65, 'task must not fire before its interval');
        assert.ok(firedAt - insertedAt < 200, 'task must not wait for the previous deadline');
    } finally {
        scheduler.kill();
    }
});

test('timing-wheel deletion does not advance remaining deadlines by a stale delay', async () => {
    const scheduler = new TaskScheduler(1000, SchedulingType.TimingWheel);
    let firedAt;
    let resolveFired;
    const fired = new Promise((resolve) => {
        resolveFired = resolve;
    });
    const remainingTask = new Task('remaining', 'Remaining later deadline');
    remainingTask.bindSyncCallback(() => {
        firedAt = performance.now();
        resolveFired();
    }, { arguments: [] });

    const removedTask = new Task('removed', 'Earlier deadline to remove');
    scheduler.addTask(removedTask, 75);
    scheduler.addTask(remainingTask, 250);
    const startedAt = performance.now();
    scheduler.resume();
    try {
        await wait(20);
        assert.equal(scheduler.deleteTaskById(removedTask.id), true);

        await Promise.race([
            fired,
            wait(400).then(() => {
                throw new Error('remaining deadline was not scheduled');
            }),
        ]);
        assert.ok(firedAt - startedAt >= 220, 'remaining task must not fire at the removed deadline');
    } finally {
        scheduler.kill();
    }
});

test('a throwing synchronous error handler is logged without escaping dispatch', () => {
    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args);

    try {
        const task = new Task('sync-error-handler', 'Test synchronous error handling');
        task.bindSyncCallback(
            () => {
                throw new Error('callback failed');
            },
            {
                arguments: [],
                onError: () => {
                    throw new Error('error handler failed');
                },
            }
        );

        assert.doesNotThrow(() => task.dispatch());
        assert.equal(errors.length, 1);
        assert.match(errors[0][0], /error handler failed/);
        assert.equal(errors[0][1].message, 'error handler failed');
        assert.equal(errors[0][3].message, 'callback failed');
    } finally {
        console.error = originalConsoleError;
    }
});

test('a throwing async error handler is logged without an unhandled rejection', async () => {
    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args);

    try {
        const task = new Task('async-error-handler', 'Test asynchronous error handling');
        task.bindAsyncCallback(
            async () => {
                throw new Error('callback rejected');
            },
            {
                arguments: [],
                onError: () => {
                    throw new Error('async error handler failed');
                },
            }
        );

        assert.doesNotThrow(() => task.dispatch());
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(errors.length, 1);
        assert.match(errors[0][0], /error handler failed/);
        assert.equal(errors[0][1].message, 'async error handler failed');
        assert.equal(errors[0][3].message, 'callback rejected');
    } finally {
        console.error = originalConsoleError;
    }
});

test('callback metadata getters return detached snapshots', async () => {
    const syncCalls = [];
    const asyncCalls = [];
    const task = new Task('snapshot-getters', 'Test callback metadata snapshots');

    task.bindSyncCallback((...args) => syncCalls.push(args), {
        arguments: ['sync argument'],
    });
    task.bindAsyncCallback(async (...args) => asyncCalls.push(args), {
        arguments: ['async argument'],
    });

    task.syncCallbacks.push(() => syncCalls.push(['injected']));
    task.syncArguments[0].push('injected');
    task.syncThisArgs[0] = null;
    task.syncErrorHandlers.pop();
    task.asyncCallbacks.push(async () => asyncCalls.push(['injected']));
    task.asyncArguments[0].push('injected');
    task.asyncThisArgs[0] = null;
    task.asyncErrorHandlers.pop();

    task.dispatch();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(syncCalls, [['sync argument']]);
    assert.deepEqual(asyncCalls, [['async argument']]);
});

test('controlled callback removal preserves aligned metadata and once indexes', async () => {
    const calls = [];
    const task = new Task('controlled-removal', 'Test controlled callback removal');

    task.bindSyncCallback((value) => calls.push(value), {
        arguments: ['removed sync'],
        once: true,
    });
    task.bindSyncCallback((value) => calls.push(value), {
        arguments: ['remaining sync'],
        once: true,
    });
    task.bindAsyncCallback(async (value) => calls.push(value), {
        arguments: ['removed async'],
        once: true,
    });
    task.bindAsyncCallback(async (value) => calls.push(value), {
        arguments: ['remaining async'],
        once: true,
    });

    assert.equal(task.removeSyncCallback(0), true);
    assert.equal(task.removeAsyncCallback(0), true);
    assert.equal(task.removeSyncCallback(5), false);
    assert.equal(task.removeAsyncCallback(-1), false);

    task.dispatch();
    task.dispatch();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, ['remaining async', 'remaining sync']);
});
