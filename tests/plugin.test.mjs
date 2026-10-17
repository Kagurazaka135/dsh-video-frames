import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { registerVideoTools } from '../lib/tools.js'

const repo = fileURLToPath(new URL('..', import.meta.url))

test('all five compiled schemas keep the public argument names and required fields', () => {
  const tools = new Map()
  registerVideoTools({ tools: { register: tool => tools.set(tool.name, tool) } })
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
