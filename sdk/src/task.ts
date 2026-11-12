import type { TaskId, TaskOptions } from './task-types.js';

/** 可绑定同步或异步回调，并由调度器触发执行的任务。 */
export class Task {
    /** 任务的可读名称。 */
    #name: string;
    /** 任务的唯一标识。 */
    #id: TaskId;
    /** 任务用途说明。 */
    #description: string;
    /** 只执行一次的同步回调索引集合。 */
    #syncOnceIndices: Set<number> = new Set();
    /** 只执行一次的异步回调索引集合。 */
    #asyncOnceIndices: Set<number> = new Set();
    /**
     * 同步回调及其参数、this 接收者和错误处理器按相同索引对应保存。
     * 回调移除时必须同步更新这些并行数组。
     */
    #syncCallbacks: Array<(...args: any[]) => any> = [];
    /** 与 #syncCallbacks 逐项对应的参数数组。 */
    #syncArguments: any[][] = [];
    /** 与 #syncCallbacks 逐项对应的 this 接收者。 */
    #syncThisArgs: unknown[] = [];
    /** 与 #syncCallbacks 逐项对应的错误处理器。 */
    #syncErrorHandlers: Array<(error: Error) => void> = [];
    /**
     * 异步回调及其参数、this 接收者和错误处理器按相同索引对应保存。
     * 一次性异步回调在派发前移除，避免未完成期间被再次派发。
     */
    #asyncCallbacks: Array<(...args: any[]) => Promise<any>> = [];
    /** 与 #asyncCallbacks 逐项对应的参数数组。 */
    #asyncArguments: any[][] = [];
    /** 与 #asyncCallbacks 逐项对应的 this 接收者。 */
    #asyncThisArgs: unknown[] = [];
    /** 与 #asyncCallbacks 逐项对应的错误处理器。 */
    #asyncErrorHandlers: Array<(error: Error) => void> = [];

