// Follow native tool-present's successful-result delivery contract.
// Files come only from the trusted native attachment store, never model paths.
export function createImageDelivery(ctx) {
  const pending = new WeakMap()
  ctx.on('tools/result', (exec, result) => {
    const delivery = pending.get(exec)
    pending.delete(exec)
    if (!delivery || result.isError) return
    try {
      delivery.session.append('deliverables/presented', {
        turn: delivery.turn, callId: exec.callId, files: delivery.files,
      })
    } catch {
      // Remote generation already succeeded: a delivery issue must not trigger a repeat.
      console.warn('[grok-imagine] Original-file card could not be recorded; the generated image remains saved. Do not regenerate.')
    }
  })
  return (value, exec) => {
    if (!exec.agent) return
    const boundary = ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary')
    if (!boundary || boundary.openTurnStartSeq === null) return
    pending.set(exec, {
      session: exec.agent.session, turn: boundary.lastTurn,
      files: [{ path: value.path, description: value.operation === 'edit' ? 'Grok 改图原图（未缩放）' : 'Grok 生成原图（未缩放）' }],
    })
  }
}
