// 工具定义：合并版 video_frames + 拆分版 video_scenes / video_gif / video_info。
// 全部复用 lib/ffmpeg.js 的核心逻辑，Node 调 ffmpeg/ffprobe。
import { join } from 'node:path'
import { mkdir, rename } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  probeVideo, extractFrames, sceneFrames, makeGif, fmtTs, cleanupDir,
} from './ffmpeg.js'

// 把一个 [ {time, file} ] 结果输出成规范 JSON + 文本
function framesOutput(frames, { outDir } = {}) {
  const list = frames.map((f) => ({ time: f.time, time_label: fmtTs(f.time) }))
  const summary = list.map((f) => `${f.time_label}  ${basename(f.file)}`).join('\n')
  return {
    value: {
      count: frames.length,
      frames: list,
      output_dir: outDir || null,
    },
    text: `已提取 ${frames.length} 帧：\n${summary}`,
  }
}

function basename(p) {
  return p.split(/[\\/]/).pop()
}

// 网格拼图（PIL 逻辑在 dsh 里通常由前端渲染；这里工具只负责出独立帧文件 + 返回列表。
// 若宿主有 PIL/ImageMagick 可后续扩展 grid。当前返回帧路径让模型/用户自行取用。）
async function emitFrames(frames, outDir, { mode, video }) {
  if (!outDir) return { value: null, text: null, frames }
  await mkdir(outDir, { recursive: true })
  const kept = []
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const ext = mode === 'gif' ? 'gif' : 'jpg'
    const name = mode === 'scenes'
      ? `scene_${String(i + 1).padStart(2, '0')}_at_${fmtTs(f.time).replace(/:/g, '-')}.${ext}`
      : `${mode}_${String(i + 1).padStart(3, '0')}.${ext}`
    const dst = join(outDir, name)
    await rename(f.file, dst)
    kept.push({ time: f.time, file: dst })
  }
  return { frames: kept }
}

