import { Task } from './task.js';
import type { IntervalId, TaskId } from './task-types.js';
import { createHash } from 'node:crypto';
import { IntervalAccumulatorMap } from './interval-accumulator-map.js';

/**
 * 按毫秒间隔调度并派发 Task。
 * pause() 会停止后续计时处理；已经派发的异步回调会继续执行。
 */
export class TaskScheduler {
    #tickTimer: ReturnType<typeof setInterval> | undefined;
    #tickIntervalMs: number = 1000;
    #intervalIdByDelay: IntervalAccumulatorMap = new IntervalAccumulatorMap();
    #tasksByIntervalId: Map<IntervalId, Task[]> = new Map();
    #needsRecalibration = false;
    #isPaused = true;
    #onTick: () => void = () => {
        // 暂停时不累计间隔，也不派发任务。
        if (this.#isPaused) return;

        // 新增间隔后重新计算基础 tick，并从零开始累计。
        if (this.#needsRecalibration) {
            if (this.#tickTimer !== undefined) {
                clearInterval(this.#tickTimer);
                this.#tickTimer = undefined;
            }
            this.#tickIntervalMs = this.greatestCommonDivisor(
                this.#tickIntervalMs,
                ...this.#intervalIdByDelay.keys()
            );
            this.#needsRecalibration = false;
            this.#intervalIdByDelay.resetElapsedTime();
            this.#tickTimer = setInterval(this.#onTick, this.#tickIntervalMs);
            return;
        }

        // 累计经过时间，并派发所有到期间隔对应的任务。
        const dueIntervals = this.#intervalIdByDelay.advanceElapsedTime(this.#tickIntervalMs);
        dueIntervals.forEach((intervalMs) => {
            this.#tasksByIntervalId.get(this.createIntervalId(intervalMs))
                ?.forEach((task) => task.dispatch());
        });
    };

    /**
     * 创建调度器并启动内部 tick 计时器。
     * @param baseIntervalMs 初始 tick 间隔，单位为毫秒。
     */
    constructor(baseIntervalMs: number = 1000) {
        this.#tickIntervalMs = baseIntervalMs;
        this.#tickTimer = setInterval(this.#onTick, this.#tickIntervalMs);
    }

    /**
     * 计算任意数量整数的最大公约数。
     * @param firstValue 第一个整数。
     * @param remainingValues 其余整数。
     * @throws 参数不是安全整数时抛出 RangeError。
     */
    greatestCommonDivisor(firstValue: number, ...remainingValues: number[]): number {
        const values = [firstValue, ...remainingValues];
        if (!values.every(Number.isSafeInteger)) {
            throw new RangeError('Arguments must be safe integers');
        }

        let divisor = Math.abs(firstValue);
        for (const value of remainingValues) {
            let left = divisor;
            let right = Math.abs(value);
            while (right !== 0) {
                [left, right] = [right, left % right];
            }
            divisor = left;
        }
        return divisor;
    }

    /** 检查值是否为正整数。 */
    isPositiveInteger(value: number): boolean {
        return value > 0 && Number.isInteger(value);
    }

    /**
     * 根据间隔确定性地生成 256 字符 IntervalId。
     * @param intervalMs 间隔毫秒数。
     */
    createIntervalId(intervalMs: number): IntervalId {
        let intervalId = '';
        for (let index = 0; index < 8; index++) {
            intervalId += createHash('md5')
                .update(intervalMs.toString() + String(index))
                .digest('hex');
        }
        return intervalId as IntervalId;
    }

