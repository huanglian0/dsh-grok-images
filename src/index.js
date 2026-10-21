import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOAuthResolver } from './auth.js'
import { createImagineService, imageType, MODEL } from './core.js'
import { createImageDelivery } from './delivery.js'
export const name = 'grok-imagine'
export const inject = ['tools', 'attachments', 'credentials', 'fs', 'workingDirectory', 'sessionProjections']

export function createToolDefinitions(defineTool, service, delivered = () => {}) {
  const run = operation => async (args, exec) => {
    const value = await service[operation](args, exec)
    try { delivered(value, exec) } catch { value.deliveryWarning = '原图已保存，但文件卡片登记失败；不要重复出图，需要原图时再调用 present。' }
    return value
  }
  const parameters = {
    prompt: { type: 'string', required: true, description: 'User-requested image generation/edit instructions, 1–16000 characters.' },
    quality: { type: 'string', enum: ['low', 'medium'], description: 'Default low; higher quality may consume more account quota or incur a higher charge.' },
    resolution: { type: 'string', enum: ['1k', '1.5k', '2k'], description: 'Default 1k; larger images may consume more account quota or incur a higher charge.' },
    aspect_ratio: { type: 'string', enum: ['1:1', '3:2', '2:3', '16:9', '9:16'], description: 'Default 1:1.' },
  }
  const output = {
    schema: { type: 'json' },
    render: (_args, value) => [
      { type: 'text', text: `${MODEL} · ${value.operation}\n图片会自动显示在本轮回复下方，可点击放大；原图另附文件卡片。请简短说明结果，不要只回复本地路径，也不必再次 present。\n供后续改图工具使用的原图路径：${value.path}\n账号：当前 xAI 登录（OAuth）。${value.deliveryWarning ? '\n' + value.deliveryWarning : ''}` },
      { type: 'image', attachment: value.image },
      { type: 'file', attachment: value.original },
    ],
  }
  return [
    defineTool({
      name: 'grok_image_status', description: 'Read-only Grok Imagine OAuth/model wiring status. Does not generate an image, test image entitlement, or prove subscription billing.',
      parameters: {}, output: { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: 30_000, isConcurrencySafe: () => true,
      execute: (_args, exec) => service.status(exec.signal),
    }),
    defineTool({
      name: 'grok_image_generate', description: 'Generate exactly one image with Grok Imagine 2.0 using ONLY the existing xAI OAuth account. Call only when the user explicitly requests an image. No automatic retries or API-key fallback. If plugin config has enabled image requests, do not ask for per-image billing confirmation. A cancelled/timed-out request may still consume quota; do not retry blindly.',
      parameters, output, timeoutMs: 180_000, isConcurrencySafe: () => false,
      execute: run('generate'),
    }),
    defineTool({
      name: 'grok_image_edit', description: 'Edit exactly one user-authorized local PNG/JPEG/WebP with Grok Imagine 2.0. Call only for an explicit user image-edit request. Uploads the selected image to xAI using existing OAuth. If plugin config has enabled image requests, do not ask for per-image billing confirmation. No automatic retries or API-key fallback.',
      parameters: { ...parameters, image_path: { type: 'string', required: true, description: 'Path of the specific input image authorized by the user; resolved through the native sandbox filesystem.' } },
      output, timeoutMs: 180_000, isConcurrencySafe: () => false,
      execute: run('edit'),
    }),
  ]
}
export async function apply(ctx, config = {}) {
  if (typeof config.installRoot !== 'string' || !path.isAbsolute(config.installRoot) || typeof config.dataHome !== 'string' || !path.isAbsolute(config.dataHome)) throw new Error('Grok Imagine requires explicit installRoot and dataHome')
  const expected = path.join(path.resolve(config.dataHome), 'attachments', 'v1')
  const actual = ctx.attachments.root
  const norm = x => process.platform === 'win32' ? x.toLowerCase() : x
  if (typeof actual !== 'string' || norm(path.resolve(actual)) !== norm(expected)) throw new Error('Grok Imagine refuses a mismatched attachment store; no files or credentials were changed')
  const sdk = p => import(pathToFileURL(path.join(config.installRoot, 'resources/app.asar/dsh/node_modules', p)).href)
  const { defineTool } = await sdk('@deepseek-ai/dsh-tools/lib/index.js')
  const { xaiOAuth } = await sdk('@earendil-works/pi-ai/dist/auth/oauth/xai.js')
  const accessToken = createOAuthResolver(ctx.credentials, xaiOAuth)
  const readInput = async (requestedPath, exec) => {
    const cwd = exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : undefined
    const target = await ctx.fs.resolve(requestedPath, { ...(cwd ? { cwd } : {}), signal: exec.signal })
    const info = await ctx.fs.stat(target, exec.signal)
    if (!info || info.type !== 'file') throw new Error('输入图片不是可读取的普通文件')
    const cap = Math.min(20 * 1024 * 1024, ctx.attachments.imageLimits.maxImageBytes)
    const data = await ctx.fs.readBytes(target, exec.signal, cap)
    const [mediaType] = imageType(data)
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    return { data, mediaType, name: path.basename(target.displayPath) }
  }
  const service = createImagineService({ accessToken, attachments: ctx.attachments, readInput, settings: { requestsEnabled: config.requestsEnabled === true } })
  for (const tool of createToolDefinitions(defineTool, service, createImageDelivery(ctx))) ctx.tools.register(tool)
  console.info(`[grok-imagine] Registered status/generate/edit native tools; image requests ${config.requestsEnabled === true ? 'enabled' : 'disabled'}.`)
}
