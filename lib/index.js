// dsh-video-frames 插件入口。
// 注册 video_frames / video_scenes / video_gif / video_info 四个工具，
// 让纯文本 DeepSeek Harness agent 具备视频理解能力（Node 调 ffmpeg/ffprobe）。
import { registerVideoTools } from './tools.js'

export const name = 'dsh-video-frames'
export const inject = ['tools']

export function apply(ctx) {
  registerVideoTools(ctx)
  ctx.on('dispose', () => {
    // 工具注册基于副作用，fiber dispose 时自动注销；这里留空供扩展
  })
}
