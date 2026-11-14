import { createHash } from 'node:crypto';
import { createSchedulingStrategy } from '../strategies/scheduling-strategy-factory.js';
import { greatestCommonDivisor } from '../utils/greatest-common-divisor.js';
import { DeadlineHeap } from '../structures/deadline-heap.js';
import type { IntervalId, TaskId } from '../types/task-types.js';
import { SchedulingType } from '../types/task-types.js';
import { subscribeToTaskDeathTimeChanges, Task } from './task.js';
import type { SchedulingStrategy } from '../strategies/scheduling-strategy.js';

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

interface ScheduleGroup {
    intervalMs: number;
    tasks: Task[];
    isDefaultGroup: boolean;
}

interface TaskDeathTimeSubscription {
    heapId: number;
    listener: () => void;
    unsubscribe: () => void;
}

/**
 * 注册并派发 Task，计时行为委托给选定的调度策略。
 * 运行中可独立调整任务周期或切换调度策略；已经派发的异步回调不会被取消。
 */
export class TaskScheduler {
    #scheduleGroups: Map<number, ScheduleGroup> = new Map();
    #defaultGroupByIntervalMs: Map<number, number> = new Map();
    #strategy: SchedulingStrategy;
    #baseIntervalMs: number;
    #schedulingType: SchedulingType;
    #nextGroupId = 0;
    #isPaused = true;
    #isSwitchingStrategy = false;
    #deathTimeSubscriptions: Map<Task, TaskDeathTimeSubscription> = new Map();
    #taskByDeathTimeHeapId: Map<number, Task> = new Map();
    #deathTimeHeap = new DeadlineHeap();
    #nextDeathTimeHeapId = 0;
    #deathTimer: ReturnType<typeof setTimeout> | undefined;

