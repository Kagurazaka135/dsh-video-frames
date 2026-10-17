// video_analyze 核心：抽帧 → 存为 image attachment → 走 ctx.llm 调 vision 模型分析。
import { readFile } from 'node:fs/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { extractFrames, sceneFrames, probeVideo } from "./ffmpeg.js";
const DEFAULT_PROMPT = '这是一段视频抽出的关键帧（可能有重复）。请简要概括画面内容：场景是什么、人物/物体在做什么、有没有关键信息（文字、进度、状态等）。直接总结，不用逐张描述。';
export async function analyzeVideo(ctx, video, options) {
    const { mode = 'uniform' } = options;
    const hostLimit = ctx.attachments.imageLimits.maxImagesPerMessage ?? 20;
    const maxFrames = Math.min(options.maxFrames ?? hostLimit, hostLimit);
    if (!Number.isInteger(maxFrames) || maxFrames < 1)
        throw new Error('max_frames 和宿主图片数量上限必须是正整数');
    // 1) 抽帧
    let frames;
    if (mode === 'scenes') {
        frames = await sceneFrames(video, { threshold: options.threshold ?? 0.3, start: options.start, end: options.end, signal: options.signal });
    }
    else {
        const info = await probeVideo(video, { signal: options.signal });
        const end = Math.min(options.end ?? info.duration ?? 0, info.duration ?? options.end ?? 0);
        const duration = Math.max(0, end - (options.start ?? 0));
        const interval = Math.max(options.interval ?? 5, Math.ceil(duration / maxFrames));
        frames = await extractFrames(video, { interval, start: options.start, end: options.end, signal: options.signal });
    }
    if (frames.length > maxFrames)
        frames = frames.slice(0, maxFrames);
    // 2) 存成 image attachments（批量）
    const inputs = await Promise.all(frames.map(async (f) => {
        const data = await readFile(f.file);
        return { data, mediaType: 'image/jpeg', name: f.file.split(/[\\/]/).pop() };
    }));
    let refs;
    try {
        refs = await ctx.attachments.saveImages(inputs);
    }
    catch (error) {
        throw new Error(`视频关键帧保存失败（本次 ${inputs.length} 张，宿主上限 ${hostLimit} 张）。请降低 max_frames 或增大 interval 后重试，并检查附件存储配置：${String(error)}`);
    }
    // 3) 构造消息：文本 + N 个 image block
    const message = createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-video-frames' },
        content: [
            { type: 'text', text: options.prompt || DEFAULT_PROMPT },
            ...refs.map((ref) => ({ type: 'image', attachment: ref })),
        ],
    });
    // 4) 调 vision 模型
    let text = '';
    let reasoning = '';
    for await (const chunk of ctx.llm.stream({
        provider: options.provider,
        model: options.model,
        messages: [message],
        maxTokens: options.maxTokens ?? 2000,
        signal: options.signal,
    })) {
        if (chunk.type === 'text-delta')
            text += chunk.text;
        else if (chunk.type === 'reasoning-delta')
            reasoning += chunk.text;
    }
    return {
        frames: frames.map((f) => f.time),
        text,
        reasoning,
    };
}
