# Task Scheduler SDK

A Node.js SDK for grouping callbacks into tasks and dispatching them on shared
intervals. It supports a greatest-common-divisor elapsed-time scheduler and a
one-shot-timer-based timing-wheel scheduler.

## Build

From the repository root:

```sh
npm run build:sdk
```

The build emits CommonJS JavaScript and TypeScript declarations into `dist/`.

## Use

```js
const {
  SchedulingType,
  Task,
  TaskScheduler,
} = require('@inspiration/task-scheduler');

const scheduler = new TaskScheduler(250);
const task = new Task('heartbeat', 'Periodic heartbeat');

task.bindSyncCallback(() => {
  console.log('heartbeat');
}, { arguments: [] });

scheduler.addTask(task, 1000);
scheduler.resume();
```

Call `scheduler.kill()` when the scheduler should no longer hold the Node.js
event loop open. Pausing or killing a scheduler does not cancel asynchronous
callbacks that were already dispatched.

## Scheduling modes

The default mode, `SchedulingType.LeastCommonMultiple`, coordinates task
intervals using an elapsed-time accumulator and a greatest-common-divisor tick.
To use the timing-wheel mode, pass `SchedulingType.TimingWheel` as the second
constructor argument:

```js
const scheduler = new TaskScheduler(1000, SchedulingType.TimingWheel);
```

In timing-wheel mode, the scheduler arms a one-shot timer for the next task
deadline instead of polling at the base tick. Task intervals are supplied in
milliseconds, just as in the default mode.
