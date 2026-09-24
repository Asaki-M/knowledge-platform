/** 默认分类与语义说明同时用于提示词和校验；每节选择最主要的一种。 */
export const DEFAULT_KNOWLEDGE_TYPES = {
  'concept': '概念定义、术语解释、原理',
  'guide': '操作流程、接入步骤、迁移教程',
  'api': '接口、请求参数、返回结构、错误码',
  'example': '代码样例、调用示例、演示',
  'faq': '常见问题与解答',
  'troubleshooting': '问题诊断、故障原因及解决方法',
  'security-rule': '安全要求、权限限制、凭据与隐私规则',
  'configuration': '配置项、环境变量、部署参数',
  'architecture': '系统架构、组件职责、交互与依赖',
  'reference': '枚举、字段表、命令和其他查阅资料',
  'specification': '协议、数据格式、行为规范与约定',
  'decision': '技术方案选择、决策理由与取舍',
  'changelog': '版本变更、发布记录、兼容性变化',
  'incident': '事故记录、影响、处置过程和复盘',
  'overview': '产品介绍、能力概览、文档导航',
  'other': '无法归入现有分类的内容，不推测缺失的信息',
} as const

export type BuiltinKnowledgeType = keyof typeof DEFAULT_KNOWLEDGE_TYPES
