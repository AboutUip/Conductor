# Conductor

Conductor 是一个基于 TypeScript 和 Node.js 的任务调度示例项目，包含可复用的任务调度 SDK，以及一个模拟咖啡店日常运营的演示程序。

## 功能

- 将多个同步或异步回调绑定到同一个 `Task`，按任务类别一起派发。
- 通过 `TaskScheduler` 按毫秒间隔调度任务；多个任务可以共享间隔。
- 默认使用时间轮安排最近截止时间；也支持基于最大公约数 tick 轮询的 GCD 模式和截止时间调度模式。
- 支持运行时添加、按 ID 删除或调整任务周期；可在运行中切换调度算法，并暂停、恢复和停止调度器。
- 支持一次性回调、独立的 `this` 接收者和回调错误处理器。

## 环境要求

- Node.js
- npm

## 安装与构建

在仓库根目录安装开发依赖并编译演示程序：

```sh
npm install
npm run build
```

编译后的演示入口为 `dist/main.js`。单独构建或检查 SDK：

```sh
npm run build:sdk
npm run check:sdk
```

检查根目录的 TypeScript 演示程序：

```sh
npm run check
```

## 运行演示

构建后运行：

```sh
node dist/main.js
```

演示会启动门店运营、后台报表和控制调度器，展示动态添加和移除任务、暂停及恢复调度，并在约 16 秒后停止所有调度器。

## 快速开始

SDK 源码入口为 `sdk/src/index.ts`。以下示例展示核心 API：

```ts
import { Task, TaskScheduler } from './sdk/src/index.js';

const scheduler = new TaskScheduler(250);
const heartbeat = new Task('heartbeat', '周期性心跳');

heartbeat.bindSyncCallback(
  () => console.log('heartbeat'),
  { arguments: [] }
);

scheduler.addTask(heartbeat, 1000);
scheduler.resume();

// 示例运行 5 秒后停止调度器。
setTimeout(() => scheduler.kill(), 5000);
```

`TaskScheduler` 初始处于暂停状态；调用 `resume()` 后才会派发任务。`pause()` 会暂停后续派发，但不会取消已经启动的异步回调。暂停期间错过的周期不会在恢复时补发。

## API 文档

完整的 SDK API 说明、参数、返回值和调度行为请参阅 [docs/README.md](./docs/README.md)。

## 项目结构

```text
.
├── main.ts                  # 咖啡店调度演示
└── sdk/
    ├── README.md            # SDK 使用说明
    └── src/
        ├── index.ts
        ├── task.ts
        ├── task-scheduler.ts
        ├── task-types.ts
        └── interval-accumulator-map.ts
```

项目采用 MIT 许可证，详见 [LICENSE](./LICENSE)。