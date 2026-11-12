/** 任务回调的参数、this 接收者和可选错误处理器。 */
export interface TaskOptions {
    /** 传递给回调的实参列表。 */
    arguments: any[];
    /** 回调运行时的 this；未提供时使用所属 Task 实例。 */
    thisArg?: unknown;
    /** 回调抛错或异步拒绝时调用的错误处理器。 */
    onError?: (error: Error) => void;
    /** 是否只执行一次；省略时随所属 Task 重复派发。 */
    once?: boolean;
}

/** 定时器间隔对应的 256 字符标识。 */
declare const intervalIdBrand: unique symbol;
export type IntervalId = string & { readonly [intervalIdBrand]: true };

/** 检查字符串长度是否符合 IntervalId 的格式。 */
export function isIntervalId(value: string): value is IntervalId {
    return value.length === 256;
}

/** Task 实例的唯一标识类型。 */
declare const taskIdBrand: unique symbol;
export type TaskId = string & { readonly [taskIdBrand]: true };

/** 检查字符串是否符合 Task ID 生成器的格式。 */
export function isTaskId(value: string): value is TaskId {
    return /^_[0-9a-z]{0,7}$/.test(value);
}

/** 类型:算法类型 */
export enum SchedulingType{
    // 累计调度：基础 tick 取任务间隔的最大公约数。
    LeastCommonMultiple = "LeastCommonMultiple",
    // 时间轮调度。
    TimingWheel = "TimingWheel"
}