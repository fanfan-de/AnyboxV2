/** close 停止接收、取消并等待自有工作；重复调用共享关闭结果，独立清理失败聚合报告。 */
export interface Owned<T> { readonly service: T; close(): Promise<void> }
