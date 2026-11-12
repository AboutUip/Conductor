const assert = require('node:assert/strict');
const test = require('node:test');
const { Task } = require('../dist/task.js');

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
