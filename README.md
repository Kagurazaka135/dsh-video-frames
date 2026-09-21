# dsh-video-frames

**插件 v0.1.0** · **实测 dsh `0.1.6-alpha.2`**

[DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 插件：给纯文本 agent 补上视频理解能力——抽帧、场景切换检测、GIF 片段、元数据探测。

底层通过 `child_process` 调本机 `ffmpeg` / `ffprobe`，参数走 argv 数组（无 shell 注入）。不需要 Python / PIL / 外部服务。

## 兼容性

> ⚠️ **dsh 处于开发者预览阶段，破坏性变更频繁**，插件的可用性随 dsh 版本变化。换 dsh 版本前先对下表。

| dsh 版本 | 状态 | 说明 |
| --- | --- | --- |
| `0.1.6-alpha.2` | ✅ 实测通过 | 2026-09-22，源码构建（`build:native-system` + `build:lib:host`）后实跑，5/5 工具通过 |
| `0.1.1-rc.2` | ⚠️ 未实测 | 插件按其编译，`peerDependencies` 标称兼容；未在新环境实跑 |

**下面两个坑与 dsh 版本无关**，属插件自身缺陷，已修复。修复前把编译产物换回修复前那版、在 `0.1.6-alpha.2` 上复跑，两个都原样复现——所以这两个修复对两个 dsh 版本同样成立。

1. **`inject` 需声明全部依赖服务**。`video_analyze` 走 `ctx.attachments` + `ctx.llm`，Cordis 的 `inject` 是*必需*语义（不是提示），未声明即访问会抛
   `cannot get property "attachments" without inject`。其余四个工具只用 `ctx.tools`，所以该问题只在 `video_analyze` 上暴露。
2. **默认视觉模型 id 会随服务端下线**。原先的 `deepseek-v4-flash-vision-exp` 已不在服务端模型列表中，
   模型解析失败后图像会降级为占位文本（模型只看到附件哈希，回复"无法查看关键帧"）。
   当前默认改为 `deepseek-flash`（`deepseek-official` 上与 `deepseek-v4-pro` 并列，是唯一 `inputModalities` 含 `image` 的）。
   换 provider / 账号前，建议先用 `ctx.llm.listModels(provider)` 确认可用的视觉模型 id。

## 工具

| 工具 | 说明 |
| --- | --- |
| `video_frames` | 合并版统一入口。`mode=uniform \| scenes \| gif \| info \| frames` 一个参数切换全部能力 |
| `video_info` | 元数据探测：时长、分辨率、帧率、编码、是否有音轨 |
| `video_scenes` | 场景感知抽帧：检测镜头切换点，每个切点抽一帧，跳过静态帧 |
| `video_gif` | 掐一段视频转成 GIF（静态帧表现不了的动态） |
| `video_analyze` | 抽帧 → 存 image attachment → 走 `ctx.llm` 调视觉模型，返回对画面内容的概括 |

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

### video_analyze 参数

| 参数 | 说明 |
| --- | --- |
| `path` | 视频文件路径（必填） |
| `mode` | `uniform`（默认，每 N 秒一帧）\| `scenes`（镜头切换点抽帧，跳过静态帧） |
| `interval` | uniform 抽帧间隔秒数（默认 5） |
| `from` / `to` | 时间段（秒），只分析某一段 |
| `prompt` | 自定义分析指令（默认：概括场景/人物动作/关键信息） |
| `max_frames` | 喂给模型的帧数上限（默认 60），控 token 的旋钮 |
| `max_tokens` | 模型输出上限（默认 2000） |
| `provider` / `model` | 视觉模型路由（默认 `deepseek-official` / `deepseek-flash`，走 `DEEPSEEK_API_KEY`） |

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

## 为什么 video_analyze 是"全塞"而不是分批

`video_analyze` 目前把抽出的帧**一次全喂**给视觉模型，不做分批滚动。这是故意的取舍：

- **最准**：模型一眼看到全部帧，不会被批间滚动摘要的中间损失带偏，跨时间线的人物/事件不会漏。
- **最省事**：一次调用即出结果，实现和调用都是单步。
- **代价是 token 和时间随帧数线性涨**：帧多了成本高、响应慢，且 DS 视觉模型可能陷入"一张张数图"的 reasoning 抽风，把 `max_tokens` 烧光吐空内容（概率性，不是必然）。

控制手段在参数上：`interval` 调稀、`mode=scenes` 跳过静态帧、`max_frames` 封顶、`max_tokens` 给足余量。提示词默认也刻意避开"数一下/逐张描述"这类诱导数图的写法。

等 DSH 正式版稳定后，再按"粗筛小批滚动"的方式做分批优化——那套（抽帧分批 + 批间摘要滚进下一批）在 video-frames skill 里已经趟过路。

## 协议

MIT
