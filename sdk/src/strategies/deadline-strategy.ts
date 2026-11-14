import { DeadlineHeap } from '../structures/deadline-heap.js';
import type { SchedulingStrategy } from './scheduling-strategy.js';

const SPIN_WINDOW_MS = 1;
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * 按单调时钟上的绝对截止时间调度任务。
 * 最小堆维护最近截止时间，单个可重排计时器唤醒调度器，并在截止时间前最多忙等 1 毫秒。
 * 操作系统调度或事件循环阻塞仍可能造成迟到；迟到时合并错过的周期，不提供硬实时或 1 毫秒精度保证。
 */
export class DeadlineStrategy implements SchedulingStrategy {
    #deadlines: DeadlineHeap = new DeadlineHeap();
    #tickTimer: ReturnType<typeof setTimeout> | undefined;
    #isPaused = true;
    #isDispatching = false;
    #clockOffsetMs = 0;
    #pausedAt = performance.now();
    #defaultIntervalMs: number;
    #dispatchGroup: (groupId: number) => void;

    #onTimer = (): void => {
        this.#tickTimer = undefined;
        if (this.#isPaused) return;

        const nextDeadline = this.#deadlines.peek();
        if (nextDeadline === undefined) return;

        if (nextDeadline.dueAt - this.#now() > SPIN_WINDOW_MS) {
            this.#schedule();
            return;
        }

        this.#spinUntil(nextDeadline.dueAt);
        this.#dispatchDue();
        this.#schedule();
    };

    constructor(
        baseIntervalMs: number,
        dispatchGroup: (groupId: number) => void
    ) {
        this.#defaultIntervalMs = baseIntervalMs;
        this.#dispatchGroup = dispatchGroup;
    }

    get defaultIntervalMs(): number {
        return this.#defaultIntervalMs;
    }

    addGroup(groupId: number, intervalMs: number): void {
        this.#deadlines.set(groupId, intervalMs, this.#now() + intervalMs);
        if (!this.#isPaused) this.#reschedule();
    }

    removeGroups(groupIds: readonly number[]): void {
        groupIds.forEach((groupId) => this.#deadlines.delete(groupId));
        if (!this.#isPaused) this.#reschedule();
    }

    flushDue(): void {
        if (this.#isPaused) return;
        this.#dispatchDue();
        this.#reschedule();
    }

    pause(): void {
        if (this.#isPaused) return;
        this.#dispatchDue();
        this.#pausedAt = this.#now();
        this.#isPaused = true;
        this.#clearTimer();
    }

    resume(): void {
        if (!this.#isPaused) return;
        this.#clockOffsetMs = performance.now() - this.#pausedAt;
        this.#isPaused = false;
        this.#schedule();
    }

    kill(): void {
        this.pause();
    }

    #now(): number {
        return this.#isPaused
            ? this.#pausedAt
            : performance.now() - this.#clockOffsetMs;
    }

    /** 派发到期组，并将下次截止时间推进至未来，避免对错过的周期逐次补发。 */
    #dispatchDue(): void {
        if (this.#isDispatching) return;
        this.#isDispatching = true;
        try {
            const now = this.#now();
            let deadline = this.#deadlines.peek();
            while (deadline !== undefined && deadline.dueAt <= now) {
                this.#deadlines.pop();
                const missedPeriods = Math.floor((now - deadline.dueAt) / deadline.intervalMs);
                this.#deadlines.set(
                    deadline.groupId,
                    deadline.intervalMs,
                    deadline.dueAt + (missedPeriods + 1) * deadline.intervalMs
                );
                this.#dispatchGroup(deadline.groupId);
                deadline = this.#deadlines.peek();
            }
        } finally {
            this.#isDispatching = false;
        }
    }

    #schedule(): void {
        if (this.#isPaused || this.#tickTimer !== undefined) return;
        const deadline = this.#deadlines.peek();
        if (deadline === undefined) return;

        const delay = Math.min(
            MAX_TIMEOUT_DELAY_MS,
            Math.max(0, deadline.dueAt - this.#now() - SPIN_WINDOW_MS)
        );
        this.#tickTimer = setTimeout(this.#onTimer, delay);
    }

    #spinUntil(deadline: number): void {
        while (this.#now() < deadline) {
            // The caller only spins when the deadline is within SPIN_WINDOW_MS.
        }
    }

    #clearTimer(): void {
        if (this.#tickTimer === undefined) return;
        clearTimeout(this.#tickTimer);
        this.#tickTimer = undefined;
    }

    #reschedule(): void {
        this.#clearTimer();
        this.#schedule();
    }
}
