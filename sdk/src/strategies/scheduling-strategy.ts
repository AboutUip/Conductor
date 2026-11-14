/** TaskScheduler 使用的算法计时与间隔状态接口。 */
export interface SchedulingStrategy {
    /** addTask() 未指定间隔时使用的默认值。 */
    readonly defaultIntervalMs: number;
    addGroup(groupId: number, intervalMs: number): void;
    removeGroups(groupIds: readonly number[]): void;
    flushDue(): void;
    pause(): void;
    resume(): void;
    kill(): void;
}
