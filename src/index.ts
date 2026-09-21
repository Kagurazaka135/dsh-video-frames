// dsh-video-frames 插件入口。
// 注册 video_frames / video_scenes / video_gif / video_info 四个工具，
// 让纯文本 DeepSeek Harness agent 具备视频理解能力（Node 调 ffmpeg/ffprobe）。
import type { Context } from '@deepseek-ai/cordis'
import { registerVideoTools } from './tools.ts'

export const name = 'dsh-video-frames'
// video_analyze 走 ctx.attachments + ctx.llm，其余工具只用 ctx.tools。
// Cordis 的 inject 是必需语义：不声明就访问即抛 "cannot get property ... without inject"。
export const inject = ['tools', 'attachments', 'llm']

export function apply(ctx: Context): void {
  registerVideoTools(ctx)
}