export function registerVideoTools(ctx) {
  // ---- 拆分版 1: video_info ----
  ctx.tools.register(defineTool({
    name: 'video_info',
    description: 'Probe a video file and return metadata: duration, resolution, fps, codec, whether it has an audio track.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the video file' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          codec: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' },
          fps: { type: 'number' }, duration: { type: 'number' }, has_audio: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `时长: ${value.duration ?? '未知'}s | 分辨率: ${value.width ?? '?'}x${value.height ?? '?'} | 帧率: ${value.fps ?? '?'}fps | 编码: ${value.codec ?? '?'} | 音轨: ${value.has_audio ? '有' : '无'}`,
      }],
    },
    async execute(args, exec) {
      return probeVideo(args.path, { signal: exec.signal })
    },
  }))

  // ---- 拆分版 2: video_scenes ----
  ctx.tools.register(defineTool({
    name: 'video_scenes',
    description: 'Scene-aware extraction: detect shot changes (cuts) and extract one frame at each cut point. Skips static frames. Good for long/multi-shot videos; more token-efficient than uniform sampling.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the video file' },
      threshold: { type: 'number', description: 'Scene-change threshold 0-1; higher = only obvious cuts (default 0.3)' },
      from: { type: 'number', description: 'Start time in seconds' },
      to: { type: 'number', description: 'End time in seconds' },
      out_dir: { type: 'string', description: 'Directory to save frame files (default: current dir /scenes)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          frames: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, time_label: { type: 'string' }, file: { type: 'string' } } } },
          output_dir: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.frames.length
          ? `检测到 ${value.count} 个镜头切换：\n${value.frames.map((f) => `${f.time_label}  ${basename(f.file)}`).join('\n')}`
          : '没有检测到场景切换',
      }],
    },
    async execute(args, exec) {
      const frames = await sceneFrames(args.path, { threshold: args.threshold ?? 0.3, start: args.from, end: args.to, signal: exec.signal })
      const outDir = args.out_dir ?? join(process.cwd(), 'scenes')
      const kept = await emitFrames(frames, outDir, { mode: 'scenes' })
      await cleanupDir(dirOf(frames[0]?.file))
      return {
        count: kept.frames.length,
        frames: kept.frames.map((f) => ({ time: f.time, time_label: fmtTs(f.time), file: f.file })),
        output_dir: outDir,
      }
    },
  }))

  // ---- 拆分版 3: video_gif ----
  ctx.tools.register(defineTool({
    name: 'video_gif',
    description: 'Cut a segment of a video and convert it to an animated GIF (for motion that static frames cannot show).',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the video file' },
      out: { type: 'string', required: true, description: 'Output GIF file path' },
      from: { type: 'number', description: 'Start time in seconds' },
      to: { type: 'number', description: 'End time in seconds' },
      duration: { type: 'number', description: 'Clip duration in seconds (overrides from/to)' },
      fps: { type: 'number', description: 'GIF frame rate (default 10)' },
      width: { type: 'number', description: 'GIF width, height auto (default 480)' },
    },
    output: {
      schema: { type: 'object', properties: { path: { type: 'string' }, size: { type: 'number' } } },
      render: (_args, value) => [{ type: 'text', text: `GIF 已生成: ${value.path} (${Math.round(value.size / 1024)} KB)` }],
    },
    async execute(args, exec) {
      await makeGif(args.path, args.out, {
        start: args.from, end: args.to, duration: args.duration,
        fps: args.fps ?? 10, width: args.width ?? 480, signal: exec.signal,
      })
      const { stat } = await import('node:fs/promises')
      const info = await stat(args.out)
      return { path: args.out, size: info.size }
    },
  }))

  // ---- 合并版: video_frames (mode 参数统一入口) ----
  ctx.tools.register(defineTool({
    name: 'video_frames',
    description: 'Extract frames from a video. Unified entry point: mode=uniform (every N seconds), mode=scenes (shot-change aware), mode=gif (animated clip), mode=info (metadata only), mode=frames (uniform but output standalone files). For fine-grained control use video_info / video_scenes / video_gif separately.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the video file' },
      mode: { type: 'string', description: 'uniform (default) | scenes | gif | info | frames' },
      interval: { type: 'number', description: 'Seconds between uniform frames (default 5)' },
      threshold: { type: 'number', description: 'Scene threshold 0-1 for mode=scenes (default 0.3)' },
      from: { type: 'number', description: 'Start time in seconds' },
      to: { type: 'number', description: 'End time in seconds' },
      duration: { type: 'number', description: 'GIF clip duration in seconds (mode=gif)' },
      fps: { type: 'number', description: 'GIF frame rate (mode=gif, default 10)' },
      width: { type: 'number', description: 'GIF width (mode=gif, default 480)' },
      out_dir: { type: 'string', description: 'Directory to save frame files (default: current dir)' },
      out: { type: 'string', description: 'Output GIF path (mode=gif)' },
    },
    output: {
      schema: { type: 'object', properties: { mode: { type: 'string' }, count: { type: 'number' }, message: { type: 'string' }, frames: { type: 'array' } } },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const mode = args.mode ?? 'uniform'
      if (mode === 'info') {
        const info = await probeVideo(args.path, { signal: exec.signal })
        return {
          mode, count: 0,
          message: `时长: ${info.duration ?? '未知'}s | 分辨率: ${info.width ?? '?'}x${info.height ?? '?'} | 帧率: ${info.fps ?? '?'}fps | 编码: ${info.codec ?? '?'} | 音轨: ${info.has_audio ? '有' : '无'}`,
        }
      }
      if (mode === 'gif') {
        if (!args.out) throw new Error('mode=gif 需要 out 参数指定 GIF 输出路径')
        await makeGif(args.path, args.out, {
          start: args.from, end: args.to, duration: args.duration,
          fps: args.fps ?? 10, width: args.width ?? 480, signal: exec.signal,
        })
        const { stat } = await import('node:fs/promises')
        const info = await stat(args.out)
        return { mode, count: 1, message: `GIF 已生成: ${args.out} (${Math.round(info.size / 1024)} KB)`, frames: [] }
      }
      if (mode === 'scenes') {
        const frames = await sceneFrames(args.path, { threshold: args.threshold ?? 0.3, start: args.from, end: args.to, signal: exec.signal })
        const outDir = args.out_dir ?? join(process.cwd(), 'scenes')
        const kept = await emitFrames(frames, outDir, { mode: 'scenes' })
        await cleanupDir(dirOf(frames[0]?.file))
        const list = kept.frames.map((f) => `${fmtTs(f.time)}  ${basename(f.file)}`)
        return { mode, count: kept.frames.length, message: `检测到 ${kept.frames.length} 个镜头切换：\n${list.join('\n')}`, frames: list }
      }
      // uniform / frames
      const frames = await extractFrames(args.path, { interval: args.interval ?? 5, start: args.from, end: args.to, signal: exec.signal })
      const outDir = args.out_dir ?? join(process.cwd(), mode === 'frames' ? 'frames' : 'grid_frames')
      const kept = await emitFrames(frames, outDir, { mode })
      await cleanupDir(dirOf(frames[0]?.file))
      const list = kept.frames.map((f) => `${fmtTs(f.time)}  ${basename(f.file)}`)
      return { mode, count: kept.frames.length, message: `已提取 ${kept.frames.length} 帧：\n${list.join('\n')}`, frames: list }
    },
  }))
}

function dirOf(p) {
  if (!p) return null
  return p.split(/[\\/]/).slice(0, -1).join('/') || '.'
}
