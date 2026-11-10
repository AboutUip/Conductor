# Task Scheduler SDK

A Node.js SDK for grouping callbacks into tasks and dispatching them on shared
intervals. The scheduler uses a greatest-common-divisor tick and an elapsed-time
accumulator to coordinate intervals.

## Build

From the repository root:

```sh
npm run build:sdk
```

The build emits CommonJS JavaScript and TypeScript declarations into `dist/`.

## Use

```js
const { Task, TaskScheduler } = require('@inspiration/task-scheduler');

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
