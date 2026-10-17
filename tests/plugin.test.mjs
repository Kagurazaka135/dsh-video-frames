import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { registerVideoTools, registerVideoAnalyzeTool } from '../lib/tools.js'
import { apply, inject } from '../lib/index.js'
import { analyzeVideo } from '../lib/analyze.js'

const repo = fileURLToPath(new URL('..', import.meta.url))

test('all five compiled schemas keep the public argument names and required fields', () => {
  const tools = new Map()
  const ctx = { tools: { register: tool => tools.set(tool.name, tool) } }
  registerVideoTools(ctx)
  registerVideoAnalyzeTool(ctx)
  assert.deepEqual([...tools.keys()], ['video_info', 'video_scenes', 'video_gif', 'video_frames', 'video_analyze'])
  const expected = {
    video_info: ['path'],
    video_scenes: ['path', 'threshold', 'from', 'to', 'out_dir'],
    video_gif: ['path', 'out', 'from', 'to', 'duration', 'fps', 'width'],
    video_frames: ['path', 'mode', 'interval', 'threshold', 'from', 'to', 'duration', 'fps', 'width', 'out_dir', 'out'],
    video_analyze: ['path', 'mode', 'interval', 'from', 'to', 'prompt', 'max_frames', 'max_tokens', 'provider', 'model'],
  }
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(Object.keys(tool.parameters.properties), expected[name])
    assert.deepEqual(tool.parameters.required, name === 'video_gif' ? ['path', 'out'] : ['path'])
  }
})

test('tools-only hosts retain four tools and register analysis after both services appear', () => {
  assert.deepEqual(inject, ['tools'])
  const names = []
  let deferred
  const ctx = {
    tools: { register: tool => names.push(tool.name) },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['attachments', 'llm'])
      deferred = callback
    },
  }
  apply(ctx)
  assert.deepEqual(names, ['video_info', 'video_scenes', 'video_gif', 'video_frames'])
  deferred(ctx)
  assert.equal(names[4], 'video_analyze')
})

test('compiled tools reject invalid arguments before running ffmpeg', async () => {
  const tools = []
  registerVideoTools({ tools: { register: tool => tools.push(tool) } })
  await assert.rejects(tools[0].execute({}, {}), { name: 'ToolArgsError', code: 'INVALID_ARGS' })
  await assert.rejects(tools[0].execute({ path: 123 }, {}), { name: 'ToolArgsError', code: 'INVALID_ARGS' })
  await assert.rejects(tools[1].execute({ path: 'unused', threshold: 'bad' }, {}), { name: 'ToolArgsError', code: 'INVALID_ARGS' })
})

