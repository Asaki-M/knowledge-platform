# LLM 模块阅读指南

本模块将业务调用与各厂商 SDK 隔离。业务层使用统一请求和响应，厂商适配器负责协议差异。

## 目录职责

```text
llm/
├── index.ts                 # 业务层公共入口，异常从 ../errors.ts 导入
├── types.ts                 # 公共消息、请求、响应与 LlmAdapter 契约
├── client.ts                # 注册、校验、供应商选择与日志追踪
├── providers/
│   └── openai/
│       ├── index.ts         # 仅导出适配器与连接配置类型
│       ├── adapter.ts       # 创建 SDK 客户端、调用、协调映射和错误转换
│       ├── mapping.ts       # 通用输入 ↔ Responses API 数据结构
│       └── normalize-error.ts # OpenAI SDK 异常 → AppError
└── README.md
```

根目录文件随通用能力演进，厂商相关文件随厂商目录扩展。当前只有 OpenAI 实现，不提前创建其他厂商的空模块。

服务端错误码共同维护在上一级的 [error-codes.ts](../error-codes.ts)，每项都有中文含义。LLM 实现引用其中的 `LLM_ERROR_CODES`，异常类统一使用 [AppError](../errors.ts)，不再在 LLM 模块内定义；厂商 `normalize-error.ts` 负责把 SDK 异常映射到这些既有错误码。

## 建议阅读顺序

1. [types.ts](types.ts)：先看 `LlmRequest`、`LlmResponse` 和 `LlmAdapter`，理解业务层与厂商实现之间的约定。
2. [../error-codes.ts](../error-codes.ts) → [../errors.ts](../errors.ts)：先看每个错误码的中文含义，再了解统一异常类以及 `retryable`、`status`、`requestId` 的含义。
3. [client.ts](client.ts)：从 `register()` 到 `generate()`，串起校验、选择适配器、取消判断、子 span 和日志。
4. [providers/openai/adapter.ts](providers/openai/adapter.ts)：看一个厂商如何实现契约，重点是构造函数的配置读取和 `generate()` 的调用编排。
5. [providers/openai/mapping.ts](providers/openai/mapping.ts)：理解输入字段如何映射到 Responses API，以及完成、截断、过滤、拒答和 Token 用量如何归一化。
6. [providers/openai/normalize-error.ts](providers/openai/normalize-error.ts)：看取消、超时、连接失败、鉴权与限流等 SDK 异常如何转换成统一错误。
7. [providers/openai/index.ts](providers/openai/index.ts) 与 [index.ts](index.ts)：确认模块对外暴露的范围，映射函数和 SDK 错误转换不通过公共入口导出。
8. [llm.test.mjs](../../test/llm.test.mjs) 与 [telemetry.test.mjs](../../test/telemetry.test.mjs)：最后用测试理解输入输出实例、边界行为及 HTTP → LLM 的 trace 关联。

## 一次调用的路径

```text
业务层传入 provider、model、messages
  → LlmClient.generate：校验并选择适配器，创建 span
  → OpenAIAdapter.generate
      → toOpenAIRequest：构造 SDK 输入
      → SDK responses.create：发起请求，传递取消信号
      → toLlmResponse：解析响应状态、文本、拒答与用量
      → 若发生异常，normalizeError 转成 AppError
  → LlmClient：记录元数据、结束 span，返回结果或抛出错误
```

`client.ts` 不根据厂商写分支，也不负责具体 SDK 字段；`mapping.ts` 只做转换和响应语义校验，不调用网络、不写日志。

## 接入下一个厂商

1. 将对应 SDK 依赖安装到 `@knowledge/server` 工作区。
2. 新建 `providers/<厂商>/`，实现 `LlmAdapter`，在该目录内组织调用、映射和异常转换。
3. 从厂商 `index.ts` 导出适配器及必要的配置类型，再从 LLM 根 `index.ts` 导出供应用组装使用。
4. 通过 `new LlmClient([adapter])` 或 `client.register(adapter)` 注册独立的 `provider` 标识。
5. 在现有 `server/test/` 中补充本地模拟 API 测试，覆盖 SDK 请求映射、响应转换、取消、超时和错误；不使用真实密钥执行常规测试。

厂商内部依赖 LLM 的 `types.ts` 和服务端公共 `errors.ts`，不要反向导入根 `index.ts`，以免与公共导出形成循环依赖。SDK 专有类型只出现在所属厂商目录，现有中文注释和密钥、日志约定继续适用。

从仓库根目录运行 `pnpm test` 可构建服务端并执行集成测试；异常从 `server/src/errors.ts` 导入 `AppError`，使用 `code` 区分分类；模型调用参数、环境变量和请求行为保持不变。
