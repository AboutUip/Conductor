# Conductor SDK API 文档

本文档说明 `sdk/src/index.ts` 导出的公开 API。SDK 使用 TypeScript 编写，运行于 Node.js。

## 导入

从 SDK 源码使用：

```ts
import {
  IntervalAccumulatorMap,
  isIntervalId,
  isTaskId,
  Task,
  TaskScheduler,
} from '../sdk/src/index.js';
import type {
  IntervalId,
  TaskId,
  TaskOptions,
} from '../sdk/src/index.js';
```

构建后的 SDK 使用 CommonJS：

```js
const { Task, TaskScheduler } = require('@inspiration/task-scheduler');
```

## 快速开始

```ts
import { Task, TaskScheduler } from '../sdk/src/index.js';

const scheduler = new TaskScheduler(250);
const task = new Task('heartbeat', '每秒发送心跳');

task.bindSyncCallback(
  (label: string) => console.log(label),
  { arguments: ['heartbeat'] },
);

const taskId = scheduler.addTask(task, 1000);
if (taskId === null) {
  throw new Error('无效的任务间隔');
}

scheduler.resume();

// 使用完毕后停止计时器，避免它继续阻止 Node.js 进程退出。
setTimeout(() => scheduler.kill(), 5000);
```

## `Task`

表示一组在同一调度周期中一起派发的同步和异步回调。

### 构造函数

```ts
new Task(name: string, description: string, existingTaskIds?: Set<TaskId> | null)
```

- `name`：任务名称。
- `description`：任务用途说明。
- `existingTaskIds`：可选的已占用 ID 集合；传入后会生成一个不在集合中的 ID。

每个实例都会生成 `TaskId`。ID 由随机字符串构成，不应作为持久化或安全凭据。

### 属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 任务名称，只读。 |
| `description` | `string` | 任务描述，只读。 |
| `id` | `TaskId` | 任务 ID，只读。 |
| `syncCallbacks` | `Array<(...args: any[]) => any>` | 已绑定的同步回调列表。 |
| `syncArguments` | `any[][]` | 与同步回调对应的参数列表。 |
| `syncThisArgs` | `unknown[]` | 与同步回调对应的 `this` 接收者。 |
| `syncErrorHandlers` | `Array<(error: Error) => void>` | 与同步回调对应的错误处理器。 |
| `asyncCallbacks` | `Array<(...args: any[]) => Promise<any>>` | 已绑定的异步回调列表。 |
| `asyncArguments` | `any[][]` | 与异步回调对应的参数列表。 |
| `asyncThisArgs` | `unknown[]` | 与异步回调对应的 `this` 接收者。 |
| `asyncErrorHandlers` | `Array<(error: Error) => void>` | 与异步回调对应的错误处理器。 |

回调列表及其配套数组提供 getter 和 setter，返回或替换的是内部数组。直接修改时必须保持各数组索引对应；一般应使用绑定方法注册回调。

### `TaskOptions`

传给回调绑定方法的选项：

```ts
interface TaskOptions {
  arguments: any[];
  thisArg?: unknown;
  onError?: (error: Error) => void;
  once?: boolean;
}
```

- `arguments`：调用回调时传入的参数数组。
- `thisArg`：回调中的 `this`；省略时使用当前 `Task` 实例。
- `onError`：回调同步抛错或异步拒绝时调用。省略时写入 `console.error`。
- `once`：设为 `true` 时只执行一次；省略或为 `false` 时，每次任务派发都会执行。

### 方法

#### `bindSyncCallback(callback, options): void`

绑定同步回调。`options` 的类型为 `TaskOptions`。

```ts
task.bindSyncCallback(
  (userId: number) => console.log(userId),
  { arguments: [42], once: true },
);
```

同步回调抛出的异常会交给对应的 `onError` 处理器，不会阻止该任务的其他回调继续执行。

#### `bindAsyncCallback(callback, options): void`

绑定返回 `Promise` 的异步回调。异步回调会启动但不会阻塞任务派发；拒绝的 Promise 会交给对应的 `onError` 处理器。

```ts
task.bindAsyncCallback(
  async (userId: number) => {
    await saveUser(userId);
  },
  { arguments: [42], once: true },
);
```

#### `runSyncCallbacks(): boolean`

立即按绑定顺序执行同步回调。执行完成后返回 `true`。

#### `dispatchAsyncCallbacks(): boolean`

启动全部异步回调但不等待完成。派发后返回 `true`。

#### `dispatch(): void`

派发该任务的回调：先启动异步回调，再执行同步回调。不会等待异步回调完成。

#### `generateTaskId(): TaskId`

生成一个随机任务 ID。

