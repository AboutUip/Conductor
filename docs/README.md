# Conductor SDK API 文档

本文档说明 `sdk/src/index.ts` 导出的公开 API。SDK 使用 TypeScript 编写，运行于 Node.js。

## 导入

从 SDK 源码使用：

```ts
import {
  IntervalAccumulatorMap,
  isIntervalId,
  isTaskId,
  SchedulingType,
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
const { SchedulingType, Task, TaskScheduler } = require('@inspiration/task-scheduler');
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

时间轮模式使用 `SchedulingType.TimingWheel`：

```ts
import { SchedulingType, Task, TaskScheduler } from '../sdk/src/index.js';

const scheduler = new TaskScheduler(1000, SchedulingType.TimingWheel);
const task = new Task('cleanup', '定期清理缓存');

task.bindSyncCallback(() => {
  console.log('清理缓存');
}, { arguments: [] });

scheduler.addTask(task, 750);
scheduler.resume();

// 使用完毕后停止计时器，避免阻止 Node.js 进程退出。
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
| `deathTime` | `number` | 可读写的剩余存活时间（毫秒）；默认 `Infinity`。赋值非负安全整数会从赋值时刻重新倒计时；`Infinity` 表示永不过期。 |
| `syncCallbacks` | `ReadonlyArray<(...args: any[]) => any>` | 已绑定同步回调的只读快照。 |
| `syncArguments` | `ReadonlyArray<ReadonlyArray<any>>` | 同步回调实参的只读快照；内层实参数组也会复制。 |
| `syncThisArgs` | `ReadonlyArray<unknown>` | 同步回调 `this` 接收者的只读快照。 |
| `syncErrorHandlers` | `ReadonlyArray<(error: Error) => void>` | 同步回调错误处理器的只读快照。 |
| `asyncCallbacks` | `ReadonlyArray<(...args: any[]) => Promise<any>>` | 已绑定异步回调的只读快照。 |
| `asyncArguments` | `ReadonlyArray<ReadonlyArray<any>>` | 异步回调实参的只读快照；内层实参数组也会复制。 |
| `asyncThisArgs` | `ReadonlyArray<unknown>` | 异步回调 `this` 接收者的只读快照。 |
| `asyncErrorHandlers` | `ReadonlyArray<(error: Error) => void>` | 异步回调错误处理器的只读快照。 |

同步和异步回调属性仅提供 getter，返回的都是快照；修改快照不会影响任务内部状态。`deathTime` getter 返回剩余毫秒数，到期后为 `0`；setter 仅接受非负安全整数或 `Infinity`。到期检测独立于调度算法，并在调度器暂停或 `kill()` 后继续；各调度器独立移除自己的注册。事件循环阻塞会推迟清理，且已经开始执行的回调不会被取消；到期计时器不会单独阻止 Node.js 进程退出。

```ts
task.deathTime = 5000; // 5 秒后过期
console.log(task.deathTime); // 当前剩余毫秒数
task.deathTime = Infinity; // 恢复为永不过期
```

使用 `bindSyncCallback()` 和 `bindAsyncCallback()` 注册回调，使用 `removeSyncCallback()` 和 `removeAsyncCallback()` 按索引安全移除回调及其配套数据。

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

#### `removeSyncCallback(index): boolean`

移除指定索引的同步回调及其参数、`this` 接收者、错误处理器和一次性标记。索引无效时返回 `false`，移除成功时返回 `true`。

#### `removeAsyncCallback(index): boolean`

移除指定索引的异步回调及其参数、`this` 接收者、错误处理器和一次性标记。索引无效时返回 `false`，移除成功时返回 `true`。

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

按毫秒间隔派发任务。多个任务可以注册在同一个间隔。调度器支持三种调度模式，由 `SchedulingType` 指定；默认使用时间轮。

### 构造函数

```ts
new TaskScheduler(baseIntervalMs?: number, schedulingType?: SchedulingType)
```

- `baseIntervalMs`：默认任务间隔，默认 `1000` 毫秒；GCD 模式也将其作为初始 tick。必须为正安全整数，否则构造函数抛出 `RangeError`。省略 `addTask()` 的间隔时使用策略当前默认间隔。
- `schedulingType`：调度模式，默认 `SchedulingType.TimingWheel`；不支持的算法会抛出 `RangeError`。

| 模式 | 说明 |
|---|---|
| `SchedulingType.LeastCommonMultiple` | GCD tick 模式。根据基础间隔和任务周期的最大公约数选择重复 tick，并用单调时钟检查独立调度组的截止时间；迟到时合并已错过的周期。 |
| `SchedulingType.TimingWheel` | 时间轮模式。按最近任务组截止时间安排单个一次性计时器；相同周期可拥有独立相位，迟到时保留周期相位并合并错过的周期。 |
| `SchedulingType.Deadline` | 截止时间调度。按单调时钟上的绝对截止时间使用最小堆选择下一任务，由单个可重排计时器唤醒，并可在目标时刻前最多忙等 1 毫秒；迟到时合并错过的周期，不提供 1 毫秒精度或硬实时保证。 |

