---
name: standard-workflow
description: ClaudeCode 主AI 全流程工作流（按需调度 Codex 支持）
tips: /standard-workflow <task_description>
---

# 🚨 5条铁律（违反=立即终止）

1. **任何操作前必须 sequential-thinking**（包括 Codex 执行AI）
2. **上下文必须由 Codex 收集**（主AI 禁止自行收集）
3. **路径必须 `<project>/.claude/`**（禁止 `~/.claude/` 或 `C:\Users\...`）
4. **默认自动执行，不询问**（仅5类例外：删核心配置/数据库破坏/Git push/连续3次同错/用户要求）
5. **工具链顺序不可乱**：sequential-thinking → shrimp-task-manager → Codex

---

# ⚡ 4步执行流程

## ```
1. Claude: sequential-thinking → 理解目标/风险/验证
2. Codex/Gemini: 收集上下文 → .claude/context-*.json
3. Claude: shrimp-task-manager 规划 → 任务拆解
4. Claude: 编码实现 + Codex/Gemini: 审查 → 小步实现 + 质量验证
## ```

---

# 📁 路径规范（高频错误）

✅ **正确**：`<project>/.claude/context-initial.json`
❌ **禁止**：`~/.claude/`

---

# 📎 Codex 调度模板

**首次调用**：
## ```
mcp__codex__codex(
  model="gpt-5-codex",
  sandbox="danger-full-access",
  approval-policy="on-failure",
  prompt="
[TASK_MARKER: YYYYMMDD-HHMMSS-XXXX]

目标：[1-2句话]
输出：[交付物列表]
约束：[限制条件]

请在响应末尾附加：[CONVERSATION_ID]: <conversationId>
"
)
## ```

**继续会话**：
## ```
mcp__codex__codex-reply(conversationId="<ID>", prompt="[指令]")
## ```

---

# 🔧 扩展工具调用

## Gemini/Qwen CLI 调用

**快速分析**：
```bash
cd <project> && gemini -p "
PURPOSE: 分析[功能]实现
TASK: 理解代码结构和依赖关系
MODE: analysis
CONTEXT: @**/*
EXPECTED: 架构说明和关键发现
RULES: 聚焦主要逻辑流程
"
```

**生成文档**（需MODE=write）：
```bash
cd <project> && gemini -p "
PURPOSE: 生成API文档
TASK: 为所有公开接口生成文档
MODE: write
CONTEXT: @src/**/*.ts
EXPECTED: docs/API.md文件
RULES: 遵循项目文档规范
" --approval-mode yolo
```

## 搜索工具快速命令

```bash
# 内容搜索
rg "export.*function" --type ts -n

# 文件查找
find . -name "*.test.ts" -type f

# 架构分析
~/.claude/scripts/get_modules_by_depth.sh
```

详细参考 @~/.claude/workflows/

---

详细流程参考 @CLAUDE.md
