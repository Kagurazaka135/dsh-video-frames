import { registerVideoTools, registerVideoAnalyzeTool } from "./tools.js";
export const name = 'dsh-video-frames';
// video_analyze 走 ctx.attachments + ctx.llm，其余工具只用 ctx.tools。
// 基础工具只等待 tools；分析工具在依赖服务就绪后延迟注册。
export const inject = ['tools'];
export function apply(ctx) {
    registerVideoTools(ctx);
    ctx.inject(['attachments', 'llm'], scoped => {
        registerVideoAnalyzeTool(scoped);
    });
}
