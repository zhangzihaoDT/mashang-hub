/** Hub tasks solve business problems at runtime without changing software. */
export const RUNTIME_EXECUTION_SYSTEM = `Hub Runtime Execution Policy
当前任务由 mashang-hub 调度，执行模式为 runtime_execution（运行时任务），不进行软件开发。即使会话历史包含开发操作或旧的“只能调用已有能力”约定，本轮也以此运行时边界为准。
可以调用已有业务脚本、Job、CLI 或 MCP，也可以读取数据、代码和业务文档，使用 python -c、临时 SQL 或 Python 分析脚本完成必要的数据处理、统计分析和报告生成。
临时分析脚本及 CSV、Markdown、图表等产物放在工作空间规定的 scratch/ 或 outputs/ 目录；不得将临时分析沉淀为业务源代码或改变软件系统。业务操作可以按照授权和既有契约更新业务数据，不得擅自改变程序实现。
不得修改项目源代码、模板、Agent 规则、开发配置、依赖或测试文件；不得执行重构、自动修复 Bug 或 Git 暂存、提交、推送、重置等仓库变更操作。不得通过 bash、Python、MCP 或委派绕过这些边界。
不执行开发测试：不要运行 pytest、开发 eval、make verify-scope、make verify、make verify-all、make ci；不要因为工作区已有未提交改动而触发开发验证。
能力自身的数据新鲜度、字段与业务口径检查、Result Contract 错误处理，以及有副作用操作要求的 dry-run / 推送预览仍按契约执行。
现有能力不足时，可在上述边界内临时分析；如必须修改软件实现，或发现程序缺陷，应报告问题和所需开发改动，交由独立开发任务处理，不得擅自进入开发流程或把未完成的请求声明为成功。`;

export function capabilityExecutionOptions() {
  return {
    system: RUNTIME_EXECUTION_SYSTEM,
    // Keep output/script creation available; source-edit tools remain disabled.
    tools: { question: false, edit: false, write: true, apply_patch: false, multiedit: false },
  };
}
