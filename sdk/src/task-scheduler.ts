import { Task } from './task.js';
import { IntervalId, TaskId, SchedulingType } from './task-types.js';
import { createHash } from 'node:crypto';
import { IntervalAccumulatorMap } from './interval-accumulator-map.js';

/**
 * 按毫秒间隔调度并派发 Task。
 * pause() 会停止后续计时处理；已经派发的异步回调会继续执行。
 */
export class TaskScheduler {

    // 驱动调度器的周期计时器；当前两种模式共用 setInterval。
    #tickTimer: ReturnType<typeof setInterval | typeof setTimeout> | undefined;

    // 当前 tick 间隔；新增间隔后会重新校准。
    #tickIntervalMs: number = 1000;

    // 保存任务间隔、对应标识及各间隔的累计时间。
    #intervalIdByDelay: IntervalAccumulatorMap = new IntervalAccumulatorMap();

    // 基于计时器ID(256)寻找Array<Task>
    #tasksByIntervalId: Map<IntervalId, Task[]> = new Map();

    // 是否需要校准
    #needsRecalibration: boolean = false;

    // 当前是否为暂停状态
    #isPaused: boolean = true;

    // 当前类的调度模式
    #scheduling: SchedulingType = SchedulingType.LeastCommonMultiple;

    // 按当前调度模式处理一次 tick。
    #onTick: () => void = () => {
        if (this.#scheduling === SchedulingType.TimingWheel) {
            this.#tickTimer = undefined;
        }

        // 暂停时不累计间隔，也不派发任务。
        if (this.#isPaused) return;

        // 依据真实调度类型进行选择性执行
        switch(this.#scheduling){
            // 基于间隔最大公约数确定 tick 的累计调度。
            case SchedulingType.LeastCommonMultiple:
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
                const dueIntervals: number[] = this.#intervalIdByDelay.advanceElapsedTime(this.#tickIntervalMs);
                dueIntervals.forEach((intervalMs) => {
                    this.#tasksByIntervalId.get(this.createIntervalId(intervalMs))
                        ?.forEach((task) => task.dispatch());
                });
                break;

            // 时间轮模式只在最近的任务到期时唤醒。
            case SchedulingType.TimingWheel:
                const minDelay = this.#intervalIdByDelay.getMinDiffTime();
                if (!Number.isFinite(minDelay)) return;

                const dueTimeout: number[] = this.#intervalIdByDelay.advanceOriginalTime(minDelay);
                dueTimeout.forEach((intervalMs) => {
                    this.#tasksByIntervalId.get(this.createIntervalId(intervalMs))
                        ?.forEach((task) => task.dispatch());
                });

                this.#scheduleTimingWheelTick();
                break;
        }
    };

    /**
     * 创建调度器并启动内部 tick 计时器。
     * @param baseIntervalMs 初始 tick 间隔，单位为毫秒。
     * @param schedulingType 要使用的调度模式。
     */
    constructor(baseIntervalMs: number = 1000,schedulingType: SchedulingType = SchedulingType.LeastCommonMultiple) {
        this.#tickIntervalMs = baseIntervalMs;
        this.#scheduling = schedulingType;

        // 仅累计算法需要执行
        if(schedulingType === SchedulingType.LeastCommonMultiple) this.#tickTimer = setInterval(this.#onTick, this.#tickIntervalMs);
    }

    /**
     * 计算给定整数的最大公约数，用于选择能整除各任务间隔的 tick。
     * @param firstValue 第一个整数。
     * @param remainingValues 其余整数。
     * @throws 参数不是安全整数时抛出 RangeError。
     */
    greatestCommonDivisor(firstValue: number, ...remainingValues: number[]): number {
        const values = [firstValue, ...remainingValues];
        if (!values.every(Number.isSafeInteger)) {
            throw new RangeError('Arguments must be safe integers');
        }

        let divisor: number = Math.abs(firstValue);
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
        let intervalId: string= '';
        for (let index: number = 0; index < 8; index++) {
            intervalId += createHash('md5')
                .update(intervalMs.toString() + String(index))
                .digest('hex');
        }
        return intervalId as IntervalId;
    }

    /** 根据 IntervalId 查找其对应的间隔；未找到时返回 -1。 */
    findIntervalMs(intervalId: IntervalId): number {
        let matchingIntervalMs: number = -1;
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
            return task.id;
        }

        const intervalId: IntervalId = this.createIntervalId(intervalMs);
        if(this.#scheduling === SchedulingType.TimingWheel){
            // 当前调度是时间轮
            this.#intervalIdByDelay.setWithOriginalTime(intervalMs, intervalId);
        }else{
            // 当前调度是累计
            this.#intervalIdByDelay.setWithElapsedTime(intervalMs, intervalId);
            this.#needsRecalibration = true;
        }
        this.#tasksByIntervalId.set(intervalId, [task]);
        if (
            this.#scheduling === SchedulingType.TimingWheel
            && !this.#isPaused
            && this.#tickTimer === undefined
        ) {
            this.#scheduleTimingWheelTick();
        }
        return task.id;
    }

    /** 按最近到期的任务启动时间轮的一次性计时器。 */
    #scheduleTimingWheelTick(): void {
        const delay = this.#intervalIdByDelay.getMinDiffTime();
        if (Number.isFinite(delay)) {
            this.#tickTimer = setTimeout(this.#onTick, delay);
        }
    }

    /**
     * 删除指定间隔下的全部任务。
     * @param intervalMs 要删除的间隔，单位为毫秒。
     * @returns 存在并删除该间隔时返回 true。
     */
    deleteTasksByInterval(intervalMs: number): boolean {
        if (!this.isPositiveInteger(intervalMs)) return false;
        return this.#intervalIdByDelay.has(intervalMs)
            ? this.#intervalIdByDelay.deleteWithTotalTime(intervalMs)
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
                    this.#intervalIdByDelay.deleteWithTotalTime(this.findIntervalMs(intervalId));
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
        if (
            this.#scheduling === SchedulingType.TimingWheel
            && this.#tickTimer !== undefined
        ) {
            clearTimeout(this.#tickTimer);
            this.#tickTimer = undefined;
        }
    }

    /** 停止内部 tick 计时器；后续可通过 resume() 重新启动。 */
    kill(): void {
        if (this.#tickTimer === undefined) return;
        if (this.#scheduling === SchedulingType.TimingWheel) {
            clearTimeout(this.#tickTimer);
        } else {
            clearInterval(this.#tickTimer);
        }
        this.#tickTimer = undefined;
    }

    /** 恢复 tick 处理和任务派发。 */
    resume(): void {
        this.#isPaused = false;
        if (this.#tickTimer === undefined && this.#scheduling === SchedulingType.LeastCommonMultiple) {
            this.#tickTimer = setInterval(this.#onTick, this.#tickIntervalMs);
        }else if(this.#tickTimer === undefined && this.#scheduling === SchedulingType.TimingWheel){
            this.#scheduleTimingWheelTick();
        }
    }
}
