# Contributing Guide

## 分支与提交流程

- 默认分支：`main`
- 建议分支命名：`feature/<module>-<topic>`、`fix/<topic>`
- 提交信息建议包含模块前缀，例如：`docs(module-c): refine room state machine`

## 提交前检查

- 文档变更需同步更新 `README.md` 导航
- 若修改接口或数据模型，必须同步更新：
  - `docs/03-接口契约.md`
  - `docs/04-数据模型与字典.md`
- 关键架构决策变化需新增或更新 `docs/ADR/`

## Pull Request 规范

- 说明变更背景与目标
- 列出影响范围（模块 A-F）
- 提供验证方式与结果
- 若有风险项，写明回滚与缓解策略

## Issue 使用建议

- 使用模块标签：`module-a` 到 `module-f`
- 使用优先级标签：`p0`、`p1`、`p2`
- 所有实施任务应关联里程碑（M0-M3）
