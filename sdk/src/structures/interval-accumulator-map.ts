import type { IntervalId } from '../types/task-types.js';

/** 保存间隔与标识的映射，并为每个间隔累计经过的时间。 */
export class IntervalAccumulatorMap extends Map<number, IntervalId> {
    // 累计值实现
    #elapsedByIntervalMs: Map<number, number> = new Map();

    // 差值Map实现
    #differenceValue: Map<number, number> = new Map();

    /** 用可选的初始键值对创建累计映射。 */
    constructor(entries?: Iterable<readonly [number, IntervalId]> | null) {
        super(entries);
    }

    /** 写入间隔及其标识，并初始化该间隔的累计时间。 */
    setWithElapsedTime(intervalMs: number, intervalId: IntervalId): void {
        super.set(intervalMs, intervalId);
        this.#elapsedByIntervalMs.set(intervalMs, 0);
    }

    /** 写入间隔及其标识，并初始化该间隔的原始时间。 */
    setWithOriginalTime(intervalMs: number, intervalId: IntervalId): void {
        super.set(intervalMs, intervalId);
        this.#differenceValue.set(intervalMs, intervalMs);
    }

    /** 删除间隔映射及其累计/差值时间。 */
    deleteWithTotalTime(intervalMs: number): boolean {
        super.delete(intervalMs);
        this.#elapsedByIntervalMs.delete(intervalMs);
        this.#differenceValue.delete(intervalMs);
        return true;
    }

    /**
     * 为所有间隔累加一个 tick，并返回本次到期的间隔。
     * @param tickIntervalMs 本次经过的 tick 毫秒数。
     */
    advanceElapsedTime(tickIntervalMs: number): number[] {
        const dueIntervals: number[] = [];
        this.#elapsedByIntervalMs.forEach((elapsedMs, intervalMs, elapsedByInterval) => {
            const updatedElapsedMs: number = elapsedMs + tickIntervalMs;
            if (updatedElapsedMs === intervalMs) {
                dueIntervals.push(intervalMs);
                elapsedByInterval.set(intervalMs, 0);
            } else {
                elapsedByInterval.set(intervalMs, updatedElapsedMs);
            }
        });
        return dueIntervals;
    }

    /**
     * 获得下一次执行的最小超时时间
     */
    getMinDiffTime(): number{
        return Math.min(...Array.from(this.#differenceValue.values()));
    }

    /**
     * 扣除实际经过的时间，并返回到期的间隔。
     * 若调用晚于截止时间，则保留周期相位，但每次只报告一次到期。
     */
    advanceOriginalTime(elapsedMs: number): number[] {
        const dueIntervals: number[] = [];
        this.#differenceValue.forEach((differenceMs, intervalMs, differenceValue) => {
            const updatedElapsedMs: number = differenceMs - elapsedMs;
            if (updatedElapsedMs <= 0) {
                dueIntervals.push(intervalMs);
                const overdueMs = -updatedElapsedMs;
                const nextDelayMs = intervalMs - (overdueMs % intervalMs);
                differenceValue.set(intervalMs, nextDelayMs);
            }else{
                differenceValue.set(intervalMs, updatedElapsedMs);
            }
        });
        return dueIntervals;
    }

    /** 将所有间隔的累计时间重置为零。
     *  服务于累计算法
     */
    resetElapsedTime(): void {
        this.#elapsedByIntervalMs.forEach((_elapsedMs, intervalMs, elapsedByInterval) => {
            elapsedByInterval.set(intervalMs, 0);
        });
    }
}