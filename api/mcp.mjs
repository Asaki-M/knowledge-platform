// 平台入口使用原生 ESM，避免 TypeScript 默认编译成 require() 后无法加载服务端 ESM。
export { default } from '../server/dist/vercel.js'