    /** 根据 IntervalId 查找其对应的间隔；未找到时返回 -1。 */
    findIntervalMs(intervalId: IntervalId): number {
        let matchingIntervalMs = -1;
        this.#intervalIdByDelay.forEach((storedIntervalId, intervalMs) => {
            if (storedIntervalId === intervalId) matchingIntervalMs = intervalMs;
        });
        return matchingIntervalMs;
    }

    /**
     * 将任务注册到指定间隔；多个任务可以共享同一间隔。
     * @param task 要注册的任务。
     * @param intervalMs 触发间隔，单位为毫秒；省略时使用当前 tick 间隔。
     * @returns 成功时返回任务 ID，间隔无效时返回 null。
     */
    addTask(task: Task, intervalMs: number = this.#tickIntervalMs): TaskId | null {
        if (!this.isPositiveInteger(intervalMs)) return null;

        if (this.#intervalIdByDelay.has(intervalMs)) {
            this.#tasksByIntervalId.get(this.#intervalIdByDelay.get(intervalMs) as IntervalId)?.push(task);
        } else {
            const intervalId = this.createIntervalId(intervalMs);
            this.#intervalIdByDelay.setWithElapsedTime(intervalMs, intervalId);
            this.#tasksByIntervalId.set(intervalId, [task]);
            this.#needsRecalibration = true;
        }
        return task.id;
    }

    /**
     * 删除指定间隔下的全部任务。
     * @param intervalMs 要删除的间隔，单位为毫秒。
     * @returns 存在并删除该间隔时返回 true。
     */
    deleteTasksByInterval(intervalMs: number): boolean {
        if (!this.isPositiveInteger(intervalMs)) return false;
        return this.#intervalIdByDelay.has(intervalMs)
            ? this.#intervalIdByDelay.deleteWithElapsedTime(intervalMs)
                && this.#tasksByIntervalId.delete(this.createIntervalId(intervalMs))
            : false;
    }

    /**
     * 按任务 ID 删除任务，可选地限定间隔。
     * @param taskId 要删除的任务 ID。
     * @param intervalMs 指定间隔时只检查该间隔；省略或无效时搜索所有间隔。
     * @returns 找到并删除任务时返回 true。
     */
    deleteTaskById(taskId: TaskId, intervalMs: number | null = null): boolean {
        let wasDeleted = false;

        // 在指定间隔中筛选目标任务；若该间隔最后一个任务被移除，同时清理间隔累计状态。
        const removeTaskFromInterval = (tasks: Task[], intervalId: IntervalId): void => {
            const remainingTasks = tasks.filter((task) => {
                if (task.id !== taskId) return true;
                if (tasks.length === 1) {
                    this.#intervalIdByDelay.deleteWithElapsedTime(this.findIntervalMs(intervalId));
                }
                wasDeleted = true;
                return !wasDeleted;
            });
            this.#tasksByIntervalId.set(intervalId, remainingTasks);
        };

        // 若指定间隔中找到了任务，无需再遍历全部间隔。
        if (
            typeof intervalMs === 'number'
            && this.isPositiveInteger(intervalMs)
            && this.#intervalIdByDelay.has(intervalMs)
            && this.#tasksByIntervalId.has(this.createIntervalId(intervalMs))
        ) {
            const intervalId = this.createIntervalId(intervalMs);
            removeTaskFromInterval(this.#tasksByIntervalId.get(intervalId)!, intervalId);
            if (wasDeleted) return true;
        }

        // 未在指定间隔中找到时，回退到所有间隔中搜索。
        this.#tasksByIntervalId.forEach((tasks, intervalId) => {
            removeTaskFromInterval(tasks, intervalId);
        });
        return wasDeleted;
    }

    /** 暂停后续 tick 处理和任务派发；不取消已经派发的异步回调。 */
    pause(): void {
        this.#isPaused = true;
    }

    /** 停止内部 tick 计时器；后续可通过 resume() 重新启动。 */
    kill(): void {
        if (this.#tickTimer === undefined) return;
        clearInterval(this.#tickTimer);
        this.#tickTimer = undefined;
    }

    /** 恢复 tick 处理和任务派发。 */
    resume(): void {
        this.#isPaused = false;
        if (this.#tickTimer === undefined) {
            this.#tickTimer = setInterval(this.#onTick, this.#tickIntervalMs);
        }
    }
}