调度器初始处于暂停状态；所有模式都只在恢复且存在任务时启动计时。完成后调用 `kill()`，避免计时器阻止 Node.js 进程退出。
任务周期可以超过 Node.js 单个计时器的最大延迟；策略会在最大计时器延迟处重新检查截止时间，不会因此提前派发。

### 方法

#### `addTask(task, intervalMs?): TaskId | null`

将未过期任务注册到指定周期。`intervalMs` 以毫秒为单位，必须是正安全整数；省略时使用策略当前默认间隔。成功返回任务 ID，周期无效或任务已过期时返回 `null`。

```ts
const id = scheduler.addTask(task, 1000);
```

同一 `Task` 可被添加到不同周期或调度器。重复添加到相同周期会增加一次该任务的派发。

#### `updateTaskInterval(taskId, newIntervalMs, currentIntervalMs?): boolean`

运行中修改任务周期。新周期必须为正安全整数，并从修改时刻开始计算；被修改的任务会脱离原周期组，原组中的其他任务保持原有相位。省略 `currentIntervalMs` 时，更新该任务在此调度器中的全部注册；提供时仅更新该原周期下的注册。周期无效或未找到任务时返回 `false`。

此 API 仅调整固定周期任务的时间，不会把任务转换为单次超时或固定延时任务。若事件循环阻塞而错过多个周期，恢复后只派发一次，并跳过过期周期。

#### `setSchedulingType(schedulingType): void`

运行中切换此调度器的算法。所有任务注册都会保留，并从切换时刻重新开始周期；切换前已经到期的任务先按旧策略派发。若调度器处于暂停状态，切换后仍保持暂停。传入不支持的算法会抛出 `RangeError`。

每个调度器同一时刻使用一种算法；所有回调仍在 Node.js 主事件循环执行。策略只决定派发时机，不提供 Worker 线程执行。

#### `deleteTaskById(taskId, intervalMs?): boolean`

按任务 ID 移除任务。找到并移除时返回 `true`，否则返回 `false`。

- 提供有效的 `intervalMs` 时先在该周期查找。
- 若该周期无效、未提供，或在指定周期中没有找到任务，则会搜索所有周期。
- 移除某周期下最后一个任务时，该周期也会从调度器中移除。

#### `deleteTasksByInterval(intervalMs): boolean`

移除指定周期下的全部任务。周期必须为正安全整数；找到并移除时返回 `true`，否则返回 `false`。

#### `pause(): void`

暂停后续计时处理和任务派发。恢复时会继续剩余时间，不补发暂停期间的周期。已经启动的异步回调不会被取消。

#### `resume(): void`

恢复计时处理和任务派发。调度器初始暂停；调用 `kill()` 停止后，也可以再次调用 `resume()` 重启。所有模式都会按已记录的截止时间重新安排计时。

#### `kill(): void`

停止并清除内部计时器。可重复调用；之后可通过 `resume()` 重新启动。该方法不会取消已经启动的异步回调。

#### `greatestCommonDivisor(firstValue, ...remainingValues): number`

计算一个或多个安全整数的最大公约数。参数不是安全整数时抛出 `RangeError`。

#### `isPositiveInteger(value): boolean`

检查数值是否为正安全整数。

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

底层兼容工具类，继承自 `Map<number, IntervalId>`，并为间隔维护累计时间或剩余时间。当前 `TaskScheduler` 策略使用独立调度组和单调时钟截止时间；此类主要供直接调用方维护传统累计/剩余时间状态。

### 构造函数

```ts
new IntervalAccumulatorMap(entries?: Iterable<readonly [number, IntervalId]> | null)
```

传入构造函数的条目会写入 `Map`，但不会初始化对应的累计时间或剩余时间；需要参与调度的条目应使用下列扩展方法添加。

### 方法

- `setWithElapsedTime(intervalMs, intervalId): void`：写入映射并将该间隔的累计时间设为零。
- `setWithOriginalTime(intervalMs, intervalId): void`：写入映射并将该间隔的剩余时间初始化为其间隔值。
- `deleteWithTotalTime(intervalMs): boolean`：删除映射和累计状态；当前实现调用后始终返回 `true`。
- `advanceElapsedTime(tickIntervalMs): number[]`：为所有已跟踪间隔累加一个 tick，返回本次恰好到期的间隔，并将其累计时间归零。
- `getMinDiffTime(): number`：返回所有剩余时间中的最小值；没有已跟踪的剩余时间时返回 `Infinity`。
- `advanceOriginalTime(elapsedMs): number[]`：从所有剩余时间中扣除实际经过的 `elapsedMs`，返回到期的间隔，并安排下一周期；超过截止时间时保留周期相位，每次只报告一次到期。
- `resetElapsedTime(): void`：将所有已跟踪间隔的累计时间归零。

## 行为说明

- 间隔和 tick 的单位均为毫秒。
- Node.js 计时器受事件循环调度影响，实际派发时间可能晚于目标间隔。
- 累计模式增加新间隔会触发重新校准；重新校准过程中会清零已有间隔的累计时间。
- 暂停或停止调度器不会撤销已派发的异步工作。
- 各回调独立处理错误；默认错误处理器会将错误写入 `console.error`。