#### `createUniqueTaskId(existingTaskIds: Set<TaskId>): TaskId`

生成一个不包含在给定集合中的任务 ID。

## `TaskScheduler`

按毫秒间隔派发任务。多个任务可以注册在同一个间隔。调度器用基础 tick 和已注册间隔的最大公约数协调周期；新增间隔时会重新校准，并重置间隔累计时间。

### 构造函数

```ts
new TaskScheduler(baseIntervalMs?: number)
```

`baseIntervalMs` 是初始基础 tick，默认 `1000` 毫秒。请传入正整数；构造函数本身不校验该值。构造时会创建内部计时器，但调度器初始处于暂停状态；计时器仍可能阻止 Node.js 进程退出，因此完成后应调用 `kill()`。

### 方法

#### `addTask(task, intervalMs?): TaskId | null`

将任务注册到指定周期。`intervalMs` 以毫秒为单位，必须是正整数；省略时使用当前基础 tick。成功返回任务 ID，无效周期返回 `null`。

```ts
const id = scheduler.addTask(task, 1000);
```

同一 `Task` 可被添加到不同周期或调度器。重复添加到相同周期会增加一次该任务的派发。

#### `deleteTaskById(taskId, intervalMs?): boolean`

按任务 ID 移除任务。找到并移除时返回 `true`，否则返回 `false`。

- 提供有效的 `intervalMs` 时先在该周期查找。
- 若该周期无效、未提供，或在指定周期中没有找到任务，则会搜索所有周期。
- 移除某周期下最后一个任务时，该周期也会从调度器中移除。

#### `deleteTasksByInterval(intervalMs): boolean`

移除指定周期下的全部任务。周期必须为正整数；找到并移除时返回 `true`，否则返回 `false`。

#### `pause(): void`

暂停后续 tick 处理和任务派发。暂停期间不累计时间，错过的周期不会在恢复时补发。已经启动的异步回调不会被取消。

#### `resume(): void`

恢复 tick 处理和任务派发。调度器初始暂停；调用 `kill()` 停止后，也可以再次调用 `resume()` 重启。

#### `kill(): void`

停止并清除内部计时器。可重复调用；之后可通过 `resume()` 重新启动。该方法不会取消已经启动的异步回调。

#### `greatestCommonDivisor(firstValue, ...remainingValues): number`

计算一个或多个安全整数的最大公约数。参数不是安全整数时抛出 `RangeError`。

#### `isPositiveInteger(value): boolean`

检查数值是否大于零且为整数。

#### `createIntervalId(intervalMs): IntervalId`

根据间隔确定性地生成 256 字符的间隔标识。

#### `findIntervalMs(intervalId): number`

查找标识对应的间隔毫秒数；找不到时返回 `-1`。

## ID 类型与类型守卫

### `TaskId` 与 `isTaskId(value)`

`TaskId` 是任务标识的品牌字符串类型。`isTaskId(value: string): value is TaskId` 检查字符串是否符合 `Task` 当前生成的格式（下划线开头，后接最多 7 个小写字母或数字）。

### `IntervalId` 与 `isIntervalId(value)`

`IntervalId` 是间隔标识的品牌字符串类型。`isIntervalId(value: string): value is IntervalId` 检查字符串长度是否为 256；它只验证长度，不验证标识是否由调度器生成。

## `IntervalAccumulatorMap`

底层工具类，继承自 `Map<number, IntervalId>`，并为间隔维护已累计的毫秒数。常规调度使用 `TaskScheduler` 即可；直接使用时，应通过扩展方法同步维护累计状态。

### 构造函数

```ts
new IntervalAccumulatorMap(entries?: Iterable<readonly [number, IntervalId]> | null)
```

传入构造函数的条目会写入 `Map`，但不会初始化对应的累计时间；需要参与累计的条目应使用 `setWithElapsedTime()` 添加。

### 方法

- `setWithElapsedTime(intervalMs, intervalId): void`：写入映射并将该间隔的累计时间设为零。
- `deleteWithElapsedTime(intervalMs): boolean`：删除映射和累计状态；当前实现调用后始终返回 `true`。
- `advanceElapsedTime(tickIntervalMs): number[]`：为所有已跟踪间隔累加一个 tick，返回本次恰好到期的间隔，并将其累计时间归零。
- `resetElapsedTime(): void`：将所有已跟踪间隔的累计时间归零。

## 行为说明

- 间隔和 tick 的单位均为毫秒。
- 增加新间隔会触发重新校准；重新校准过程中会清零已有间隔的累计时间。
- 暂停或停止调度器不会撤销已派发的异步工作。
- 各回调独立处理错误；默认错误处理器会将错误写入 `console.error`。