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

`Task.deathTime` is the remaining lifetime in milliseconds. It defaults to
`Infinity`; assigning a non-negative safe integer restarts its countdown, while
assigning `Infinity` disables expiration. Each scheduler independently removes
its registrations when the task expires, even while paused or killed. Expiration
does not interrupt callbacks that have already started, cannot run while the
event loop is blocked, and does not keep the process alive by itself.

## Scheduling modes

The default mode, `SchedulingType.TimingWheel`, schedules a one-shot timer for
the next task-group deadline using a monotonic clock.
Task intervals are supplied in milliseconds:

```js
const scheduler = new TaskScheduler(1000);
```

The base interval and explicit task intervals must be positive safe integers.
The constructor throws `RangeError` for an invalid base interval, while
`addTask()` returns `null` for an invalid task interval. Delays above Node.js's
single-timer limit are rechecked in bounded timer-sized steps without
dispatching before the task deadline.

To use the GCD-tick mode instead, pass
`SchedulingType.LeastCommonMultiple`. It polls task-group deadlines on a
repeating tick derived from the greatest common divisor of the base interval
and task periods. Late periods are coalesced, while task phases remain anchored
to monotonic-clock deadlines.

For deadline-driven scheduling, use `SchedulingType.Deadline`. It keeps
absolute deadlines in a min-heap, uses one re-armed timer, and may busy-spin
for up to the final millisecond before a deadline. Late periods are coalesced
instead of being dispatched in a catch-up burst. This is best-effort timing,
not a 1 ms or hard real-time guarantee: OS scheduling and event-loop blocking
can delay dispatch.

## Runtime scheduling changes

`scheduler.updateTaskInterval(taskId, newIntervalMs, currentIntervalMs?)`
changes a periodic task's interval while the scheduler is running. The updated
task starts a new period from the update time; peers in its former interval
group keep their existing deadlines. Omitting `currentIntervalMs` updates all
registrations of that task in the scheduler. Missed periods are coalesced
instead of being replayed.

`scheduler.setSchedulingType(SchedulingType.Deadline)` switches the algorithm
for the entire scheduler. Registered tasks are retained and their periods
restart from the switch time. The scheduler remains paused if it was paused
before the change. Scheduling strategies control dispatch timing only; task
callbacks still execute on Node.js's main event loop.

## Internal structure

`TaskScheduler` owns task registration and dispatch. Timer and interval tracking
are implemented by internal strategies behind `SchedulingStrategy`; the
factory selects the strategy for each `SchedulingType`. To add an algorithm,
implement the strategy interface and register it in the factory without adding
algorithm-specific timer logic to `TaskScheduler`.

Source is grouped by responsibility: `src/core/` contains task and scheduler
facades, `src/strategies/` contains algorithm implementations, `src/structures/`
contains deadline and interval data structures, and `src/types/` and `src/utils/`
contain shared types and helpers. The package entry point remains `src/index.ts`.
