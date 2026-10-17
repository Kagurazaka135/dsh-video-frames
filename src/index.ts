// dsh-video-frames 插件入口。
// 注册 video_frames / video_scenes / video_gif / video_info 四个工具，
// 让纯文本 DeepSeek Harness agent 具备视频理解能力（Node 调 ffmpeg/ffprobe）。
import type { Context } from '@deepseek-ai/cordis'
import { registerVideoTools, registerVideoAnalyzeTool } from './tools.ts'

export const name = 'dsh-video-frames'
// video_analyze 走 ctx.attachments + ctx.llm，其余工具只用 ctx.tools。
// 基础工具只等待 tools；分析工具在依赖服务就绪后延迟注册。
export const inject = ['tools']

export function apply(ctx: Context): void {
  registerVideoTools(ctx)
  ctx.inject(['attachments', 'llm'], scoped => {
    registerVideoAnalyzeTool(scoped)
  })
}