    /** 任务名称。 */
    get name(): string { return this.#name; }
    /** 任务的唯一标识。 */
    get id(): TaskId { return this.#id; }
    /** 任务描述。 */
    get description(): string { return this.#description; }
    /** 已绑定同步回调的只读快照。 */
    get syncCallbacks(): ReadonlyArray<(...args: any[]) => any> { return [...this.#syncCallbacks]; }
    /** 同步回调实参的只读快照，包含复制后的实参数组。 */
    get syncArguments(): ReadonlyArray<ReadonlyArray<any>> {
        return this.#syncArguments.map((args) => [...args]);
    }
    /** 同步回调 this 接收者的只读快照。 */
    get syncThisArgs(): ReadonlyArray<unknown> { return [...this.#syncThisArgs]; }
    /** 同步回调错误处理器的只读快照。 */
    get syncErrorHandlers(): ReadonlyArray<(error: Error) => void> {
        return [...this.#syncErrorHandlers];
    }
    /** 已绑定异步回调的只读快照。 */
    get asyncCallbacks(): ReadonlyArray<(...args: any[]) => Promise<any>> {
        return [...this.#asyncCallbacks];
    }
    /** 异步回调实参的只读快照，包含复制后的实参数组。 */
    get asyncArguments(): ReadonlyArray<ReadonlyArray<any>> {
        return this.#asyncArguments.map((args) => [...args]);
    }
    /** 异步回调 this 接收者的只读快照。 */
    get asyncThisArgs(): ReadonlyArray<unknown> { return [...this.#asyncThisArgs]; }
    /** 异步回调错误处理器的只读快照。 */
    get asyncErrorHandlers(): ReadonlyArray<(error: Error) => void> {
        return [...this.#asyncErrorHandlers];
    }

    /**
     * 创建任务并生成或分配唯一 ID。
     * @param name 任务名称。
     * @param description 任务描述。
     * @param existingTaskIds 用于避免 ID 冲突的已有 ID 集合；省略时直接生成 ID。
     */
    constructor(name: string, description: string, existingTaskIds: Set<TaskId> | null = null) {
        this.#name = name;
        this.#description = description;
        this.#id = existingTaskIds
            ? this.createUniqueTaskId(existingTaskIds)
            : this.generateTaskId();
    }

    /** 按当前规则生成一个 Task ID。 */
    generateTaskId(): TaskId {
        return (`_${Math.random().toString(36).substring(2, 9)}`) as TaskId;
    }

    /**
     * 生成一个不在给定集合中的 Task ID。
     * @param existingTaskIds 已占用的 Task ID 集合。
     */
    createUniqueTaskId(existingTaskIds: Set<TaskId>): TaskId {
        const taskId = this.generateTaskId();
        return existingTaskIds.has(taskId)
            ? this.createUniqueTaskId(existingTaskIds)
            : taskId;
    }

    /**
     * 绑定同步回调。运行任务时会使用 options 中保存的参数和 this。
     * @param callback 要执行的同步函数。
     * @param options 回调参数、this 接收者及可选错误处理器。
     */
    bindSyncCallback(callback: (...args: any[]) => any, options: TaskOptions): void {
        this.#syncCallbacks.push(callback);
        this.#syncArguments.push(options.arguments ? options.arguments : []);
        this.#syncThisArgs.push(options.thisArg ?? this);
        this.#syncErrorHandlers.push(
            options.onError ?? ((error) => {
                console.error(`Task ${this.#name} encountered an error:`, error);
            })
        );
        if (options.once === true) this.#syncOnceIndices.add(this.#syncCallbacks.length - 1);
    }

    /**
     * 绑定异步回调。异步执行不阻塞任务派发。
     * @param callback 要执行的异步函数。
     * @param options 回调参数、this 接收者及可选错误处理器。
     */
    bindAsyncCallback(callback: (...args: any[]) => Promise<any>, options: TaskOptions): void {
        this.#asyncCallbacks.push(callback);
        this.#asyncArguments.push(options.arguments ? options.arguments : []);
        this.#asyncThisArgs.push(options.thisArg ?? this);
        this.#asyncErrorHandlers.push(
            options.onError ?? ((error) => {
                console.error(`Task ${this.#name} encountered an error:`, error);
            })
        );
        if (options.once === true) this.#asyncOnceIndices.add(this.#asyncCallbacks.length - 1);
    }

    /** 移除指定索引的同步回调及其配套数据。 */
    removeSyncCallback(index: number): boolean {
        if (!Number.isInteger(index) || index < 0 || index >= this.#syncCallbacks.length) return false;
        this.#removeSyncCallback(index);
        return true;
    }

    /** 移除指定索引的异步回调及其配套数据。 */
    removeAsyncCallback(index: number): boolean {
        if (!Number.isInteger(index) || index < 0 || index >= this.#asyncCallbacks.length) return false;
        this.#removeAsyncCallback(index);
        return true;
    }

    /** 调用错误处理器；若处理器自身失败，将处理器错误和原始错误写入日志。 */
    #handleCallbackError(errorHandler: (error: Error) => void, error: unknown): void {
        const taskError = error instanceof Error ? error : new Error(String(error));
        try {
            errorHandler(taskError);
        } catch (handlerError) {
            const reportedError = handlerError instanceof Error
                ? handlerError
                : new Error(String(handlerError));
            console.error(
                `Task ${this.#name} error handler failed:`,
                reportedError,
                'Original callback error:',
                taskError
            );
        }
    }

    /** 运行全部同步回调；单个回调的异常交由其错误处理器处理。 */
    runSyncCallbacks(): boolean {
        let index = 0;
        while (index < this.#syncCallbacks.length) {
            const callback = this.#syncCallbacks[index];
            const args = this.#syncArguments[index];
            const thisArg = this.#syncThisArgs[index];
            const errorHandler = this.#syncErrorHandlers[index];
            const isOnce = this.#syncOnceIndices.has(index);
            // 一次性回调在执行前移除，避免重入或异常时再次派发。
            if (isOnce) this.#removeSyncCallback(index);

            try {
                Reflect.apply(callback, thisArg, args);
            } catch (error) {
                this.#handleCallbackError(errorHandler, error);
            }
            if (!isOnce) index++;
        }
        return true;
    }

    /** 派发全部异步回调，不等待其完成。 */
    dispatchAsyncCallbacks(): boolean {
        let index = 0;
        while (index < this.#asyncCallbacks.length) {
            const callback = this.#asyncCallbacks[index];
            const args = this.#asyncArguments[index];
            const thisArg = this.#asyncThisArgs[index];
            const errorHandler = this.#asyncErrorHandlers[index];
            const isOnce = this.#asyncOnceIndices.has(index);
            // 在等待异步结果前移除一次性回调，防止下一次 tick 重复派发。
            if (isOnce) this.#removeAsyncCallback(index);
            else index++;

            try {
                Promise.resolve(Reflect.apply(callback, thisArg, args)).catch((error) => {
                    this.#handleCallbackError(errorHandler, error);
                });
            } catch (error) {
                this.#handleCallbackError(errorHandler, error);
            }
        }
        return true;
    }

    /** 移除同步回调及其配套数据，并修正剩余的一次性回调索引。 */
    #removeSyncCallback(index: number): void {
        this.#syncCallbacks.splice(index, 1);
        this.#syncArguments.splice(index, 1);
        this.#syncThisArgs.splice(index, 1);
        this.#syncErrorHandlers.splice(index, 1);
        this.#shiftOnceIndices(this.#syncOnceIndices, index);
    }

    /** 移除异步回调及其配套数据，并修正剩余的一次性回调索引。 */
    #removeAsyncCallback(index: number): void {
        this.#asyncCallbacks.splice(index, 1);
        this.#asyncArguments.splice(index, 1);
        this.#asyncThisArgs.splice(index, 1);
        this.#asyncErrorHandlers.splice(index, 1);
        this.#shiftOnceIndices(this.#asyncOnceIndices, index);
    }

    /**
     * 移除指定索引，并将其后的索引左移一位。
     * @param indices 一次性回调索引集合。
     * @param removedIndex 已删除回调的索引。
     */
    #shiftOnceIndices(indices: Set<number>, removedIndex: number): void {
        const remainingIndices = [...indices]
            .filter((index) => index !== removedIndex)
            .map((index) => index > removedIndex ? index - 1 : index);
        indices.clear();
        remainingIndices.forEach((index) => indices.add(index));
    }

    /** 派发此任务的同步和异步回调；已启动的异步工作不会被取消。 */
    dispatch(): void {
        this.dispatchAsyncCallbacks();
        this.runSyncCallbacks();
    }
}
