// Reuse only the existing xAI OAuth grant; never fall back to an API key.
const KEY = 'llm-pi-ai/xai'
function grant(record) {
  const value = record?.payload
  if (record?.kind !== 'grant' || value?.type !== 'oauth' || typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !Number.isFinite(value.expires)) {
    throw new Error('未找到现有 xAI 账号 OAuth 授权；不会改用 API Key。请先通过新版原生账号流程登录 Grok。')
  }
  return value
}
export function createOAuthResolver(credentials, oauth) {
  if (!credentials?.readRecord || !credentials?.modifyRecord || typeof oauth?.refresh !== 'function') throw new Error('Grok Imagine: native OAuth services are unavailable')
  return async function accessToken(signal) {
    signal?.throwIfAborted()
    let record = await credentials.readRecord(KEY)
    let value = grant(record)
    if (value.expires <= Date.now() + 30_000) {
      // Same record + native cross-process lock as the chat adapter. Refresh is
      // inside modifyRecord, so simultaneous chat/image requests cannot rotate
      // the same refresh token independently and lose the user's login.
      try {
        record = await credentials.modifyRecord(KEY, async current => {
          const latest = grant(current)
          if (latest.expires > Date.now() + 30_000) return undefined
          signal?.throwIfAborted()
          const next = await oauth.refresh(latest, signal)
          grant({ kind: 'grant', payload: next })
          return { kind: 'grant', payload: next }
        })
      } catch {
        signal?.throwIfAborted()
        throw new Error('xAI 账号授权刷新失败。请在新版原生账号中检查登录；没有尝试 API Key，也没有发送图片生成请求。')
      }
      value = grant(record)
    }
    signal?.throwIfAborted()
    return value.access
  }
}