    #onDeathTimer = (): void => {
        this.#deathTimer = undefined;
        const now = performance.now();
        let deadline = this.#deathTimeHeap.peek();
        while (deadline !== undefined && deadline.dueAt <= now) {
            const task = this.#taskByDeathTimeHeapId.get(deadline.groupId);
            if (task === undefined) {
                this.#deathTimeHeap.pop();
            } else if (task.deathTime <= 0) {
                this.#deathTimeHeap.pop();
            } else {
                this.#updateTaskDeathTime(task);
            }
            deadline = this.#deathTimeHeap.peek();
        }
        this.#removeExpiredTasks();
        this.#rescheduleDeathTimer();
    };

    /**
     * 创建使用指定间隔策略的调度器。
     * @param baseIntervalMs 默认任务间隔，单位为毫秒；GCD 模式也将其作为初始 tick。
     * @param schedulingType 要使用的调度算法；省略时使用时间轮。
     * @throws {RangeError} 当基础间隔不是正安全整数或算法不受支持时。
     */
    constructor(
        baseIntervalMs: number = 1000,
        schedulingType: SchedulingType = SchedulingType.TimingWheel
    ) {
        if (!Number.isSafeInteger(baseIntervalMs) || baseIntervalMs <= 0) {
            throw new RangeError('baseIntervalMs must be a positive safe integer.');
        }
        this.#baseIntervalMs = baseIntervalMs;
        this.#schedulingType = schedulingType;
        this.#strategy = this.#createStrategy(schedulingType);
    }

    /** 计算安全整数的最大公约数。 */
    greatestCommonDivisor(firstValue: number, ...remainingValues: number[]): number {
        return greatestCommonDivisor(firstValue, ...remainingValues);
    }

    /** 检查数值是否为正安全整数。 */
    isPositiveInteger(value: number): boolean {
        return Number.isSafeInteger(value) && value > 0;
    }

    /**
     * 根据间隔确定性地生成 256 字符标识。
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

    /** 根据标识查找间隔；找不到时返回 -1。 */
    findIntervalMs(intervalId: IntervalId): number {
        for (const group of this.#scheduleGroups.values()) {
            if (this.createIntervalId(group.intervalMs) === intervalId) return group.intervalMs;
        }
        return -1;
    }

    /**
     * 将未过期任务注册到指定间隔；同周期任务共享同一调度相位。
     * @param task 要注册的任务。
     * @param intervalMs 正安全整数间隔毫秒数；省略时使用策略当前默认间隔。
     * @returns 任务 ID；间隔无效或任务已过期时返回 null。
     */
    addTask(task: Task, intervalMs: number = this.#strategy.defaultIntervalMs): TaskId | null {
        if (!this.isPositiveInteger(intervalMs) || task.deathTime <= 0) return null;

        const defaultGroupId = this.#defaultGroupByIntervalMs.get(intervalMs);
        const defaultGroup = defaultGroupId === undefined
            ? undefined
            : this.#scheduleGroups.get(defaultGroupId);
        if (defaultGroup !== undefined) {
            defaultGroup.tasks.push(task);
            this.#ensureTaskDeathTimeSubscription(task);
            this.#rescheduleDeathTimer();
            return task.deathTime > 0 ? task.id : null;
        }

        this.#strategy.flushDue();
        this.#addScheduleGroup(intervalMs, [task], true);
        return task.deathTime > 0 ? task.id : null;
    }

    /**
     * 运行中修改任务周期；更新后的任务从修改时刻开始新周期，原共享周期组中的其他任务不受影响。
     * @param taskId 要修改的任务 ID。
     * @param newIntervalMs 新周期，必须为正安全整数。
     * @param currentIntervalMs 可选的原周期筛选；省略时更新该任务在本调度器中的全部注册。
     * @returns 找到并更新至少一个注册时返回 true。
     */
    updateTaskInterval(
        taskId: TaskId,
        newIntervalMs: number,
        currentIntervalMs: number | null = null
    ): boolean {
        if (
            !this.isPositiveInteger(newIntervalMs)
            || (currentIntervalMs !== null && !this.isPositiveInteger(currentIntervalMs))
        ) {
            return false;
        }

        this.#refreshDeathTimeSubscriptions();
        this.#strategy.flushDue();
        const movedTasks: Task[] = [];
        const removedGroupIds: number[] = [];
        this.#scheduleGroups.forEach((group, groupId) => {
            if (currentIntervalMs !== null && group.intervalMs !== currentIntervalMs) return;
            const matchingTasks = group.tasks.filter((task) => task.id === taskId);
            if (matchingTasks.length === 0) return;

            group.tasks = group.tasks.filter((task) => task.id !== taskId);
            matchingTasks.forEach((task) => movedTasks.push(task));
            if (group.tasks.length === 0) {
                this.#deleteScheduleGroup(groupId);
                removedGroupIds.push(groupId);
            }
        });

        if (movedTasks.length === 0) return false;
        this.#strategy.removeGroups(removedGroupIds);
        this.#addScheduleGroup(newIntervalMs, movedTasks, false);
        return true;
    }

    /**
     * 在运行中切换此调度器使用的算法。
     * 所有已注册任务都会保留，并从切换时刻开始新的周期；暂停状态也会保留。
     */
    setSchedulingType(schedulingType: SchedulingType): void {
        if (this.#isSwitchingStrategy) {
            throw new Error('Cannot switch scheduling algorithms while a switch is in progress.');
        }
        if (schedulingType === this.#schedulingType) return;

        this.#refreshDeathTimeSubscriptions();
        const nextStrategy = this.#createStrategy(schedulingType);
        this.#isSwitchingStrategy = true;
        try {
            this.#strategy.flushDue();
            this.#strategy.kill();
            this.#strategy = nextStrategy;
            this.#schedulingType = schedulingType;
            this.#scheduleGroups.forEach((group, groupId) => {
                this.#strategy.addGroup(groupId, group.intervalMs);
            });
            if (!this.#isPaused) this.#strategy.resume();
        } finally {
            this.#isSwitchingStrategy = false;
        }
    }

    #createStrategy(schedulingType: SchedulingType): SchedulingStrategy {
        return createSchedulingStrategy(
            schedulingType,
            this.#baseIntervalMs,
            (groupId) => this.#dispatchGroup(groupId)
        );
    }

    #addScheduleGroup(intervalMs: number, tasks: Task[], isDefaultGroup: boolean): void {
        const groupId = ++this.#nextGroupId;
        this.#scheduleGroups.set(groupId, { intervalMs, tasks, isDefaultGroup });
        if (isDefaultGroup) this.#defaultGroupByIntervalMs.set(intervalMs, groupId);
        this.#strategy.addGroup(groupId, intervalMs);
        tasks.forEach((task) => this.#ensureTaskDeathTimeSubscription(task));
        this.#rescheduleDeathTimer();
    }

    #deleteScheduleGroup(groupId: number): void {
        const group = this.#scheduleGroups.get(groupId);
        if (group === undefined) return;

        this.#scheduleGroups.delete(groupId);
        if (group.isDefaultGroup && this.#defaultGroupByIntervalMs.get(group.intervalMs) === groupId) {
            this.#defaultGroupByIntervalMs.delete(group.intervalMs);
        }
    }

    /** 派发指定相位组中的未过期任务。 */
    #dispatchGroup(groupId: number): void {
        const tasks = [...(this.#scheduleGroups.get(groupId)?.tasks ?? [])];
        tasks.forEach((task) => {
            const group = this.#scheduleGroups.get(groupId);
            if (group === undefined || !group.tasks.includes(task)) return;
            if (task.deathTime <= 0) {
                this.#removeTaskRegistrations(task);
                this.#rescheduleDeathTimer();
                return;
            }
            task.dispatch();
        });
    }

    #removeExpiredTasks(): void {
        const removedGroupIds: number[] = [];
        const expiredTasks = new Set<Task>();
        this.#scheduleGroups.forEach((group, groupId) => {
            const remainingTasks = group.tasks.filter((task) => {
                if (task.deathTime > 0) return true;
                expiredTasks.add(task);
                return false;
            });
            if (remainingTasks.length === group.tasks.length) return;

            group.tasks = remainingTasks;
            if (remainingTasks.length === 0) {
                this.#deleteScheduleGroup(groupId);
                removedGroupIds.push(groupId);
            }
        });
        if (removedGroupIds.length > 0) this.#strategy.removeGroups(removedGroupIds);
        expiredTasks.forEach((task) => this.#unsubscribeTaskDeathTime(task));
    }

    #removeTaskRegistrations(task: Task): void {
        const removedGroupIds: number[] = [];
        this.#scheduleGroups.forEach((group, groupId) => {
            const remainingTasks = group.tasks.filter((registeredTask) => registeredTask !== task);
            if (remainingTasks.length === group.tasks.length) return;

            group.tasks = remainingTasks;
            if (remainingTasks.length === 0) {
                this.#deleteScheduleGroup(groupId);
                removedGroupIds.push(groupId);
            }
        });
        if (removedGroupIds.length > 0) this.#strategy.removeGroups(removedGroupIds);
        this.#unsubscribeTaskDeathTime(task);
    }

    #refreshDeathTimeSubscriptions(): void {
        this.#removeExpiredTasks();
        const activeTasks = new Set<Task>();
        this.#scheduleGroups.forEach((group) => {
            group.tasks.forEach((task) => activeTasks.add(task));
        });

        this.#deathTimeSubscriptions.forEach((subscription, task) => {
            if (activeTasks.has(task)) return;
            this.#unsubscribeTaskDeathTime(task);
        });

        activeTasks.forEach((task) => this.#ensureTaskDeathTimeSubscription(task));

        this.#rescheduleDeathTimer();
    }

    #ensureTaskDeathTimeSubscription(task: Task): void {
        if (this.#deathTimeSubscriptions.has(task)) return;
        if (task.deathTime <= 0) {
            this.#removeTaskRegistrations(task);
            return;
        }

        const heapId = ++this.#nextDeathTimeHeapId;
        const schedulerReference = new WeakRef(this);
        const listener = (): void => {
            const scheduler = schedulerReference.deref();
            if (scheduler !== undefined) scheduler.#onTaskDeathTimeChanged(task);
        };
        const unsubscribe = subscribeToTaskDeathTimeChanges(task, listener);
        this.#deathTimeSubscriptions.set(task, { heapId, listener, unsubscribe });
        this.#taskByDeathTimeHeapId.set(heapId, task);
        this.#updateTaskDeathTime(task);
    }

    #onTaskDeathTimeChanged(task: Task): void {
        this.#updateTaskDeathTime(task);
        this.#rescheduleDeathTimer();
    }

    #updateTaskDeathTime(task: Task): void {
        const subscription = this.#deathTimeSubscriptions.get(task);
        if (subscription === undefined) return;

        const remainingTimeMs = task.deathTime;
        if (remainingTimeMs <= 0) {
            this.#removeTaskRegistrations(task);
        } else if (remainingTimeMs === Infinity) {
            this.#deathTimeHeap.delete(subscription.heapId);
        } else {
            this.#deathTimeHeap.set(
                subscription.heapId,
                1,
                performance.now() + remainingTimeMs
            );
        }
    }

    #unsubscribeTaskDeathTime(task: Task): void {
        const subscription = this.#deathTimeSubscriptions.get(task);
        if (subscription === undefined) return;

        subscription.unsubscribe();
        this.#deathTimeSubscriptions.delete(task);
        this.#taskByDeathTimeHeapId.delete(subscription.heapId);
        this.#deathTimeHeap.delete(subscription.heapId);
    }

    #rescheduleDeathTimer(): void {
        if (this.#deathTimer !== undefined) {
            clearTimeout(this.#deathTimer);
            this.#deathTimer = undefined;
        }

        const nextDeadline = this.#deathTimeHeap.peek();
        if (nextDeadline === undefined) return;

        const delayMs = Math.min(
            MAX_TIMEOUT_DELAY_MS,
            Math.max(1, Math.ceil(nextDeadline.dueAt - performance.now()))
        );
        this.#deathTimer = setTimeout(this.#onDeathTimer, delayMs);
        this.#deathTimer.unref();
    }

    /**
     * 删除指定间隔下的全部任务。
     * @param intervalMs 要删除的间隔，单位为毫秒。
     * @returns 存在并删除该间隔时返回 true。
     */
    deleteTasksByInterval(intervalMs: number): boolean {
        if (!this.isPositiveInteger(intervalMs)) return false;

        this.#strategy.flushDue();
        const removedGroupIds: number[] = [];
        this.#scheduleGroups.forEach((group, groupId) => {
            if (group.intervalMs !== intervalMs) return;
            this.#deleteScheduleGroup(groupId);
            removedGroupIds.push(groupId);
        });
        this.#strategy.removeGroups(removedGroupIds);
        this.#refreshDeathTimeSubscriptions();
        return removedGroupIds.length > 0;
    }

    /**
     * 按任务 ID 删除任务，可选地优先限定间隔。
     * @param taskId 要删除的任务 ID。
     * @param intervalMs 优先查找的间隔；未提供或未匹配时搜索所有间隔。
     */
    deleteTaskById(taskId: TaskId, intervalMs: number | null = null): boolean {
        this.#strategy.flushDue();
        const matchingIntervalExists = intervalMs !== null
            && this.isPositiveInteger(intervalMs)
            && [...this.#scheduleGroups.values()].some((group) => group.intervalMs === intervalMs);
        let groupsToSearch = [...this.#scheduleGroups.entries()];
        if (matchingIntervalExists) {
            groupsToSearch = groupsToSearch.filter(([, group]) => group.intervalMs === intervalMs);
        }

        const hasMatch = groupsToSearch.some(([, group]) =>
            group.tasks.some((task) => task.id === taskId)
        );
        if (!hasMatch && matchingIntervalExists) {
            groupsToSearch = [...this.#scheduleGroups.entries()];
        }

        const removedGroupIds: number[] = [];
        let wasDeleted = false;
        groupsToSearch.forEach(([groupId, group]) => {
            const remainingTasks = group.tasks.filter((task) => task.id !== taskId);
            if (remainingTasks.length === group.tasks.length) return;

            wasDeleted = true;
            group.tasks = remainingTasks;
            if (remainingTasks.length === 0) {
                this.#deleteScheduleGroup(groupId);
                removedGroupIds.push(groupId);
            }
        });
        this.#strategy.removeGroups(removedGroupIds);
        this.#refreshDeathTimeSubscriptions();
        return wasDeleted;
    }

    /** 暂停后续计时处理和任务派发。 */
    pause(): void {
        if (this.#isPaused) return;
        this.#strategy.pause();
        this.#isPaused = true;
    }

    /** 恢复计时处理和任务派发。 */
    resume(): void {
        if (!this.#isPaused) return;
        this.#isPaused = false;
        this.#strategy.resume();
    }

    /** 停止策略计时器；之后可通过 resume() 重新启动。 */
    kill(): void {
        this.#strategy.kill();
        this.#isPaused = true;
    }
}
