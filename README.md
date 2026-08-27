# dsh-video-frames

[DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 插件：给纯文本 agent 补上视频理解能力——抽帧、场景切换检测、GIF 片段、元数据探测。

底层通过 `child_process` 调本机 `ffmpeg` / `ffprobe`，参数走 argv 数组（无 shell 注入）。不需要 Python / PIL / 外部服务。

## 工具

| 工具 | 说明 |
| --- | --- |
| `video_frames` | 合并版统一入口。`mode=uniform \| scenes \| gif \| info \| frames` 一个参数切换全部能力 |
| `video_info` | 元数据探测：时长、分辨率、帧率、编码、是否有音轨 |
| `video_scenes` | 场景感知抽帧：检测镜头切换点，每个切点抽一帧，跳过静态帧 |
| `video_gif` | 掐一段视频转成 GIF（静态帧表现不了的动态） |

### video_frames 参数

| 参数 | 说明 |
| --- | --- |
| `path` | 视频文件路径（必填） |
| `mode` | `uniform`（默认，每 N 秒一帧）\| `scenes`（镜头切换）\| `gif`（动图）\| `info`（元数据）\| `frames`（uniform 但输出独立文件） |
| `interval` | uniform 抽帧间隔秒数（默认 5） |
| `threshold` | scenes 模式场景阈值 0-1，越高越只认明显切镜（默认 0.3） |
| `from` / `to` | 时间段（秒），只处理某一段 |
| `duration` | gif 模式片段时长（秒），优先于 from/to |
| `fps` | gif 帧率（默认 10） |
| `width` | gif 宽度，高度自适应（默认 480） |
| `out_dir` | 抽出的帧保存目录 |
| `out` | gif 输出路径（mode=gif 必填） |

拆分版 `video_scenes` / `video_gif` / `video_info` 参数与上面对应项一致，适合 agent 按需调用单个工具。

## 安装 / 注册

要求：**Node >= 18**，且 `ffmpeg` / `ffprobe` 在系统 PATH 中。

通过 DSH 的 bundle patch 机制挂载：

```yml
# cordis.patch.yml
- insert:
    - id: dsh-video-frames
      name: 'dsh-video-frames'
```

或按 DSH 插件市场的常规方式注册本包。完整 DSH 插件开发说明见 [deepseek-harness docs/cookbook/adding-a-tool](https://github.com/deepseek-ai/deepseek-harness)。

## 实现说明

- 均匀抽帧用 `fps=1/N`（按墙钟时间，不受关键帧影响）；时间段用 `-ss`（input 定位）+ `-t`（时长），避开 `-to` 在 seek 后时间戳重置的坑。
- 场景检测两遍：`select='gt(scene,THRESH)',showinfo` 从日志解析 `pts_time`，再按时间戳精抽单帧。
- 探测 fps 有三级兜底：`r_frame_rate` → `avg_frame_rate`（concat 拼接视频常是 0/0）→ 数帧/时长推算。
- GIF 部分精简 ffmpeg 写完会崩返回非零码但文件已生成，以文件存在为准。

## 协议

MIT
