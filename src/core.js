import { randomUUID } from 'node:crypto'
export const MODEL = 'grok-imagine-image-2.0'
const API = 'https://api.x.ai/v1'
const RATIOS = ['1:1', '3:2', '2:3', '16:9', '9:16']
const MAX_IMAGE = 20 * 1024 * 1024
const MAX_JSON = 32 * 1024 * 1024
export function imageType(data) {
  const b = Buffer.from(data)
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', 'png']
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return ['image/jpeg', 'jpg']
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', 'webp']
  throw new Error('图片内容不是支持的 PNG/JPEG/WebP；未保存无效图片。')
}
export async function boundedBytes(response, limit, signal) {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > limit) { await response.body?.cancel().catch(() => {}); throw new Error('图片服务响应超过安全大小限制') }
  if (!response.body) throw new Error('图片服务返回了空响应')
  const reader = response.body.getReader(), parts = []
  let size = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('图片服务响应超过安全大小限制')
      parts.push(Buffer.from(value))
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  return Buffer.concat(parts, size)
}
function safeMessage(body, token) {
  const raw = body?.error?.message ?? body?.error ?? body?.message
  return typeof raw === 'string' ? raw.replaceAll(token, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 400) : '请求被拒绝'
}
export function buildPayload(mode, args, image) {
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 16_000) throw new Error('图片提示词必须为 1–16000 个字符')
  const quality = args.quality ?? 'low', resolution = args.resolution ?? '1k', ratio = args.aspect_ratio ?? '1:1'
  if (!['low', 'medium'].includes(quality)) throw new Error('quality 只支持 low / medium')
  if (!['1k', '1.5k', '2k'].includes(resolution)) throw new Error('resolution 只支持 1k / 1.5k / 2k')
  if (!RATIOS.includes(ratio)) throw new Error('不支持的图片宽高比')
  const body = { model: MODEL, prompt: args.prompt, n: 1, response_format: 'b64_json', quality, resolution, aspect_ratio: ratio }
  if (mode === 'edit') {
    if (!image || image.data.byteLength > MAX_IMAGE) throw new Error('编辑输入图片缺失或超过 20 MiB')
    const [type] = imageType(image.data)
    body.image = { type: 'image_url', url: `data:${type};base64,${Buffer.from(image.data).toString('base64')}` }
  } else if (mode !== 'generate') throw new Error('无效的图片操作')
  return body
}
export function createImagineService({ accessToken, attachments, readInput, settings = {}, fetchImpl = globalThis.fetch }) {
  if (typeof accessToken !== 'function' || !attachments?.saveImage || !attachments?.saveFile) throw new Error('Grok Imagine 原生依赖未就绪')
  let busy = false
  async function request(path, signal, body) {
    const token = await accessToken(signal)
    const response = await fetchImpl(API + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    let value
    try { value = JSON.parse((await boundedBytes(response, MAX_JSON, signal)).toString('utf8')) }
    catch (error) { signal?.throwIfAborted(); throw new Error(`xAI 返回了无效或过大的响应（HTTP ${response.status}）：${String(error.message).replaceAll(token, '[redacted]').slice(0, 180)}`) }
    if (!response.ok || value?.error) throw new Error(`xAI 图片请求失败（HTTP ${response.status}）：${safeMessage(value, token)}。没有自动重试，也不会切换 API Key。`)
    return { value, requestId: response.headers.get('x-request-id') ?? null }
  }
  async function status(signal) {
    const { value } = await request('/image-generation-models/' + MODEL, signal)
    return {
      provider: 'xai', model: MODEL, auth: 'existing-native-xai-oauth-only',
      modelListed: value.id === MODEL && value.output_modalities?.includes('image') === true,
      inputModalities: Array.isArray(value.input_modalities) ? value.input_modalities.filter(x => ['text','image'].includes(x)) : [],
      generationEnabled: settings.requestsEnabled === true,
      thisCheckSentImageRequest: false, subscriptionBillingVerified: false,
      note: '本次仅查询模型目录，没有额外出图。生成与编辑按用户的图片任务直接使用当前 xAI 登录。',
    }
  }
  async function imageBytes(item, signal) {
    if (typeof item?.b64_json === 'string') {
      if (item.b64_json.length > Math.ceil(MAX_IMAGE / 3) * 4) throw new Error('生成图片超过 20 MiB')
      const data = Buffer.from(item.b64_json, 'base64')
      if (!data.length || data.byteLength > MAX_IMAGE || data.toString('base64') !== item.b64_json) throw new Error('图片服务返回了无效 base64')
      imageType(data); return data
    }
    if (typeof item?.url === 'string') {
      const url = new URL(item.url)
      if (url.protocol !== 'https:' || url.hostname !== 'imgen.x.ai' || url.port || url.username || url.password) throw new Error('拒绝从未允许的图片地址下载')
      // Do not forward the OAuth bearer to a CDN, and never follow redirects.
      const response = await fetchImpl(url.href, { signal, redirect: 'error', headers: { Accept: 'image/png,image/jpeg,image/webp' } })
      if (!response.ok) throw new Error(`生成图片下载失败（HTTP ${response.status}）；为防重复计费没有重新生成`)
      const data = await boundedBytes(response, MAX_IMAGE, signal); imageType(data); return data
    }
    throw new Error('xAI 未返回可用图片，可能受到内容过滤；没有自动重试')
  }
  async function run(mode, args, exec = {}) {
    const signal = AbortSignal.any([...(exec.signal ? [exec.signal] : []), AbortSignal.timeout(180_000)])
    signal.throwIfAborted()
    // This host-owned switch cannot be overridden by a model argument.
    if (settings.requestsEnabled !== true) throw new Error('Grok 图片请求尚未启用：现有账号已接线，但图片权限与计费仍待确认。未发出生成/编辑请求；请先由用户确认实际试图，不能自行改用付费 API。')
    if (busy) throw new Error('已有一项 Grok 图片请求正在执行；请等待，勿重复提交')
    busy = true
    let sent = false, returnedImage = false, originalPath
    try {
      let input
      if (mode === 'edit') {
        if (typeof args.image_path !== 'string' || !args.image_path.trim() || typeof readInput !== 'function') throw new Error('编辑必须提供一张已获准读取的本地 image_path 图片')
        input = await readInput(args.image_path, exec)
        imageType(input.data)
        await attachments.validateImage(input)
      }
      const body = buildPayload(mode, args, input)
      signal.throwIfAborted()
      sent = true
      const { value, requestId } = await request(mode === 'edit' ? '/images/edits' : '/images/generations', signal, body)
      if (!Array.isArray(value.data) || value.data.length !== 1) throw new Error('图片服务未返回预期的一张图片；没有自动重试')
      const data = await imageBytes(value.data[0], signal), [mediaType, ext] = imageType(data)
      returnedImage = true
      signal.throwIfAborted()
      const name = `grok-${mode}-${randomUUID()}.${ext}`
      // Keep byte-identical original separately: normal preview admission may
      // downscale large images. Both are native immutable attachment records.
      const original = await attachments.saveFile({ data, mediaType, name })
      originalPath = attachments.fileHostPath(original)
      const preview = await attachments.saveImage({ data, mediaType, name })
      return {
        model: MODEL, operation: mode, quality: body.quality, resolution: body.resolution,
        image: preview, original, path: attachments.fileHostPath(original), requestId,
        auth: 'existing-native-xai-oauth-only', subscriptionBillingVerified: false,
      }
    } catch (error) {
      if (sent && (signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError')) throw new Error('图片请求已中断或超时，但服务端可能已接收并消耗额度；没有自动重试。请先检查账号记录，勿重复生成。')
      if (returnedImage) throw new Error('xAI 已返回图片，但本地处理或保存失败，服务端可能已消耗额度；没有重新生成。' + (originalPath ? `原图已保存：${originalPath}。` : '') + String(error.message).slice(0, 180))
      throw error
    } finally { busy = false }
  }
  return { status, generate: (args, exec) => run('generate', args, exec), edit: (args, exec) => run('edit', args, exec) }
}
