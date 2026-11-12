import { SchedulingType, Task, TaskScheduler } from './sdk/src/index.js';

/** 输出带本地时间戳的 demo 日志。 */
const log = (message: string): void => {
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
};

/** 控制调度器待执行的一次性事件。 */
interface ScheduledAction {
    /** 到期时间，使用 Date.now() 的毫秒时间戳。 */
    dueAt: number;
    /** 事件到期时执行的操作。 */
    callback: () => void;
}

/** 运行咖啡店任务调度示例。 */
function main(): void {
    // Task 表示一类任务：同一 Task 内的回调会在该 Task 被派发时一起执行。
    // 不同类别或负载使用独立的 Scheduler；示例间隔单位为毫秒。
    const storeScheduler = new TaskScheduler(500);
    const backOfficeScheduler = new TaskScheduler(1000);
    const controlScheduler = new TaskScheduler(250);
    const timingWheelScheduler = new TaskScheduler(1000, SchedulingType.TimingWheel);
    /** 待控制任务检查并派发的一次性事件队列。 */
    const pendingActions: ScheduledAction[] = [];

    // 一次性事件只排入队列，由单个控制 Task 统一检查和派发。
    // 控制 Task 每 250ms 检查一次，因此事件实际派发时间最多有一个 tick 的偏差。
    /**
     * 将操作排入队列，并按相对延迟计算其到期时间。
     * @param delayMs 从调用时刻起的延迟毫秒数。
     * @param callback 到期后执行的操作。
     */
    const scheduleAction = (delayMs: number, callback: () => void): void => {
        pendingActions.push({ dueAt: Date.now() + delayMs, callback });
    };

    /** 周期检查队列并执行所有已经到期的一次性事件。 */
    const timeoutTask = new Task('timeout-control', '处理待执行的一次性事件');
    timeoutTask.bindSyncCallback(
        (): void => {
            const now = Date.now();
            // 先收集到期事件，再从待处理队列移除，避免执行期间修改队列影响遍历。
            const dueActions = pendingActions.filter((action) => action.dueAt <= now);
            for (let index = pendingActions.length - 1; index >= 0; index--) {
                if (pendingActions[index].dueAt <= now) pendingActions.splice(index, 1);
            }
            // 一次性操作由控制 Task 统一派发，不为每个事件单独创建 Task。
            dueActions.forEach((action) => action.callback());
        },
        { arguments: [] }
    );
    controlScheduler.addTask(timeoutTask, 250);

    // 时间轮演示：用不同周期任务观察下一次到期时间及实际触发间隔。
    const timingWheelStartedAt = Date.now();
    [700, 1200].forEach((intervalMs) => {
        const task = new Task(`timing-wheel-${intervalMs}`, `时间轮 ${intervalMs}ms 周期测试`);
        let lastRunAt = timingWheelStartedAt;
        task.bindSyncCallback(
            (): void => {
                const now = Date.now();
                log(
                    `时间轮测试：目标 ${intervalMs}ms，实测间隔 ${now - lastRunAt}ms，`
                    + `运行总时长 ${now - timingWheelStartedAt}ms`
                );
                lastRunAt = now;
            },
            { arguments: [] }
        );
        timingWheelScheduler.addTask(task, intervalMs);
    });

    // 门店运营类别：收银台和库存检查属于同一类，每秒一起执行。
    const storeOperationsTask = new Task('store-operations', '门店日常运营');
    storeOperationsTask.bindSyncCallback(
        (station: string): void => {
            log(`${station}: 检查新订单`);
        },
        { arguments: ['收银台'] }
    );
    storeOperationsTask.bindSyncCallback(
        (items: string[]): void => {
            log(`库存检查：${items.join('、')}`);
        },
        { arguments: [['咖啡豆', '牛奶', '纸杯']] }
    );
    storeScheduler.addTask(storeOperationsTask, 1000);

    // 后台报表类别独立调度，每三秒派发；同类报表回调一起执行。
    const reportingTask = new Task('back-office-reports', '后台报表');
    // 同类报表回调绑定在同一个 Task 中，每次周期派发时都会一起启动。
    reportingTask.bindAsyncCallback(
        async (period: string): Promise<void> => {
            log(`开始生成${period}销售报表`);
            await Promise.resolve();
            log(`${period}销售报表已生成`);
        },
        { arguments: ['班次'] }
    );
    reportingTask.bindAsyncCallback(
        async (): Promise<void> => {
            await Promise.resolve();
            log('库存汇总报表已更新');
        },
        { arguments: [] }
    );
    backOfficeScheduler.addTask(reportingTask, 3000);

    log('咖啡店开始营业，启动门店、后台、控制与时间轮测试调度器');
    storeScheduler.resume();
    backOfficeScheduler.resume();
    controlScheduler.resume();
    timingWheelScheduler.resume();

    // 运行五秒后新增 750ms 的设备检查，观察调度器重新校准基础 tick。
    /** 动态注册的设备监控任务；后续移除时使用其 ID 定位。 */
    let equipmentTask: Task | null = null;
    // 新增一个任务类别，并在新增后再安排五秒后的清理操作。
    scheduleAction(5000, () => {
        equipmentTask = new Task('equipment-check', '检查咖啡机状态');
        equipmentTask.bindSyncCallback(
            (): void => {
                log('设备检查：咖啡机运行正常');
            },
            { arguments: [] }
        );
        storeScheduler.addTask(equipmentTask, 750);
        log('新增设备监控类别（每 750ms），门店调度器将重新校准');
        scheduleAction(5000, () => {
            if (equipmentTask) {
                const removed = storeScheduler.deleteTaskById(equipmentTask.id, 750);
                log(`移除设备监控类别：${removed}`);
            }
        });
    });

    // 控制调度器独立运行，因此能在其他调度器暂停期间恢复它们。
    // 12 秒时暂停业务调度器；控制调度器仍继续检查自己的队列。
    scheduleAction(12000, () => {
        storeScheduler.pause();
        backOfficeScheduler.pause();
        timingWheelScheduler.pause();
        log('店铺短暂打烊：暂停门店、后台与时间轮任务派发');
    });

    // 14 秒时恢复业务调度器；暂停期间不补算错过的周期。
    scheduleAction(14000, () => {
        storeScheduler.resume();
        backOfficeScheduler.resume();
        timingWheelScheduler.resume();
        log('店铺重新营业：恢复门店、后台与时间轮任务派发');
    });

    // 16 秒时停止全部调度器，确保 Node.js 进程可以正常退出。
    scheduleAction(16000, () => {
        storeScheduler.kill();
        backOfficeScheduler.kill();
        controlScheduler.kill();
        timingWheelScheduler.kill();
        log('演示结束：停止所有调度器');
    });
}

main();