test('a linked built package loads five tools without resolving dsh-tools at runtime', async () => {
  const tmp = join(repo, '.tmp')
  await mkdir(tmp, { recursive: true })
  const dir = await mkdtemp(join(tmp, 'link-'))
  try {
    const plugin = join(dir, 'plugin')
    const host = join(dir, 'host')
    await mkdir(join(host, 'node_modules'), { recursive: true })
    await mkdir(plugin)
    await cp(join(repo, 'lib'), join(plugin, 'lib'), { recursive: true })
    await cp(join(repo, 'package.json'), join(plugin, 'package.json'))
    await symlink(plugin, join(host, 'node_modules', 'dsh-video-frames'), process.platform === 'win32' ? 'junction' : 'dir')
    const prefix = pathToFileURL(join(plugin, 'lib')).href + '/'
    const loader = join(dir, 'deny-tools.mjs')
    await writeFile(loader, `export async function resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-tools' && context.parentURL?.startsWith(${JSON.stringify(prefix)})) {
        throw Object.assign(new Error('Cannot find package @deepseek-ai/dsh-tools'), { code: 'ERR_MODULE_NOT_FOUND' });
      }
      return next(specifier, context);
    }`)
    const runner = join(host, 'check.mjs')
    await writeFile(runner, `import { apply } from 'dsh-video-frames';
      const names = [];
      const ctx = { tools: { register(tool) { names.push(tool.name) } }, inject(_deps, callback) { callback(ctx) } };
      apply(ctx);
      if (names.length !== 5) throw new Error('Expected five tools: ' + names);
      console.log(names.join(','));`)
    const output = execFileSync(process.execPath, ['--no-warnings', '--experimental-loader', pathToFileURL(loader).href, runner], { encoding: 'utf8', cwd: host })
    assert.match(output, /video_info,video_scenes,video_gif,video_frames,video_analyze/)
    assert.doesNotMatch(await readFile(join(plugin, 'lib/tools.js'), 'utf8'), /from ['"]@deepseek-ai\/dsh-tools['"]|defineVideoTool\(/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('out_dir keeps same-device rename and copies/unlinks on EXDEV', async () => {
  await mkdir(join(repo, '.tmp'), { recursive: true })
  const dir = await mkdtemp(join(repo, '.tmp', 'exdev-'))
  const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  const originalRename = fs.rename
  try {
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = dir
    const video = join(dir, 'sample.mp4')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=1', '-t', '2', '-c:v', 'mpeg4', video])
    const tools = []
    registerVideoTools({ tools: { register: tool => tools.push(tool) } })
    const extract = tools.find(tool => tool.name === 'video_frames')
    for (const crossDevice of [false, true]) {
      const sources = []
      fs.rename = async (from, to) => {
        sources.push(from)
        if (crossDevice) throw Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })
        return originalRename(from, to)
      }
      syncBuiltinESMExports()
      const out = join(dir, crossDevice ? 'cross-device' : 'same-device')
      const value = await extract.execute({ path: video, interval: 1, out_dir: out }, { signal: new AbortController().signal })
      assert.equal(value.count, 2)
      assert.equal(sources.length, 2)
      for (const source of sources) await assert.rejects(fs.stat(source), { code: 'ENOENT' })
      for (const file of await fs.readdir(out)) {
        assert.deepEqual((await readFile(join(out, file))).subarray(0, 2), Buffer.from([0xff, 0xd8]))
      }
    }
  } finally {
    fs.rename = originalRename
    syncBuiltinESMExports()
    for (const [key, value] of Object.entries(previousTemp)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('170-second analysis adapts to host limits, keeps LLM integration, and explains attachment failures', async () => {
  await mkdir(join(repo, '.tmp'), { recursive: true })
  const dir = await mkdtemp(join(repo, '.tmp', 'analyze-'))
  const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  try {
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = dir
    const video = join(dir, '170s.mp4')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=32x32:rate=1', '-t', '170', '-c:v', 'mpeg4', video])
    let batch, request
    const ctx = {
      attachments: {
        imageLimits: { maxImagesPerMessage: 20 },
        async saveImages(inputs) {
          assert(inputs.length <= ctx.attachments.imageLimits.maxImagesPerMessage)
          batch = inputs
          return inputs.map((_, i) => ({ id: `test-${i}` }))
        },
      },
      llm: {
        async *stream(input) {
          request = input
          yield { type: 'text-delta', text: 'test summary' }
        },
      },
    }
    const options = { provider: 'test', model: 'test', prompt: '', signal: new AbortController().signal }
    const value = await analyzeVideo(ctx, video, options)
    assert.equal(value.text, 'test summary')
    assert(batch.length > 0 && batch.length <= 20)
    assert(value.frames.at(-1) >= 150, 'uniform sampling must cover the whole video')
    assert.equal(request.messages[0].content.filter(block => block.type === 'image').length, batch.length)
    ctx.attachments.imageLimits.maxImagesPerMessage = 3
    await analyzeVideo(ctx, video, { ...options, maxFrames: 60 })
    assert(batch.length <= 3, 'explicit max_frames must still respect the host limit')
    await analyzeVideo(ctx, video, { ...options, maxFrames: 2, start: 20, end: 100 })
    assert(batch.length <= 2)
    assert(request.messages[0].content.some(block => block.type === 'text'))
    ctx.attachments.saveImages = async () => { throw new Error('Image batch exceeds the configured image-count limit.') }
    await assert.rejects(analyzeVideo(ctx, video, options), /视频关键帧保存失败.*降低 max_frames 或增大 interval/)
  } finally {
    for (const [key, value] of Object.entries(previousTemp)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
})
